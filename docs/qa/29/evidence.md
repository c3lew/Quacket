# QA evidence — slice #29

Run 2026-08-16. Two legs, both against shipped code:

- **Leg B** — the real `<App>` in a real browser (Chromium via Playwright), with
  a hand-written services object. What the user READS and CLICKS.
- **Leg A** — the production `createFiling` against real `gh`, the real private
  repo `c3lew/quacket-qa-target`, and a real disk. What is on DISK and what `gh`
  is actually asked. Full console log: `leg-a-real-gh.log`.

Regression suite before the walkthrough: **791 passed / 31 files, 0 failed.**

---

## 13. A visible Check again action for a pending previous report, so I can retry reconciliation when connectivity or authentication returns.

**On startup, with a report the previous run left unresolved** the palette showed
one row (`qa29-ac1-pending-status-not-a-wall.png`):

> Your report from last time is still pending. Could not check GitHub for this report.
> `[ Check again ]`

**Clicking Check again** (`qa29-ac4-check-again-updates-the-status.png`): the same
row became

> Your report from last time was filed as issue #58.  `[ View on GitHub ]`

The harness log recorded the call as `recover(fil_qa29_a)`.

**Against real GitHub** (leg A, S2). Launch 1 with `gh` refusing (`gh: not logged
in`) ended at `state: pending`. The only calls it made were reads; no
issue-creating call was made. The user then "signs back in" and Check again runs:

```
[QA29] S2 [Check again] once GitHub answers
[ {"state":"checking",...}, {"state":"filed", "receipt": {...issues/…}} ]
```

Issues on GitHub carrying that report's identity afterwards: **1** (not 2).

**Clicking View on GitHub** opened
`https://github.com/c3lew/quacket-qa-target/issues/37` and the row disappeared;
the report being typed in the capture box was still there.

---

## 14. The previous-report status remains non-blocking, so an unresolved Filing does not stop me capturing a new report.

With the pending row on screen the whole time, a complete new report was captured
end to end (`qa29-ac2-capture-usable-beside-pending.png`,
`qa29-ac3-new-report-filed-old-row-survives.png`):

1. Typed "The tray icon vanishes after I unlock Windows" into the capture box.
2. Clicked **Add screenshot** — thumbnail appeared with Edit / Remove controls.
3. Clicked **Refine** — the refined form appeared (type, Title, Actual).
4. Clicked **Submit issue** — the Done screen appeared: **"Issue #99 filed"**.

The previous-report row stayed on screen, unchanged, through all four steps.

The row sits above the capture box in normal page flow. Nothing was overlaid, no
dialog appeared, the capture box never lost focus, and no control was disabled by
the row's presence.

While the lookup never answered at all (`?case=hang`,
`qa29-ac6-still-checking-no-button.png`) the row read "Still checking your report
from last time…" and the capture box was still fully usable — a full
type → Refine → Submit round completed to "Issue #99 filed".

---

## 15. A new Draft is stored independently from an Ambiguous Filing, so new typing, images, discard, and submission cannot overwrite the older report.

**In the browser.** The harness recorded every disk call the app made. With the
unresolved report `fil_qa29_a` on screen, typing produced
`saveDraft(d_msvc2d7q_p6zjnt)` — a different id — and attaching produced
`attachImage()` under that same new id. Submitting produced `file()`. The
previous-report row survived all of it.

**Discard** (`qa29-ac3-discard-does-not-take-the-old-report.png`): typed a new
report, pressed **Discard**. Log: `discardDraft() — the new draft was thrown
away`. The capture box emptied; the previous-report row remained.

**On a real disk** (leg A, S1). A crash left an Ambiguous Filing on disk. Then a
whole new report was captured beside it — saved, a screenshot attached, saved
again — and then **discarded**, the most destructive thing a draft can do. The
Ambiguous Filing's on-disk record was compared before and after:

```
expect(after).toEqual(before)   ✓ byte-identical
filings on disk afterwards:     [fil_qa29_s1_…]   ✓ still there
```

Recovery then still resolved it to `filed`, and GitHub held exactly **1** issue
carrying its identity.

---

## 16. Recovery success produces an OS notification when the palette is hidden, so an uncertain report gets a clear conclusion without stealing focus.

`qa29-ac5-hidden-success-raises-os-notification.png`. The lookup was set to take
3s; **Escape** was pressed immediately, which the log recorded as `hide() — the
palette went to the tray`. When the lookup resolved:

```
OS NOTIFICATION RAISED: "Your report from last time was filed as issue #57."
```

The window was not re-shown by the resolution. Behind it the Done screen was
waiting ("Issue #57 filed", Open in browser / New report) for when the user
returns.

---

## 17. Recovery failure produces an OS notification when the palette is hidden, so I know when the preserved report still needs attention.

`qa29-ac5-hidden-failure-raises-os-notification.png`. Same procedure, failing
lookup:

```
OS NOTIFICATION RAISED: "Your report from last time was not sent. Open Quacket to try again."
```

On returning, the row read "Your report from last time was not sent, so it is
safe to try again. Could not upload an image to this repo." with `[ Try again ]`.

**The counter-case** (`qa29-ac5-visible-submit-gains-no-notification.png`): an
ordinary report submitted with the window OPEN produced the Done screen "Issue
#99 filed" and **no** notification line in the log.

---

## 18. The palette shows high-level recovery states without upload or journal internals, so the next action stays obvious.

The four states, as rendered:

| state | what the palette said | its one control |
|---|---|---|
| still checking | Still checking your report from last time… | *(none — a spinner)* |
| still pending | Your report from last time is still pending. Could not check GitHub for this report. | `Check again` |
| filed | Your report from last time was filed as issue #58. | `View on GitHub` |
| filed (comment) | Your report from last time was added to issue #37. | `View on GitHub` |
| safe to retry | Your report from last time was not sent, so it is safe to try again. Could not upload an image to this repo. | `Try again` |

Each state had a different icon and colour treatment (spinner / question / check
/ warning).

Full rendered page text was read out of the DOM in every state. No occurrence of
*marker*, *journal*, *receipt*, *atomic*, *handoff*, *snapshot*, *workspace*,
*reconciliation*, *pagination*, a percentage, an upload count, a state-machine
name, or a file path.

**Leg A, S4** drove the one route by which a raw operating-system error could
reach that sentence: a Filing resumed after a failed create, with the disk
throwing `EPERM: operation not permitted, open '…\filings\…\img_1.png'` while the
app re-read its own screenshot. What the palette would render was:

```
Could not file this report.
```

Scanned for `marker, journal, receipt, atomic, handoff, snapshot, workspace,
filing, reconcil, pagination, upload, appdata, eperm, enoent, \, /filings/,
.json` → **none present**.

---

## 38. Errors written in plain language with one safe next action, so recovery remains usable without technical knowledge.

Every sentence in the table above is one sentence of ordinary English naming the
report ("your report from last time") and where it stands.

Each state offers **at most one** control, and never a second competing one:

- `pending` — the only offer is `Check again` (another look at GitHub). No
  "send it again" was offered anywhere while the outcome was unknown.
- `failed` — `Try again`.
- `filed` — `View on GitHub`.
- `checking` — no control at all.

Leg A S2 confirms the `pending` offer is not a disguised resend: while GitHub was
unavailable, **zero** issue-creating calls were made, and after the retry GitHub
held 1 issue, not 2.

---

## Follow-up round (driven after the first judging pass)

**A recovery resolving while hidden, with a report half-typed.**
`qa29-ac5-hidden-success-with-draft-in-progress.png`. Typed "Half a sentence I do
not want to lose", pressed Escape (`hide()` logged), then let the lookup resolve:

```
hide() — the palette went to the tray
OS NOTIFICATION RAISED: "Your report from last time was filed as issue #57."
```

On return the palette showed the half-typed sentence still in the capture box,
with the conclusion as a **row** beside it ("…was filed as issue #57." /
`View on GitHub`) — not the full Done screen that appears when there is no draft.
So the notification still fires, and the in-progress report is not displaced.

Confirmed independently against the state machine
(`harness-hidden.test.ts.txt`), both with and without a draft:

```
[NO DRAFT]   hidden: true  stage: done   effects: [hide, notify]
[WITH DRAFT] hidden: true  stage: input  effects: [hide, notify]
             recovery rows: 1   raw preserved: "half a sentence"
```

**The composed `pending` row after a local create failure.** Leg A S4 emits
`state: pending` with `message: "Could not file this report."`. Rendered
(`qa29-issue-pending-plus-could-not-file-contradiction.png`), that composes to:

> Your report from last time is still pending. Could not file this report.
> `[ Check again ]`

---

## Observations outside the acceptance sentences

1. **Two unresolved reports are indistinguishable.**
   `qa29-ac4-check-again-is-scoped-to-its-own-row.png`. With two unresolved
   reports the palette showed two rows reading the *identical* sentence — "Your
   report from last time is still pending. Could not check GitHub for this
   report." — with no title, date, or other way to tell which is which. Clicking
   the second row's Check again correctly acted on only that report
   (`recover(fil_qa29_b)`; leg A S3 confirms the other is neither asked about nor
   advanced on GitHub), but the user cannot tell from the screen which report
   they just acted on.

2. **"Still pending" and "Could not file this report." contradict each other.**
   See the follow-up round above. A create that failed locally comes back as
   *still pending* (we do not know) carrying a *definitive* failure sentence, with
   a `Check again` button. Reachable in the real product: leg A S4 produced
   exactly that event against a real disk and real `gh`.

3. **The internal-terms guard test does not cover button labels.** The scan in
   `recovery.test.ts` reads `recoveryNotice(...).text` and `recoveryAlert(...)`,
   not `action.label`. The shipped labels are clean; the guard would not catch a
   future one that is not.

---

## Not covered by this run

The native shell: tray icon, global hotkey, the real Windows notification
surface, and the updater. Both legs run outside Tauri, so "an OS notification was
raised" here means the app issued the notification with that exact text — not
that Windows drew a toast.
