# Walkthrough evidence — slice #28

Everything below was observed against real `gh`, a real private GitHub repo
(`c3lew/quacket-qa-target`) and a real disk. Faults were injected at one of two
seams only: a single `gh` call's result, or a single filesystem method. The full
console log is `leg-a-real-gh.log`; the browser observations are the three PNGs
in this directory.

Vocabulary used by the app under test: a *Filing* is one submission attempt; it
carries an opaque identity written into the remote body as an invisible HTML
comment. Startup reconciliation walks unfinished Filings and reports each as
`checking` → one of `filed` / `pending` / `failed`.

---

## Acceptance sentences under test

1. As a user, I want the app to recover a report when GitHub accepted it but the
   app crashed before receiving or saving the response, so that I do not have to
   inspect GitHub manually.
2. As a user, I want the app to verify an ambiguous Filing against GitHub before
   retrying it, so that it never retries merely because a local response was lost.
3. As a user, I want a matching Filing identity to restore the report as Done, so
   that a recovered remote success has the same outcome as a normal success.
4. As a user, I want an authoritative no-match to resume the same Filing
   automatically, so that the app completes the Submit action I already requested
   without another decision.
5. As a user, I want an offline, unauthenticated, or otherwise unavailable GitHub
   check to leave the Filing pending, so that uncertainty is not mistaken for
   failure.
6. As a user, I want retryable failures distinguished from ambiguous outcomes, so
   that the app never presents Retry while duplicate safety is unknown.
7. As a returning user, I want startup recovery to run automatically, so that
   interrupted Filings progress without requiring me to understand recovery
   machinery.
8. As a returning user, I want startup recovery to leave capture usable while
   GitHub is slow, so that restoring an old report does not recreate the original
   interruption cost.
9. As a returning user, I want a durable Filing receipt to restore the Done state
   after a crash, so that terminal success remains terminal across restarts.
10. As a returning user, I want pending cleanup work to resume independently after
    restart, so that local debris does not require manual maintenance.

Also stated as acceptance criteria on the ticket:

- A `failed` result is emitted only when durable evidence proves no issue or
  comment was created, making Retry safe.
- A resumed create that loses its outcome again returns the Filing to `pending`.
- A match is established by exact marker verification and returns the URL and
  issue number the receipt needs — never a fuzzy title or body match.

---

## S1 — GitHub accepted the report, then the crash

Setup, identical in both runs below: the report is submitted for real and GitHub
accepts it. The receipt write and the workspace cleanup are then both made to
fail, which is what a process dying between "GitHub said yes" and "we wrote it
down" leaves on disk. Disk afterwards, in both runs:

```
{ "state": "filing", "receipt": null }
```

### S1a — the app is relaunched immediately (0 ms later)

GitHub accepted the report as **issue #58**. Startup recovery then ran:

```
events:
  { "state": "checking" }
  { "state": "filed", "receipt": { "url": ".../issues/59", "issueNumber": 59,
                                   "title": "QA28 S1 issue 0 ...", "repo": "c3lew/quacket-qa-target" } }

gh calls made during recovery:
  api user
  api repos/c3lew/quacket-qa-target/issues?state=all&creator=c3lew&per_page=100&page=1
  label list --repo c3lew/quacket-qa-target --limit 100 --json name
  issue create --repo c3lew/quacket-qa-target --title "QA28 S1 issue 0 ..." --body-file - --label bug
```

Read back from GitHub afterwards, filtered on the Filing's hidden identity:

```json
[{"number":59,"created_at":"2026-08-15T17:29:00Z","title":"QA28 S1 issue 0 1786814932770"},
 {"number":58,"created_at":"2026-08-15T17:28:56Z","title":"QA28 S1 issue 0 1786814932770"}]
```

Two issues with the same title and the same hidden identity, four seconds apart
(that read-back was taken minutes later; the immediate read-back in the log shows
only #58, because the same lag hides #59 from the listing at first). The receipt
the user is shown points at #59; #58 is not referenced anywhere.

This run is the one recorded in `leg-a-real-gh.log`. The same scenario was run
three times in total during this session and produced a duplicate every time.

Supporting measurement, taken separately with `gh` alone (no app involved): after
`gh issue create` returns, the same listing endpoint recovery reads does not yet
contain the new issue for several seconds.

```
round 1: create returned in 1167 ms; issue visible in
         issues?state=all&creator=… after 4339 ms; in issues?state=all after 5220 ms
round 2: create returned in 1468 ms; visible after 6897 ms / 7786 ms
```

Comment listings were measured the same way and were visible within ~2 s of the
create call starting (i.e. roughly as soon as the create returned).

### S1b — the app is relaunched 20 s later

Same crash, same setup. GitHub accepted the report as **issue #60**.

```
events:
  { "state": "checking" }
  { "state": "filed", "receipt": { "url": ".../issues/60", "issueNumber": 60,
                                   "title": "QA28 S1 issue 20000 ...", "repo": "c3lew/quacket-qa-target" } }

gh calls made during recovery:
  api user
  api repos/c3lew/quacket-qa-target/issues?state=all&creator=c3lew&per_page=100&page=1
```

No create call. Issues on GitHub carrying this identity: exactly one, #60.

### S1c — the same crash, but the report was a comment on an existing issue

```
events:
  { "state": "checking" }
  { "state": "filed", "receipt": { "url": ".../issues/37#issuecomment-5303399930",
                                   "issueNumber": 37, "target": {"kind":"comment","issueNumber":37},
                                   "title": "QA28 S1 comment ..." } }

gh calls during recovery:
  api repos/c3lew/quacket-qa-target/issues/37/comments?per_page=100&page=1
```

Comments on GitHub carrying this identity: exactly one.

---

## S2 — the report never reached GitHub

The submit died at the create call, so nothing was created remotely (verified: 0
issues carried the identity before recovery ran). Recovery, on the next launch:

```
events:
  { "state": "checking" }
  { "state": "filed", "receipt": { "url": ".../issues/61", "issueNumber": 61,
                                   "filingId": "fil_qa28_s2_...", "title": "QA28 S2 no-match ..." } }

gh calls during recovery:
  api user
  api repos/…/issues?state=all&creator=c3lew&per_page=100&page=1
  label list …
  issue create …            (exactly one)
```

Issues on GitHub carrying this identity afterwards: exactly one, #61. The Filing
identity in the receipt is the same one the interrupted submit used. The
workspace was removed afterwards. No user decision was requested.

---

## S3 — the GitHub check could not be completed

Seven independent runs, each with one thing wrong with the lookup. In every case
the report had NOT been created remotely beforehand.

| what went wrong | events | gh calls during recovery |
|---|---|---|
| offline (`api` exits non-zero, DNS failure) | `checking` → `pending` "Could not confirm which GitHub account is signed in." | `api user` |
| not authenticated (HTTP 401) | `checking` → `pending` "Could not confirm which GitHub account is signed in." | `api user` |
| rate limited (HTTP 403) | `checking` → `pending` "Could not check GitHub for this report." | `api user`, one listing page |
| malformed page (exit 0, body is not JSON) | `checking` → `pending` "Could not check GitHub for this report." | `api user`, one listing page |
| empty output, exit 0 | `checking` → `pending` "Could not check GitHub for this report." | `api user`, one listing page |
| pagination interrupted (page 1 full, page 2 fails) | `checking` → `pending` "Could not check GitHub for this report." | `api user`, page 1, page 2 — then it stops |
| every page comes back full, so the listing never ends (the walk hits its own page cap) | `checking` → `pending` "Could not check GitHub for this report." | `api user`, pages 1–100 |

In all seven: no create call of any kind, and a read-back of GitHub found zero
issues carrying the identity. The report stayed on disk with a record of when and
why the check failed, e.g.

```json
{ "message": "Could not check GitHub for this report.", "at": "2026-08-15T17:29:57.162Z" }
```

In all of them, immediately afterwards, a brand-new report was captured and filed
successfully while the old one was still pending (issues #62–#67).

---

## S4 — the boundary between "failed" and "still unknown"

**A resumed Filing that dies while uploading a screenshot.**

```
events:
  { "state": "checking" }
  { "state": "failed", "kind": "upload_failed", "message": "Could not upload an image to this repo." }

gh calls: api user, listing page, assets branch ref, one PUT (the upload, which failed)
```

Read-back: zero issues on GitHub carry this identity — nothing was created.

**A resumed create whose outcome is lost again (the create timed out).**

```
events:
  { "state": "checking" }
  { "state": "pending", "message": "Could not create the issue. GitHub took too long to respond." }
```

What that leaves on disk, and what the launch after it does:

```
on disk:  { "state": "failed",
            "lastFailure": { "kind": "create_failed",
                             "message": "Could not create the issue. GitHub took too long to respond." } }

the next launch (GitHub unavailable this time):
  { "state": "checking" }
  { "state": "pending", "message": "Could not check GitHub for this report." }
```

So the stored word is `failed`, while both the stream that reported it and the
next launch that read it treat the Filing as unresolved: the next boot asked
GitHub again rather than acting on the stored word. No screen was observed in
this scenario, so what the palette shows for a `pending` or `failed` Filing —
including whether a Retry button appears — is not covered by this walkthrough at
all.

---

## S5 — a durable receipt across a restart, and stuck local cleanup

A report was filed for real (**issue #68**); deleting its workspace afterwards was
made to fail, so local debris was left behind.

```
after the failed cleanup:
  { "state": "filed", "cleanup": "pending",
    "cleanupFailure": { "message": "injected remove failure",
                        "at": "2026-08-15T17:30:20.448Z", "attempts": 1 } }

next launch, disk still broken:
  events: [ { "state": "filed", "receipt": { "url": ".../issues/68", "issueNumber": 68,
                                             "title": "QA28 S6 stuck cleanup ...",
                                             "repo": "c3lew/quacket-qa-target" } } ]
  cleanupFailure: { "at": "2026-08-15T17:30:20.448Z", "attempts": 2 }   ← same first-failure time

next launch, disk healthy:
  events: [ { "state": "filed", "receipt": { …/issues/68 } } ]
  gh calls during that launch: []      ← none at all
  workspaces left on disk afterwards: []
```

---

## S6 — recovery while GitHub is unresponsive

The recovery lookup was made to never return. While it was still in flight:

```
{ "recoveryEvents": ["checking"], "recoveryFinished": false,
  "filedAnyway": "https://github.com/c3lew/quacket-qa-target/issues/69", "tookMs": 2589 }
```

A brand-new report was captured and filed to GitHub in 2.6 s while recovery was
still hanging.

A workspace whose own record is corrupt on disk:

```
events: [ { "state": "pending", "message": "Could not read this report on this computer." } ]
```

The recovery pass ended normally rather than raising an error, and the workspace
was left untouched.

---

## S7 — the palette itself, driven in a browser

The real UI was mounted in a browser and driven by a person-equivalent script;
recovery was scripted to produce the events above at a chosen moment.

**A recovered report arriving on an untouched palette** (screenshot
`qa28-story30-recovered-done.png`). Text on screen sampled every 60 ms:

```
t=66ms    Quacket · c3lew/quacket-qa-target · Issues · [Add screenshot] [Refine]
t=2591ms  Quacket · c3lew/quacket-qa-target · Issues · Issue #57 filed ·
          Tray icon disappears after unlocking Windows · c3lew/quacket-qa-target
          [Open in browser] [New report]
```

The capture box was on screen and usable for the whole 2.6 s before the recovered
report appeared. Nothing had to be clicked to start recovery.

**GitHub never answers** (screenshot
`qa28-story29-capture-usable-while-github-hangs.png`). With the recovery lookup
hanging forever, the capture box accepted typing normally and the Refine and
Discard actions were present:

```
textbox "What broke? Type it however it comes out." → "tray icon vanished after I unlocked windows"
disabled: false, readOnly: false
```

**A recovery landing while the user is mid-sentence** (screenshot
`qa28-recovery-does-not-steal-a-half-typed-report.png`). The user typed "the
update banner shows the wrong version"; the recovered report resolved 10 s later.
Twelve seconds after that:

```
textarea still present, value = "the update banner shows the wrong version"
screen = the capture box (not the done screen)
```

The typed text was untouched. The recovered report did not appear on screen in
this case.

**What the palette shows for a report recovery could NOT resolve** (screenshot
`qa28-pending-filing-offers-no-retry.png`). Recovery was scripted to end in
`pending` ("Could not check GitHub for this report."), and separately in `failed`
("Could not upload an image to this repo."). Four seconds after each landed, every
button on screen was enumerated:

```
pending:  ["c3lew/quacket-qa-target", "Issues", "", "", "Add screenshot", "Refine"]
failed:   ["c3lew/quacket-qa-target", "Issues", "", "", "Add screenshot", "Refine"]
buttons matching /retry|try again/i: none, in either case
```

In both, the screen is the ordinary capture box: no Retry, and in fact no mention
of the unresolved report at all.

Browser console errors across all runs: one, a 404 for `/favicon.ico`
(the harness page has no icon). No application errors.

---

## Regression suite

The project's own test suite, run before the walkthrough and unrelated to the
harness below: `npx vitest run` — 30 files, 764 tests, all passing. `npx tsc
--noEmit`: clean.

The walkthrough harness itself ends 15 passed / 1 failed; the failure is the S1a
duplicate above, asserted as `expected [['issue','create',…]] to deeply equal []`.
