#!/usr/bin/env bash
# Runs all browser tests. Needs Playwright with Chromium (set NODE_PATH if it is installed globally).
set -euo pipefail
cd "$(dirname "$0")"
status=0
for t in redact e2e start hostile popup reload regressions retest dictation security marks selection duplicates testplan duration shapes drafts extras pause attribution report; do
  echo "=== $t ==="
  node "$t.mjs" || status=1
done
exit $status
