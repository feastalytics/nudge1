#!/usr/bin/env bash
# Destructive restore is deliberately an explicit operator action, never startup.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[[ $# -eq 3 && "$1" =~ ^[0-9]{8}T[0-9]{6}Z$ && "$3" == --confirm-restore ]] || { echo 'Usage: restore.sh BACKUP_TIMESTAMP MATCHING_RELEASE_DIR --confirm-restore' >&2; exit 1; }
stamp=$1
release_dir=$(realpath "$2")
[[ "$release_dir" =~ ^/opt/nudge/releases/[a-zA-Z0-9._-]+$ && -f "$release_dir/release.json" ]] || { echo 'Invalid matching release directory.' >&2; exit 1; }
exec 9>/run/nudge-maintenance.lock
flock -n 9 || { echo 'Maintenance is already in progress.' >&2; exit 1; }
bucket=$(host_value backupBucket)
region=$(host_value region)
scratch=$(mktemp -d /srv/nudge/.restore.XXXXXX)
trap 'rm -rf -- "$scratch"' EXIT
aws s3 cp "s3://$bucket/backups/$stamp/COMPLETE" "$scratch/COMPLETE" --region "$region" --only-show-errors
for name in postgres.dump redis.rdb release.json SHA256SUMS; do
  aws s3 cp "s3://$bucket/backups/$stamp/$name" "$scratch/$name" --region "$region" --only-show-errors
done
(cd "$scratch" && sha256sum --check SHA256SUMS)
python3 - "$scratch/release.json" "$release_dir/release.json" <<'PY'
import json,sys
backup,release=(json.load(open(p)) for p in sys.argv[1:])
if backup['images'] != release['images'] or backup['sourceUrl'] != release['sourceUrl']:
    raise SystemExit('Release must match every backup image digest and source URL.')
PY
touch /etc/nudge/maintenance
compose stop --timeout 120 web worker cron redis
# Render the old, matched release with CURRENT secrets. Its ENCRYPTION_KEY and
# POSTGRES_PASSWORD must still be the original values; never regenerate them.
safe_release="/opt/nudge/releases/restore-$stamp"
[[ ! -e "$safe_release" ]] || { echo 'This restore release already exists; inspect it before retrying.' >&2; exit 1; }
cp -a "$release_dir" "$safe_release"
python3 - "$safe_release/release.json" <<'PY'
import json,sys
path=sys.argv[1]
value=json.load(open(path)); value['sendEnabled']=False
with open(path,'w') as f: json.dump(value,f,indent=2)
PY
python3 "$safe_release/deploy/render-runtime.py" --release "$safe_release/release.json"
NUDGE_CURRENT=$safe_release
compose up -d --wait postgres
compose exec -T postgres dropdb --if-exists --force -U nudge nudge
compose exec -T postgres createdb -U nudge nudge
compose exec -T postgres pg_restore -U nudge -d nudge --no-owner --no-acl < "$scratch/postgres.dump"
# Redis normally prefers its AOF over an RDB. Bootstrap from this RDB with AOF
# disabled, then enable AOF and wait for its rewrite before normal startup.
python3 - <<'PY'
from pathlib import Path
import shutil
root=Path('/srv/nudge/redis')
if not root.is_dir() or root.is_symlink(): raise SystemExit('Invalid Redis data directory')
for item in root.iterdir():
    if item.is_dir() and not item.is_symlink(): shutil.rmtree(item)
    else: item.unlink()
PY
cp "$scratch/redis.rdb" /srv/nudge/redis/dump.rdb
compose run -d --no-deps --name nudge-redis-restore redis redis-server --appendonly no >/dev/null
for attempt in {1..30}; do
  if docker exec nudge-redis-restore redis-cli ping >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec nudge-redis-restore redis-cli CONFIG SET appendonly yes >/dev/null
aof_ready=false
for attempt in {1..120}; do
  info=$(docker exec nudge-redis-restore redis-cli INFO persistence)
  if [[ "$info" == *$'aof_rewrite_in_progress:0\r'* && "$info" == *$'aof_last_bgrewrite_status:ok\r'* ]]; then aof_ready=true; break; fi
  sleep 1
done
[[ "$aof_ready" == true ]] || { echo 'Redis AOF rewrite did not finish; application remains stopped.' >&2; exit 1; }
docker stop --time 60 nudge-redis-restore >/dev/null
docker rm nudge-redis-restore >/dev/null
ln -sfn "$safe_release" /opt/nudge/current
rm /etc/nudge/maintenance
systemctl restart nudge.service
echo 'Restore completed with sends DISABLED. Verify campaign status, pending sends and worker health before enabling sends in a new release.'
