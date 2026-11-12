# @paperclipai/adapter-utils

Shared utilities for Paperclip adapters: process spawning, environment
injection, sandbox/SSH transport, workspace sync, and the round-trip helpers
that move code between the local execution-workspace cwd and wherever the
agent actually runs.

For the adapter-author guide see
[`docs/adapters/creating-an-adapter.md`](../../docs/adapters/creating-an-adapter.md)
and the in-repo notes at [`packages/adapters/AUTHORING.md`](../adapters/AUTHORING.md).

## Sandbox bridge deadlines

Command-managed bridge control operations (queue reads, input delivery, setup,
and cleanup) have a host-enforced deadline of at most 30 seconds per shell
command. A shorter configured timeout still applies. These operations cannot
inherit the agent run's hours-long lifetime or wait forever on a provider that
ignores its timeout. Long-lived agent session commands keep their own limits.

A control timeout reports a transport failure. It does not prove that the
remote command stopped and does not replay an uncertain write. The process
session closes failed input delivery and uses its existing shutdown path;
normal execution settlement must still verify termination.

## Native archive transfer deadlines

Native `syncIn` and `syncOut` calls accept an optional `minimumTimeoutMs` budget. The
server validates this budget and extends the worker RPC deadline. Providers can
honor this field for file transfers without changing their configuration. Daytona
uses the larger of this minimum and its configured timeout. Other providers keep
their existing behavior. The minimum is limited to 30 minutes and does not change
sandbox lifetimes, stored settings or the timeout for other commands.

The remote-workspace archive path uses the verified capture size for downloads
and the local archive size for uploads. Large archives get one second per MiB
plus 60 seconds, capped at 30 minutes. Small archives keep the existing provider
timeout when that calculation is no greater than five minutes. Archive size,
checksum, confinement and host space checks still apply.

An exact retained-sandbox resume keeps its recorded provider timeout and RPC
overhead. It uses the normal one-minute fallback only when no timeout was
recorded. A five-minute cold restore must not be cut off by that fallback.
Resume still targets the recorded allocation and does not acquire a replacement.

## No-remote-git contract

The local execution-workspace cwd is the only persistence boundary across
runs. No adapter may depend on a git remote for cross-run state.

Adapters that run the agent on a different host should use the SSH round-trip
helpers in [`src/ssh.ts`](./src/ssh.ts):

- `prepareWorkspaceForSshExecution({ spec, localDir, remoteDir })` — bundles
  the local cwd (tracked files, dirty edits, untracked additions, and the git
  history needed to reconstruct it) to `remoteDir` before the run starts. Runs
  with no `git remote` configured.
- `restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir, ... })` —
  syncs the remote cwd back into `localDir` after the run, including any new
  commits the agent created. Also runs with no `git remote` configured.

`prepareRemoteManagedRuntime` in
[`src/remote-managed-runtime.ts`](./src/remote-managed-runtime.ts) wraps both
calls for adapters that want a per-run remote workspace and an automatic
`restoreWorkspace()` finally hook.

The invariant is pinned by the `no-remote-git contract` case in
[`src/ssh-fixture.test.ts`](./src/ssh-fixture.test.ts), which asserts that a
remote-only commit propagates to the local worktree through the
prepare → restore round-trip with no git remote configured at any point. Do
not regress that test.

## Coherent workspace transfer excludes

`prepareWorkspaceForSshExecution` and `prepareRemoteManagedRuntime` accept a
`workspaceExclude` pattern list. The patterns are workspace-relative (absolute
paths, parent-relative `..` segments, empty segments, and patterns containing
a backslash are dropped) and are
interpreted identically on the Git and non-Git paths, in every file mode:

- **upload**: the working-tree overlay (`tar`) skips the excluded paths. On
  the Git path the clean checkout from the imported history still happens
  first; the excludes only remove content from the overlay that would
  otherwise carry local ignored files (`.gitignore` alone does **not** keep
  `node_modules` out of the copy, because the overlay tars the whole tree).
- **baseline**: the restore baseline is captured with exactly the canonical
  exclude list the upload applied — `prepareWorkspaceForSshExecution` returns
  it as `transferExclude` and `prepareRemoteManagedRuntime` uses that
  verbatim.
- **restore**: `mergeDirectoryWithBaseline` only considers files present in
  the baseline, so a file excluded from the upload is never treated as
  deleted-at-restore time and survives restore untouched.

This coherence is the contract: one selection, applied to upload, baseline,
and restore alike. Excludes are a caller-provided policy — no default
dependency/cache excludes are imposed, and patterns should target content
that is provably regenerable or provably irrelevant to the mandate; do not
exclude tracked files or `.git` (both are handled internally).

Only pattern shapes that tar and the baseline matcher
(`excludePatternMatches`) interpret with the same coverage are accepted,
because tar excludes globs while the baseline matches literal rooted paths:

- a **bare literal name** (`node_modules`) is expanded internally to the four
  equivalent forms `node_modules`, `node_modules/*`, `*/node_modules`,
  `*/node_modules/*` — tar matches bare names at any depth, and the expansion
  reproduces exactly that in the baseline matcher;
- **rooted literal paths** (`build/dist`) and the rooted-contents form
  (`build/dist/*`) are applied together with their any-depth companions
  (`*/build/dist`, `*/build/dist/*`): tar excludes are un-anchored by
  default, so these shapes also match nested `pkg/build/dist/...`, and the
  companion keeps the baseline matcher on the same coverage;
- the **any-depth forms** `*/name` and `*/name/*` are applied as-is;
- **any other pattern is dropped** (fail closed): glob patterns such as
  `*.log` or `dist/*.map` are matched by tar but not by the baseline matcher,
  so applying them would delete the matching local files at restore time.
  Patterns containing a backslash are dropped for the same reason: GNU tar
  reads a backslash as an escape (`a\b` matches `ab`, `dist\cache` matches
  `distcache`), while the baseline matcher compares backslashes literally.
  Dropping an exclude only transfers more files; it can never lose data.

Passing `node_modules` alone is therefore sufficient (and equivalent to
listing all four forms); the same holds for `build/dist` or `build/dist/*`
alone — the companions are derived internally. Listing the expanded forms
explicitly is also fine.

## Per-run SSH workspace retention (dry-run, disabled by default)

Each remote-managed run creates `<remoteCwd>/.paperclip-runtime/runs/<runId>`.
Nothing in the round-trip removes those trees afterwards.
[`src/ssh-run-retention.ts`](./src/ssh-run-retention.ts) is the first,
deliberately minimal step towards native retention:

- Policy is separate from the algorithm and is disabled by default; only
  `mode: "dry-run"` is accepted (anything else fails closed). Proposed pilot
  defaults: minimum age 48 h, at most 5 directories and 1 GiB per batch, a
  30 s time budget, a 7-day quarantine before any final deletion, and runs
  without an issue stay protected.
- `evaluateSshRunWorkspaceRetention` turns structured eligibility evidence
  (settled terminal run, settled finalization, resolved issue, unchanged
  generations, no process references, provably recoverable git, no protected
  adapter content, complete API data) into a `KEEP` / `SKIP` /
  `QUARANTINE_ELIGIBLE` / `DELETE_ELIGIBLE` decision. Unverifiable evidence
  produces `SKIP`; possibly-still-needed payloads produce `KEEP`.
- `planSshRunWorkspaceRetentionBatch` bounds one batch and replays idempotent
  receipts (`runId` + generation + policy revision) so concurrent finalizers
  and crash replays do not duplicate decisions.
- `sweepSshRunWorkspacesMetadataOnly` performs a read-only, metadata-only
  scan (`find` + bounded `du`) and returns a manifest. It never writes,
  renames, quarantines, or deletes anything. The policy time budget is
  enforced with real clock readings (`now()` before planning and between
  eligibility calls): SSH command timeouts are clamped to the remaining
  budget, and candidates are deferred with `time_budget` instead of decided
  once it is spent. An adapter-lane sweep has no Paperclip API access, so
  its manifest reports every candidate as `SKIP api_incomplete` by design;
  producing actionable decisions requires a server-side evidence provider,
  and executing them requires a future, separately authorized
  implementation with a shared native claim and proven quarantine/restore.
- `prepareRemoteManagedRuntime` accepts an optional `runRetention` policy and
  runs the sweep after the run's `restoreWorkspace()` completes — the real
  finalization event of the SSH lane — excluding the current run. The sweep
  is best-effort: it can never fail the run it closes.
