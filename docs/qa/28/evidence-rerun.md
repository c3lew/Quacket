# Walkthrough evidence — slice #28, re-run after the #37 fix

Observed 2026-08-16 against real `gh`, the real private repo
`c3lew/quacket-qa-target`, and a real disk. Faults were injected at exactly two
seams: a single `gh` call's result, or a single filesystem method. Everything
else is the shipped path. Full console output: `leg-a-real-gh-rerun.log`.
Browser observations are the four `qa28-rerun-*.png` files here.

Vocabulary: a *Filing* is one submission attempt; it carries an opaque identity
written into the remote body as an invisible HTML comment. Startup
reconciliation walks unfinished Filings and reports each as `checking` → one of
`filed` / `pending` / `failed`.

---

## Acceptance sentences under test

1. Recover a report when GitHub accepted it but the app crashed before receiving
   or saving the response, so the user does not have to inspect GitHub manually.
2. Verify an ambiguous Filing against GitHub before retrying it, so it never
   retries merely because a local response was lost.
3. A matching Filing identity restores the report as Done.
4. An authoritative no-match resumes the same Filing automatically, completing
   the Submit the user already requested without another decision.
5. An offline, unauthenticated, or otherwise unavailable GitHub check leaves the
   Filing pending, so uncertainty is not mistaken for failure.
6. Retryable failures are distinguished from ambiguous outcomes, so Retry is
   never offered while duplicate safety is unknown.
7. Startup recovery runs automatically.
8. Startup recovery leaves capture usable while GitHub is slow.
9. A durable Filing receipt restores the Done state after a crash.
10. Pending cleanup work resumes independently after restart.

Also on the ticket: `failed` only with durable evidence that nothing was
created; a resumed create that loses its outcome returns to `pending`; a match
is established by exact marker verification and returns URL + issue number.

---

## S1 — GitHub accepted the report, then the crash

Setup, identical in all three runs: the report is submitted for real and GitHub
accepts it. The receipt write and the workspace cleanup are then both made to
fail — what a process dying between "GitHub said yes" and "we wrote it down"
leaves on disk. Disk afterwards: `{ state: "filing", receipt: null }`.

### Relaunched immediately (0 ms) — this is the scenario #37 was filed about

```
GitHub accepted the report as   https://…/issues/83
disk after the crash            { state: "filing", receipt: null }

recovery events
  { state: "checking" }
  { state: "filed", receipt: { url: ".../issues/83", issueNumber: 83,
                               repo: "c3lew/quacket-qa-target",
                               target: { kind: "new-issue" },
                               title: "QA28 S1 issue 0 …" } }

gh calls during recovery
  api user
  api repos/…/issues?state=all&creator=c3lew&per_page=100&page=1
  (no create, no comment, no --method)

issues on GitHub carrying this Filing's hidden identity
  https://…/issues/83          ← exactly one

wall clock for this scenario: 18.0 s
```

### Relaunched after 20 s

```
accepted as                     https://…/issues/84
recovery events                 checking → filed, receipt → issues/84
gh calls during recovery        api user, the same issues listing (no create)
issues carrying the identity    https://…/issues/84   ← exactly one
```

### Comment leg, relaunched immediately

```
recovery events    checking → filed
receipt            url  …/issues/37#issuecomment-5303592475
                   issueNumber 37, target { kind: "comment", issueNumber: 37 }
gh calls           api repos/…/issues/37/comments?per_page=100&page=1   (no create)
comments carrying the identity   one, the same URL
```

---

## S2 — the create never reached GitHub, then recovery

The create is made to fail with `gh: connection reset` on the way out; a read-back
confirms GitHub has nothing carrying this identity. Then a fresh launch:

```
recovery events
  { state: "checking" }
  { state: "filed", receipt: { url: ".../issues/85", issueNumber: 85,
                               filingId: "fil_qa28_s2_…" } }   ← same Filing id

gh calls during recovery
  api user
  api repos/…/issues?state=all&creator=c3lew&per_page=100&page=1
  label list --repo …
  issue create --repo … --title "QA28 S2 no-match …" --body-file - --label bug

issues on GitHub carrying the identity
  https://…/issues/85          ← exactly one, and it is the receipt's URL

No question was put to the user at any point. Wall clock: 26.0 s.
```

---

## S3 — six ways the lookup cannot conclude

Each ran the same shape: a Filing whose outcome is unknown, one `gh` fault
injected, a launch, then a brand-new report captured and filed while the old one
is still pending.

| injected fault | events | gh calls | on GitHub | on disk |
|---|---|---|---|---|
| offline (`no such host`) | checking → pending, "Could not confirm which GitHub account is signed in." | `api user` | nothing carrying the identity | `lastCheck { message, at: 18:19:07.462Z }` |
| not authenticated (401) | checking → pending, same message | `api user` | nothing | `lastCheck` at 18:19:26.374Z |
| rate limited (403) | checking → pending, "Could not check GitHub for this report." | `api user`, issues listing | nothing | `lastCheck` at 18:19:45.347Z |
| malformed page (unparseable JSON) | checking → pending, same | `api user`, issues listing | nothing | `lastCheck` at 18:20:05.235Z |
| empty stdout, exit 0 | checking → pending, same | `api user`, issues listing | nothing | `lastCheck` at 18:20:24.693Z |
| interrupted pagination (page 2 fails) | checking → pending, same | `api user`, listing page 1, listing page 2 | nothing | `lastCheck` at 18:20:44.060Z |

In every one of the six: **no create call of any kind**, and a new report
captured immediately afterwards filed normally (issues 86, 87, 88, 89, 90, 91).

---

## S4 — the failed/pending boundary

### `failed` (durable evidence nothing was created)

A resumed Filing dies on the image-upload leg, before any create:

```
events
  { state: "checking" }
  { state: "failed", kind: "upload_failed",
    message: "Could not upload an image to this repo." }

gh calls
  api user
  api repos/…/issues?state=all&creator=…&page=1
  api repos/…/git/ref/heads/quacket-assets
  api --method PUT repos/…/contents/.quacket/assets/…png     ← the upload that failed
  (no issue create, no comment)
```

### a resumed create that loses its outcome

```
events
  { state: "checking" }
  { state: "pending", message: "Could not create the issue. GitHub took too long to respond." }

the Filing left on disk
  { state: "failed",
    lastFailure: { kind: "create_failed",
                   message: "Could not create the issue. GitHub took too long to respond." } }

the launch after that, GitHub unavailable
  { state: "checking" }
  { state: "pending", message: "Could not check GitHub for this report." }
```

---

## S6 — a durable receipt across restarts, and a stuck cleanup

A report is filed for real (issue 92); the workspace removal is made to fail.

```
after the failed cleanup
  { state: "filed", cleanup: "pending",
    cleanupFailure: { message: "injected remove failure", at: 18:21:42.004Z, attempts: 1 } }

second launch, cleanup still broken
  events         [ { state: "filed", receipt: { url: ".../issues/92", issueNumber: 92, … } } ]
  cleanupFailure { message: …, at: 18:21:42.004Z, attempts: 2 }      ← first failure time kept

final launch, cleanup working
  events         [ { state: "filed", receipt: { url: ".../issues/92", … } } ]
  gh calls       []                                                  ← none at all
  workspace      drained
```

---

## S7 / S8 — recovery is never in the way

```
GitHub never answers the recovery lookup:
  recoveryEvents   ["checking"]      recoveryFinished  false
  a brand-new report filed anyway    https://…/issues/93     in 2649 ms

an unreadable workspace:
  recover() yields { state: "pending", message: "Could not read this report on this computer." }
  and never throws
```

---

## S9 — a match is the marker, not the title

A report is filed for real under its own identity, then a DIFFERENT Filing with
the byte-identical title has its create fail on the way out. Recovery runs on
the second Filing:

```
already on GitHub, same title, different identity
  https://…/issues/95

recovery events
  { state: "checking" }
  { state: "filed", receipt: { url: ".../issues/96", issueNumber: 96,
                               filingId: "fil_qa28_s9_…" } }

gh calls during recovery
  api user
  api repos/…/issues?state=all&creator=…&page=1
  label list --repo …
  issue create --repo … --title "QA28 S9 identical title …" --label bug   ← exactly one

decoy   https://…/issues/95
receipt https://…/issues/96          ← not the decoy

issues carrying THIS Filing's identity
  https://…/issues/96                ← exactly one
```

The identical title did not produce a match; the marker decided.

---

## Browser leg — the shipped palette in a real browser

The real `<App>` mounted with a hand-written services object; recovery is a
scripted event stream, so this leg shows the screen, not the reconciliation.

**A recovered report arrives as Done, with nothing clicked**
(`qa28-rerun-story30-recovered-done.png`). Text sampled every 60 ms:

```
t=67ms     "Quacket … Add screenshot  Refine Ctrl+Enter"
t=2529ms   "Quacket … Issue #57 filed  Tray icon disappears after unlocking Windows
            c3lew/quacket-qa-target  Open in browser  New report Ctrl+N"
```

**GitHub never answers; capture still works**
(`qa28-rerun-story29-capture-usable-while-github-hangs.png`): the textbox
accepts "the tray icon vanishes after I unlock windows", and Refine and Discard
are both enabled while recovery is still hanging on `checking`.

**Recovery landing mid-sentence leaves the words alone**
(`qa28-rerun-recovery-does-not-steal-a-half-typed-report.png`): typed at t≈3 s,
recovery resolved at t=10 s; at t=14 s the textbox still reads "half a sentence
I was still writing when recovery landed" and the screen is still the capture
screen.

**A pending or failed outcome offers no Retry**
(`qa28-rerun-pending-filing-offers-no-retry.png`). Every button on screen, both
cases:

```
pending:  [ "c3lew/quacket-qa-target Ctrl+R", "Issues", "", "", "Add screenshot", "Refine Ctrl+Enter" ]
failed:   [ "c3lew/quacket-qa-target Ctrl+R", "Issues", "", "", "Add screenshot", "Refine Ctrl+Enter" ]
full page text, both cases:
  "Quacket c3lew/quacket-qa-target Ctrl+R Issues Add screenshot Refine Ctrl+Enter"
```

(The two empty labels are the icon-only Settings and Hide-to-tray buttons.)

---

## Regression suite

`npx tsc --noEmit` clean; `npx vitest run` — 30 files / 768 tests, all passing.
