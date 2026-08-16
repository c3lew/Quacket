#!/usr/bin/env bash
# One command to reopen the #29 QA environment. From the repo root:
#
#   bash docs/qa/29/replay.sh          # the palette, in a browser
#   bash docs/qa/29/replay.sh --legA   # the real-gh walkthrough, start to finish
#
# The harness itself is throwaway and lives here as .txt so nothing builds or
# ships it; this restores it, runs it, and takes it back out again.
set -euo pipefail
cd "$(dirname "$0")/../../.."
here=docs/qa/29

cleanup() { rm -f src/qa-29.test.ts src/qa-harness.tsx qa.html; }
trap cleanup EXIT

if [[ "${1:-}" == "--legA" ]]; then
  cp "$here/harness-leg-a.test.ts.txt" src/qa-29.test.ts
  # Writes real issues to the throwaway private repo c3lew/quacket-qa-target.
  npx vitest run src/qa-29.test.ts
  exit
fi

cp "$here/harness-leg-b.tsx.txt" src/qa-harness.tsx
cp "$here/qa.html.txt" qa.html
cat <<'URLS'

  A previous report nobody could ask GitHub about (Check again):
    http://localhost:1421/qa.html?case=pending&delay=800
  The lookup never answers, the capture box still works:
    http://localhost:1421/qa.html?case=hang
  It turns out never to have been sent (Try again):
    http://localhost:1421/qa.html?case=failed&delay=500
  It turns out to have been filed:
    http://localhost:1421/qa.html?case=filed&delay=3000
  Pending first, filed on the second look (click Check again):
    http://localhost:1421/qa.html?case=recheck&delay=700
  Two unresolved reports at once:
    http://localhost:1421/qa.html?case=two&delay=600

  For the notification cases: press Escape to send the palette to the tray,
  then watch the harness strip at the bottom of the page.

URLS
npx vite --port 1421 --strictPort
