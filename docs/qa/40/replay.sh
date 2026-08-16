#!/usr/bin/env bash
# One command to reopen the #40 QA environment. From the repo root:
#
#   bash docs/qa/40/replay.sh          # the palette, in a browser
#   bash docs/qa/40/replay.sh --legA   # the real-gh walkthrough, start to finish
#
# The harness itself is throwaway and lives here as .txt so nothing builds or
# ships it; this restores it, runs it, and takes it back out again.
#
# Leg B renders the sentences leg A captured (docs/qa/40/s*-events.json) — the
# browser never retypes a message by hand, so what is on screen is what the
# shipped producer actually emitted.
set -euo pipefail
cd "$(dirname "$0")/../../.."
here=docs/qa/40

cleanup() { rm -f src/qa-40.test.ts src/qa-harness.tsx qa.html; }
trap cleanup EXIT

if [[ "${1:-}" == "--legA" ]]; then
  cp "$here/harness-leg-a.test.ts.txt" src/qa-40.test.ts
  # Writes real issues to the throwaway private repo c3lew/quacket-qa-target.
  npx vitest run src/qa-40.test.ts
  exit
fi

cp "$here/harness-leg-b.tsx.txt" src/qa-harness.tsx
cp "$here/qa.html.txt" qa.html
cat <<'URLS'

  The #40 row itself — a resume the disk killed (S1):
    http://localhost:1421/qa.html?case=s1&delay=500
  The other resume failure — GitHub refused the create (S2):
    http://localhost:1421/qa.html?case=s2&delay=500
  The lookup that could not answer, unchanged by the fix (S3):
    http://localhost:1421/qa.html?case=s3&delay=500
  Pending, then [Check again] resolves it — click the button (S4):
    http://localhost:1421/qa.html?case=s4&delay=700
  What #29 shipped, replayed for comparison (the old contradiction):
    http://localhost:1421/qa.html?case=before&delay=500

  Every case but `before` is replayed from the JSON leg A captured.

URLS
npx vite --port 1421 --strictPort
