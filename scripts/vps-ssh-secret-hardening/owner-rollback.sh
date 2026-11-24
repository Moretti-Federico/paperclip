#!/usr/bin/env bash
# Return Paperclip production to the pre-hardening image.
# Run as the owner:  sudo bash owner-rollback.sh <backup suffix>
# <backup suffix> is the "before-ssh-secret-hardening-<UTC timestamp>" that
# owner-cutover.sh printed. Restores those compose files (and .env, when the
# cutover rotated the agent JWT secret), restarts, and checks health.
# The fix changes no data, so nothing else needs restoring. A rollback
# re-exposes injected values in ssh argv.
set -euo pipefail
umask 077

SUFFIX="${1:?usage: owner-rollback.sh <backup suffix>}"
ROOT="${PAPERCLIP_DIR:-/srv/paperclip}"
CTR="paperclip-paperclip-1"
OLD_ID="sha256:608f0708cedeaeb821b3b835d99229c19bb9905df4ab35b1c8d2077104acba17"
HEALTH_URL="${PAPERCLIP_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
FILES=("$ROOT/compose.yml" "$ROOT/compose.override.yml" "$ROOT/upgrade-2026.1106.0/override.yml")

for f in "${FILES[@]}"; do test -f "$f.$SUFFIX.bak" || { echo "STOP: missing $f.$SUFFIX.bak"; exit 1; }; done
for f in "${FILES[@]}"; do cp -a "$f.$SUFFIX.bak" "$f"; done
if [[ -f "$ROOT/.env.$SUFFIX.bak" ]]; then cp -a "$ROOT/.env.$SUFFIX.bak" "$ROOT/.env"; echo ".env restored"; fi
cd "$ROOT"
docker compose config --images | sort -u
docker compose up -d paperclip
deadline=$((SECONDS + ${HEALTH_TIMEOUT_SEC:-240}))
until curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; do
  (( SECONDS < deadline )) || { echo "ROLLBACK=NOT HEALTHY: docker compose logs --tail 100 paperclip"; exit 1; }
  sleep 3
done
test "$(docker inspect -f '{{.Image}}' "$CTR")" = "$OLD_ID"
echo "ROLLBACK=OK"
