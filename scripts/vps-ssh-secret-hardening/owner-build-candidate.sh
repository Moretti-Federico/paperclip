#!/usr/bin/env bash
# Build (do NOT deploy) the SSH secret-hardening candidate image on the VPS.
# Run as the owner:  sudo bash owner-build-candidate.sh <staging dir>
# The staging dir must contain chunk-3ZK6CBQV.mjs (the patched runtime chunk).
# Production is only inspected, never changed: no compose edit, no restart.
set -euo pipefail
umask 077

STAGE="${1:?usage: owner-build-candidate.sh <staging dir>}"
CTR="paperclip-paperclip-1"
BASE="local/paperclip:2026.1106.0-oauth-v3-ssh-cleanup-candidate"
BASE_ID="sha256:608f0708cedeaeb821b3b835d99229c19bb9905df4ab35b1c8d2077104acba17"
TAG="local/paperclip:2026.1106.0-oauth-v3-ssh-cleanup-ssh-secret-hardening"
CHUNK="/app/server/dist-runtime/chunk-3ZK6CBQV.mjs"
PROD_CHUNK_SHA="181ba3186e722015bd1cbb70fd74eca39e3a266d0660ba1c4ada185b8864791b"
NEW_CHUNK_SHA="763c883ea5c6bb243fbb5d06fc9ee6d0daff5761cb65028620a95aceea93c060"

echo "=== PRECONDITIONS ==="
test "$(docker inspect -f '{{.Image}}' "$CTR")" = "$BASE_ID"
test "$(docker image inspect -f '{{.Id}}' "$BASE")" = "$BASE_ID"
test "$(docker run --rm --network none --entrypoint sha256sum "$BASE" "$CHUNK" | cut -d' ' -f1)" = "$PROD_CHUNK_SHA"
test "$(sha256sum "$STAGE/chunk-3ZK6CBQV.mjs" | cut -d' ' -f1)" = "$NEW_CHUNK_SHA"

echo "=== BUILD CANDIDATE ==="
cat > "$STAGE/Dockerfile" <<DOCKER
FROM $BASE
COPY --chown=node:node chunk-3ZK6CBQV.mjs $CHUNK
LABEL local.paperclip.ssh-secret-hardening="vps/ssh-secret-hardening" \\
      local.paperclip.ssh-secret-hardening.chunk-sha256="$NEW_CHUNK_SHA"
DOCKER
export TMPDIR="$STAGE"
docker build --pull=false --network=none -t "$TAG" -f "$STAGE/Dockerfile" "$STAGE"

echo "=== STATIC VERIFICATION ==="
test "$(docker run --rm --network none --entrypoint sha256sum "$TAG" "$CHUNK" | cut -d' ' -f1)" = "$NEW_CHUNK_SHA"
docker run --rm --network none --entrypoint node "$TAG" --check "$CHUNK"
# Only the chunk differs from the base runtime.
list() { docker run --rm --network none --entrypoint sh "$1" -c 'cd /app/server/dist-runtime && find . -type f -exec sha256sum {} + | sort -k2'; }
diff <(list "$BASE") <(list "$TAG") | grep '^[<>]' | awk '{print $1, $3}'
test "$(diff <(list "$BASE") <(list "$TAG") | grep -c '^>')" = "1"
docker run --rm --network none --entrypoint sh "$TAG" -c "! grep -q 'exec env \${envArgs' $CHUNK && grep -q 'paperclip-run-env' $CHUNK"
docker run --rm --network none --entrypoint node "$TAG" --input-type=module -e "
  const m = await import('file://$CHUNK');
  for (const n of ['runSshCommand', 'createSshCommandManagedRuntimeRunner', 'runChildProcess']) {
    if (typeof m[n] !== 'function') { console.error('missing export ' + n); process.exit(1); }
  }
  console.log('IMPORT_OK');
"

echo "=== RESULT ==="
docker image inspect "$TAG" --format 'CANDIDATE_ID={{.Id}}'
test "$(docker inspect -f '{{.Image}}' "$CTR")" = "$BASE_ID"
echo "PRODUCTION_UNCHANGED=OK"
echo "CANDIDATE=$TAG"
