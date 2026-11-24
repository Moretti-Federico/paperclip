#!/usr/bin/env bash
# Cut Paperclip production over to the SSH secret-hardening candidate image.
# Run as the owner, ONLY after an explicit GO:
#   sudo bash owner-cutover.sh [--rotate-agent-jwt]
#
# --rotate-agent-jwt  also adds a new PAPERCLIP_AGENT_JWT_SECRET to .env, which
#                     invalidates every agent JWT minted before (they were
#                     exposed in ssh argv). Board sessions are unaffected.
#                     The value is generated here and never printed.
#
# The script refuses to start while an agent run is active, backs up every
# file it changes, and rolls back automatically if the new container does not
# become healthy. Manual rollback: owner-rollback.sh <backup suffix>.
set -euo pipefail
umask 077

ROOT="${PAPERCLIP_DIR:-/srv/paperclip}"
OVERRIDE_DIR="$ROOT/upgrade-2026.1106.0"
CTR="paperclip-paperclip-1"
OLD_TAG="local/paperclip:2026.1106.0-oauth-v3-ssh-cleanup-candidate"
OLD_ID="sha256:608f0708cedeaeb821b3b835d99229c19bb9905df4ab35b1c8d2077104acba17"
NEW_TAG="local/paperclip:2026.1106.0-oauth-v3-ssh-cleanup-ssh-secret-hardening"
NEW_ID="sha256:3ca9de40fdab6a690479815ec34524c3ce0bf7d36c870c6fa8ee80d661de7543"
CHUNK="/app/server/dist-runtime/chunk-3ZK6CBQV.mjs"
NEW_CHUNK_SHA="763c883ea5c6bb243fbb5d06fc9ee6d0daff5761cb65028620a95aceea93c060"
HEALTH_URL="${PAPERCLIP_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
RUN_CHECK_CMD="${RUN_CHECK_CMD:-runuser -u federico-admin -- /home/federico-admin/claude-work/p0-stabilization/pcq.sh -At -c \"select count(*) from heartbeat_runs where status = 'running'\"}"
FILES=("$ROOT/compose.yml" "$ROOT/compose.override.yml" "$OVERRIDE_DIR/override.yml")
SUFFIX="before-ssh-secret-hardening-$(date -u +%Y%m%dT%H%M%SZ)"

ROTATE_JWT=0
case "${1:-}" in
  "") ;;
  --rotate-agent-jwt) ROTATE_JWT=1 ;;
  *) echo "usage: owner-cutover.sh [--rotate-agent-jwt]" >&2; exit 2 ;;
esac

wait_healthy() {
  local deadline=$((SECONDS + ${HEALTH_TIMEOUT_SEC:-240}))
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  return 1
}

restore_backups() {
  for f in "${FILES[@]}"; do cp -a "$f.$SUFFIX.bak" "$f"; done
  if [[ -f "$ROOT/.env.$SUFFIX.bak" ]]; then cp -a "$ROOT/.env.$SUFFIX.bak" "$ROOT/.env"; fi
}

echo "=== PRECONDITIONS ==="
test "$(docker image inspect -f '{{.Id}}' "$NEW_TAG")" = "$NEW_ID"
test "$(docker inspect -f '{{.Image}}' "$CTR")" = "$OLD_ID"
for f in "${FILES[@]}"; do
  test "$(grep -c "image: $OLD_TAG\$" "$f")" = "1" || { echo "STOP: $f does not name $OLD_TAG exactly once"; exit 1; }
done
if (( ROTATE_JWT )) && grep -q '^PAPERCLIP_AGENT_JWT_SECRET=' "$ROOT/.env"; then
  echo "STOP: PAPERCLIP_AGENT_JWT_SECRET already set in .env; rotate it by hand"; exit 1
fi
ACTIVE=$(eval "$RUN_CHECK_CMD" | tr -d '[:space:]')
[[ "$ACTIVE" =~ ^[0-9]+$ ]] || { echo "STOP: could not count active runs"; exit 1; }
(( ACTIVE == 0 )) || { echo "STOP: $ACTIVE agent run(s) active; retry when idle"; exit 1; }
echo "active_runs=0"

echo "=== BACKUP ($SUFFIX) ==="
for f in "${FILES[@]}"; do cp -a "$f" "$f.$SUFFIX.bak"; echo "$f.$SUFFIX.bak"; done
if (( ROTATE_JWT )); then cp -a "$ROOT/.env" "$ROOT/.env.$SUFFIX.bak"; echo "$ROOT/.env.$SUFFIX.bak"; fi

echo "=== SWITCH IMAGE ==="
for f in "${FILES[@]}"; do sed -i "s#image: $OLD_TAG\$#image: $NEW_TAG#" "$f"; done
if (( ROTATE_JWT )); then
  printf 'PAPERCLIP_AGENT_JWT_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$ROOT/.env"
  echo "PAPERCLIP_AGENT_JWT_SECRET added (value not shown)"
fi
cd "$ROOT"
RESOLVED=$(docker compose config --images | sort -u)
if [[ "$RESOLVED" != "$NEW_TAG" ]]; then
  echo "STOP: compose resolves to: $RESOLVED"; restore_backups; exit 1
fi

echo "=== RESTART ==="
docker compose up -d paperclip
if wait_healthy \
  && [[ "$(docker inspect -f '{{.Image}}' "$CTR")" == "$NEW_ID" ]] \
  && [[ "$(docker exec "$CTR" sha256sum "$CHUNK" | cut -d' ' -f1)" == "$NEW_CHUNK_SHA" ]]; then
  echo "=== RESULT ==="
  curl -fsS --max-time 5 "$HEALTH_URL" | head -c 400; echo
  echo "CUTOVER=OK image=$NEW_TAG backups=*.$SUFFIX.bak"
  echo "NEXT: run post-install-probe.py during the next agent run"
  exit 0
fi

echo "=== NOT HEALTHY: AUTOMATIC ROLLBACK ==="
restore_backups
docker compose up -d paperclip
if wait_healthy && [[ "$(docker inspect -f '{{.Image}}' "$CTR")" == "$OLD_ID" ]]; then
  echo "ROLLBACK=OK (production back on $OLD_TAG)"
else
  echo "ROLLBACK=CHECK MANUALLY: docker compose ps; docker compose logs --tail 100 paperclip"
fi
exit 1
