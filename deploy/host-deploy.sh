#!/usr/bin/env bash
# Execute only from a reviewed, checksummed release artifact on the target host.
set -euo pipefail
[[ ${EUID} -eq 0 && $# -eq 5 ]] || { echo 'Usage: host-deploy.sh RELEASE_DIR DATA_VOLUME_ID SECRET_ARN BACKUP_BUCKET REGION (as root)' >&2; exit 1; }
release_dir=$(realpath "$1")
volume_id=$2
secret_arn=$3
backup_bucket=$4
aws_region=$5
[[ "$release_dir" =~ ^/opt/nudge/releases/[a-zA-Z0-9._-]+$ && -f "$release_dir/release.json" ]] || { echo 'Invalid release directory.' >&2; exit 1; }
[[ "$volume_id" =~ ^vol-[a-f0-9]+$ && "$backup_bucket" =~ ^[a-z0-9.-]+$ && "$aws_region" =~ ^[a-z]{2}-[a-z]+-[0-9]+$ ]] || { echo 'Invalid infrastructure identifiers.' >&2; exit 1; }
[[ "$secret_arn" =~ ^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[a-zA-Z0-9/_+=.@-]+$ ]] || { echo 'Invalid secret ARN.' >&2; exit 1; }
export AWS_PAGER='' DOCKER_CONFIG=/run/nudge/docker
install -d -m 0700 /etc/nudge /run/nudge /run/nudge/docker
exec 9>/run/nudge-maintenance.lock
flock -n 9 || { echo 'Another deployment, backup or restore is running.' >&2; exit 1; }

# Find the exact attached EBS volume by serial, never by an assumed nvme order.
serial=${volume_id//-/}
device=$(lsblk -dnpo NAME,SERIAL | awk -v serial="$serial" '{gsub(/-/, "", $2); if ($2 == serial) print $1}')
[[ -n "$device" && $(printf '%s\n' "$device" | wc -l) -eq 1 ]] || { echo 'Expected attached data volume was not found.' >&2; exit 1; }
filesystem=$(blkid -s TYPE -o value "$device" || true)
if [[ -z "$filesystem" ]]; then
  [[ $(lsblk -nrpo NAME "$device" | wc -l) -eq 1 ]] || { echo 'Refusing to format a volume with partitions.' >&2; exit 1; }
  [[ -z $(findmnt -rn -S "$device") ]] || { echo 'Refusing to format a mounted volume.' >&2; exit 1; }
  mkfs.ext4 -q "$device"
elif [[ "$filesystem" != ext4 ]]; then
  echo 'Expected an ext4 data volume; refusing to modify it.' >&2; exit 1
fi
uuid=$(blkid -s UUID -o value "$device")
install -d -m 0750 /srv/nudge
if mountpoint -q /srv/nudge; then
  [[ $(findmnt -n -o UUID /srv/nudge) == "$uuid" ]] || { echo '/srv/nudge is mounted from a different volume.' >&2; exit 1; }
else
  mount "$device" /srv/nudge
fi
if ! grep -qF "UUID=$uuid /srv/nudge " /etc/fstab; then
  printf 'UUID=%s /srv/nudge ext4 defaults,nofail 0 2\n' "$uuid" >> /etc/fstab
fi
install -d -m 0750 /srv/nudge/postgres /srv/nudge/redis /srv/nudge/caddy-data /srv/nudge/caddy-config
install -d -m 0755 /etc/systemd/system/docker.service.d
install -m 0644 "$release_dir/deploy/docker-storage.conf" /etc/systemd/system/docker.service.d/nudge-storage.conf

# Preserve a matched database + queue snapshot before changing a running release.
if [[ -L /opt/nudge/current ]]; then
  bash /opt/nudge/current/deploy/backup.sh --lock-held
fi
python3 - "$secret_arn" "$backup_bucket" "$aws_region" "$volume_id" <<'PY'
import json,os,sys
fd=os.open('/etc/nudge/host.json',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:
    json.dump(dict(zip(('secretArn','backupBucket','region','volumeId'),sys.argv[1:])),f)
PY
python3 "$release_dir/deploy/render-runtime.py" --release "$release_dir/release.json"
while IFS= read -r registry; do
  aws ecr get-login-password --region "$aws_region" | docker login --username AWS --password-stdin "$registry" >/dev/null
done < <(python3 - "$release_dir/release.json" <<'PY'
import json,sys
images=json.load(open(sys.argv[1]))['images'].values()
for registry in sorted({image.split('/')[0] for image in images if '.dkr.ecr.' in image}): print(registry)
PY
)
new_compose=(docker compose --project-name nudge --env-file /run/nudge/compose.env -f "$release_dir/deploy/compose.yml")
"${new_compose[@]}" --profile tools pull
# Persist a startup fence across host reboots if a migration fails partway.
touch /etc/nudge/maintenance
"${new_compose[@]}" stop --timeout 120 web worker cron
"${new_compose[@]}" up -d --wait postgres redis
# A failed migration leaves the application stopped. Use the documented backup
# restore; never automatically run old code against a possibly changed schema.
"${new_compose[@]}" run --rm --no-deps migrate
if [[ -L /opt/nudge/current ]]; then
  ln -sfn "$(readlink -f /opt/nudge/current)" /opt/nudge/previous
fi
ln -sfn "$release_dir" /opt/nudge/current
install -m 0644 "$release_dir/deploy/nudge.service" /etc/systemd/system/nudge.service
install -m 0644 "$release_dir/deploy/nudge-backup.service" /etc/systemd/system/nudge-backup.service
install -m 0644 "$release_dir/deploy/nudge-backup.timer" /etc/systemd/system/nudge-backup.timer
systemctl daemon-reload
systemctl enable nudge.service nudge-backup.timer
rm /etc/nudge/maintenance
systemctl restart nudge.service
systemctl start nudge-backup.timer
echo 'Release installed. Verify HTTPS, staff-only sign-in, backups and worker health before enabling sends.'
