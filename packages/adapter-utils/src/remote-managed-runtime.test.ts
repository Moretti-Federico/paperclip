import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  sweepSshRunWorkspacesMetadataOnly,
  syncDirectoryToSsh,
} = vi.hoisted(() => ({
  prepareWorkspaceForSshExecution: vi.fn(
    async (_input?: unknown): Promise<{ gitBacked: boolean; transferExclude?: string[] }> => ({ gitBacked: false }),
  ),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({
    stdout: Buffer.from('{"token":"remote"}\n').toString("base64"),
    stderr: "",
  })),
  sweepSshRunWorkspacesMetadataOnly: vi.fn(async () => ({
    mode: "dry-run",
    policyRevision: "1",
    runsRoot: "/app/.paperclip-runtime/runs",
    scannedAtMs: 0,
    scanned: 0,
    plannedBytes: 0,
    decisions: [],
    deferred: [],
    notes: [],
  })),
  syncDirectoryToSsh: vi.fn(async (_input: { localDir: string }) => undefined),
}));

vi.mock("./ssh.js", () => ({
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
}));

vi.mock("./ssh-run-retention.js", () => ({
  sweepSshRunWorkspacesMetadataOnly,
}));

import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import { resolveReferencedSourceIgnore } from "./sandbox-managed-runtime.js";
import { setExpensiveWorkspaceGitExecutor } from "./git-workspace-sync.js";

describe("remote managed runtime", () => {
  const cleanupDirs: string[] = [];

  it("stages all files over SSH without Git or cache exclusions and restores the same baseline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-plain-"));
    cleanupDirs.push(root);
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
    await writeFile(path.join(root, "node_modules", "personal.bin"), Buffer.from([0, 255, 1]));
    // The upload reports the effective transfer excludes it applied; the
    // baseline must mirror exactly that list (single source of truth).
    prepareWorkspaceForSshExecution.mockResolvedValueOnce({ gitBacked: false, transferExclude: ["explicitly-excluded"] });
    const prepared = await prepareRemoteManagedRuntime({
      spec: { host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app", remoteCwd: "/app",
        privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS", strictHostKeyChecking: true },
      runId: "plain", adapterKey: "test", workspaceLocalDir: root,
      workspaceFileMode: "all", workspaceExclude: ["explicitly-excluded"],
    });
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: root, remoteDir: prepared.workspaceRemoteDir, workspaceFileMode: "all", workspaceExclude: ["explicitly-excluded"],
    }));
    await prepared.restoreWorkspace();
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      restoreGitHistory: false, baselineSnapshot: expect.objectContaining({
        exclude: [".paperclip-runtime", "explicitly-excluded"],
        entries: expect.any(Map),
      }),
    }));
    const args = vi.mocked(restoreWorkspaceFromSshExecution).mock.calls[0] as unknown as [{ baselineSnapshot: { entries: Map<string, unknown> } }];
    expect(args[0].baselineSnapshot.entries.has("node_modules/personal.bin")).toBe(true);
  });

  it("mirrors the upload's effective transfer excludes into the baseline on the Git path too", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-git-"));
    cleanupDirs.push(root);
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "left.bin"), Buffer.from([1, 2, 3]));
    prepareWorkspaceForSshExecution.mockResolvedValueOnce({
      gitBacked: true,
      transferExclude: ["node_modules", "node_modules/*", "*/node_modules", "*/node_modules/*"],
    });
    const prepared = await prepareRemoteManagedRuntime({
      spec: { host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app", remoteCwd: "/app",
        privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS", strictHostKeyChecking: true },
      runId: "git-backed", adapterKey: "test", workspaceLocalDir: root,
      workspaceExclude: ["node_modules", "node_modules/*", "*/node_modules", "*/node_modules/*"],
    });
    await prepared.restoreWorkspace();
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      restoreGitHistory: true,
      baselineSnapshot: expect.objectContaining({
        exclude: [
          ".git",
          ".git/*",
          ".paperclip-runtime",
          "node_modules",
          "node_modules/*",
          "*/node_modules",
          "*/node_modules/*",
        ],
        entries: expect.any(Map),
      }),
    }));
    const args = vi.mocked(restoreWorkspaceFromSshExecution).mock.calls[0] as unknown as [{ baselineSnapshot: { entries: Map<string, unknown> } }];
    // Excluded from the upload => excluded from the baseline => never a
    // restore-time deletion candidate.
    expect(args[0].baselineSnapshot.entries.has("node_modules/left.bin")).toBe(false);
  });

  it("runs the retention sweep after restore only when the policy is enabled, and never fails the run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-retention-"));
    cleanupDirs.push(root);
    await mkdir(root, { recursive: true });

    const enabledPolicy = {
      enabled: true,
      mode: "dry-run" as const,
      minAgeHours: 48,
      maxBatchDirs: 5,
      maxBatchBytes: 1024 * 1024 * 1024,
      timeBudgetMs: 30_000,
      minQuarantineDays: 7,
      runsWithoutIssue: "protected" as const,
      policyRevision: "1",
    };

    // Disabled by default: no sweep at all.
    const inert = await prepareRemoteManagedRuntime({
      spec: { host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app", remoteCwd: "/app",
        privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS", strictHostKeyChecking: true },
      runId: "retention-off", adapterKey: "test", workspaceLocalDir: root,
      runRetention: {
        policy: { ...enabledPolicy, enabled: false },
      },
    });
    await inert.restoreWorkspace();
    expect(sweepSshRunWorkspacesMetadataOnly).not.toHaveBeenCalled();

    // Enabled: the sweep runs after the workspace restore, anchored to the
    // same runs root, with the current run excluded.
    let capturedManifest: unknown = null;
    const active = await prepareRemoteManagedRuntime({
      spec: { host: "127.0.0.1", port: 2222, username: "fixture", remoteWorkspacePath: "/app", remoteCwd: "/app",
        privateKey: "PRIVATE KEY", knownHosts: "KNOWN HOSTS", strictHostKeyChecking: true },
      runId: "retention-on", adapterKey: "test", workspaceLocalDir: root,
      runRetention: {
        policy: enabledPolicy,
        onManifest: (manifest) => {
          capturedManifest = manifest;
        },
      },
    });
    sweepSshRunWorkspacesMetadataOnly.mockRejectedValueOnce(new Error("sweep exploded"));
    await active.restoreWorkspace();
    expect(sweepSshRunWorkspacesMetadataOnly).toHaveBeenCalledWith(expect.objectContaining({
      runsRoot: "/app/.paperclip-runtime/runs",
      excludeRunIds: ["retention-on"],
    }));
    // A failing sweep is swallowed: restore already completed and no error
    // escapes the finalization path. The second (successful) sweep proves the
    // manifest callback is honored.
    await active.restoreWorkspace();
    expect(sweepSshRunWorkspacesMetadataOnly).toHaveBeenCalledTimes(2);
    expect(capturedManifest).toEqual(expect.objectContaining({ mode: "dry-run" }));
  });


  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("restores runtime assets without restoring an in-place SSH workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-assets-only-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const homeDir = path.join(rootDir, "home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(path.join(homeDir, "auth.json"), '{"token":"host"}\n', "utf8");

    let restoredAuth = "";
    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-in-place",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      assets: [
        {
          key: "home",
          localDir: homeDir,
          restore: async ({ assetDir, readFile }) => {
            restoredAuth = (await readFile(path.posix.join(assetDir, "auth.json"))).toString("utf8");
          },
        },
      ],
    });

    expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: homeDir,
      remoteDir: "/app/.paperclip-runtime/codex/home",
    }));

    await prepared.restoreWorkspace();

    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      "base64 < '/app/.paperclip-runtime/codex/home/auth.json'",
      { maxBuffer: 1024 * 1024 },
    );
    expect(restoredAuth).toBe('{"token":"remote"}\n');
  });

  it("stages each additional project into its own isolated SSH dir, isolating one failure", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-additional-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const firstDir = path.join(rootDir, "referenced-first");
    const secondDir = path.join(rootDir, "referenced-second");
    const brokenDir = path.join(rootDir, "referenced-broken");
    await mkdir(workspaceDir, { recursive: true });

    // The transfer rejects only for the broken project's directory.
    syncDirectoryToSsh.mockImplementation(async (input: { localDir: string }) => {
      if (input.localDir === brokenDir) throw new Error("ssh transfer failed");
      return undefined;
    });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-additional",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: firstDir, projectId: "first", ignoreResolution: { kind: "other" } },
        { localPath: brokenDir, projectId: "broken", ignoreResolution: { kind: "other" } },
        { localPath: secondDir, projectId: "second", ignoreResolution: { kind: "other" } },
      ],
    });

    // Each healthy project staged into its OWN isolated dir under the runtime
    // root; the broken one is skipped, not fatal.
    expect(Object.keys(prepared.additionalSourceDirs).sort()).toEqual(["first", "second"]);
    expect(prepared.additionalSourceDirs.first).toBe("/app/.paperclip-runtime/codex/project-first");
    expect(prepared.additionalSourceDirs.second).toBe("/app/.paperclip-runtime/codex/project-second");
    expect(prepared.additionalSourceDirs.broken).toBeUndefined();
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: firstDir,
      remoteDir: "/app/.paperclip-runtime/codex/project-first",
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      localDir: secondDir,
      remoteDir: "/app/.paperclip-runtime/codex/project-second",
    }));
  });

  it("skips an additional project whose localPath is not absolute", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-relative-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const healthyDir = path.join(rootDir, "referenced-healthy");
    await mkdir(workspaceDir, { recursive: true });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-relative",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: "relative/referenced", projectId: "relative", ignoreResolution: { kind: "other" } },
        { localPath: healthyDir, projectId: "healthy", ignoreResolution: { kind: "other" } },
      ],
    });

    // The relative-path project never reaches the transfer and is skipped; the
    // absolute-path project still stages.
    expect(Object.keys(prepared.additionalSourceDirs)).toEqual(["healthy"]);
    expect(syncDirectoryToSsh).not.toHaveBeenCalledWith(expect.objectContaining({
      localDir: "relative/referenced",
    }));
  });

  it("passes a project's resolved Git-ignored paths to the SSH exclude list, escaped", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-ignore-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const projectDir = path.join(rootDir, "referenced-project");
    await mkdir(workspaceDir, { recursive: true });

    await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-ignore",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        {
          localPath: projectDir,
          projectId: "proj",
          ignoreResolution: { kind: "git", ignoredPaths: ["secret.env", "build", "weird[1].txt"] },
        },
      ],
    });

    const call = syncDirectoryToSsh.mock.calls.find((entry) => entry[0].localDir === projectDir);
    expect(call).toBeDefined();
    const exclude = (call![0] as { exclude?: string[] }).exclude ?? [];
    // The resolved ignored paths ride the exclude list, glob-escaped, on top of
    // the fixed heavy-directory excludes the SSH lane already applies.
    expect(exclude).toContain("secret.env");
    expect(exclude).toContain("build");
    expect(exclude).toContain("weird\\[1].txt");
    expect(exclude).toContain("node_modules");
  });

  it("skips a project whose ignore resolution failed without ever calling syncDirectoryToSsh for it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-failed-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const healthyDir = path.join(rootDir, "referenced-healthy");
    const failedDir = path.join(rootDir, "referenced-failed");
    await mkdir(workspaceDir, { recursive: true });

    const prepared = await prepareRemoteManagedRuntime({
      spec: {
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteWorkspacePath: "/app",
        remoteCwd: "/app",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        strictHostKeyChecking: true,
      },
      runId: "run-failed",
      adapterKey: "codex",
      workspaceLocalDir: workspaceDir,
      workspaceRemoteDir: "/app",
      syncWorkspace: false,
      additionalSources: [
        { localPath: healthyDir, projectId: "healthy", ignoreResolution: { kind: "other" } },
        { localPath: failedDir, projectId: "failed", ignoreResolution: { kind: "failed", reason: "git status timed out" } },
      ],
    });

    // Fail closed: the failed project never reaches the transfer at all — no
    // bytes are sent for it — while the healthy project still stages.
    expect(Object.keys(prepared.additionalSourceDirs)).toEqual(["healthy"]);
    expect(syncDirectoryToSsh).not.toHaveBeenCalledWith(expect.objectContaining({ localDir: failedDir }));
  });

  it("never leaks a raw absolute path into the remote per-project staging warning", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-runtime-redact-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const failedDir = path.join(rootDir, "referenced-failed");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(failedDir, { recursive: true });

    // A raw toplevel string that makes `failedDir` a non-descendant, carrying
    // a sensitive absolute path — exactly the shape a caught Git diagnostic
    // could embed. `resolveReferencedSourceIgnore` is the single choke point
    // that must reduce it to the fixed category before anything downstream
    // (here, the remote lane's warning) ever sees it.
    const sensitivePath = "/srv/alice/project";
    let ignoreResolution;
    try {
      setExpensiveWorkspaceGitExecutor(async (input) => {
        if (input.operation === "referenced_source.toplevel") {
          return { stdout: `${sensitivePath}\n`, stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });
      ignoreResolution = await resolveReferencedSourceIgnore(failedDir);
    } finally {
      setExpensiveWorkspaceGitExecutor(null);
    }
    expect(ignoreResolution.kind).toBe("failed");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await prepareRemoteManagedRuntime({
        spec: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/app",
          remoteCwd: "/app",
          privateKey: "PRIVATE KEY",
          knownHosts: "KNOWN HOSTS",
          strictHostKeyChecking: true,
        },
        runId: "run-redact",
        adapterKey: "codex",
        workspaceLocalDir: workspaceDir,
        workspaceRemoteDir: "/app",
        syncWorkspace: false,
        additionalSources: [{ localPath: failedDir, projectId: "failed", ignoreResolution }],
      });

      const warnedText = warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(warnedText).toContain("failed");
      expect(warnedText).not.toContain(sensitivePath);
      expect(warnedText).not.toContain(failedDir);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
