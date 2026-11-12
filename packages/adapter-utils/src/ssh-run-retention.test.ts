import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY,
  evaluateSshRunWorkspaceRetention,
  listLocalRunWorkspaceNames,
  parseSshRunWorkspaceRetentionPolicy,
  planSshRunWorkspaceRetentionBatch,
  sizeLocalRunWorkspaces,
  sweepSshRunWorkspacesMetadataOnly,
  type SshRunRetentionCandidate,
  type SshRunRetentionEligibilityInput,
  type SshRunRetentionReceipt,
  type SshRunWorkspaceRetentionPolicy,
} from "./ssh-run-retention.js";

const NOW_MS = Date.parse("2026-11-12T12:00:00Z");
const OLD_MS = NOW_MS - 72 * 60 * 60 * 1000; // 72h before now
const POLICY: SshRunWorkspaceRetentionPolicy = {
  ...DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY,
  enabled: true,
};

/** Full positive evidence: the only shape that can reach an eligible outcome. */
const FULL_ELIGIBILITY: SshRunRetentionEligibilityInput = {
  apiComplete: true,
  runTerminal: true,
  finalizationSettled: true,
  issueResolved: "done",
  issueGenerationUnchanged: true,
  workspaceGenerationUnchanged: true,
  processReferencesAbsent: true,
  gitRecoverable: true,
  protectedContentAbsent: true,
};

function candidate(overrides: Partial<SshRunRetentionCandidate> = {}): SshRunRetentionCandidate {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    bytes: 1024,
    newestMtimeMs: OLD_MS,
    eligibility: FULL_ELIGIBILITY,
    ...overrides,
  };
}

describe("ssh run workspace retention policy", () => {
  it("is disabled and dry-run by default", () => {
    expect(DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY.enabled).toBe(false);
    expect(DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY.mode).toBe("dry-run");
    expect(DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY.minAgeHours).toBe(48);
    expect(DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY.maxBatchDirs).toBe(5);
    expect(DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY.maxBatchBytes).toBe(1024 * 1024 * 1024);
    expect(DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY.timeBudgetMs).toBe(30_000);
    expect(DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY.minQuarantineDays).toBe(7);
    expect(DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY.runsWithoutIssue).toBe("protected");
  });

  it("rejects any mode other than dry-run (fail closed)", () => {
    expect(parseSshRunWorkspaceRetentionPolicy({ enabled: true, mode: "apply" })).toBeNull();
    expect(parseSshRunWorkspaceRetentionPolicy({ enabled: true, mode: "delete" })).toBeNull();
    expect(parseSshRunWorkspaceRetentionPolicy({ enabled: true, mode: "dry-run" })?.mode).toBe("dry-run");
  });

  it("protects runs without an issue in the first version", () => {
    expect(parseSshRunWorkspaceRetentionPolicy({ enabled: true, runsWithoutIssue: "delete" })).toBeNull();
  });
});

describe("evaluateSshRunWorkspaceRetention", () => {
  it("grants QUARANTINE_ELIGIBLE only with full evidence and sufficient age", () => {
    const { decision } = evaluateSshRunWorkspaceRetention(candidate(), POLICY, NOW_MS);
    expect(decision).toEqual({ outcome: "QUARANTINE_ELIGIBLE", reason: "eligible" });
  });

  it("SKIPs when the Paperclip API is unreachable, incomplete, or 404", () => {
    for (const eligibility of [undefined, {}, { ...FULL_ELIGIBILITY, apiComplete: false }]) {
      const { decision } = evaluateSshRunWorkspaceRetention(candidate({ eligibility }), POLICY, NOW_MS);
      expect(decision).toEqual({ outcome: "SKIP", reason: "api_incomplete" });
    }
  });

  it("SKIPs non-terminal runs and runs with unsettled finalization", () => {
    expect(
      evaluateSshRunWorkspaceRetention(candidate({ eligibility: { ...FULL_ELIGIBILITY, runTerminal: false } }), POLICY, NOW_MS).decision,
    ).toEqual({ outcome: "SKIP", reason: "run_not_terminal" });
    expect(
      evaluateSshRunWorkspaceRetention(
        candidate({ eligibility: { ...FULL_ELIGIBILITY, finalizationSettled: false } }),
        POLICY,
        NOW_MS,
      ).decision,
    ).toEqual({ outcome: "SKIP", reason: "finalization_unsettled" });
  });

  it("KEEPS runs without an issue even when fully evidenced and large", () => {
    const { decision } = evaluateSshRunWorkspaceRetention(
      candidate({ bytes: 50 * 1024 * 1024 * 1024, eligibility: { ...FULL_ELIGIBILITY, issueResolved: null } }),
      POLICY,
      NOW_MS,
    );
    expect(decision).toEqual({ outcome: "KEEP", reason: "protected_run_without_issue" });
  });

  it("SKIPs open issues, unknown issue state, and changed generations", () => {
    expect(
      evaluateSshRunWorkspaceRetention(candidate({ eligibility: { ...FULL_ELIGIBILITY, issueResolved: "in_progress" } }), POLICY, NOW_MS)
        .decision,
    ).toEqual({ outcome: "SKIP", reason: "issue_unresolved" });
    const { issueResolved: _omit, ...withoutIssue } = FULL_ELIGIBILITY;
    expect(evaluateSshRunWorkspaceRetention(candidate({ eligibility: withoutIssue }), POLICY, NOW_MS).decision).toEqual({
      outcome: "SKIP",
      reason: "issue_state_unknown",
    });
    expect(
      evaluateSshRunWorkspaceRetention(
        candidate({ eligibility: { ...FULL_ELIGIBILITY, issueGenerationUnchanged: false } }),
        POLICY,
        NOW_MS,
      ).decision,
    ).toEqual({ outcome: "SKIP", reason: "issue_generation_changed" });
    expect(
      evaluateSshRunWorkspaceRetention(
        candidate({ eligibility: { ...FULL_ELIGIBILITY, workspaceGenerationUnchanged: false } }),
        POLICY,
        NOW_MS,
      ).decision,
    ).toEqual({ outcome: "SKIP", reason: "workspace_generation_changed" });
  });

  it("KEEPS candidates younger than the minimum age", () => {
    const fresh = NOW_MS - 47 * 60 * 60 * 1000;
    const { decision } = evaluateSshRunWorkspaceRetention(candidate({ newestMtimeMs: fresh }), POLICY, NOW_MS);
    expect(decision).toEqual({ outcome: "KEEP", reason: "too_recent" });
  });

  it("SKIPs when process references are unverified and KEEPS unproven-git or protected content", () => {
    expect(
      evaluateSshRunWorkspaceRetention(
        candidate({ eligibility: { ...FULL_ELIGIBILITY, processReferencesAbsent: false } }),
        POLICY,
        NOW_MS,
      ).decision,
    ).toEqual({ outcome: "SKIP", reason: "process_references_unverified" });
    // Dirty worktree, stash, HEAD not on a verified remote, shallow clone,
    // external gitdir, live worktree: the caller classifies these as one
    // unproven-recoverability verdict and the payload is kept.
    expect(
      evaluateSshRunWorkspaceRetention(candidate({ eligibility: { ...FULL_ELIGIBILITY, gitRecoverable: false } }), POLICY, NOW_MS)
        .decision,
    ).toEqual({ outcome: "KEEP", reason: "git_not_proven_recoverable" });
    expect(
      evaluateSshRunWorkspaceRetention(
        candidate({ eligibility: { ...FULL_ELIGIBILITY, protectedContentAbsent: false } }),
        POLICY,
        NOW_MS,
      ).decision,
    ).toEqual({ outcome: "KEEP", reason: "protected_adapter_content" });
  });

  it("holds quarantined payloads for the quarantine window, then marks DELETE_ELIGIBLE after the same checks", () => {
    const quarantinedAtMs = NOW_MS - 6 * 24 * 60 * 60 * 1000;
    expect(
      evaluateSshRunWorkspaceRetention(candidate({ quarantinedAtMs }), POLICY, NOW_MS).decision,
    ).toEqual({ outcome: "KEEP", reason: "quarantine_hold" });
    const expiredAtMs = NOW_MS - 7 * 24 * 60 * 60 * 1000;
    expect(
      evaluateSshRunWorkspaceRetention(candidate({ quarantinedAtMs: expiredAtMs }), POLICY, NOW_MS).decision,
    ).toEqual({ outcome: "DELETE_ELIGIBLE", reason: "quarantine_expired" });
    // The 7-day re-check still requires a settled issue: an issue reopened
    // during quarantine keeps the payload.
    expect(
      evaluateSshRunWorkspaceRetention(
        candidate({ quarantinedAtMs: expiredAtMs, eligibility: { ...FULL_ELIGIBILITY, issueResolved: "in_progress" } }),
        POLICY,
        NOW_MS,
      ).decision,
    ).toEqual({ outcome: "SKIP", reason: "issue_unresolved" });
  });

  it("keys decisions by run, generation, and policy revision", () => {
    const first = evaluateSshRunWorkspaceRetention(candidate({ generation: "g1" }), POLICY, NOW_MS);
    const second = evaluateSshRunWorkspaceRetention(candidate({ generation: "g2" }), POLICY, NOW_MS);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(first.idempotencyKey).toContain("11111111-1111-4111-8111-111111111111");
    expect(first.idempotencyKey).toContain(POLICY.policyRevision);
  });
});

describe("planSshRunWorkspaceRetentionBatch", () => {
  function batchCandidate(runId: string, newestMtimeMs: number, bytes = 1024): SshRunRetentionCandidate {
    return candidate({ runId, newestMtimeMs, bytes });
  }

  it("processes the oldest candidates first and caps the batch at maxBatchDirs", () => {
    const candidates = [1, 2, 3, 4, 5, 6, 7].map((index) =>
      batchCandidate(`run-${index}`, OLD_MS + index * 1000),
    );
    const plan = planSshRunWorkspaceRetentionBatch({ candidates, policy: POLICY, nowMs: NOW_MS });
    const processed = plan.entries.map((entry) => entry.runId);
    expect(processed).toEqual(["run-1", "run-2", "run-3", "run-4", "run-5"]);
    expect(plan.deferred).toContainEqual({ runId: "run-6", reason: "batch_dir_limit" });
    expect(plan.deferred).toContainEqual({ runId: "run-7", reason: "batch_dir_limit" });
  });

  it("caps cumulative bytes and defers oversize directories to on-demand", () => {
    const policy: SshRunWorkspaceRetentionPolicy = { ...POLICY, maxBatchBytes: 2500 };
    const candidates = [
      batchCandidate("small-1", OLD_MS, 1000),
      batchCandidate("small-2", OLD_MS + 1000, 1000),
      batchCandidate("small-3", OLD_MS + 2000, 1000), // would exceed 2500
      batchCandidate("huge", OLD_MS - 1000, 5000), // older, but oversize
    ];
    const plan = planSshRunWorkspaceRetentionBatch({ candidates, policy, nowMs: NOW_MS });
    expect(plan.deferred).toContainEqual({ runId: "huge", reason: "oversize_on_demand" });
    expect(plan.entries.map((entry) => entry.runId)).toEqual(["small-1", "small-2"]);
    expect(plan.deferred).toContainEqual({ runId: "small-3", reason: "batch_byte_limit" });
  });

  it("stops when the time budget is exhausted", () => {
    const candidates = [1, 2].map((index) => batchCandidate(`run-${index}`, OLD_MS + index));
    const plan = planSshRunWorkspaceRetentionBatch({
      candidates,
      policy: POLICY,
      nowMs: NOW_MS,
      elapsedMs: POLICY.timeBudgetMs,
    });
    expect(plan.entries).toEqual([]);
    expect(plan.deferred).toEqual([
      { runId: "run-1", reason: "time_budget" },
      { runId: "run-2", reason: "time_budget" },
    ]);
  });

  it("replays idempotent receipts for unchanged candidates without re-deciding or duplicating", () => {
    const target = batchCandidate("replayed-run", OLD_MS, 2048);
    const receipts: SshRunRetentionReceipt[] = [
      {
        idempotencyKey: `ssh-run-retention:${POLICY.policyRevision}:replayed-run:none`,
        runId: "replayed-run",
        policyRevision: POLICY.policyRevision,
        outcome: "KEEP",
        reason: "git_not_proven_recoverable",
        decidedAtMs: NOW_MS - 1000,
        bytes: 2048,
      },
    ];
    // Even with full positive eligibility now available, the recorded
    // decision stands until the candidate changes.
    const plan = planSshRunWorkspaceRetentionBatch({ candidates: [target], policy: POLICY, nowMs: NOW_MS, receipts });
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].replayed).toBe(true);
    expect(plan.entries[0].decision).toEqual({ outcome: "KEEP", reason: "git_not_proven_recoverable" });
    // A changed byte size invalidates the receipt and re-decides.
    const grown = { ...target, bytes: 4096 };
    const replan = planSshRunWorkspaceRetentionBatch({ candidates: [grown], policy: POLICY, nowMs: NOW_MS, receipts });
    expect(replan.entries[0].replayed).toBe(false);
    expect(replan.entries[0].decision).toEqual({ outcome: "QUARANTINE_ELIGIBLE", reason: "eligible" });
    // Deterministic replay: concurrent finalizers produce the same plan.
    const again = planSshRunWorkspaceRetentionBatch({ candidates: [target], policy: POLICY, nowMs: NOW_MS, receipts });
    expect(again.entries[0].idempotencyKey).toBe(plan.entries[0].idempotencyKey);
    expect(again.entries[0].decision).toEqual(plan.entries[0].decision);
  });
});

describe("sweepSshRunWorkspacesMetadataOnly (local fixture)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function createRunsRoot(entries: Array<{ runId: string; ageHours: number; files?: number; bytesPerFile?: number }>) {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-run-retention-"));
    cleanupDirs.push(runsRoot);
    for (const entry of entries) {
      const dir = path.join(runsRoot, entry.runId);
      await mkdir(dir, { recursive: true });
      const fileCount = entry.files ?? 2;
      const bytesPerFile = entry.bytesPerFile ?? 1024;
      for (let index = 0; index < fileCount; index += 1) {
        await writeFile(path.join(dir, `part-${index}.bin`), Buffer.alloc(bytesPerFile, 1));
      }
      const stamp = new Date(NOW_MS - entry.ageHours * 60 * 60 * 1000);
      await utimes(dir, stamp, stamp);
      await utimes(path.join(dir, "part-0.bin"), stamp, stamp);
    }
    return runsRoot;
  }

  const localListing = (runsRoot: string) => ({
    listNames: () => listLocalRunWorkspaceNames({ runsRoot }),
    listSizes: (runIds: string[]) => sizeLocalRunWorkspaces({ runsRoot, runIds }),
  });

  it("performs no scan at all when disabled", async () => {
    const runsRoot = await createRunsRoot([{ runId: "run-a", ageHours: 96 }]);
    const manifest = await sweepSshRunWorkspacesMetadataOnly({
      spec: { host: "unused", port: 1, username: "u", remoteWorkspacePath: "/x", remoteCwd: "/x", privateKey: null, knownHosts: null, strictHostKeyChecking: false },
      runsRoot,
      policy: { ...DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY, enabled: false },
      now: () => NOW_MS,
    });
    // The disabled policy returns before any listing: no ssh command is built
    // or attempted (the spec points at an unreachable host on purpose).
    expect(manifest.mode).toBe("disabled");
    expect(manifest.decisions).toEqual([]);
    expect(manifest.notes).toContain("retention disabled: no scan performed");
  });

  it("reports SKIP api_incomplete without an eligibility provider and excludes the current run", async () => {
    const runsRoot = await createRunsRoot([
      { runId: "current-run", ageHours: 1 },
      { runId: "old-run-1", ageHours: 96 },
      { runId: "old-run-2", ageHours: 72 },
    ]);
    const manifest = await sweepSshRunWorkspacesMetadataOnly({
      spec: { host: "unused", port: 1, username: "u", remoteWorkspacePath: "/x", remoteCwd: "/x", privateKey: null, knownHosts: null, strictHostKeyChecking: false },
      runsRoot,
      policy: POLICY,
      now: () => NOW_MS,
      excludeRunIds: ["current-run"],
      ...localListing(runsRoot),
    });
    expect(manifest.mode).toBe("dry-run");
    expect(manifest.decisions.map((entry) => entry.runId).sort()).toEqual(["old-run-1", "old-run-2"]);
    for (const entry of manifest.decisions) {
      expect(entry.outcome).toBe("SKIP");
      expect(entry.reason).toBe("api_incomplete");
    }
    expect(manifest.notes).toContain("no eligibility provider: every new decision is SKIP api_incomplete by design");
  });

  it("uses supplied eligibility evidence and never touches the fixture trees beyond stat", async () => {
    const runsRoot = await createRunsRoot([
      { runId: "eligible-run", ageHours: 96, files: 8, bytesPerFile: 4096 },
      { runId: "dirty-git-run", ageHours: 96 },
    ]);
    const manifest = await sweepSshRunWorkspacesMetadataOnly({
      spec: { host: "unused", port: 1, username: "u", remoteWorkspacePath: "/x", remoteCwd: "/x", privateKey: null, knownHosts: null, strictHostKeyChecking: false },
      runsRoot,
      policy: POLICY,
      now: () => NOW_MS,
      ...localListing(runsRoot),
      eligibility: async (entry) =>
        entry.runId === "eligible-run" ? FULL_ELIGIBILITY : { ...FULL_ELIGIBILITY, gitRecoverable: false },
    });
    const byRun = new Map(manifest.decisions.map((entry) => [entry.runId, entry]));
    expect(byRun.get("eligible-run")).toMatchObject({ outcome: "QUARANTINE_ELIGIBLE", reason: "eligible" });
    expect(byRun.get("dirty-git-run")).toMatchObject({ outcome: "KEEP", reason: "git_not_proven_recoverable" });
    // Dry-run means dry-run: the trees still exist, untouched.
    await expect(stat(path.join(runsRoot, "eligible-run"))).resolves.toBeTruthy();
  });
});
