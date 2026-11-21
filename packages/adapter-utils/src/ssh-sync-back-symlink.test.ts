import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Deterministic local harness for the SSH sync-back pipeline: every `ssh`
// subprocess executes its final command string through `sh -c` on this
// machine, so the full restore path (remote tar -> staging extraction ->
// copyDirectoryContents -> staging cleanup) runs against local directories
// without an SSH server. `git` and `tar` subprocesses pass through untouched.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((file: string, args: string[], options: object, callback: Parameters<typeof actual.execFile>[3]) => {
      if (file !== "ssh") return actual.execFile(file, args, options, callback);
      return actual.execFile("sh", ["-c", args.at(-1)!], options, callback);
    }),
    spawn: vi.fn((file: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      if (file !== "ssh") return actual.spawn(file, args, options);
      return actual.spawn("sh", ["-c", args.at(-1)!], options);
    }),
  };
});

import { syncDirectoryFromSsh } from "./ssh.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// The three Git-tracked relative skill symlinks whose targets the SSH
// sync-back rewrote to a deleted /tmp/paperclip-ssh-sync-back-* staging
// directory (VPS-824): each link climbs out of .claude/skills to a target
// that exists inside the workspace.
const RELATIVE_SKILL_LINKS = [
  { linkPath: ".claude/skills/company-creator", target: "../../.agents/skills/company-creator" },
  { linkPath: ".claude/skills/directions-lab", target: "../../.agents/skills/directions-lab" },
  { linkPath: ".claude/skills/paperclip", target: "../../skills/paperclip" },
] as const;

// A relative link whose target does not exist: restore must keep it a
// dangling symlink with the exact original target, not materialize or drop it.
const DANGLING_SKILL_LINK = {
  linkPath: ".claude/skills/pending-skill",
  target: "../../.agents/skills/pending-skill",
} as const;

const EXTERNAL_LINK_PATH = "external-link";

const LOCAL_SSH_SPEC = {
  host: "fixture.invalid",
  port: 22,
  username: "fixture",
  remoteWorkspacePath: "/nonexistent",
  remoteCwd: "/nonexistent",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: false,
} as const;

async function materializeWorkspaceTree(rootDir: string, externalTargetPath: string): Promise<void> {
  await mkdir(path.join(rootDir, ".agents/skills/company-creator"), { recursive: true });
  await mkdir(path.join(rootDir, ".agents/skills/directions-lab"), { recursive: true });
  await mkdir(path.join(rootDir, "skills/paperclip"), { recursive: true });
  await mkdir(path.join(rootDir, ".claude/skills"), { recursive: true });
  await writeFile(path.join(rootDir, ".agents/skills/company-creator/SKILL.md"), "company-creator\n", "utf8");
  await writeFile(path.join(rootDir, ".agents/skills/directions-lab/SKILL.md"), "directions-lab\n", "utf8");
  await writeFile(path.join(rootDir, "skills/paperclip/SKILL.md"), "paperclip\n", "utf8");
  await writeFile(path.join(rootDir, "README.md"), "regular file\n", "utf8");
  for (const entry of [...RELATIVE_SKILL_LINKS, DANGLING_SKILL_LINK]) {
    await symlink(entry.target, path.join(rootDir, entry.linkPath));
  }
  await symlink(externalTargetPath, path.join(rootDir, EXTERNAL_LINK_PATH));
}

describe("ssh sync-back relative symlink fidelity", () => {
  it("restores relative symlink targets verbatim across consecutive sync-backs", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-link-fidelity-"));
    roots.push(rootDir);
    const externalTargetPath = path.join(rootDir, "external-target.txt");
    await writeFile(externalTargetPath, "external payload\n", "utf8");

    const localDir = path.join(rootDir, "workspace");
    const remoteDir = path.join(rootDir, "remote-source");
    await materializeWorkspaceTree(localDir, externalTargetPath);
    await materializeWorkspaceTree(remoteDir, externalTargetPath);

    await git(localDir, ["init"]);
    await git(localDir, ["checkout", "-b", "main"]);
    await git(localDir, ["config", "user.name", "Paperclip Test"]);
    await git(localDir, ["config", "user.email", "test@paperclip.dev"]);
    await git(localDir, ["add", "."]);
    await git(localDir, ["commit", "-m", "symlink workspace"]);
    expect(await git(localDir, ["status", "--porcelain"])).toBe("");

    // Two consecutive restores mirror the repeated VPS-824 sync-backs: each
    // round must leave the Git index clean, which only holds when every
    // restored link target is byte-identical to the committed one.
    for (let round = 1; round <= 2; round += 1) {
      await syncDirectoryFromSsh({
        spec: LOCAL_SSH_SPEC,
        remoteDir,
        localDir,
        exclude: [".git", ".paperclip-runtime"],
        preserveLocalEntries: [".git"],
      });

      for (const entry of [...RELATIVE_SKILL_LINKS, DANGLING_SKILL_LINK]) {
        const target = await readlink(path.join(localDir, entry.linkPath));
        expect(target, `round ${round}: readlink ${entry.linkPath}`).toBe(entry.target);
        expect(target, `round ${round}: staging leak in ${entry.linkPath}`).not.toContain("paperclip-ssh-sync-back");
      }
      // The dangling link stays a symlink to the still-missing target.
      await expect(
        stat(path.join(localDir, DANGLING_SKILL_LINK.linkPath)),
        `round ${round}: dangling link must stay dangling`,
      ).rejects.toMatchObject({ code: "ENOENT" });

      // Absolute external target is preserved verbatim and keeps resolving to
      // the payload outside the workspace, never into the staging directory.
      const externalTarget = await readlink(path.join(localDir, EXTERNAL_LINK_PATH));
      expect(externalTarget, `round ${round}: external link target`).toBe(externalTargetPath);
      expect(externalTarget, `round ${round}: staging leak in ${EXTERNAL_LINK_PATH}`).not.toContain(
        "paperclip-ssh-sync-back",
      );
      await expect(readFile(path.join(localDir, EXTERNAL_LINK_PATH), "utf8")).resolves.toBe("external payload\n");

      await expect(readFile(path.join(localDir, "README.md"), "utf8")).resolves.toBe("regular file\n");

      expect(await git(localDir, ["status", "--porcelain"]), `round ${round}: git status after restore`).toBe("");
    }
  }, 30_000);
});
