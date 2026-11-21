# Fork pull-request CI

The fork calls `pr-trusted.yml` and `ci-routing.yml` locally. GitHub resolves
these reusable workflows from the same commit as the caller, so an upstream
`master` update cannot change the checks for an unchanged fork revision.
Workflow changes require independent review: PR code can change its own CI
definition. Permissions remain read-only, checkout does not retain credentials,
and the routing workflow selects GitHub-hosted runners for this fork. The fork
uses the complete local matrix instead of downloading an upstream planner;
upstream fleet/profiling authorization is not available to fork PRs.

The local Docker context check matches the fork's Dockerfile. It retains the
generated-file drift and Compose secret-forwarding checks. It does not import
an upstream runtime stage that the fork does not ship.

The policy job audits both checked-in lockfiles with `pnpm audit --json`,
including development dependencies, without installation or lifecycle scripts.
It fails on newly affected package/version/advisory/severity combinations,
registry errors, muted findings or incomplete reports. Existing vulnerabilities
remain visible in the retained audit artifacts. Identical lockfiles share one
registry response; this reports an unchanged graph, not a vulnerability-free
project. There is no ignore list, severity waiver or success fallback.
This is an independent vulnerability check, not a claim that GitHub Dependency
Review ran. It does not supply Dependency Review's dependency-diff or license
analysis. The existing `pull_request_target` review workflow remains unchanged
and may still fail because Dependency Review is unsupported on this repository.
It executes the base branch's definition, so a PR cannot repair that check in
its own run. Keep that failure visible when assessing merge readiness.

Runner staging tests compile small, host-native C fixtures using `cc` from
the Linux C/Rust toolchain or macOS developer tools. They deliberately avoid
copying host coreutils: a multicall executable can change behavior after a
rename, and two different utility paths can contain identical bytes.

The native-server lane restores the existing Rust caches, then prepares the
release daemon before starting Vitest. Cold preparation has a 15-minute step
limit; the lane has 35 minutes, retaining its former 20-minute test allowance.
The Dot test's bounded incremental build remains in place, so a missing or
invalid build still fails. Cache misses are expected on a new fork and do not
prove that compilation or lock contention was the original timeout's cause.

The sandbox write-denial test accepts any positive shell exit status, requires
normal process completion, and checks that the outside sentinel is unchanged
before asserting the exit result. A skipped sandbox test is not containment
evidence: run it on a CI worker with Bubblewrap available.

Useful focused verification commands:

```sh
node --test packages/paperclip-runner/scripts/stage-runner-binary.test.mjs
node --test scripts/__tests__/e2e-shard.test.mjs .github/scripts/tests/pr-runner-rust-cache.test.mjs
pnpm exec vitest run --project @paperclipai/server server/src/services/native-runtime/runner-bridge-tools.test.ts
pnpm --filter @paperclipai/paperclip-runner test:typescript:vitest --native-server
```

Full typecheck, build, Docker and native-server acceptance belong on CI workers
with sufficient disk and RAM. Record the exact commit, actual selected suites,
skips and failures. A successful job or a local wiring test does not qualify
unexecuted tests, a different commit, or a combined backport revision.
