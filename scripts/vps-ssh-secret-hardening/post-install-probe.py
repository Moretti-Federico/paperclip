#!/usr/bin/env python3
"""Value-free post-install probe for the SSH secret-transport fix.

Scans live `ssh` client processes on the host (the Paperclip container's
processes are visible from the host PID namespace) and reports ONLY counts:

  legacy_exec_env   ssh processes whose argv still carries `exec env NAME=`
                    (the vulnerable construction)  -> must be 0
  env_file_wrapper  ssh processes whose argv sources the private env file
                    (".paperclip-run-env/")        -> >0 while agents run

It never prints a command line, an environment, or any value. Run it as the
owner (root sees every process) while at least one SSH agent run is active.
Exit code: 0 = OK, 1 = legacy construction seen, 2 = nothing to inspect.
"""
import os
import re
import sys

LEGACY = re.compile(rb"exec env [A-Za-z_][A-Za-z0-9_]*=")
MARKER = b".paperclip-run-env/"


def main() -> int:
    total = legacy = wrapper = 0
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/comm", "rb") as handle:
                if handle.read().strip() != b"ssh":
                    continue
            with open(f"/proc/{entry}/cmdline", "rb") as handle:
                cmdline = handle.read()
        except OSError:
            continue
        total += 1
        if LEGACY.search(cmdline):
            legacy += 1
        if MARKER in cmdline:
            wrapper += 1
    print(f"ssh_processes={total} legacy_exec_env={legacy} env_file_wrapper={wrapper}")
    if legacy:
        print("RESULT=FAIL legacy argv construction still running")
        return 1
    if total == 0:
        print("RESULT=INCONCLUSIVE no ssh process running; retry during an agent run")
        return 2
    print("RESULT=OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
