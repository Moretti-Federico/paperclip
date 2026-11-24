#!/usr/bin/env python3
"""Splice the SSH secret-transport fix into the production runtime chunk.

Production (local/paperclip:2026.1106.0-oauth-v3-ssh-cleanup-candidate) bundles
packages/adapter-utils/src/ssh.ts into server/dist-runtime/chunk-3ZK6CBQV.mjs.
This tool replaces exactly the top-level declarations the fix changes, taken
from an esbuild compile of the fixed ssh.ts (same esbuild version/target as the
runtime bundle), and renames the identifiers the bundler renamed in that chunk.

usage: make-chunk-patch.py <prod-chunk> <fixed-ssh.js (esbuild output)> <out-chunk>
Refuses to run unless the input chunk is byte-identical to production.
"""
import hashlib
import re
import sys

PROD_SHA256 = "181ba3186e722015bd1cbb70fd74eca39e3a266d0660ba1c4ada185b8864791b"
SECTION_START = "// packages/adapter-utils/src/ssh.ts\nfunction createSshCommandManagedRuntimeRunner(input) {"
# Identifiers of the ssh.ts module that the bundler renamed inside this chunk.
RENAMES = {"shellQuote": "shellQuote2", "randomUUID": "randomUUID2"}
NEW_NAMES = [
    "REMOTE_ENV_DIR_EXPR", "REMOTE_ENV_ORPHAN_MAX_AGE_MINUTES", "REMOTE_ENV_PROVISION_TIMEOUT_MS",
    "REMOTE_ENV_CLEANUP_TIMEOUT_MS", "remoteEnvFilePathExpr", "buildRemoteEnvFileContent",
    "provisionRemoteEnvFile", "SSH_LOGIN_PROFILE_STEPS", "collectSshEnvEntries", "runSshCommandWithoutEnv",
]
# Names the inserted code references from the surrounding module; each must
# exist in the production section under exactly this name.
REQUIRED_IN_SECTION = ["execFileText", "spawnText", "createSshAuthArgs", "isValidShellEnvKey", "shellQuote2", "randomUUID2"]


def die(msg):
    sys.exit(f"ERROR: {msg}")


def top_level_blocks(source):
    """Map declared name -> text of each column-0 top-level declaration."""
    decl = re.compile(r"^(?:async function|function|var|let|const) ([A-Za-z_$][\w$]*)", re.M)
    starts = [(m.start(), m.group(1)) for m in decl.finditer(source)]
    boundary = re.compile(r"^(?:async function|function|var|let|const|export|import|//) ", re.M)
    blocks = {}
    for start, name in starts:
        nxt = boundary.search(source, start + 1)
        blocks[name] = source[start:nxt.start() if nxt else len(source)].rstrip("\n") + "\n"
    return blocks


def rename(text):
    for old, new in RENAMES.items():
        text = re.sub(rf"(?<![\w$.]){re.escape(old)}(?![\w$])", new, text)
    return text


def replace_once(haystack, old, new, label):
    if haystack.count(old) != 1:
        die(f"{label}: expected exactly one match, found {haystack.count(old)}")
    return haystack.replace(old, new)


def main():
    prod_path, fixed_js_path, out_path = sys.argv[1:4]
    prod = open(prod_path, "rb").read()
    if hashlib.sha256(prod).hexdigest() != PROD_SHA256:
        die("input chunk is not the production chunk")
    chunk = prod.decode("utf8")
    fixed = top_level_blocks(open(fixed_js_path, encoding="utf8").read())

    start = chunk.index(SECTION_START)
    end = chunk.index("\n// packages/", start + len(SECTION_START))
    section = chunk[start:end]
    for name in NEW_NAMES:
        if re.search(rf"(?<![\w$]){name}(?![\w$])", chunk):
            die(f"name collision: {name}")
    for name in REQUIRED_IN_SECTION:
        if not re.search(rf"(?<![\w$]){name}(?![\w$])", section):
            die(f"missing in section: {name}")
    prod_blocks = top_level_blocks(section)

    # 1. Managed-runtime runner: env goes to runSshCommand, not into the script.
    new_runner = rename(fixed["createSshCommandManagedRuntimeRunner"])
    # Keep the production chunk's local rename of `failure` (failure2).
    if "const failure2 = error;" in prod_blocks["createSshCommandManagedRuntimeRunner"]:
        new_runner = re.sub(r"(?<![\w$])failure(?![\w$])", "failure2", new_runner)
    section = replace_once(section, prod_blocks["createSshCommandManagedRuntimeRunner"], new_runner, "runner")

    # 2. New helpers right after isValidShellEnvKey.
    helpers = "".join(rename(fixed[n]) for n in [
        "REMOTE_ENV_DIR_EXPR", "REMOTE_ENV_ORPHAN_MAX_AGE_MINUTES", "REMOTE_ENV_PROVISION_TIMEOUT_MS",
        "REMOTE_ENV_CLEANUP_TIMEOUT_MS", "remoteEnvFilePathExpr", "buildRemoteEnvFileContent",
        "provisionRemoteEnvFile",
    ])
    iv = prod_blocks["isValidShellEnvKey"]
    section = replace_once(section, iv, iv + helpers, "helpers")

    # 3. runSshCommand + buildSshSpawnTarget, with their new private helpers.
    old_pair = prod_blocks["runSshCommand"] + prod_blocks["buildSshSpawnTarget"]
    new_pair = "".join(rename(fixed[n]) for n in [
        "SSH_LOGIN_PROFILE_STEPS", "collectSshEnvEntries", "runSshCommandWithoutEnv",
        "runSshCommand", "buildSshSpawnTarget",
    ])
    section = replace_once(section, old_pair, new_pair, "runSshCommand/buildSshSpawnTarget")

    if "exec env " in section:
        die("legacy `exec env` construction still present in ssh section")
    out = chunk[:start] + section + chunk[end:]
    open(out_path, "w", encoding="utf8").write(out)
    print("patched sha256", hashlib.sha256(out.encode("utf8")).hexdigest())


if __name__ == "__main__":
    main()
