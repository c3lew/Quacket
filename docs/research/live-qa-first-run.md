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
- Suspected (UNTESTED — reported in the QA issue itself, then noticed it might be
  real): double-clicking the tray icon probably toggles the window twice
  (open-then-close reads as "nothing happened"); the tray tooltip has no version
  (the spec puts the version in the tray menu — the menu was not opened in this QA).

## Still never exercised

Codex refine in-app; the follow-up second turn in-app; annotation editor on a
real canvas; Esc-mid-submit + background-failure OS notification in the real
window; similar-issue card with live candidates; issue list view; repo switcher;
settings page; updater; autostart toggle; NSIS installer; multi-day tray soak.
