# Live QA: first real run of the assembled app + the submit write leg

2026-07-16. Environment: Windows 11, `claude` 2.1.211 (claude.exe, Max), `codex-cli`
0.144.4 (npm .cmd shim), `gh` 2.90.0 authed as c3lew, Node 24.14.1, Rust 1.95.0.
Target: `c3lew/quacket-qa-target`, a **throwaway private repo created for this QA**.
Everything below was executed, not reasoned about. This is the first time the
assembled app was ever launched, and the first time anything was written to a real
GitHub repo.

## Part 1 — submit write leg, headless (real `createGitHub` over `node:child_process`)

Driven by a throwaway vitest probe (deleted after; its checks are listed here because
the transcript is the evidence). **16/16 green** after two QA-probe corrections:

| Check | Result |
|---|---|
| `checkAuth` ok; `listRepos` includes the push-access target | PASS |
| `uploadImages` fills `uploadedUrl`, SHA-pinned (40-hex) | PASS |
| `submit` creates a real issue; title lands verbatim | PASS |
| `bug` label applied (existing label only) | PASS |
| Private repo → blob **link**, no dead inline embed | PASS |
| No marker/footer in body text (URLs excluded — see below) | PASS |
| No empty scaffolding (no bare `##`) | PASS |
| Comment path: full report as comment on the same issue | PASS |
| Retry with `uploadedUrl` set: **zero** gh spawns, same URL | PASS |
| `quacket-assets` branch exists | PASS |

Probe corrections (probe bugs, not product bugs): the no-marker scan must exclude
URLs (the repo is literally named `quacket-qa-target`, and `.quacket/assets/` is the
spec-decided path); and Node 24's type stripping cannot import the repo's TS
(parameter properties), so the probe ran under vitest instead.

## Part 2 — the assembled app, driven as a user

`npm run tauri dev`, then real input injection (SendKeys/clipboard/mouse) with a
screenshot verified at every stage:

1. **Global hotkey** Ctrl+Shift+Q summoned the palette instantly. Tray alive.
2. **First-run onboarding** rendered with LIVE enumeration: Claude 2.1.211
   (account + 5 models), Codex 0.144.4 (account + 7 models). The gh card was
   correctly absent (gh healthy). Model picker honestly said "Choose a model".
3. Clicking **Use Claude Code** collapsed onboarding into the capture box —
   `settings.json` written (`model: "default"`, a real enumerated id).
4. **Clipboard paste of mixed CJK/EN text** landed intact (the image paste handler
   does not swallow text paste).
5. **Refine** — first attempt FAILED instantly (defect #1 below). After the fix,
   vite HMR reloaded the webview and the **draft restored silently in place**
   (stories 29–30 observed live). Retried refine: real `claude` call →
   **clean English draft**: type Bug, symptom title ≤70 chars, Repro/Expected/
   Actual sections, Environment = "Windows 11" (mentioned in the input, so its
   presence is not fabrication; both observations from the messy dump survived).
6. **Submit** → done screen "Issue #4 filed" + Open in browser + New report →
   [real issue](https://github.com/c3lew/quacket-qa-target/issues/4) with the
   `bug` label and exactly the sections above. No Quacket marker anywhere.
7. **Draft slot freed on confirmed success** — the drafts folder is gone from
   the app data dir. Discovery caches + settings persisted (runtime fs ACL works).

## Defects found (all fixed same-day, each with a fails-without-the-fix test)

1. **Every text-only Claude refine died instantly in the shipped app.** The
   spawn's cwd `$TEMP/quacket` was never created: `createServices` computes the
   path, nothing mkdirps it, and the no-image path touches nothing else on the
   fs. Every test had injected an mkdtemp'd base that already existed. Codex
   survived only because it mkdirps its own session dir. Fix: `claude.ts`
   mkdirps its cwd (idempotent; survives temp cleaners). This is the same
   "tested from the code instead of from reality" class as round 4's findings.
2. **Empty repo (zero commits) → generic upload error.** The whole Git Data API
   answers `409 Git Repository is empty` (real transcript captured into
   `github.test.ts`). Live-probed the Contents-API alternative: it works, **but
   on an empty repo the branch it creates becomes the default branch** — the
   user's brand-new project would be fronted by a Quacket assets README. Fix:
   plain-language refusal ("no commits yet…") routing to [File without images].
3. **`lastRepo` never persisted by a successful submit** (story 16). Only the
   Ctrl+R switcher wrote it; filing against the `repos[0]` default left it null
   forever, and `repos[0]` reorders as other repos are pushed. Fix: submit
   success commits the target as last-used.

## Observed, left open (deliberately)

- Footer picker labels crowd/overlap at rest width — cosmetic.
- A spawn-level failure showed the generic "Something went wrong." banner rather
  than a taxonomy message. The mkdirp fix removed the only known trigger, but the
  fallback path is still generic.
- ~~Suspected (UNTESTED)~~ **CONFIRMED AND FIXED (same day, follow-up session):
  double-clicking the tray icon toggled the window twice.** Verified by
  instrumenting `on_tray_icon_event` and driving a real double-click on the real
  tray icon (located via UIA in the Win11 overflow flyout). The captured
  delivery: `Click{Down}` → `Click{Up}` → `DoubleClick`(+129 ms) → `Click{Up}` —
  the second PRESS becomes `WM_LBUTTONDBLCLK` but the second RELEASE still
  arrives as a plain `Click{Up}`, so toggle-on-every-Up ran twice. Fix:
  `tray_gate.rs` — a click gate that acts on the first `Click{Up}` and swallows
  any further `Click{Up}` inside the user's real `GetDoubleClickTime()` interval
  (not a hardcoded 500 ms; accessibility settings can raise it to 900 ms).
  Single-click stays zero-latency; double-click toggles ONCE. Acceptance was
  live, both directions, with gate decisions logged: hidden + double-click →
  `admitted=true(show)`, `admitted=false(swallowed)`, window visible and stays;
  visible + double-click → hidden. 4 unit tests pin the gate, including the
  captured 129 ms tail and a triple-click burst (the swallowed tail must not
  extend the window, or a click-happy user locks themselves out).

  Two things this investigation also settled: a **manual** launch (no
  `--hidden`) deliberately shows the window at startup (`lib.rs` setup) — that
  is design, not a bug, but it invalidated every "fresh instance = hidden" test
  assumption until spotted; and the earlier "double-click seemed fine" pre-fix
  observation was the overflow flyout's light-dismiss racing the second click,
  which is why flyout icons flaked while a pinned icon would fail reliably.
- Still untested: the tray tooltip has no version (the spec puts the version in
  the tray MENU, which exists — `Quacket v0.1.0` — but was not opened in this QA).

## Part 3 — codex in-app + the follow-up second turn (same day, follow-up session)

Driven through the real app exactly like Part 2. The chain: footer AI picker →
Codex (model auto-followed to `GPT-5.6-Sol`, thinking `medium` — the round-5
provider-switch fix, live) → **Ctrl+R repo switcher** (fuzzy "qa", match
highlighting, Private badges, Current badge — all correct) → pasted a
deliberately vague CJK/EN report ("捲動列表的時候有時候會卡一下 scroll lag??…")
→ refine via live `codex exec`.

Turn 1 came back exactly per contract: type bug, title "Scrolling sometimes
lags in long lists", **only** Repro steps + Actual (nothing else was mentioned —
no-fabrication held on a live codex model), three sharp follow-up questions,
empty `similar_issues` (the repo's tray issues are genuinely unrelated).

Answered ONE question in the draft UI ("the recent-sent list on the done
screen, around 200 items"), skipped the rest, submitted. The submit ran the
**`codex exec resume` second turn in the real app** and the fold-in is visible
in the filed result ([issue #5](https://github.com/c3lew/quacket-qa-target/issues/5)):
title sharpened to "Recent-sent list scrolling lags around 200 items", the
answer integrated INTO Repro steps (not appended as Q&A), the two skipped
questions invented nothing, `bug` label applied, draft slot freed on success.
`settings.json` afterwards: `lastRepo`, `provider: codex`, `model:
gpt-5.6-sol`, `effort: medium` all persisted.

## Part 4 — the rest of the surfaces (same day, follow-up session)

All driven through the real app. Everything below passed unless flagged.

- **Settings page** — opened via the gear; two groups (AI / App), live account
  line, all pickers populated. **This is where a real bug surfaced (below).**
- **Autostart toggle** — checking "Start with Windows" wrote
  `HKCU\…\Run\Quacket = "…\quacket.exe --hidden"` (the `--hidden` flag is the
  design: an autostarted launch comes up tray-only); unchecking removed the key.
  Verified against the real registry, both directions.
- **Issue list view** — "Issues" showed all open issues with #number, title,
  `bug` chip, relative time, updatedAt-desc order, and a per-row open-in-browser
  icon. Live `gh` fetch.
- **Similar-issue card, true positive** — typed a tray-vanish report against a
  repo holding three lookalikes; refine returned all three in `similar_issues`
  with per-candidate reasons; the inline card rendered (non-blocking, Submit
  still primary = files new if ignored). Selecting #3 flipped the button to
  **"Comment on #3"**; submitting posted the report as a comment on #3 with **no
  new issue created** (latest stayed #5), no marker, and the done screen read
  **"Added to issue #3"** (not "Issue filed"). One action switches back.
- **Annotation editor** — clicking a thumbnail's Edit widened the window and
  opened the canvas editor. Pen (freehand red stroke) and Circle (red ellipse)
  both drew; Ctrl+Z removed the last shape; Done flattened (destructive v1),
  narrowed the window back, and the thumbnail gained a **"✓ Marked" badge**.
- **Discard** (Ctrl+Shift+D) — cleared the palette AND deleted the draft folder
  on disk. The only route that loses a draft.
- **Esc mid-submit** — submitted, then pressed Esc ~250 ms later (window hid
  mid-send). Issue #6 still landed on GitHub — the submission continued in the
  background — and the draft slot freed only on that confirmed success.
- **NSIS installer** — `npx tauri build` produced
  `Quacket_0.1.0_x64-setup.exe` (2.1 MB) plus a valid minisign updater
  signature (`.sig`). First time the installer was ever built. `latest.json` is
  a CI artifact (dist ticket #13), not a local one.

### The bug this session found: a transient codex enumeration failure was cached as "codex vanished"

Opening Settings showed a red banner — *"Codex is not available any more, so
Quacket switched to Claude Code"* — while codex was demonstrably working (Part 3
had just refined with it). Root cause, traced live:

- `discovery-cache.codex.json` held `account: null, models: []` — an empty
  offering — while `codex login status` and a direct `codex app-server`
  `model/list` probe both worked fine (the catalog returns in ~120 ms).
- `discovery.ts`'s codex fallback returned that empty offering with
  `cacheable: true` on ANY enumeration throw (a slow app-server boot, a parse
  hiccup), so one transient failure froze "codex has no models" for the 24 h
  TTL. `reconcileSettings` then reads empty-models as "provider vanished",
  fires the story-38 notice, and switches a codex user to Claude — stuck for a
  day.
- The claude path already got this right (`cacheable: false` on a broken
  probe, with a comment saying exactly why); the codex path didn't honor its
  own rule. **Fix:** a codex fallback is cacheable only when version-GATED (a
  stable fact), never when enumeration was attempted and threw. Pinned by two
  tests (a threw enumeration re-enumerates next call; a gated one caches),
  mutation-verified.

## Still never exercised

The updater's actual self-update (endpoint is a placeholder `quacket.invalid`;
needs a published release to exercise download→verify→apply); installing from
the built NSIS `.exe` and the SmartScreen prompt; multi-day tray soak (survival
across an explorer restart, idle memory); and the background-failure OS
**notification** specifically (Esc-mid-submit was verified on a SUCCESS; a clean
live failure while hidden is hard to stage without breaking the network — the
notify-on-failure path stays unit-verified, round 2/3).
