#!/usr/bin/env bash
# Briefly stop inbound processing and sends so DB and queue match at backup time.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
if [[ ${1:-} != --lock-held ]]; then
  exec 9>/run/nudge-maintenance.lock
  flock -n 9 || { echo 'Backup skipped: maintenance is in progress.'; exit 0; }
fi
bucket=$(host_value backupBucket)
region=$(host_value region)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
scratch=$(mktemp -d /srv/nudge/.backup.XXXXXX)
mapfile -t restart_services < <(compose ps --status running --services | grep -E '^(web|worker|cron)$' || true)
cleanup() {
  local result=$?
  rm -rf -- "$scratch"
  if [[ ${#restart_services[@]} -gt 0 ]]; then compose start "${restart_services[@]}" || result=1; fi
  exit "$result"
}
trap cleanup EXIT
compose stop --timeout 120 web worker cron
compose exec -T postgres pg_dump -U nudge -d nudge --format=custom --no-owner --no-acl > "$scratch/postgres.dump"
compose exec -T redis redis-cli SAVE >/dev/null
compose cp redis:/data/dump.rdb "$scratch/redis.rdb" >/dev/null
cp "$NUDGE_CURRENT/release.json" "$scratch/release.json"
(cd "$scratch" && sha256sum postgres.dump redis.rdb release.json > SHA256SUMS)
aws s3 cp "$scratch/" "s3://$bucket/backups/$stamp/" --recursive --region "$region" --sse AES256 --only-show-errors
touch "$scratch/COMPLETE"
aws s3 cp "$scratch/COMPLETE" "s3://$bucket/backups/$stamp/COMPLETE" --region "$region" --sse AES256 --only-show-errors
echo "Backup completed: s3://$bucket/backups/$stamp/"
