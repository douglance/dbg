#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
	echo "usage: scripts/visionos-attach-smoke.sh <bundle-id> [attach args...]"
	exit 1
fi

bundle_id="$1"
shift || true

echo "[1/6] attaching to ${bundle_id}"
dbg attach "${bundle_id}" --verbose-attach "$@"

echo "[2/6] status"
dbg status

echo "[3/6] pause"
dbg pause

echo "[4/6] query frames"
dbg q "SELECT * FROM frames LIMIT 5"

echo "[5/6] continue"
dbg c

echo "[6/6] close"
dbg close
