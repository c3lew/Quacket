# QA evidence — ticket #40

A bug-fix ticket, so the scope is the bug's own repro scenario plus the
regression suite. The two acceptance sentences the bug sat under (#29's
覆蓋驗收項 18 and 38) are the judging oracle; the client's demo-closeout call was
to re-demo only that row, not the whole #29 slice.

Run 2026-08-16 against real `gh`, the throwaway private repo
`c3lew/quacket-qa-target`, and a real disk.

## The two acceptance sentences under test

> **18.** As a Quacket user, I want the palette to show high-level recovery
> states without upload or journal internals, so that the next action stays
> obvious.

> **38.** As a Quacket user, I want errors written in plain language with at most
> one safe next action — and no action offered while the outcome is still being
> checked — so that recovery remains usable without technical knowledge.

## How the evidence was produced

Two legs, and the join between them is the point.

- **Leg A** (`harness-leg-a.test.ts.txt`, log in `leg-a-real-gh.log`) drives the
  shipped `createFiling()` against real `gh`, a real private repo and a real
  disk, faults injected at exactly two seams. It **captures what the producer
  actually emits** into `s1-events.json`, `s2-events.json`, `s3-events.json`,
  `s4-events.json`.
- **Leg B** (`harness-leg-b.tsx.txt`) mounts the shipped `<App>` in a browser and
  **replays those captured files**. No sentence is retyped by hand into the
  browser, so a row cannot read correctly because QA typed it correctly. The one
  exception is `?case=before`, which replays the event `docs/qa/29` recorded
  before the fix so the two rows can be read side by side.

Reopen either with one command — see `README.md`.

---

## Baseline: the row as #29 shipped it

`?case=before` — replaying the pre-fix event through the same palette.

> Your report from last time is still pending. Could not file this report.
> [Check again]

Evidence: `qa40-before-the-contradiction-as-shipped.png`.

The bug is visible in one line: an uncertainty frame with a verdict inside it,
over a button offering to look again at something the sentence just said had
failed.

---

## S1 — the exact repro: a resume the disk killed

The scenario from `docs/qa/29`'s S4, re-run unchanged: a create that failed
locally, then a resume whose disk gives out while re-reading its own screenshot.

What the shipped producer emitted (`s1-events.json`, real `gh`, real disk):

```json
[
  { "state": "checking", "filingId": "fil_qa40_s1_1786860742234" },
  { "state": "pending",  "filingId": "fil_qa40_s1_1786860742234",
    "message": "Could not confirm whether this report was sent." }
]
```

Rendered by the shipped palette:

> Your report from last time is still pending. Could not confirm whether this
> report was sent.
> [Check again]

Evidence: `qa40-s1-pending-says-cannot-confirm.png`.

Four further observations on the same row:

- **While the outcome is still being checked, no action is offered.** The row on
  the way in reads "Still checking your report from last time…" with no button
  at all — the second half of sentence 38, which only exists in the in-flight
  state. Evidence: `qa40-s1-still-checking-offers-no-action.png`.
- **[Check again] still does its job** and now agrees with the sentence: clicking
  it re-runs reconciliation scoped to that report
  (`recover(fil_qa40_s1_…) called` in the harness strip). Pressing it returns the
  row to "Still checking…" and the button disappears while the look is in flight,
  so it cannot be pressed twice. Capture stays fully usable beside it — typed a
  whole report while it sat there, and the harness strip shows the draft saved
  under its own id.
  Evidence: `qa40-s1-check-again-and-capture-still-work.png`.
- **When the second look lands, the row is re-stated, not replaced by a wall** —
  same sentence, button back, the half-typed report untouched.
  Evidence: `qa40-s1-after-check-again-row-is-restated.png`.
- **The reason the write stopped is not lost.** The snapshot on disk after the
  failure still records it (`leg-a-real-gh.log`, "S1 what the disk still records
  about the failure"):
  `"lastFailure": { "kind": "create_failed", "message": "Could not create the issue." }`
- **Nothing from inside the machine reached the user.** The internal-terms sweep
  runs over every sentence in every scenario, not just this one, and all four
  came back empty (`S1/S2/S3/S4 internal terms that reached the user: []`) —
  sentence 18's other half. S3 is the one worth the sweep: its message is the
  only one that names GitHub.

## S2 — the other way a resume dies: GitHub refuses the create

Same crash, but the lookup is left real (it authoritatively finds nothing) and
only the resume's own create is refused. This is the neighbouring route into the
same frame, and it lands the same way:

> Your report from last time is still pending. Could not confirm whether this
> report was sent.
> [Check again]

Evidence: `s2-events.json`, `qa40-s2-rejected-create-also-uncertainty.png`.

Leg A also confirmed the two failed attempts created nothing behind the user's
back: zero issues in the repo carry this report's identity.

Worth naming, because it looks like under-informing: QA knows nothing was
created here, and the row still says "could not confirm". The product does not
know that. `gh` exiting non-zero on a create does not tell it whether the create
landed first — that is the whole reason this path goes back to `pending` — so
"could not confirm" is the true statement available to it, and the next startup
asks GitHub rather than guessing on the user's behalf.

## S3 — the fix did not flatten every pending message into one

The opposite failure mode: if every `pending` row had been collapsed to the one
generic sentence, the user would lose the reason a lookup could not answer. With
GitHub unreachable for the lookup, the row keeps the lookup's own — different,
informative, and still written as uncertainty:

> Your report from last time is still pending. Could not confirm which GitHub
> account is signed in.
> [Check again]

Evidence: `s3-events.json`, `qa40-s3-lookup-keeps-its-own-reason.png`.

Keeping the lookup's own reason is right; **this particular reason is not the
one that was true**. The injected fault is a dead network
(`gh: could not resolve host github.com`), and the row blames sign-in, because
`findFiling` asks `gh api user` first and `actor()` returns `null` for any
failure — offline, rate-limited, timed out, or actually signed out
(`src/core/filing/lookup.ts:123-131, 152-155`). A non-technical user goes
looking through sign-in settings for a problem that is really the wi-fi. This
predates #40 and is filed separately as a known issue.

## S4 — the button the sentence promises actually resolves it

"Could not confirm" is only honest because something can still go and find out.
So: the same crash, GitHub unreachable on the first look, then the user presses
[Check again] once connectivity is back. Both looks captured in one file
(`s4-events.json`, a pass per look).

Look 1 → still pending. Look 2 → the palette says:

> **Issue #115 filed**
> QA40 S4 … · c3lew/quacket-qa-target
> [Open in browser] [New report]

Evidence: `qa40-s4-check-again-resolves-it.png`, and the issue is real:
<https://github.com/c3lew/quacket-qa-target/issues/115>.

Leg A checked the part the screenshot cannot show: exactly **one** issue in the
repo carries this report's identity. The button resolved the uncertainty by
asking, not by sending a second copy.

## Does the guard actually bite?

The fix claims a future producer dropping a verdict into a pending row fails the
build. Verified by reverting the one-line fix in `filing.ts`
(`message: UNCONFIRMED` → `message: messageOf(error)`) and re-running:

```
FAIL src/core/filing/filing.test.ts
- Expected: /\bcould not (file|create|comment|upload|send)\b/i
+ Received: "Could not create the issue. GitHub took too long to respond."
  Tests  1 failed | 78 passed (79)
```

Restored, green again (79 passed). The rider from the ticket comment is in
place too: `recovery.test.ts`'s internal-terms sweep now runs over
`action?.label` for all four states, not just `text`.

## The status mark on the row

The mark left of every recovery sentence is `<Icon name="question" size={14} />`
from `Palette.tsx`'s tone table — an inline SVG that inherits the row's colour,
not a typographic `?`. It renders small in a `css`-scaled screenshot, which is
easy to misread as a glyph.

## Regression suite

```
tsc --noEmit   clean
vitest run     31 files, 791 passed
```

## Not covered

The native shell — tray, global hotkey, the real Windows notification surface,
the updater. Both legs run outside Tauri, so a browser stands in for the OS.
Nothing in this fix touches the shell; the row above is drawn by the same
component tree either way.

Two more honest limits of the rig:

- Leg B reimplements `recover()`'s in-flight guard (the harness's `inFlight`
  set), so "the button cannot be pressed twice" is proven against QA's copy of
  that rule, not the shipped one. What IS shipped evidence is the button's
  absence during `checking` — that comes from the real component.
- Only `checking`, `pending` and `filed` are photographed. The fourth state
  (`failed`, "safe to try again") is untouched by this fix and covered by
  `recovery.test.ts` alone.
