#!/usr/bin/env bash
# One command to reopen the #28 QA environment. From the repo root:
#
#   bash docs/qa/28/replay.sh          # the palette, in a browser
#   bash docs/qa/28/replay.sh --legA   # the real-gh walkthrough, start to finish
#
# The harness itself is throwaway and lives here as .txt so nothing builds or
# ships it; this restores it, runs it, and takes it back out again.
set -euo pipefail
cd "$(dirname "$0")/../../.."
here=docs/qa/28

cleanup() { rm -f src/qa-28.test.ts src/qa-harness.tsx qa.html; }
trap cleanup EXIT

if [[ "${1:-}" == "--legA" ]]; then
  cp "$here/harness-leg-a.test.ts.txt" src/qa-28.test.ts
  # Writes real issues to the throwaway private repo c3lew/quacket-qa-target.
  npx vitest run src/qa-28.test.ts
  exit
fi

cp "$here/harness-leg-b.tsx.txt" src/qa-harness.tsx
cp "$here/qa.html.txt" qa.html
echo
echo "  A recovered report comes back as Done:"
echo "    http://localhost:1421/qa.html?case=filed&delay=2500"
echo "  GitHub never answers, the capture box still works:"
echo "    http://localhost:1421/qa.html?case=hang"
echo "  It lands while you are typing, and leaves your words alone:"
echo "    http://localhost:1421/qa.html?case=filed&delay=10000"
echo
npx vite --port 1421 --strictPort
