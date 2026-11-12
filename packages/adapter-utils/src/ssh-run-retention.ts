import { promises as fs } from "node:fs";
import path from "node:path";
import { runSshCommand, type SshRemoteExecutionSpec } from "./ssh.js";

/**
 * Retention of per-run SSH workspace copies
 * (`<remoteCwd>/.paperclip-runtime/runs/<runId>`), in dry-run form.
 *
 * First version, by design:
 * - Disabled by default; `mode` is `"dry-run"` only. There is no code path
 *   that renames, quarantines, or deletes anything. The evaluator produces
 *   decisions and receipts; executing them is future work that requires its
 *   own authorization, a shared native claim, proven quarantine/restore, and
 *   symlink/mount/device/inode guards.
 * - Policy is separate from the algorithm. The defaults below are the
 *   proposed pilot values, not existing settings.
 * - Eligibility is evidence-based and defaults to "unverified". An adapter
 *   lane cannot prove eligibility (no Paperclip API access), so its dry-run
 *   manifest reports every candidate as SKIP `api_incomplete`. Only a caller
 *   that supplies full evidence (a server-side service) can reach
 *   QUARANTINE_ELIGIBLE.
 */

export const SSH_RUN_WORKSPACE_RETENTION_POLICY_REVISION = "1";

export const DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY = {
  enabled: false,
  mode: "dry-run",
  minAgeHours: 48,
  maxBatchDirs: 5,
  maxBatchBytes: 1024 * 1024 * 1024,
  timeBudgetMs: 30_000,
  minQuarantineDays: 7,
  runsWithoutIssue: "protected",
  policyRevision: SSH_RUN_WORKSPACE_RETENTION_POLICY_REVISION,
} as const;

export type SshRunWorkspaceRetentionPolicy = {
  enabled: boolean;
  mode: "dry-run";
  minAgeHours: number;
  maxBatchDirs: number;
  maxBatchBytes: number;
  timeBudgetMs: number;
  minQuarantineDays: number;
  runsWithoutIssue: "protected";
  policyRevision: string;
};

/**
 * Structured eligibility evidence for one candidate. Every field defaults to
 * unverified; the evaluator fails safe (SKIP when a decision cannot be made,
 * KEEP when the data may still be needed).
 */
export interface SshRunRetentionEligibility {
  /** Paperclip API reachable and the run record was read completely. */
  apiComplete: boolean;
  /** Run is in a settled terminal status. */
  runTerminal: boolean;
  /** workspace finalization receipts settled: no lease, retry, or recovery. */
  finalizationSettled: boolean;
  /**
   * Resolved issue outcome. `"done"` and `"cancelled"` count as resolved;
   * `null` means the run has no issue; any other string is an unresolved
   * issue and keeps the payload.
   */
  issueResolved: string | null;
  issueGenerationUnchanged: boolean;
  workspaceGenerationUnchanged: boolean;
  /** No process holds a cwd/fd/root on the tree (verified, not assumed). */
  processReferencesAbsent: boolean;
  /**
   * Git is provably recoverable: clean tracked files, no untracked output
   * left behind, no stash, HEAD and refs recoverable from a verified durable
   * remote, no shallow-clone gaps, no external gitdir, no live worktrees.
   */
  gitRecoverable: boolean;
  /** No adapter HOME/XDG/session/managed-auth content lacking a proven backup. */
  protectedContentAbsent: boolean;
}

export type SshRunRetentionEligibilityInput = Partial<SshRunRetentionEligibility>;

export interface SshRunRetentionCandidate {
  runId: string;
  generation?: string | null;
  bytes: number;
  newestMtimeMs: number;
  quarantinedAtMs?: number | null;
  eligibility?: SshRunRetentionEligibilityInput;
}

export type SshRunRetentionDecision =
  | { outcome: "KEEP"; reason: string }
  | { outcome: "SKIP"; reason: string }
  | { outcome: "QUARANTINE_ELIGIBLE"; reason: string }
  | { outcome: "DELETE_ELIGIBLE"; reason: string };

export interface SshRunRetentionReceipt {
  idempotencyKey: string;
  runId: string;
  policyRevision: string;
  outcome: SshRunRetentionDecision["outcome"];
  reason: string;
  decidedAtMs: number;
  bytes: number;
  generation?: string | null;
}

export function sshRunRetentionIdempotencyKey(input: {
  runId: string;
  generation?: string | null;
  policyRevision: string;
}): string {
  return `ssh-run-retention:${input.policyRevision}:${input.runId}:${input.generation ?? "none"}`;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function parseSshRunWorkspaceRetentionPolicy(value: unknown): SshRunWorkspaceRetentionPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  // First version: dry-run only. Anything else is rejected (fail closed),
  // so an execution mode can never be enabled by accident.
  if (raw.mode !== undefined && raw.mode !== "dry-run") return null;
  if (raw.runsWithoutIssue !== undefined && raw.runsWithoutIssue !== "protected") return null;
  const numberOr = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
  return {
    enabled: raw.enabled === true,
    mode: "dry-run",
    minAgeHours: numberOr(raw.minAgeHours, DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY.minAgeHours),
    maxBatchDirs: Math.floor(numberOr(raw.maxBatchDirs, DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY.maxBatchDirs)),
    maxBatchBytes: numberOr(raw.maxBatchBytes, DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY.maxBatchBytes),
    timeBudgetMs: numberOr(raw.timeBudgetMs, DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY.timeBudgetMs),
    minQuarantineDays: numberOr(raw.minQuarantineDays, DEFAULT_SSH_RUN_WORKSPACE_RETENTION_POLICY.minQuarantineDays),
    runsWithoutIssue: "protected",
    policyRevision:
      typeof raw.policyRevision === "string" && raw.policyRevision.length > 0
        ? raw.policyRevision
        : SSH_RUN_WORKSPACE_RETENTION_POLICY_REVISION,
  };
}

/**
 * Pure eligibility evaluation. Check order is the conservative order:
 * anything that makes a decision impossible produces SKIP; anything that
 * suggests the payload may still be needed produces KEEP. Only fully
 * evidenced, terminal, recoverable, aged-out candidates are eligible.
 */
export function evaluateSshRunWorkspaceRetention(
  candidate: SshRunRetentionCandidate,
  policy: SshRunWorkspaceRetentionPolicy,
  nowMs: number,
): { decision: SshRunRetentionDecision; idempotencyKey: string } {
  const idempotencyKey = sshRunRetentionIdempotencyKey({
    runId: candidate.runId,
    generation: candidate.generation,
    policyRevision: policy.policyRevision,
  });
  const eligibility: SshRunRetentionEligibilityInput = candidate.eligibility ?? {};

  const decide = (decision: SshRunRetentionDecision): { decision: SshRunRetentionDecision; idempotencyKey: string } => ({
    decision,
    idempotencyKey,
  });

  if (eligibility.apiComplete !== true) return decide({ outcome: "SKIP", reason: "api_incomplete" });
  if (eligibility.runTerminal !== true) return decide({ outcome: "SKIP", reason: "run_not_terminal" });
  if (eligibility.finalizationSettled !== true) return decide({ outcome: "SKIP", reason: "finalization_unsettled" });
  if (eligibility.issueResolved === null) {
    // First version protects runs without an issue, however large.
    return decide({ outcome: "KEEP", reason: "protected_run_without_issue" });
  }
  if (eligibility.issueResolved === undefined) return decide({ outcome: "SKIP", reason: "issue_state_unknown" });
  if (eligibility.issueResolved !== "done" && eligibility.issueResolved !== "cancelled") {
    return decide({ outcome: "SKIP", reason: "issue_unresolved" });
  }
  if (eligibility.issueGenerationUnchanged !== true) {
    return decide({ outcome: "SKIP", reason: "issue_generation_changed" });
  }
  if (eligibility.workspaceGenerationUnchanged !== true) {
    return decide({ outcome: "SKIP", reason: "workspace_generation_changed" });
  }

  const ageMs = nowMs - candidate.newestMtimeMs;
  if (ageMs < policy.minAgeHours * HOUR_MS) return decide({ outcome: "KEEP", reason: "too_recent" });

  if (eligibility.processReferencesAbsent !== true) {
    return decide({ outcome: "SKIP", reason: "process_references_unverified" });
  }
  if (eligibility.gitRecoverable !== true) {
    return decide({ outcome: "KEEP", reason: "git_not_proven_recoverable" });
  }
  if (eligibility.protectedContentAbsent !== true) {
    return decide({ outcome: "KEEP", reason: "protected_adapter_content" });
  }

  if (typeof candidate.quarantinedAtMs === "number") {
    const quarantinedForMs = nowMs - candidate.quarantinedAtMs;
    if (quarantinedForMs >= policy.minQuarantineDays * DAY_MS) {
      return decide({ outcome: "DELETE_ELIGIBLE", reason: "quarantine_expired" });
    }
    return decide({ outcome: "KEEP", reason: "quarantine_hold" });
  }
  return decide({ outcome: "QUARANTINE_ELIGIBLE", reason: "eligible" });
}

export interface SshRunRetentionBatchPlanInput {
  candidates: SshRunRetentionCandidate[];
  policy: SshRunWorkspaceRetentionPolicy;
  nowMs: number;
  receipts?: SshRunRetentionReceipt[];
  /** Already-consumed budget (ms) before this batch starts. */
  elapsedMs?: number;
}

export interface SshRunRetentionBatchEntry {
  runId: string;
  candidate: SshRunRetentionCandidate;
  decision: SshRunRetentionDecision;
  idempotencyKey: string;
  replayed: boolean;
}

export interface SshRunRetentionBatchDeferral {
  runId: string;
  reason: "batch_dir_limit" | "batch_byte_limit" | "time_budget" | "oversize_on_demand";
}

export interface SshRunRetentionBatchPlan {
  entries: SshRunRetentionBatchEntry[];
  deferred: SshRunRetentionBatchDeferral[];
  plannedBytes: number;
}

/**
 * Plans one retention batch: oldest candidates first, capped by directory
 * count, cumulative bytes, and the remaining time budget. An idempotent receipt
 * for an unchanged candidate (same key, same bytes, same generation) replays
 * the recorded decision instead of re-deciding, so concurrent finalizers and
 * crash-replay produce identical, non-duplicated plans.
 *
 * The planner is pure and synchronous, so it does not measure time itself:
 * the caller passes the real elapsed time (`now()` readings taken before
 * planning and between eligibility calls) and every candidate is deferred
 * with `time_budget` once that elapsed time has consumed the policy budget.
 */
export function planSshRunWorkspaceRetentionBatch(input: SshRunRetentionBatchPlanInput): SshRunRetentionBatchPlan {
  const { policy, nowMs } = input;
  const receiptsByKey = new Map((input.receipts ?? []).map((receipt) => [receipt.idempotencyKey, receipt]));
  const sorted = [...input.candidates].sort((a, b) => a.newestMtimeMs - b.newestMtimeMs);

  const entries: SshRunRetentionBatchEntry[] = [];
  const deferred: SshRunRetentionBatchDeferral[] = [];
  let plannedBytes = 0;
  const elapsedMs = input.elapsedMs ?? 0;

  for (const candidate of sorted) {
    const idempotencyKey = sshRunRetentionIdempotencyKey({
      runId: candidate.runId,
      generation: candidate.generation,
      policyRevision: policy.policyRevision,
    });
    if (elapsedMs >= policy.timeBudgetMs) {
      deferred.push({ runId: candidate.runId, reason: "time_budget" });
      continue;
    }
    const receipt = receiptsByKey.get(idempotencyKey);
    if (receipt && receipt.bytes === candidate.bytes && (receipt.generation ?? null) === (candidate.generation ?? null)) {
      // Idempotent replay: the recorded decision stands, no new decision is
      // produced and no batch capacity is consumed beyond the listing.
      entries.push({
        runId: candidate.runId,
        candidate,
        decision: { outcome: receipt.outcome, reason: receipt.reason },
        idempotencyKey,
        replayed: true,
      });
      continue;
    }
    if (entries.filter((entry) => !entry.replayed).length >= policy.maxBatchDirs) {
      deferred.push({ runId: candidate.runId, reason: "batch_dir_limit" });
      continue;
    }
    if (candidate.bytes > policy.maxBatchBytes) {
      // A single directory larger than the whole batch budget is never
      // processed inline; it waits for an explicit on-demand operation.
      deferred.push({ runId: candidate.runId, reason: "oversize_on_demand" });
      continue;
    }
    if (plannedBytes + candidate.bytes > policy.maxBatchBytes) {
      deferred.push({ runId: candidate.runId, reason: "batch_byte_limit" });
      continue;
    }
    const { decision } = evaluateSshRunWorkspaceRetention(candidate, policy, nowMs);
    entries.push({ runId: candidate.runId, candidate, decision, idempotencyKey, replayed: false });
    plannedBytes += candidate.bytes;
  }

  return { entries, deferred, plannedBytes };
}

export interface SshRunWorkspaceMetadata {
  runId: string;
  bytes: number;
  newestMtimeMs: number;
}

function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseSshMetadataListing(stdout: string): Array<{ runId: string; newestMtimeMs: number }> {
  const entries: Array<{ runId: string; newestMtimeMs: number }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.lastIndexOf("\t");
    if (separator <= 0) continue;
    const runId = trimmed.slice(0, separator);
    const mtimeSeconds = Number(trimmed.slice(separator + 1));
    if (runId.includes("/") || runId === "." || runId === "..") continue;
    if (!Number.isFinite(mtimeSeconds)) continue;
    entries.push({ runId, newestMtimeMs: Math.floor(mtimeSeconds * 1000) });
  }
  return entries;
}

function parseSshByteListing(stdout: string): Map<string, number> {
  const byRun = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.lastIndexOf("\t");
    if (separator <= 0) continue;
    const bytes = Number(trimmed.slice(0, separator));
    const target = trimmed.slice(separator + 1);
    const runId = path.posix.basename(target);
    if (Number.isFinite(bytes)) byRun.set(runId, bytes);
  }
  return byRun;
}

/** Metadata-only name/mtime listing of run workspaces over SSH. */
export async function listSshRunWorkspaceNames(input: {
  spec: SshRemoteExecutionSpec;
  runsRoot: string;
  timeoutMs?: number;
}): Promise<Array<{ runId: string; newestMtimeMs: number }>> {
  const listing = await runSshCommand(
    input.spec,
    `find ${shellQuotePosix(input.runsRoot)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\t%T@\\n' 2>/dev/null | sort`,
    { timeoutMs: input.timeoutMs ?? 30_000, maxBuffer: 1024 * 1024 },
  );
  return parseSshMetadataListing(listing.stdout);
}

/** Byte sizes for a bounded shortlist of run workspaces over SSH (`du -sb`). */
export async function sizeSshRunWorkspaces(input: {
  spec: SshRemoteExecutionSpec;
  runsRoot: string;
  runIds: string[];
  timeoutMs?: number;
}): Promise<Map<string, number>> {
  if (input.runIds.length === 0) return new Map();
  const targets = input.runIds.map((runId) => shellQuotePosix(path.posix.join(input.runsRoot, runId)));
  const byteListing = await runSshCommand(
    input.spec,
    `du -sb ${targets.join(" ")} 2>/dev/null || true`,
    { timeoutMs: input.timeoutMs ?? 30_000, maxBuffer: 1024 * 1024 },
  );
  return parseSshByteListing(byteListing.stdout);
}

/** Local (fixture/test) variant: name/mtime listing. */
export async function listLocalRunWorkspaceNames(input: {
  runsRoot: string;
}): Promise<Array<{ runId: string; newestMtimeMs: number }>> {
  const entries = await fs.readdir(input.runsRoot, { withFileTypes: true }).catch(() => []);
  const result: Array<{ runId: string; newestMtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stat = await fs.stat(path.join(input.runsRoot, entry.name)).catch(() => null);
    if (stat) result.push({ runId: entry.name, newestMtimeMs: stat.mtimeMs });
  }
  return result.sort((a, b) => a.newestMtimeMs - b.newestMtimeMs);
}

/** Local (fixture/test) variant: byte sizes for a shortlist. */
export async function sizeLocalRunWorkspaces(input: {
  runsRoot: string;
  runIds: string[];
}): Promise<Map<string, number>> {
  const byRun = new Map<string, number>();
  const walk = async (dir: string): Promise<number> => {
    const stats = await fs.lstat(dir).catch(() => null);
    if (!stats) return 0;
    let total = stats.blocks * 512;
    if (stats.isDirectory()) {
      for (const name of await fs.readdir(dir).catch(() => [])) {
        total += await walk(path.join(dir, name));
      }
    }
    return total;
  };
  for (const runId of input.runIds) {
    byRun.set(runId, await walk(path.join(input.runsRoot, runId)));
  }
  return byRun;
}

export interface SshRunWorkspaceRetentionManifest {
  mode: "dry-run" | "disabled";
  policyRevision: string;
  runsRoot: string;
  scannedAtMs: number;
  /** Measured sweep duration (ms): `now()` readings, not estimates. */
  elapsedMs: number;
  scanned: number;
  plannedBytes: number;
  decisions: Array<{
    runId: string;
    bytes: number;
    newestMtimeMs: number;
    outcome: SshRunRetentionDecision["outcome"];
    reason: string;
    idempotencyKey: string;
    replayed: boolean;
  }>;
  deferred: SshRunRetentionBatchDeferral[];
  notes: string[];
}

/**
 * Read-only dry-run sweep of a runs root. Lists metadata, sizes only the
 * oldest-first shortlist, evaluates one small batch, and returns a manifest.
 * Never writes — no receipts, no renames, no deletions. Candidates without
 * an eligibility provider (the adapter-lane case) are reported as SKIP
 * `api_incomplete` by design.
 *
 * The policy time budget is enforced with real `now()` measurements taken
 * before planning and between eligibility calls: SSH command timeouts are
 * clamped to the remaining budget, and candidates are deferred with
 * `time_budget` (never silently decided) once it is exhausted.
 */
export async function sweepSshRunWorkspacesMetadataOnly(input: {
  spec: SshRemoteExecutionSpec;
  runsRoot: string;
  policy: SshRunWorkspaceRetentionPolicy;
  now?: () => number;
  receipts?: SshRunRetentionReceipt[];
  excludeRunIds?: string[];
  eligibility?: (candidate: SshRunWorkspaceMetadata) => Promise<SshRunRetentionEligibilityInput>;
  listNames?: () => Promise<Array<{ runId: string; newestMtimeMs: number }>>;
  listSizes?: (runIds: string[]) => Promise<Map<string, number>>;
}): Promise<SshRunWorkspaceRetentionManifest> {
  const now = input.now ?? Date.now;
  const startedAtMs = now();
  const elapsedMs = () => now() - startedAtMs;
  const remainingBudgetMs = () => input.policy.timeBudgetMs - elapsedMs();
  // Clamp every SSH command to the remaining budget (at least 1 ms so a
  // nearly-spent budget surfaces as a command failure rather than a hang).
  const clampTimeoutMs = (fallbackMs: number) => Math.max(1, Math.min(fallbackMs, remainingBudgetMs()));
  if (!input.policy.enabled) {
    return {
      mode: "disabled",
      policyRevision: input.policy.policyRevision,
      runsRoot: input.runsRoot,
      scannedAtMs: startedAtMs,
      elapsedMs: 0,
      scanned: 0,
      plannedBytes: 0,
      decisions: [],
      deferred: [],
      notes: ["retention disabled: no scan performed"],
    };
  }
  if (input.policy.mode !== "dry-run") {
    throw new Error("ssh run workspace retention supports dry-run mode only in this version");
  }
  const listNames =
    input.listNames ?? (() => listSshRunWorkspaceNames({ spec: input.spec, runsRoot: input.runsRoot, timeoutMs: clampTimeoutMs(30_000) }));
  const listSizes =
    input.listSizes ??
    ((runIds: string[]) => sizeSshRunWorkspaces({ spec: input.spec, runsRoot: input.runsRoot, runIds, timeoutMs: clampTimeoutMs(30_000) }));
  const excluded = new Set(input.excludeRunIds ?? []);
  const notes: string[] = [];
  const budgetDeferred: SshRunRetentionBatchDeferral[] = [];

  if (remainingBudgetMs() <= 0) {
    return {
      mode: "dry-run",
      policyRevision: input.policy.policyRevision,
      runsRoot: input.runsRoot,
      scannedAtMs: startedAtMs,
      elapsedMs: elapsedMs(),
      scanned: 0,
      plannedBytes: 0,
      decisions: [],
      deferred: [],
      notes: ["time budget exhausted before the metadata scan: nothing scanned"],
    };
  }

  // Metadata-first: names and mtimes for everything, then bytes only for the
  // bounded shortlist (oldest first, ~2x the batch cap so the byte and time
  // limits still have candidates to work with).
  const names = await listNames();
  const candidates = names.filter((entry) => !excluded.has(entry.runId)).sort((a, b) => a.newestMtimeMs - b.newestMtimeMs);
  const shortlist = candidates
    .slice(0, Math.max(input.policy.maxBatchDirs * 2, input.policy.maxBatchDirs))
    .map((entry) => entry.runId);
  let sizes = new Map<string, number>();
  if (remainingBudgetMs() > 0) {
    sizes = await listSizes(shortlist);
  } else {
    notes.push("time budget exhausted before sizing: shortlist deferred");
    for (const runId of shortlist) {
      budgetDeferred.push({ runId, reason: "time_budget" });
    }
  }
  const sizedCandidates: SshRunRetentionCandidate[] = [];
  for (const entry of candidates) {
    const bytes = sizes.get(entry.runId);
    if (bytes === undefined) continue;
    sizedCandidates.push({ runId: entry.runId, bytes, newestMtimeMs: entry.newestMtimeMs });
  }

  // Resolve eligibility for the shortlist before planning so each decision is
  // taken once, with evidence. Replay receipts keep their recorded decision.
  // The clock is re-read between calls: once the budget is spent, the
  // remaining candidates are deferred rather than decided on stale time.
  const eligibilityByRun = new Map<string, SshRunRetentionEligibilityInput>();
  const plannableCandidates: SshRunRetentionCandidate[] = [];
  for (const candidate of sizedCandidates) {
    if (input.eligibility && remainingBudgetMs() <= 0) {
      budgetDeferred.push({ runId: candidate.runId, reason: "time_budget" });
      continue;
    }
    if (input.eligibility) {
      eligibilityByRun.set(candidate.runId, await input.eligibility(candidate));
    }
    plannableCandidates.push(candidate);
  }
  const evidenceCandidates: SshRunRetentionCandidate[] = plannableCandidates.map((candidate) => ({
    ...candidate,
    eligibility: eligibilityByRun.get(candidate.runId) ?? {},
  }));

  const plan = planSshRunWorkspaceRetentionBatch({
    candidates: evidenceCandidates,
    policy: input.policy,
    nowMs: now(),
    receipts: input.receipts,
    elapsedMs: elapsedMs(),
  });

  return {
    mode: "dry-run",
    policyRevision: input.policy.policyRevision,
    runsRoot: input.runsRoot,
    scannedAtMs: startedAtMs,
    elapsedMs: elapsedMs(),
    scanned: names.length,
    plannedBytes: plan.plannedBytes,
    decisions: plan.entries.map((entry) => ({
      runId: entry.runId,
      bytes: entry.candidate.bytes,
      newestMtimeMs: entry.candidate.newestMtimeMs,
      outcome: entry.decision.outcome,
      reason: entry.decision.reason,
      idempotencyKey: entry.idempotencyKey,
      replayed: entry.replayed,
    })),
    deferred: [...budgetDeferred, ...plan.deferred],
    notes: input.eligibility ? notes : [...notes, "no eligibility provider: every new decision is SKIP api_incomplete by design"],
  };
}
