# Quacket

A desktop bug-reporting palette for Windows. Press a global hotkey anywhere, dump a
half-formed complaint and a screenshot into a small window, and Quacket uses a
locally-installed AI CLI to refine it into a structured GitHub issue and file it
with `gh`.

The point is the **capture**: bug reports die because filing one interrupts what you
were doing. Quacket makes filing cost one hotkey and one paragraph. It brings no AI
API key and no server — it drives the `claude` / `codex` CLIs the user has already
installed and authenticated, and files through the user's own `gh`.

## Status

All five gates are green (see [Running it](#running-it)). The stdin blocker that
made submit structurally dead is **fixed**: Quacket spawns through its own Rust
command, which closes stdin and can kill a timed-out child (proven against real
processes). Round 3 fixed the two defects that made the app unusable rather than
merely wrong — a first run could never reach the capture box, and a dropped
screenshot from outside `$HOME` was denied by the fs scope.

**Round 4 was the first time any of this met a live CLI, and that is what round 4
is for.** Three things came back that no test in this repo could have found, and
one of them was a blocker:

- **Every Codex refine failed to spawn on Windows** — the prompt went as argv, and
  Rust refuses to spawn a `.cmd` shim (which is how npm ships `codex`) with any
  newline-containing argument. The prompt is multi-line by construction, so this
  fired on **100%** of Codex refines. Fixed: the prompt goes on stdin.
- **`--ignore-user-config` was missing** though the spec pins it, so the user's
  `~/.codex/config.toml` steered every refine — including spawning their `notify`
  hook. Fixed; measured 26 226 → 20 418 input tokens.
- Two of the three "inferred from docs, not verified" adapter assumptions came back
  **CONFIRMED**; one came back a **MISMATCH** and is fixed. See
  [What live verification settled](#what-live-verification-settled).

Round 4 also closed the last data-loss hole in the image path: **both** producers of
it, intake and annotation, now write bytes before state (blockers #5 and #5b).

**Round 5 was about one defect that keeps moving, and it is now structurally
prevented rather than fixed again.** A `<select>` whose `value` matches no
`<option>` shows `option[0]`, reads it back, and fires no change when the user
picks what is on screen. It had been found and fixed FOUR times in three rounds,
each fix scoped to the file it was found in — so each round found it in the next
file. It is the platform primitive's default, not carelessness, so every new
surface inherits it free. `Picker.tsx` is now the only file allowed to write one
and `raw-select.guard.test.ts` fails the build on a second (AST-based, so the
repo's prose about `<select>` does not trip it). Round 5 also fixed the
first-run card discarding its own effort pick, and made the in-flight mark the
draft store's own bracket instead of a boolean every caller asserted. That
bracket has since been superseded outright by the Filing transaction — see
[Filing](#filing) — which removes the need for a draft to have an in-flight
state at all.

**The same "fixed per-file, so it moved" shape was found a third time during
integration, one layer below the UI**, and is fixed with the two halves joined:
the card's effort reached `services.refine`, and the adapters turned `effort`
into argv, but the single line carrying it between them
(`components/services.ts`) was executed by **no test** — `createUiServices` is
built only in `main.tsx`, and `App.test.tsx` imports just its type. Replacing it
with `effort: null` silently disabled reasoning effort app-wide, on every refine,
for both providers, and left the whole suite as it then stood (669 tests) and
`tsc` green. Measured, then pinned by `components/services.test.ts` (blocker #8).

What is left unsettled is named below and nowhere else. Nothing here is
aspirational — if it is described here, it exists, and every number was measured.

## The two seams, and why they are the only ones

Quacket's core is pure TypeScript that **cannot touch the machine directly**.
Everything the outside world provides arrives through exactly two injected ports:

| Port | File | Implementation |
| --- | --- | --- |
| `ProcessRunner` | `src/core/runner.ts` | `src/app/runner.ts` → our own `src-tauri/src/proc.rs` |
| `FileStore` | `src/core/files.ts` | `src/app/files.ts` (tauri-plugin-fs) |

**Why these two and nothing else.** Quacket's entire outside world is three CLIs
(`claude`, `codex`, `gh`) and a disk. Processes were always going to need a seam —
you cannot unit-test "did we pass `-s read-only`" against a real `codex`. The
filesystem needed one for a second reason: **the core runs inside a WebView2
renderer, which has no Node**. `node:fs` imports type-check happily and then fail
at `vite build`, or worse, at runtime. Injecting both ports means core modules are
honest about what they need, tests drive real behaviour with no host mocking, and
the files that know Tauri exists are quarantined at the edge — `src/app/` plus
`src/ui/main.tsx`, which is the platform entry point. Nothing under `src/core/`, and
no `.tsx` below `main.tsx`, imports a host API.

**Why a port rather than importing `@tauri-apps/plugin-fs` in core.** That swaps one
hard host dependency for another and drags Tauri IPC mocking into every test that
currently does honest disk I/O. Under injection, `src/core/drafts/store.test.ts`
writes real files to a real temp dir through `nodeFiles` — a draft that survives a
simulated crash actually round-tripped a disk.

Two deliberate consequences:

- **`FileStore` is not a mirror of `node:fs`.** Reads return `null` for "not there"
  instead of throwing a host-specific errno, because core must never sniff
  `e.code === 'ENOENT'` (plugin-fs does not speak Node's dialect). `remove` is
  recursive and idempotent. Every caller wanted both anyway.
- **`joinPath` is pure and always emits `/`.** Windows accepts forward slashes at
  the syscall level in both Node and Rust, so one separator works everywhere and
  keeps joined paths comparable in assertions.

**The rule:** nothing under `src/core/` may import `node:*`, `child_process`,
`@tauri-apps/*`, or any process/filesystem API. Enforced by review and by
`vite build` — a `node:` import in core fails the build loudly.

## Filing

Submitting is **one transaction**, owned by `core/filing/`, not a pipeline the
caller assembles. It exists because of one failure a user cannot recover from on
their own: GitHub accepts the report, Quacket loses the answer, and the app shows
a Retry that would file it twice.

What `file()` guarantees, in the order it happens:

1. **Identity before any remote write.** A Filing gets a stable, opaque id, and
   that id goes into the remote body as a hidden HTML comment
   (`<!-- quacket-filing: … -->`). Nothing visible: no branding, no footer. It is
   exact text, so a later run can find the report it created rather than guess
   from a title.
2. **Ownership by rename.** `DraftStore.handoff` flushes its write queue, writes
   the final draft.json (the follow-up answers land here or nowhere) and MOVES
   the whole draft directory into `<appdata>/filings/<id>/draft/`. One rename on
   one volume: no screenshot is copied, and the report is frozen — later typing
   and later screenshots cannot reach what is being written.
3. **Terminal success.** The submit is over the instant GitHub accepts the
   report. The receipt is then written to `<appdata>/filings/<id>/filing.json`
   and the workspace deleted, but neither of those is what makes it filed:
   nothing after the remote write — a failed receipt write, a failed cleanup —
   can turn a filed report back into a retryable failure, because a retry after
   acceptance is a second report. A lost receipt write costs the MEMORY of the
   outcome across a restart, not the outcome; for as long as the process lives,
   a resume of that identity still returns the receipt rather than filing again.

A pre-terminal failure throws a `FilingError` carrying the id, and the only safe
way to try again is to RESUME it: `file({kind: 'resume', filingId, decision})`,
where the decision is the user's own — Retry or File without images. A second
`{kind: 'new'}` would be a second report.

Consequences worth knowing:

- **A filing workspace is not a draft.** It does not consume the single-draft
  slot, so several pending cleanups and the active capture surface coexist.
- **The auto-save stops the moment a Filing owns the report**
  (`filingOwnsDraft`). Not a nicety: writing under the old draft id after the
  handoff would recreate a directory whose manifest lists screenshots whose bytes
  now live elsewhere, which `readDraftDir` calls corruption and throws on.
- **An upload is remembered, not repeated** (#27). Each confirmed upload writes
  an Asset receipt into the Filing snapshot before the next one starts, keyed by
  repository, media type and a SHA-256 of the exact bytes — so a retry re-sends
  only what never landed, and annotated bytes are a different asset rather than a
  stale reuse. The key deliberately is not the image id: an id survives
  annotation, the bytes do not. Receipts live in the Filing that earned them;
  nothing shares them between Filings, because nothing needs to yet.
- **Startup reconciles what a crash left behind** (#28). `recover()` walks every
  Filing workspace on disk and streams `checking` / `filed` / `pending` /
  `failed` — a stream, not a summary, so a slow GitHub costs a status line and
  never the capture box. The three facts it distinguishes are the whole design:
  an exact marker match reconstructs the receipt with **no second create call**;
  an authoritative no-match (a complete, parsed pagination of the repo's issues
  or the issue's comments with the identity absent) resumes the SAME Filing,
  because the user already pressed Submit; anything else — offline, signed out,
  rate limited, malformed, interrupted, empty-handed — is `pending`, which never
  creates remotely and never offers a Retry. `failed` is emitted only with
  durable evidence that nothing was created (a resume that died on the upload
  leg, which runs strictly before the create), so a Retry cannot duplicate.
  Indexed GitHub search is deliberately unused: it can find a report but its lag
  means it can never prove one is absent.
- **A no-match is only believed once the create has settled** (#37). The listing
  endpoints lag too — measured against real `gh`, an issue took up to 6.9 s to
  appear in `issues?state=all&creator=…`, comments ~2 s — so "complete listing,
  marker absent" is not the same fact as "not on GitHub", and reading it as one
  filed the user's report twice. So the Filing stamps `attemptedAt` the instant
  before it asks GitHub to create, and reconciliation waits out the remainder of
  a 15 s window BEFORE it looks: one request, and whatever it says is worth
  believing. A create that cannot be dated — no stamp, an unparseable one, a
  clock that moved backwards — waits the full window rather than none.
- **A pending cleanup drains on that same pass** (#33), and a stuck one records
  when it first failed and how many times it has been tried — `updatedAt` moves
  on every write, so it could not tell the first failure from the fifth.
- **A receipt is self-sufficient.** It carries the repo, the target and the
  title, not just the URL: the workspace holding the report is deleted when
  cleanup succeeds, so a recovered Done screen has nowhere else to read them
  from. Both paths build the done row from the receipt (`receiptEntry`).
- **The palette shows a recovered report as Done only on an untouched capture
  box.** Recovery races the user; replacing what they are typing with a done
  screen would be the interruption Quacket exists to avoid. The non-blocking
  previous-report status with Check again is #29, still open.

## Module map

Core is headless and host-agnostic. UI is a renderer over a pure reducer.

```
src/core/                     no IO, no DOM — everything injected
  types.ts                    the domain. Draft, RefinedDraft, ImageAttachment,
                              ProviderCapabilities, Settings, ProviderError.
                              Every shared type comes from here.
  runner.ts   files.ts        the two seams (interfaces only)
  testing/
    fake-runner.ts            scripted ProcessRunner for tests
    node-files.ts             REAL FileStore on node:fs — tests only, never bundled
  llm/          69 tests      claude.ts / codex.ts adapters: argv, stdin, stream
                              parsing, error taxonomy. Hands back the RAW model
                              object; does not interpret it.
  refine/      102 tests      prompt.ts / schema.ts / parse.ts: what we ask for and
                              how the answer becomes a RefinedDraft.
  discovery/    45 tests      which models/efforts each CLI offers, live-enumerated,
                              cached 24h per provider. No hardcoded model list.
                              Only a probe's 404 may hide a model — a probe that
                              merely BROKE degrades to the CLI default, uncached.
  github/        4 tests      GitHub DISCOVERY only: `gh auth status`, the repo list,
                              the open-issue list. Every `gh` WRITE moved to filing/.
  filing/       77 tests      the Filing transaction: one verb (`file`) from a final
                              draft to a durable receipt. Assigns an opaque identity
                              before the first remote write and carries it in the
                              body as a hidden HTML comment; takes the draft
                              directory by an atomic rename; uploads, renders and
                              creates; and writes the receipt to disk. Neither that
                              write nor the cleanup after it can turn a filed report
                              back into a retryable failure. `recover()` is the
                              second verb: it streams what a crash left behind,
                              deciding filed / resume / pending from an exact
                              marker lookup (lookup.ts), never a fuzzy title.
                              renderSection is the one place section markdown is
                              produced, so the
                              no-fabrication rule is enforced where it cannot be
                              bypassed: an emptied section is dropped, not headed.
  drafts/       15 tests      auto-save from the first keystroke; nothing is lost
                              except by discard or a confirmed submit. `handoff` is
                              the one way a draft leaves: it flushes the write queue,
                              writes the final draft.json, and RENAMES the directory
                              into a Filing workspace. No copy, and no draft is ever
                              in two places.
  ui/           94 tests      reducer.ts (pure stage machine; effects come back as
                              data) + onboarding.ts. `MachineState` (gh + providers)
                              is split from `DetectedState` on purpose: it is exactly
                              the part no palette control can change, so the cards
                              derive from re-detected machine state and settings live
                              in one place. Storing the whole snapshot is what made
                              first run inescapable.
  files.test.ts  6 tests      joinPath

src/app/                      Tauri-aware host layer (with src/ui/main.tsx)
  runner.ts     22 tests      ProcessRunner over our own quacket_run / quacket_spawn
  files.ts                    FileStore on tauri-plugin-fs
  services.ts                 composition root: resolves real dirs, wires core

src/ui/                       React. Renders the reducer, performs its effects.
  main.tsx                    entry: builds Platform, composes both service layers.
                              The one .tsx that imports Tauri directly — it IS the
                              platform edge; App.tsx and below stay host-agnostic.
  App.tsx       84 tests      reducer host + effect performer + keyboard owner
  components/  198 tests      services.ts (UI-facing port over src/app) + keymap /
                              fuzzy / format / session / host / notify / settings —
                              every real decision lives in a pure .ts module.
                              Picker.tsx is the ONLY file that writes a `<select>`;
                              raw-select.guard.test.ts fails the build if a second
                              one appears in any .tsx under src/ (AST, not grep).
                              services.test.ts drives the REAL createUiServices —
                              built nowhere but main.tsx, so it had no test at all.
  annotate/     41 tests      model.ts (pure ops/geometry/keymap) + AnnotateEditor.tsx

src-tauri/    27 tests        thin glue: tray, global hotkey, autostart, window, the
                              spawn command, and the drag-drop fs grant. No business
                              logic. 1454 lines, of which proc.rs (714) is spawn/IO/
                              kill/allowlist, dnd.rs (284) is the drop grant, and
                              capabilities.rs (239) is ACL tests only.
```

**Why `dnd.rs` is legal glue and not logic.** It decides nothing about a report; it
answers "may the webview read this path", which is a question only Rust can answer
because plugin-fs's scope object lives there. A drop is consent to read exactly the
file dropped, so the grant is made at the moment of the drop rather than pre-declared
as a glob — see [Known blockers](#known-blockers).

**Why `src/app/services.ts` and `src/ui/components/services.ts` both exist.** They
are layered, not duplicated. `src/app` answers "what are the core modules, wired to
the real machine"; `src/ui/components` answers "what does the palette need" and
composes the pipelines that span core modules (refine = prompt + adapter + parse;
submit = store + github). `main.tsx` builds the first and passes it into the second.

## Testing

**Decisions live in `.ts`; `.tsx` tests prove the wiring performs them.** The first
half of that rule is unchanged and still load-bearing: keyboard mapping, fuzzy
ranking, restore, error mapping, annotation geometry are pure `.ts` modules with
tests. **If it is worth deciding, it does not get decided in a `.tsx`.**

What changed: `.tsx` is now collected (`include: ['src/**/*.test.{ts,tsx}']`).
`environment: 'node'` is still the default so the headless core pays nothing; a file
that needs a DOM opts in with a `// @vitest-environment jsdom` docblock. The old rule
read "no component tests, by design", but in practice it had become "the `.tsx` cannot
be tested, so whatever is left in it is unverifiable" — and the v1 lifecycle blockers
(auto-save racing the submit bracket, batched dispatches rendering over each other's
effects) all lived in exactly that blind spot. What a reducer *decides* and what the
wiring *performs* are two different claims; only a rendered component can prove the
second.

Tests drive real behaviour: real temp dirs through `nodeFiles`, scripted argv through
`FakeRunner`. `src/app/runner.test.ts` fakes at the true boundary —
`window.__TAURI_INTERNALS__`, the object Rust injects — so assertions land on exactly
what would cross to Rust.

**A port's fake proves its callers, never its implementation — so the implementation
needs its own test.** `UiServices` is the palette's whole outside world, and faking
it is what makes `App.test.tsx` possible. But `createUiServices` — the real thing
behind that port — is constructed **only** in `main.tsx`, which no test loads. So for
five rounds the entire file was executed by nothing, and the one line carrying the
user's model and effort into the adapter could be deleted with the whole suite green
(blocker #8). This is the same shape as the round-4 lesson one level up: there, the
fake could not refuse what the OS refuses; here, the fake stands *in front of* the
code under test, so the code under test never runs. `components/services.test.ts`
therefore builds the real composition and fakes only the process — the repo's one
seam, and the only thing that should ever be faked. **If a module is only built at the
entry point, assume it is untested until you have watched a mutation of it go red.**

**A fake cannot refuse what the OS refuses — and that is where the seam ends.** The
one seam is what makes this codebase testable, and round 4 found its price. `FakeRunner`
accepts any argv, so `codex.ts` handing the prompt as a multi-line argument passed
every test for three rounds while **100% of real Codex refines failed to spawn** —
Windows will not start a `.cmd` shim with a newline in argv. Two tests had gone
further and *asserted* the broken argv, pinning the bug in place as if it were the
contract.

The lesson is not "trust the seam less"; it is that a scripted fake proves *we sent
what we meant to send*, never *the OS would accept it*. Claims of that second kind
(argv the OS must swallow, stdin EOF, a killed grandchild, a scope check) are settled
by `cargo test` against real processes, or by live verification, or they are not
settled. Where a test now encodes an OS rule rather than an observation, it says so —
see `codex.test.ts`'s *"never puts a newline in argv"*.

**Two jsdom gaps are stubbed, and only these two:** `URL.createObjectURL`, and (in the
annotation tests) `<img>` load + canvas `getContext`/`toBlob`. jsdom ships neither, so
the editor could not be rendered at all — which is precisely why `annotate-done` got
to be a second, unnoticed producer of blocker #5. These supply browser APIs that are
missing; they never stand in for the code under test, and the store underneath is
real.

**The Rust tests are not a formality.** `cargo test` is where stdin-EOF-delivery and
timeout-kill are proven, because they are unprovable in TypeScript: they spawn real
`node` children. The stdin tests echo only on the `end` event, so a child that exits
at all *is* the proof EOF arrived; the kill tests read the child's self-reported pid
from a file and ask **`tasklist`**, never the return value of the thing under test.

## Running it

```bash
npm install

npx tsc --noEmit                  # typecheck        → 0 errors
npx vitest run                    # tests            → 769 passed, 30 files
npx vite build                    # frontend bundle  → succeeds
cd src-tauri && cargo check       # Rust             → succeeds
cd src-tauri && cargo test        # Rust             → 31 passed

npm run tauri dev                 # run the app
```

`npx vite build` is a real gate, not a formality: it is what catches a `node:` import
sneaking into core. `cargo test` is the only gate that proves stdin EOF and
timeout-kill against a real process — do not treat it as optional.

Requires `claude` and/or `codex`, plus `gh`, installed and authenticated. Quacket
enumerates models from whichever CLIs are present rather than shipping a list.

## Known blockers

**FIXED — `ProcSpec.stdin` could not be delivered.** tauri-plugin-shell has no
`stdin_close` IPC command, so a child could be written to but never sent EOF, and
`execute()` returned no pid to kill on a timeout. Both CLIs need EOF to answer at
all, so this produced *silently wrong results*, not degradation. The plugin is now
**gone from the tree** (Rust crate, JS dependency, and `shell:*` permissions all
removed — `capabilities.rs` has a test that fails if any `shell:` permission ever
returns). `src-tauri/src/proc.rs` owns spawn/IO/kill and re-implements the allowlist
as `proc::ALLOWED` = exactly `claude`, `codex`, `gh`. On Windows the child is put in
a job object with `KILL_ON_JOB_CLOSE`, because codex ships as an npm `.cmd` shim:
killing the child would only kill `cmd.exe` and orphan the real CLI. Proven by
`cargo test` against real processes, including the grandchild-behind-a-shim case.

**FIXED — the ACL denied 8 of 9 fs commands.** plugin-fs permissions are strictly
per-command; `default.json` granted only `fs:allow-read-file`. All nine are granted
now, declared once against the global `fs:scope`.

**FIXED — a dropped screenshot outside `$HOME` could not be read (story 5).** The
previous entry in this section used to end "…`fs:allow-read-file` alone keeps the
wider `$HOME/**`, because a dragged screenshot is an arbitrary path the user picked."
That was wrong twice over, and it is worth keeping the correction visible because the
sentence *sounded* like a considered trade-off. `$HOME/**` was simultaneously **too
wide** — a blanket read over every file the user owns — and **too narrow**: it never
covered `D:\shots\bug.png`, a network share, or a USB stick, so plugin-fs denied
`readFile` and the drag path was dead off the home tree. One static glob cannot
express runtime consent, so it failed at both ends.

The file picker was immune, which is why this survived: plugin-dialog grants the
picked path at runtime inside its own command (`s.allow_file(&path)` on
`window.try_fs_scope()`) before handing the path back. Picker and drop share one
`readFile`; only the picker had earned its access. `src-tauri/src/dnd.rs` now mirrors
that call for drops — a drop *is* the consent, so it earns exactly the file it names,
at the moment it names it, and only for the image extensions the frontend will
actually read. The static scope is consequently pinned to the four paths Quacket owns
(`$APPDATA`, `$TEMP/quacket`, + `/**`), and **no fs permission carries a scope of its
own**. Verified against the generated ACL (`gen/schemas/capabilities.json`), not just
the source.

Two traps worth knowing, both now pinned by tests:

- Tauri core *does* call `scopes.allow_file` on drop, but `crate::Scopes::allow_file`
  only touches the **asset-protocol** scope, never plugin-fs's. Reading that line and
  assuming the drop was covered is how the gap survives a skim.
- The grant fires on **Enter as well as Drop**. Tauri runs its own handler — the one
  that emits `tauri://drag-drop` to the webview — *before* `Builder::on_window_event`
  listeners, so a Drop-only grant races the frontend's `readFile`. It wins by orders
  of magnitude, but "wins in practice" is how a wire ends up crossed.

### What is still NOT settled

> **Read this first if you are picking Quacket up.** The five gates below are
> green and the numbers in this file were all measured. The app has now been run
> for real — one full journey, hotkey to filed issue, on 2026-07-16
> (`docs/research/live-qa-first-run.md`) — and that single run found three
> defects the whole green suite could not see (#1b). Treat that as the ledger's
> calibration: everything in the STILL-NEVER-EXERCISED list should be assumed to
> hide the same class of surprise. Nothing here has been dropped to make the
> list shorter.

**1. MOSTLY SETTLED — the CLIs, the write leg, and one full app journey are live-verified.**
Round 4 ran the real adapters against live `claude` 2.1.211, `codex-cli` 0.144.4 and
`gh` 2.90.0 on this machine (`docs/research/live-verification-round4.md`), which is
what found the Codex spawn blocker. What that covers and what it does not:

- **Covered — driven against the real thing:** both providers' golden paths
  end-to-end (prompt + image + schema → the real `parseRefined()`, unmassaged),
  the no-fabrication rule against live models, `codex exec resume`, `AGENTS.md`
  via `-C`, and every `gh` **read** argv. Separately, `cargo test` proves spawn,
  stdin EOF and timeout-kill against real child processes.
- **NOW EXERCISED — the first real run happened 2026-07-16** (see
  `docs/research/live-qa-first-run.md`). The assembled app was launched via
  `npm run tauri dev` and driven end to end through the real user journey:
  global hotkey summon → first-run onboarding completed to the capture box →
  CJK/EN mixed text pasted → refine against live `claude` → draft screen →
  submit through real `gh` → done screen → **a real issue with a real `bug`
  label on a real (throwaway, private) repo**. Silent draft restore, the
  draft slot freeing only on confirmed success, discovery caches, and
  plugin-fs's runtime scope check were all observed live. Separately, the
  whole submit WRITE leg (orphan `quacket-assets` branch, Contents-API
  upload, SHA-pinned URLs, private-repo blob links, label filtering,
  comment-vs-issue, retry reusing blobs with zero spawns) was driven by the
  real `createGitHub` over `node:child_process` against the same repo —
  16/16 checks green.
- The precedent held perfectly: **first contact found three real defects that
  677 green tests could not see** (all fixed same-day, each with a
  fails-without-the-fix test — see "What the first real run found" below).
- **A follow-up session closed three more gaps live** (Part 3 of the QA doc):
  codex refine in-app (provider switch in the footer, model auto-followed),
  the **follow-up second turn via `codex exec resume` in the real app** (one
  answer folded into the filed issue #5, skipped questions invented nothing),
  and the Ctrl+R repo switcher. The tray icon is exercised too (single- and
  double-click, live).
- **A THIRD session cleared most of the rest** (Part 4 of the QA doc), all
  driven live: settings page, autostart toggle (verified against the real HKCU
  Run key, with the `--hidden` flag, both directions), issue-list view,
  similar-issue card with a real lookalike + the comment-vs-issue switch (posted
  a comment on an existing issue, no new issue, done screen "Added to issue
  #3"), the annotation editor (pen/circle/undo/flatten/marked-badge/window
  morph), Discard (UI + disk), and Esc-mid-submit (submission continued in the
  background, slot freed on success). The **NSIS installer was built for the
  first time** (`Quacket_0.1.0_x64-setup.exe` + a valid minisign updater sig).
  This session also found and fixed the codex false-vanish cache bug (#1c below).
- **STILL NEVER EXERCISED:** the updater's actual self-update (placeholder
  endpoint; needs a published release), installing from the built NSIS exe +
  SmartScreen, the background-failure OS notification specifically (Esc-mid-submit
  was verified on a success; a clean live failure-while-hidden is hard to stage —
  the notify path stays unit-verified), and multi-day tray soak.

**1b. What the first real run found (2026-07-16), all fixed same-day.** Three
defects, none visible to the suite, every one in the "tested from an mkdtemp'd
world instead of from reality" class:

- **Every text-only Claude refine died instantly**: the spawn's cwd
  (`$TEMP/quacket`) had never been created — nothing on the no-image path
  touches the fs, and every test injected a temp base that already existed.
  Fixed in the adapter (`claude.ts` mkdirps its own cwd, as codex already did
  for its session dir); pinned by a test whose base genuinely does not exist.
- **An empty repo (zero commits) broke image upload with a generic error**: the
  whole Git Data API answers `409 Git Repository is empty` (real transcript in
  `github.test.ts`). The Contents API *would* work — live-verified — but on an
  empty repo the branch it creates becomes the **default branch**, fronting the
  user's new project with a Quacket README: exactly the pollution the label
  rules forbid. So the fix is an honest plain-language refusal that routes to
  [File without images].
- **`lastRepo` was never persisted by a successful submit** — only the Ctrl+R
  switcher wrote it, so a user filing against the `repos[0]` default kept
  `lastRepo: null` forever, and `repos[0]` reorders whenever any other repo is
  pushed. Story 16 says last-USED; now the submit success path commits it.

A fourth defect from the same run was confirmed and fixed in a follow-up
session: **double-clicking the tray icon toggled the window twice** (the second
press becomes `WM_LBUTTONDBLCLK` but the second release still arrives as a plain
`Click{Up}` — captured live by instrumenting the handler and double-clicking the
real icon). `src-tauri/src/tray_gate.rs` now gates the toggle: act on the first
`Click{Up}`, swallow the rest of the burst within the user's real
`GetDoubleClickTime()`. Verified live in both directions; 4 unit tests pin it,
including the captured 129 ms tail. Details + two collateral clarifications (a
manual launch shows the window BY DESIGN; the overflow flyout's light-dismiss
made the pre-fix bug flaky) in `docs/research/live-qa-first-run.md`.

Also observed, real but left unfixed (deliberately): the footer pickers' labels crowd
and overlap at rest width (cosmetic — later escalated as #17/#18 and resolved by
removing the footer pickers entirely; see the story-37 note in §8); a spawn-level
failure surfaces as the generic "Something went wrong." rather than a taxonomy
message (the mkdirp fix removed the only known trigger); and the tray tooltip
carries no version (the spec puts the version in the tray MENU, which exists but
went unopened in QA).

**1c. What the third QA session found (2026-07-16): a transient codex enumeration
failure was cached as "codex vanished".** Opening Settings showed *"Codex is not
available any more, so Quacket switched to Claude Code"* while codex was working
(the same session had just refined with it). `discovery-cache.codex.json` held an
empty offering (`account: null, models: []`) even though `codex app-server`
`model/list` returns fine in ~120 ms. `discovery.ts` cached the codex fallback
with `cacheable: true` on ANY enumeration throw — so one slow app-server boot
froze "codex has no models" for the 24 h TTL, which `reconcileSettings` reads as
"provider vanished" and switches away from for a day. The claude path already did
this right (`cacheable: false` on a broken probe); the codex path didn't honor
its own documented rule. Fixed: a codex fallback is cacheable only when
version-GATED, never when enumeration was attempted and threw. Two tests pin both
sides, mutation-verified. This is the same "tested from the code, not from
reality" class — every prior discovery test scripted a CLEAN app-server.

**2. The ACL is proven by construction, not at runtime.** The tests verify that every
plugin-fs API the frontend imports is granted, and cross-check the permission→command
mapping against **plugin-fs's own `acl-manifests.json`** rather than a remembered
list. They do **not** execute plugin-fs's runtime scope check — that needs the real
app. The glob shapes are tauri's own `fs:scope-appdata-recursive` shapes verbatim.

The drop grant in `dnd.rs` inherits the same limit, and stops one step short of it.
Its `FileGrant` seam proves the *decision* — which dropped paths earn a grant, and
that neighbours, non-images, and directories do not. What stays unproven is only that
`Scope::allow_file` makes a subsequent `readFile` pass. That is not a guess: it is the
identical call on the identical object plugin-dialog makes for the file picker, which
works in this app today. It is unasserted for a mechanical reason, not a design one —
building a real `tauri::fs::Scope` needs `tauri::test::mock_app()`, whose `test`
feature makes muda's comctl32-v6 imports live in the test binary, which then fails to
load (STATUS_ENTRYPOINT_NOT_FOUND: test exes get no v6 activation manifest) and takes
**all 27 Rust tests** down with it. Trading the suite for one assertion was the wrong
price.

**2b. The drop grant and the frontend read agree by a pinned test, not a shared
symbol** — they are in different languages. `dnd.rs` mirrors `IMAGE_EXTENSIONS` from
`src/ui/main.tsx` and `the_granted_extensions_are_the_ones_the_frontend_reads` parses
that very line to keep the pair honest, so a format added on one side goes red instead
of failing in the shipped app. This is only load-bearing because `main.tsx` now has
**one** list: the constant used to feed just the file dialog while an independent
`/\.(png|jpe?g)$/i` gated the reads, so the test guarded the constant that was not the
gate — widening the regex alone kept all 27 Rust tests green while the frontend read a
format Rust had never granted. `isImage` derives from the list; there is one gate.

**3. SETTLED — both inferred adapter behaviours were verified live in round 4.** This
entry used to name them as guesses. They are not guesses any more, and neither
degraded silently, so the entry is kept only to record the answers:

- **Claude's `api_retry` shape: CONFIRMED.** `error` is a bare enum string, so
  `claude.ts`'s first branch reads it correctly. A real-shape fixture now pins it.
  One thing came with it: the enum has **ten** members and both this file's source
  (`headless-cli-invocation-contract.md`) and `errors.ts` listed **nine** —
  `oauth_org_not_allowed` was missing and fell through to the status/text
  heuristics. Both are fixed, and a test now walks the whole enum so an eleventh
  member cannot go unmapped quietly.
- **`codex exec resume` accepts `--skip-git-repo-check` and `--output-schema`:
  CONFIRMED.** `followUp` is not broken; a live resume returned schema-conforming
  output in 11–13 s.

What replaced them is real and is **4** and **6** below.

**4. FIXED — an all-sections-dropped report no longer files a title over an empty
body.** `renderSection` still correctly refuses to emit `## Actual` over nothing —
the renderer was never the bug. The floor now lives where this entry said it
belonged: the reducer's `file-without-images` case checks whether stripping image
refs (via the now-shared `imageRefPattern` in `types.ts` — one definition, both
judgments) would empty every section, and falls back to the raw dump as the body,
file-as-is shape (empty heading, verbatim text). The raw dump is the user's own
writing, so the no-fabrication rule is untouched — it forbids inventing, not
shipping unpolished. Refined title and type survive; a draft with even one
surviving prose section is left alone. Pinned from both ends: `reducer.test.ts`
(both directions) and `github.test.ts`, whose end-to-end probe drives the real
reducer into the real `submit()` and asserts the exact `gh` stdin. Mutation:
disabling the fallback reddens exactly 2 tests.

**5. FIXED — an image could reach the screen without reaching the disk, on every
route, and the draft it left behind could not be reopened.** Worth keeping in full,
because the shape of it is the point and it had **two independent producers** that
were found a round apart.

The rule now: **bytes first, state second.** Nothing may put an image into `UiState`
that is not already on disk. That is not a tidy-up, it is the whole fix — the
auto-save builds `draft.json` FROM STATE, while `attachImage` is the only thing that
ever writes the bytes, so any moment where state leads the disk is a manifest entry
with no file. `DraftStore.imageBytes` calls exactly that corruption and throws
(`draft image img_1 is missing from disk`), deliberately and correctly. The draft did
not restore missing one screenshot; it did not restore at all.

| producer | what it did | found |
| --- | --- | --- |
| intake (paste / drag-drop / pick) | dispatched `add-image` *before* `await attachImage`, and all three callers dropped the rejection (`void`ed, or a `try` scoped to the read) | round 3, fixed round 4 |
| `annotate-done` | rewrote `bytes` **and** `mediaType: 'image/png'` in state with **nothing writing the new bytes at all** | round 4, fixed round 4 |

The annotation half was the nastier of the two and needed no failure to fire.
`DraftStore.fileFor` derives the filename from `mediaType`, so annotating a **JPEG**
renamed it in the manifest (`img_1.png`) over a file still called `img_1.jpg` — a
**100% deterministic** brick, not a race. Annotating a PNG lost the marks instead:
same filename, stale bytes, restored silently without the drawing.

Both now funnel through the store's own re-attach path, which was designed for this
all along (`store.ts`: *"Re-attaching the same id overwrites the file, which is how
annotation (destructive in v1) lands."*) — the call was simply never made. `flattenedImage` is exported
from `reducer.ts` and used by both the reducer and `App.tsx`, so "annotated ⇒ PNG +
`annotated: true`" has one definition; restating it in the `.tsx` is what would let
the two drift and rename a file out from under the manifest again.

A failure on either route now says so in the WarningSlot and keeps the bytes, so
**Try again** is a button that can actually work. On the annotate route nothing is
dispatched on failure, so the editor stays open with the marks still on the canvas
and the draft still describing the image genuinely on disk.

Pinned by tests that drive the real component against a **real `DraftStore` on a real
temp dir** — `store.load()` must return the text and not throw. Re-coupling either
producer turns them red with the exact production error. The round-3 note that *"`vi.fn(async () => {})` is the
only `attachImage` any test uses; none rejects it"* is no longer true, and that was
the thing that let this live for three rounds.

**5b. The orphan file after a JPEG is annotated is known and benign.** Re-attaching
writes `img_1.png` and the manifest stops naming `img_1.jpg`, which stays on disk
until the draft folder is removed by discard, a confirmed submit, or `pruneOthers`.
`load()` reads only what the manifest names, so it is litter inside an ephemeral
folder, not a defect — recorded so nobody re-derives it as one.

**6. SETTLED (owner's call) — `DEFAULT_TIMEOUT_MS` widened 120 s → 180 s.** Round 4
measured a live golden path at **90.7 s** against the research docs' 2.3–6.3 s,
leaving the old constant ~1.3× of headroom. The owner decided: the timeout's job is
**hang detection, not a latency budget** — killing a slow-but-alive refine turns a
success into a failure, while a genuinely hung child just delivers its bad news a
minute later (the user has Esc and the background-failure notification either way).
180 s is 2× the worst measurement. The default is now pinned by a test
(`claude.test.ts`) so it cannot quietly shrink back under the measured tail; the
90.7 s-vs-6.3 s discrepancy itself is still unexplained (one machine, one day) and
still worth a second measurement if refines feel slow.

**7. `--ignore-user-config` does not suppress `~/.codex/skills/`.** The flag is in
(spec-mandated, and it stops the user's `config.toml` steering refines), but a skills
directory still loaded with the flag present. Measured, not theorised — the error
item persisted with and without. Impact is unquantified. **UNSETTLED.**

**8. FIXED — the user's model and effort reached the CLI through one line that no
test executed.** Found at round 5 integration, and worth keeping because it is the
repo's signature failure in a new place.

Round 5 fixed "the first-run card discards its own effort pick" *in the card*, and
the adapters had always pinned `effort → argv` (`codex.test.ts`, `claude.test.ts`).
Both halves green. The line joining them —

```ts
// src/ui/components/services.ts, inside refine()
model: settings.model,
effort: settings.effort,
```

— belonged to neither. `createUiServices` is constructed **only in `main.tsx`**;
`App.test.tsx` imports its *type* and hands the component a fake. So nothing ran
it. Replacing `effort: settings.effort` with `effort: null` disables reasoning
effort **app-wide, on every refine, for both providers** — and left the entire suite
as it stood at that moment (669 tests, before the four below existed) and
`tsc --noEmit` green. That was executed, not argued.

Now pinned by `components/services.test.ts`, which drives the **real**
`createUiServices` with the **real** adapter and **real** `createGitHub` over
`FakeRunner`, so the assertion lands where the spec puts it — the argv handed to
`codex`/`claude`. Both mutations (`effort: null`, `model: null`) redden exactly
their own claim and nothing else.

**The general lesson, since it will recur:** a composition root that is only ever
built by the app's entry point is invisible to a suite that fakes it. Two green
halves do not make a green whole; the *joint* is a claim and needs its own test.
`UiServices` is a port, and every port has this shape — the fake proves the caller,
never the implementation.

**Sibling residual, RESOLVED BY DELETION: the Palette FOOTER pickers (story 37)
no longer exist.** `Pickers` in `Palette.tsx` was the app's *second* surface for
choosing model/effort, its commit logic checked by reading rather than running —
a residual this file used to flag with "if you touch that footer, test it first".
Nobody ever did; instead the surface itself went. The footer row could not hold
AI + Model + Thinking + Discard + Refine + shortcut hints in 620px: #17 traded
the resulting overlap for selects that clip their own value, #18 showed the clip
squeezing values to one-letter stubs, and the fix was to stop duplicating the
surface — Settings (which has room, labels, and tests) is now the single place
the AI / model / thinking choice lives. The untested-composition risk did not
get tested; it got deleted, which is better.

**9. OPEN, UNREPRODUCED — a suspected timing flake in `App.test.tsx`.** Recorded
because it was seen, not because it is understood; it is the one thing in this file
that is a report rather than a measurement.

During round 5 a fix agent saw **5 failures** in *"a screenshot the page never
manages to read"* on a cold-transform run, all dying at **~1020 ms against a
1000 ms budget** — testing-library's default `waitFor` timeout, which nothing in
this repo overrides. It has not reproduced since: **4 consecutive full runs at
integration, including one with the vite cache deleted, were 673/673 green**, and
the block passes alone.

The honest reading is that it was probably an artefact of the round-5 setup —
another agent was rewriting files *while* vitest transformed them, on a loaded
machine — but that is a hypothesis, not a finding, and "it went away" is not a
diagnosis. What is real either way: those assertions sit ~2 % under a default
budget on a cold run, so a slower machine (CI, a fresh clone) can cross it. If it
fires, the fix is an explicit timeout on those `waitFor`s — **not** a retry, and
**not** deleting the assertions, which pin genuine unhandled-rejection behaviour.

The listener in that block is `process.on('unhandledRejection')`, which is
process-global and therefore shared with every other file in the same vitest
worker. It is installed and removed per test (2 installs, 2 `stop()`s, in
`finally`), so it is balanced today — but it is a global, and a future test that
leaks one will produce confusing cross-file failures.

**10. FIXED — `detect()` could brick boot on its own, via `autostart`.** Round 3 made
draft loading resilient by giving it its own boot slot, reasoning that *only detection
may stand between the user and the capture box*. That left `detect()` carrying the
whole boot: `App.tsx` awaits it with no catch **by design**, so a rejection there was
a palette stuck on "Checking your setup…" forever — no capture box, no error card, not
even Discard. The exact brick round 3 had called a blocker for `loadDraft`.

Two of `detect()`'s three inputs already degraded to a known state (`ghState` to
not-installed, `capabilitiesOf` to absent). `core.autostart.isEnabled()` did not, so
one unreadable registry key could take the app down. That is this repo's single
most-repeated defect shape, for the fourth time: **one producer not knowing an
invariant its siblings keep** (round 2: `renderBody` vs the parser; round 4:
`annotate-done` vs the manifest; round 5: attach vs `shouldSaveDraft`).

Fixed at the source, not with a catch on the boot effect — a catch there would let a
future contract break slide silently, which is the opposite of what is wanted.
`autostartState()` degrades to `false` (the honest answer to "is it on?" when the Run
key cannot be read; the toggle still works, since enabling an already-enabled
autostart is a no-op), and `detect()`'s never-rejects contract is now stated where it
is implemented. `services.test.ts`'s *"detect never rejects"* block rejects **every**
input in turn — not just the one that was broken — so the next input added to
`detect()` has to degrade too. Mutation-verified: restoring the bare
`core.autostart.isEnabled()` reddens exactly 2 of the 8 tests and leaves the other 6
green, so each pins its own claim.

## What live verification settled

Round 4 drove the real adapters against live CLIs on this machine — `claude`
**2.1.211**, `codex-cli` **0.144.4**, `gh` **2.90.0**, `rustc` 1.95.0. Full transcript
and method: `docs/research/live-verification-round4.md`. `gh` was read-only; nothing
was written to any repo.

| Claim the code made | Verdict |
| --- | --- |
| Codex prompt delivery on Windows | **MISMATCH — BLOCKER.** 100% of refines failed to spawn. Fixed (stdin) |
| `--ignore-user-config` present (spec pins it) | **MISMATCH.** Absent; user config steered every refine. Fixed |
| Claude `api_retry` event shape | **CONFIRMED** — bare enum string, read correctly |
| `api_retry` category list complete | **MISMATCH** — 9 of 10; `oauth_org_not_allowed` unmapped. Fixed |
| `codex exec resume` accepts `--skip-git-repo-check` / `--output-schema` | **CONFIRMED** — `followUp` is not broken |
| Both providers' golden paths → `parseRefined()` | **CONFIRMED** — unmassaged, both |
| No-fabrication rule against live models | **CONFIRMED** — 3 runs, both providers; `Environment` omitted, never padded |
| `AGENTS.md` via `-C` is read | **CONFIRMED** — Codex's only system-prompt route works |
| `gh` read argv, `viewerPermission`, label objects | **CONFIRMED** |
| `github.ts` "empty listing prints empty stdout" | **MISMATCH** — prints `[]\n`. No defect (the code is defensive); the *comment* claimed "verified" and was not. Comment corrected |
| Claude refine latency vs. the 120 s timeout | **UNSETTLED** — 90.7 s measured vs. 6.3 s documented. See blocker #6 |

**The blocker is the argument for doing this at all.** `codex.ts` passed the prompt as
argv; npm ships `codex` as a `.cmd` batch shim, and Rust's `Command` refuses to spawn a
batch file with any newline-containing argument (CVE-2024-24576 hardening).
`buildUserPrompt()` is multi-line by construction, so **every** Codex refine and every
follow-up died — and two existing tests had *enshrined* it, asserting `args.at(-1)` was
the prompt, with `FakeRunner` stubbing away the OS failure that a real spawn would hit.
A fake cannot refuse what the OS refuses. Those tests were rewritten, not deleted.

**Carry this forward.** The verifying agent's first harness routed `codex.cmd` through
`cmd.exe`, which silently truncates multi-line args at the first newline and **exits
0** — it produced a plausible-but-wrong draft and a follow-up that "succeeded" while
the model never saw the answer. That harness lie is the same shape as the fixture lies
it was sent to find, and it nearly became a conclusion. A harness that cannot
reproduce the real failure is not evidence.

## Conventions

- **The user is not an engineer.** A control must carry its own meaning; a sentence
  teaching someone how to operate it is evidence the control failed. Icons are inline
  SVG with `stroke="currentColor"` — never emoji, never typographic glyphs. One
  deliberate exception: the `DuckMark` brand mark is fixed-colour by design — it is
  the tray icon redrawn as vector (#23), and an identity mark does not recolour with
  state.
- **No fabrication.** The refiner may not invent an issue number, a section, or a
  detail the user did not give. `dropInventedIssues` enforces this against the
  candidates actually shown.
- **Nothing is lost.** Crash, kill, close, and every failed submit keep the draft.
  Only an explicit discard or a confirmed submit success frees the slot.
- **Filing** — begins once one Draft's final content and target are fixed, then
  attempts to turn that Draft into a GitHub issue or comment. It may produce
  reusable Asset receipts before it reaches the terminal Filing receipt.
- **Filing identity** — the stable identity assigned before GitHub is asked to
  write. If a crash leaves the outcome ambiguous, Quacket reconciles GitHub by
  this identity before it can retry the Filing.
- **Ambiguous Filing** — a Filing whose GitHub outcome cannot yet be reconciled.
  Filing keeps its final content and assets independently and never blocks the
  next capture. A matching Filing identity becomes a Filing receipt; an
  authoritative no-match resumes the same Filing automatically.
- **Filing success is terminal.** Once GitHub confirms the issue or comment and
  returns its URL and number, the report is filed. No later local failure — the
  receipt write included — may make it retryable or permit another filing.
- **Filing receipt** — proof that GitHub accepted an issue or comment:
  its URL, issue number, and target. Pending receipts form a cleanup queue
  independent of the active Draft slot: they restore as Done after a crash but
  never block the next report or permit the filed report to be retried.
- **Asset receipt** — the durable, SHA-pinned URL for one exact screenshot
  revision already committed to `quacket-assets`. It is saved as each asset
  lands; retries reuse it only while repository, media type, and content still
  match, so annotating the same image id cannot reuse stale bytes.
- Shared types come from `src/core/types.ts`. If two modules need a shape, it lives
  there — not copied.
