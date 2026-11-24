# SSH secret hardening: rollout, verification, rollback (VPS fork)

Status: ready for owner GO. Nothing here is deployed.

## Scope

Production runs `local/paperclip:2026.1106.0-oauth-v3-ssh-cleanup-candidate`
(image id `sha256:608f0708…`). That image is the official `2026.1106.0`
(`d69631b01`) plus two local patches: OAuth `offline_access` (in
`server.mjs`) and the SSH run-workspace cleanup (P2, compiled into the
runtime chunks).

The SSH code of that image lives in one runtime chunk:
`/app/server/dist-runtime/chunk-3ZK6CBQV.mjs`
(sha256 `181ba318…791b`). The fix replaces only that file. No other file,
no database migration, no configuration change.

| Item | Value |
| --- | --- |
| Source branch | `fix/ssh-secret-argv-hardening` (on `prod/2026.1106.0-p2-baseline`) |
| Production chunk sha256 | `181ba3186e722015bd1cbb70fd74eca39e3a266d0660ba1c4ada185b8864791b` |
| Patched chunk sha256 | `763c883ea5c6bb243fbb5d06fc9ee6d0daff5761cb65028620a95aceea93c060` |
| Candidate tag | `local/paperclip:2026.1106.0-oauth-v3-ssh-cleanup-ssh-secret-hardening` |

## 1. Regenerate the patched chunk (optional, reproducibility)

```sh
# esbuild 0.28.2, target node24 (the versions of the runtime bundle)
esbuild packages/adapter-utils/src/ssh.ts --format=esm --platform=node \
  --target=node24 --outfile=$TMPDIR/ssh.fixed.js
python3 -I scripts/vps-ssh-secret-hardening/make-chunk-patch.py \
  <production chunk copy> $TMPDIR/ssh.fixed.js chunk-3ZK6CBQV.mjs
# prints: patched sha256 763c883e…c060
```

`make-chunk-patch.py` refuses any input that is not the production chunk.
It replaces only the declarations the fix changes and fails on a name
collision or on a remaining `exec env` construction.

## 2. Build the candidate (owner, no production change)

```sh
sudo bash scripts/vps-ssh-secret-hardening/owner-build-candidate.sh <staging dir>
```

The script checks the running container and the base image ids, checks both
chunk hashes, builds the overlay image, and verifies in the image that:
only the chunk differs from the base runtime, the chunk parses, the legacy
construction is absent, and the chunk imports with its exports. It ends with
`PRODUCTION_UNCHANGED=OK`.

## 3. Cutover (needs explicit GO)

1. Confirm that no agent run is active (an SSH copy phase must not be cut).
2. Back up the compose files.
3. Set `image:` to the candidate tag in every file that names the current
   image: `/srv/paperclip/compose.yml`, `/srv/paperclip/compose.override.yml`,
   `/srv/paperclip/upgrade-2026.1106.0/override.yml`.
4. Run `docker compose config | grep image:` and confirm the candidate tag.
5. Run `docker compose up -d paperclip`.

## 4. Post-install verification

1. `curl -fsS 127.0.0.1:3100/api/health` returns OK and commit `d69631b01`.
2. `docker inspect -f '{{.Image}}' paperclip-paperclip-1` is the candidate id.
3. `docker exec paperclip-paperclip-1 sha256sum /app/server/dist-runtime/chunk-3ZK6CBQV.mjs`
   is `763c883e…c060`.
4. During a normal agent run (Claude, Codex or OpenCode):
   `sudo python3 -I scripts/vps-ssh-secret-hardening/post-install-probe.py`
   must print `legacy_exec_env=0` and `env_file_wrapper>=1`. The probe prints
   counts only.
5. The run completes and its agent can call the Paperclip API (this proves
   that `PAPERCLIP_API_KEY` reached the remote process).
6. `sudo ls -la /home/paperclip-dev/.paperclip-run-env` shows mode `drwx------`
   and no `*.env` file once no launch is in progress.

## 5. Rollback

The fix changes no data. Rollback is the previous image:

1. Restore the backed-up compose files (or set `image:` back to
   `local/paperclip:2026.1106.0-oauth-v3-ssh-cleanup-candidate`).
2. `docker compose up -d paperclip`.
3. Check `/api/health` and the image id `sha256:608f0708…`.
4. Optional: `sudo rmdir /home/paperclip-dev/.paperclip-run-env`.

A rollback restores the argv exposure.

## 6. Credential follow-up (owner decision)

These values were in `ssh` argv during SSH runs before the fix. Rotate them
after the cutover, not before (a rotated value would leak again):

- each agent's `GH_TOKEN` / `GITHUB_TOKEN` secret;
- `ZHIPU_API_KEY`, `ALIBABA_TOKEN_PLAN_API_KEY`, `HERMES_TELEGRAM_BOT_TOKEN`;
- agent identity key pairs (`PAPERCLIP_AGENT_PRIVATE_KEY`) when the instance
  issues them;
- `PAPERCLIP_API_KEY` run tokens: agent JWTs valid for 48 h
  (`PAPERCLIP_AGENT_JWT_TTL_SECONDS`), not bound to the run's end. Tokens
  minted before the cutover stay valid up to 48 h after it. To end them at
  once, set a new `PAPERCLIP_AGENT_JWT_SECRET` at the cutover restart (no run
  active). Do not rotate `BETTER_AUTH_SECRET` for this: it is the fallback
  signing secret and also ends board sessions.
