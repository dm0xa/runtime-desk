#!/usr/bin/env bash
# Sherlock compose-project (group) page benchmark.
#
# Builds the real frontend, renders the group page in headless Chromium against a fixed
# Compose project fixture, and scores how many valuable facts reach the screen.
#
#   bash autoresearch.sh            # metric lines
#   bash autoresearch.sh --verbose  # plus the rendered text (debugging only)
set -uo pipefail
cd "$(dirname "$0")"

BUILD_LOG="$(mktemp -t group-probe-build)"
trap 'rm -f "$BUILD_LOG"' EXIT
if ! npm run build >"$BUILD_LOG" 2>&1; then
  echo "METRIC group_signals=0"
  echo "ASI build=failed"
  tail -25 "$BUILD_LOG"
  exit 1
fi

exec python3 scripts/group_probe.py "$@"
