# Quacket

**Turn a messy observation into a clean GitHub issue — without leaving what you were doing.**

[![Release](https://img.shields.io/github/v/release/c3lew/Quacket)](https://github.com/c3lew/Quacket/releases/latest)
[![License: MIT](https://img.shields.io/github/license/c3lew/Quacket)](LICENSE)
[![Release build](https://github.com/c3lew/Quacket/actions/workflows/release.yml/badge.svg)](https://github.com/c3lew/Quacket/actions/workflows/release.yml)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078d4)

Bug reports die because filing one interrupts what you were doing. Quacket makes
filing cost **one hotkey and one paragraph**: press a global shortcut anywhere,
dump a half-formed complaint and a screenshot into a small palette, and Quacket
refines it into a structured GitHub issue and files it — then gets out of your way.

**It brings no AI API key and no server.** Quacket drives the `claude` / `codex`
CLIs you have already installed and authenticated, and files issues through your
own `gh`. Nothing about your work leaves your machine except the issue you chose
to file, through tools you already trust.

## How it works

1. **Summon** — press the hotkey (default `Ctrl+Shift+Q`). A small palette
   appears over whatever you were doing.
2. **Dump** — type the complaint however it comes out. Paste, drag in, or pick
   screenshots; mark them up with the built-in annotation editor.
3. **Refine** — your local AI CLI turns the dump into a titled, sectioned,
   labeled issue. If it needs to know more, it asks; if the repo already has a
   lookalike issue, Quacket offers to comment on it instead of filing a duplicate.
4. **File** — one click submits through `gh`, screenshots included. Done.

## Features

- **Global hotkey capture** — a tray-resident palette, summonable from anywhere
- **Screenshots first-class** — paste, drag-drop, or pick; annotate with pen and
  shapes before filing
- **AI refinement, locally driven** — uses whichever of `claude` / `codex` you
  have; models and thinking levels are enumerated live from your CLIs, never
  hardcoded
- **No fabrication** — the refiner cannot invent details, sections, or issue
  numbers you didn't give it
- **Duplicate detection** — similar open issues are surfaced before you file;
  one click turns your report into a comment on the existing issue
- **Nothing is lost** — drafts auto-save from the first keystroke and survive
  crashes, kills, and failed submits; only a confirmed success or an explicit
  discard frees the slot
- **Auto-update** — checks GitHub Releases daily and updates in place with one click

## Install

Grab the installer from the [latest release](https://github.com/c3lew/Quacket/releases/latest)
and run it. No admin rights needed.

**Requirements:**

- Windows 10/11
- [`gh`](https://cli.github.com/) — installed and signed in (`gh auth login`)
- [`claude`](https://docs.anthropic.com/en/docs/claude-code) and/or
  [`codex`](https://github.com/openai/codex) — installed and signed in
  (optional but recommended; without one you can still file your raw text)

Quacket checks all three on first run and tells you exactly what's missing and
how to fix it.

## Development

Pure-TypeScript core behind two injected seams (process + filesystem), a React
palette over a pure reducer, and a thin Tauri/Rust edge that owns spawning,
the tray, and the drag-drop consent model. The full design rationale — and an
unusually honest ledger of what is and isn't verified — lives in
[CONTEXT.md](CONTEXT.md).

```bash
npm install

npx tsc --noEmit                  # typecheck
npx vitest run                    # frontend tests
npx vite build                    # frontend bundle (also gates core purity)
cargo check --manifest-path src-tauri/Cargo.toml
cargo test  --manifest-path src-tauri/Cargo.toml   # proves spawn/stdin/kill on real processes

npm run tauri dev                 # run the app
```

### Releasing

Bump the version in `src-tauri/Cargo.toml` and `package.json`, then:

```bash
git tag v0.x.y && git push origin v0.x.y
```

CI builds the NSIS installer, signs the updater artifacts, and publishes a
GitHub release. Installed apps pick it up automatically within a day.

## License

[MIT](LICENSE)
