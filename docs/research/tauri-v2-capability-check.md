# Tauri v2 capability check: tray, global hotkey, clipboard image, autostart on Windows

Research for issue #5. State of the world as of **2026-07-16**: `tauri 2.11.5`, `tauri-plugin-global-shortcut 2.3.2`, `tauri-plugin-clipboard-manager 2.3.2`, `tauri-plugin-autostart 2.5.1` (latest stable on crates.io).

## TL;DR verdict

**Tauri v2 covers all of Quacket's hard requirements natively. No custom Rust is strictly required for v1.** A few optional Rust snippets improve polish (focus-stealing fallback, idle memory trimming).

| Requirement | Covered by | Verdict | Gotchas |
|---|---|---|---|
| Tray with menu | `tauri` core (TrayIcon API, `tray-icon` feature) | ✅ Native | Pin recent `tray-icon` (≥0.21.2); older versions had Explorer-restart and hidden-window crash bugs (now fixed) |
| Global hotkey | `tauri-plugin-global-shortcut` 2.3.2 | ✅ Native | Conflict surfaces as `AlreadyRegistered` error (not silent). Won't fire while an elevated app has focus |
| Clipboard image read | `tauri-plugin-clipboard-manager` 2.3.2 | ✅ Native | `readImage()` returns raw RGBA, not PNG — must encode via canvas or Rust. Simpler: use the DOM `paste` event, which gives PNG directly in WebView2 |
| Drag-and-drop image | `tauri` core webview drag-drop events | ✅ Native | `dragDropEnabled: true` (default) gives file *paths* via `onDragDropEvent` but kills HTML5 DnD on Windows — pick one model |
| Autostart | `tauri-plugin-autostart` 2.5.1 | ✅ Native | HKCU `Run` registry key. NSIS uninstaller removes it since tauri PR #12643; MSI does not |
| Always-ready hidden window | `tauri` core (`visible: false`, `show()`/`hide()`) | ✅ Native | Show from hotkey is near-instant since WebView2 stays alive. Idle RAM ~40–80 MB total (WebView2 dominates). Focus-stealing edge cases exist |

---

## (a) Tray with menu

- **API**: `TrayIconBuilder` (Rust) / `TrayIcon.new()` (JS). Menus with clickable items, `on_menu_event` / per-item handlers. Backed by the `tray-icon` crate.
- **Windows click events**: full support — `Click` (with button + state), `DoubleClick`, `Enter`, `Move`, `Leave`. Left vs right click distinguishable. `show_menu_on_left_click(false)` / `menuOnLeftClick: false` lets left-click do a custom action (e.g. toggle capture window) while right-click shows the menu. (The "click events unsupported" caveat in the docs is **Linux-only**.)
- **Dynamic menu updates**: supported at runtime — `tray.set_menu(...)`, `MenuItem::set_text/set_enabled`, `tray.set_icon`, `set_tooltip`.
- **Gotchas (all fixed in current versions — pin accordingly)**:
  - Tray icon vanished after `explorer.exe` restart (`TaskbarCreated` not handled) — fixed in `tray-icon` [#325](https://github.com/tauri-apps/tray-icon/pull/325); the old tao-era bug [tao#476](https://github.com/tauri-apps/tao/issues/476) is closed.
  - **App crash after all windows hidden for a long time on Windows** ([tauri#14088](https://github.com/tauri-apps/tauri/issues/14088)) — exactly Quacket's usage pattern; fixed by `tray-icon` ≥ 0.21.2 ([tray-icon#284](https://github.com/tauri-apps/tray-icon/pull/284)). **Action: ensure `cargo update` pulls tray-icon ≥ 0.21.2.**
  - Tray creation at Windows login could race with the shell not being ready (relevant with autostart) — mitigated in `tray-icon` ([#293](https://github.com/tauri-apps/tray-icon/pull/293), [#171](https://github.com/tauri-apps/tray-icon/issues/171)).

## (b) Global hotkey

- **API**: `register('CtrlOrAlt+...')` with callback (JS) or `Shortcut` + handler (Rust). `Pressed`/`Released` states. `isRegistered`, `unregister`, `unregisterAll` all exist — re-registration (e.g. user changes the hotkey in settings) is unregister→register, fully supported.
- **Conflict behavior — errors ARE surfaced, not silent**: on Windows the plugin uses `RegisterHotKey`; when the OS returns `ERROR_HOTKEY_ALREADY_REGISTERED` the crate returns `Error::AlreadyRegistered(hotkey)` (verified in `tauri-apps/global-hotkey` Windows source). In JS the `register()` promise rejects; in Rust you get a `Result::Err`. Quacket can catch this and prompt the user to pick another combo.
- **Windows limits / gotchas**:
  - Hotkeys registered by a non-elevated process do **not** fire while an elevated (admin) window or some fullscreen games have focus (Windows UIPI, see [tauri#14770](https://github.com/tauri-apps/tauri/issues/14770)). Acceptable for v1; document it.
  - Some `Win`-key combos are reserved by the OS and will fail registration (surfaced as an error, same path as conflicts).
  - Key-release events are detected by a 50 ms `GetAsyncKeyState` polling thread — fine for Quacket (we only need press).
  - Permissions: nothing enabled by default; must add `global-shortcut:allow-register` (+ `is-registered`, `unregister`) to capabilities.

## (c) Clipboard image read

- **Supported**: `readImage()` / `writeImage()` exist on Windows/macOS/Linux since plugin 2.0.0 (mobile is text-only). Permission: `clipboard-manager:allow-read-image`.
- **Format gotcha**: `readImage()` returns an `Image` handle exposing `rgba()` (raw RGBA bytes) and `size()`. It is **not** an encoded PNG — the docs' own `new Blob([await img.rgba()])` example produces a non-renderable blob (this confusion is why [plugins-workspace#2225](https://github.com/tauri-apps/plugins-workspace/issues/2225) asks for `readImagePNG()`). To get a PNG for GitHub upload: `new ImageData(rgba, w, h)` → canvas → `toBlob('image/png')` in the frontend (no Rust needed), or `image` crate in Rust.
- **Simpler primary path**: WebView2 is Chromium — a DOM `paste` event on the capture window delivers `clipboardData.items` with an `image/png` `File` directly, no plugin, no re-encoding, works for screenshots (Win+Shift+S) out of the box. Recommendation: **paste event as the primary intake; plugin `readImage()` only for an explicit "Paste image" button/menu action** where no keyboard event exists.
- **Open Windows reports (low frequency, watch)**: intermittent crash when the Win+V clipboard-history panel opens while the plugin is active ([plugins-workspace#3415](https://github.com/tauri-apps/plugins-workspace/issues/3415), single report, May 2026, unconfirmed); clipboard sometimes left empty after app close ([#1107](https://github.com/tauri-apps/plugins-workspace/issues/1107)). Neither blocks v1.

## (d) Drag-and-drop image intake

Two mutually exclusive models on Windows; **pick one**:

1. **Tauri native (default, `dragDropEnabled: true`)**: `getCurrentWebview().onDragDropEvent()` fires `enter`/`over` (position), `drop` (**file paths**), `leave`. You then read bytes via the `fs` plugin. HTML5 DnD (`ondrop`/`ondragover` with `File` objects) does **not** fire for OS file drops — the native layer intercepts them ("Disabling it is required to use HTML5 drag and drop on the frontend on Windows" — official config docs).
2. **HTML5 (`dragDropEnabled: false`)**: standard DOM DnD gives `File` objects (bytes directly, no fs permission needed), but you lose the native drag events entirely.

Recommendation for Quacket: **model 1** (native). It gives hover position for a drop-target highlight, and dropping non-file content is a non-goal. Reading dropped image files needs `fs` plugin read permission scoped appropriately. Known quirk: drop position is inaccurate while devtools is attached (docs note). Also [tauri#13761](https://github.com/tauri-apps/tauri/issues/13761): `dragDropEnabled` set via Rust `WebviewWindowBuilder` had a bug — set it in `tauri.conf.json` instead.

## (e) Autostart

- **Mechanism on Windows**: `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` registry value (via the `auto-launch` crate). Per-user, **no admin rights needed**. `enable()` / `disable()` / `isEnabled()` from JS or Rust; supports launch args — pass e.g. `--hidden` so an autostarted Quacket comes up tray-only without flashing the window.
- **Installer interplay**:
  - **NSIS**: since [tauri PR #12643](https://github.com/tauri-apps/tauri/pull/12643) the generated uninstaller deletes the autostart Run value on uninstall (and preserves it on updates). This is in current tauri-bundler.
  - **MSI (WiX)**: no such cleanup — an uninstalled app leaves a dangling Run entry. **Another reason to ship NSIS** (see Distribution notes).
- **Open issue to be aware of**: [plugins-workspace#771](https://github.com/tauri-apps/plugins-workspace/issues/771) (2023, v1-era, still open) reports the Run entry disappearing after one boot for one app; no reproduction, likely app-specific (AV/registry cleaner). Not considered a blocker.

## (f) Always-ready hidden window

- **Pattern**: create the capture window at startup with `visible: false` (+ `skipTaskbar: true`, `decorations: false`, `alwaysOnTop: true` as desired); hotkey/tray handlers call `window.show()` + `window.set_focus()`; Esc/blur calls `hide()`. Intercept the close request (`api.prevent_close()` + hide) so ✕ never destroys the webview. This is the standard, officially supported tray-app pattern ([discussion #11489](https://github.com/tauri-apps/tauri/discussions/11489)).
- **Show latency**: no official benchmark exists; because the WebView2 process stays alive and the DOM is already rendered, `show()` is a native `ShowWindow` call — effectively instant (well under 100 ms, anecdotally). The expensive path is *creating* a window (WebView2 init, high hundreds of ms) — avoid create-on-demand, keep it hidden.
- **Idle footprint (Windows, WebView2)**: real-world reports put a simple Tauri app at **~30–80 MB working set total across processes** at idle (app exe a few MB; `msedgewebview2.exe` processes dominate). A 2026 comparison measured ~42 MB idle vs ~168 MB for equivalent Electron. Hiding the window does NOT release WebView2; the processes stay resident. If we want to trim further: wry exposes `WebViewExtWindows::set_memory_usage_level(Low)` — call it on hide, reset on show (small custom Rust nicety; WebView2 then trims caches when inactive). Fully unloading the webview when hidden (destroy + recreate) trades ~50 MB RAM for slow (~0.5–1 s) summon — not worth it for Quacket's "always-ready" requirement.
- **Focus gotchas on Windows**:
  - Showing from a **global hotkey or tray click generally focuses correctly** — Windows grants foreground rights to the process that received the hotkey/click.
  - There are open reports where `set_focus()` after `show()` still doesn't take keyboard focus in some setups ([tauri#7519](https://github.com/tauri-apps/tauri/issues/7519), [#11566](https://github.com/tauri-apps/tauri/issues/11566) — the latter about `focus: false` being ignored at creation). If we hit this, the known fallback is a tiny Rust snippet (minimize→restore trick or `AttachThreadInput` + `SetForegroundWindow`). Defer until observed.

## (g) Needs custom Rust

**Nothing is required.** Optional, small, in priority order:

1. `on_window_event` close-request interception → hide instead of exit (a few lines in `setup`; arguably core-API usage, not "custom Rust").
2. `set_memory_usage_level(Low)` on hide / `Normal` on show, via wry's Windows extension trait — idle RAM trim.
3. Focus-stealing fallback (`AttachThreadInput`/minimize-restore) — only if `show()+set_focus()` proves unreliable in testing.
4. RGBA→PNG encode in Rust (`image` crate) — only if we prefer encoding off the UI thread over the canvas approach.

## Distribution notes (feeds the "Distribution & updates" fog item)

- **Ship NSIS, not MSI**: NSIS uninstaller cleans up the autostart Run key (PR #12643); MSI doesn't. NSIS also supports per-user install (no UAC), matching HKCU autostart.
- **Updater**: `tauri-plugin-updater` supports Windows NSIS; combined with per-user install this gives silent-ish updates without elevation. A tray-resident app must handle "update while running" (updater replaces the exe; app restarts) — design point for the distribution ticket.
- **WebView2 runtime**: Tauri's Windows installers bootstrap WebView2 if missing (default `downloadBootstrapper`); Win10/11 ship it, so usually a no-op.

## Sources

- Official docs: [System Tray](https://v2.tauri.app/learn/system-tray/), [Global Shortcut plugin](https://v2.tauri.app/plugin/global-shortcut/), [Clipboard plugin](https://v2.tauri.app/plugin/clipboard/), [clipboard-manager JS API](https://v2.tauri.app/reference/javascript/clipboard-manager/), [Autostart plugin](https://v2.tauri.app/plugin/autostart/), [webview JS API (onDragDropEvent)](https://v2.tauri.app/reference/javascript/api/namespacewebview/), [window config (`dragDropEnabled`)](https://v2.tauri.app/reference/config/), [Windows Installer](https://v2.tauri.app/distribute/windows-installer/)
- Source verified: [global-hotkey Windows impl](https://github.com/tauri-apps/global-hotkey/blob/dev/src/platform_impl/windows/mod.rs) (`ERROR_HOTKEY_ALREADY_REGISTERED` → `Error::AlreadyRegistered`)
- Issues/PRs: [tauri#14088](https://github.com/tauri-apps/tauri/issues/14088) (hidden-window crash, fixed), [tray-icon#284](https://github.com/tauri-apps/tray-icon/pull/284), [tray-icon#325](https://github.com/tauri-apps/tray-icon/pull/325) (Explorer restart), [tao#476](https://github.com/tauri-apps/tao/issues/476) (closed), [tauri PR#12643](https://github.com/tauri-apps/tauri/pull/12643) (NSIS autostart cleanup), [plugins-workspace#2225](https://github.com/tauri-apps/plugins-workspace/issues/2225) (readImagePNG request), [#3415](https://github.com/tauri-apps/plugins-workspace/issues/3415) (Win+V crash report), [#1107](https://github.com/tauri-apps/plugins-workspace/issues/1107), [#771](https://github.com/tauri-apps/plugins-workspace/issues/771) (autostart entry vanishing), [tauri#14770](https://github.com/tauri-apps/tauri/issues/14770) (hotkey vs elevated focus), [tauri#7519](https://github.com/tauri-apps/tauri/issues/7519)/[#11566](https://github.com/tauri-apps/tauri/issues/11566) (focus quirks), [tauri#13761](https://github.com/tauri-apps/tauri/issues/13761) (`dragDropEnabled` via Rust builder), [discussion #11489](https://github.com/tauri-apps/tauri/discussions/11489) (tray-only pattern)
- Footprint: [Electron vs Tauri comparisons, 2026](https://tech-insider.org/tauri-vs-electron-2026/) (~42 MB vs ~168 MB idle), [openreplay comparison](https://blog.openreplay.com/comparing-electron-tauri-desktop-applications/), wry `set_memory_usage_level` ([wry v0.35 release notes](https://v2.tauri.app/release/wry/v0.35.0/))
