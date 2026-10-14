#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run on the Nudge host as root through SSM.' >&2; exit 1; }
python3 "$(dirname "${BASH_SOURCE[0]}")/verify-storage.py"
export AWS_PAGER='' DOCKER_CONFIG=/run/nudge/docker
NUDGE_CURRENT=/opt/nudge/current
compose() { docker compose --project-name nudge --env-file /run/nudge/compose.env -f "${NUDGE_CURRENT}/deploy/compose.yml" "$@"; }
host_value() { python3 -c 'import json,sys; print(json.load(open("/etc/nudge/host.json"))[sys.argv[1]])' "$1"; }
