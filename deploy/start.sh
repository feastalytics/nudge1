#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[[ ! -e /etc/nudge/maintenance ]] || { echo 'Deployment or restore is incomplete; startup is blocked for operator recovery.' >&2; exit 1; }
python3 "${NUDGE_CURRENT}/deploy/render-runtime.py" --release "${NUDGE_CURRENT}/release.json"
# Images have already been pulled and migrations applied by host-deploy.sh.
compose up -d --pull never --remove-orphans
