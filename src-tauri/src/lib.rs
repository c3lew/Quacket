//! Thin glue. Tray, global shortcut, autostart, window management, and a spawn
//! command — nothing else.
//!
//! Every decision Quacket actually makes (which CLI to call, how to refine, what to
//! file) lives in the TS core behind the `ProcessRunner` seam. Rust only owns the
//! things a webview cannot: the tray, an OS-level hotkey, keeping the capture
//! window alive and hidden so summoning it is instant, and — see `proc` — actually
//! owning a child process, because no shipped plugin can close a child's stdin or
//! kill one on a timeout, and both CLIs need both.

mod dnd;
mod proc;
mod tray_gate;

#[cfg(test)]
mod capabilities;

use serde::Serialize;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, DragDropEvent, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_fs::FsExt;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// The one webview. Created hidden at startup and never destroyed — see `hide_on_close`.
const CAPTURE_WINDOW: &str = "main";

/// Mirrors `DEFAULT_SETTINGS.hotkey` in `src/core/types.ts`. Registered natively at
/// startup so the app is summonable before the webview finishes booting; the frontend
/// rebinds via the global-shortcut JS plugin when the user's stored hotkey differs.
const DEFAULT_HOTKEY: &str = "CmdOrCtrl+Shift+Q";

/// Passed by the autostart Run key so a boot-launched Quacket comes up tray-only.
const HIDDEN_FLAG: &str = "--hidden";

/// Why the startup hotkey isn't live. `None` means it registered fine.
///
/// Held in app state rather than pushed as an event: `setup` runs before the webview
/// has a listener attached, so an event emitted here is dropped every single time.
/// The frontend reads this once on mount via the `hotkey_conflict` command.
#[derive(Clone, Serialize)]
pub struct HotkeyConflict {
    pub hotkey: String,
    pub reason: String,
}

struct StartupHotkey(Option<HotkeyConflict>);

/// The persistent, non-blocking warning. `None` = the hotkey is live.
#[tauri::command]
fn hotkey_conflict(state: tauri::State<'_, StartupHotkey>) -> Option<HotkeyConflict> {
    state.0.clone()
}

fn show_capture(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(CAPTURE_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn toggle_capture(app: &AppHandle) {
    let Some(window) = app.get_webview_window(CAPTURE_WINDOW) else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let version = MenuItemBuilder::with_id("version", format!("Quacket v{}", env!("CARGO_PKG_VERSION")))
        .enabled(false)
        .build(app)?;
    let capture = MenuItemBuilder::with_id("capture", "New report").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit Quacket").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&version)
        .separator()
        .item(&capture)
        .separator()
        .item(&quit)
        .build()?;

    TrayIconBuilder::with_id("quacket")
        .icon(app.default_window_icon().expect("bundle icon is configured").clone())
        .tooltip("Quacket")
        .menu(&menu)
        // Left-click toggles the capture window; right-click opens the menu.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "capture" => show_capture(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // A double-click delivers TWO Click{Up}s (the second press becomes
            // DBLCLK, the second release does not — captured live, see
            // tray_gate.rs). Ungated, the toggle runs twice and the window
            // opens-then-closes. The gate makes the burst one gesture.
            static GATE: std::sync::Mutex<Option<tray_gate::ClickGate>> = std::sync::Mutex::new(None);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let mut gate = GATE.lock().expect("tray gate lock");
                let admitted = gate
                    .get_or_insert_with(|| tray_gate::ClickGate::new(tray_gate::double_click_interval()))
                    .admit(std::time::Instant::now());
                if admitted {
                    toggle_capture(tray.app_handle());
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// Registers the default hotkey. A conflict is reported, never fatal and never
/// auto-rebound: the OS returns `AlreadyRegistered` and the app still starts.
fn register_hotkey(app: &AppHandle) -> Option<HotkeyConflict> {
    // Parse failure and registration conflict are different error types but the same
    // outcome for the user: no hotkey, app still runs, tray still works.
    let reason = match DEFAULT_HOTKEY.parse::<tauri_plugin_global_shortcut::Shortcut>() {
        Ok(shortcut) => app.global_shortcut().register(shortcut).err()?.to_string(),
        Err(e) => e.to_string(),
    };
    Some(HotkeyConflict {
        hotkey: DEFAULT_HOTKEY.to_string(),
        reason,
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_FLAG]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    // This global handler fires for EVERY registered shortcut —
                    // including a custom hotkey the frontend registers, whose JS
                    // callback (toggleOnHotkey in src/ui) already toggles; the plugin
                    // dispatches both handlers for one press, and two toggles cancel
                    // out. Acting on the default only keeps it to one toggle per
                    // press: Rust owns the default hotkey, the frontend owns rebinds.
                    if event.state() == ShortcutState::Pressed
                        && DEFAULT_HOTKEY.parse::<Shortcut>().is_ok_and(|s| s == *shortcut)
                    {
                        toggle_capture(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(proc::Sessions::default())
        .invoke_handler(tauri::generate_handler![
            hotkey_conflict,
            proc::quacket_run,
            proc::quacket_spawn,
            proc::quacket_stdin_write,
            proc::quacket_kill,
        ])
        .setup(|app| {
            let handle = app.handle();
            build_tray(handle)?;
            app.manage(StartupHotkey(register_hotkey(handle)));

            // The window is `visible: false` in tauri.conf.json, so an autostarted
            // launch is already tray-only. A launch the user asked for should show up.
            if !std::env::args().any(|arg| arg == HIDDEN_FLAG) {
                show_capture(handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // The X hides; it must never destroy the webview. Recreating it costs
            // high-hundreds of ms of WebView2 init and breaks the instant summon.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }

            // A drop is the user handing us a specific file, so it earns read access
            // to exactly that file — see `dnd`. This is what keeps the static scope in
            // capabilities/default.json pinned to Quacket's own two directories.
            //
            // Granted on Enter as well as Drop, and that is not belt-and-braces. Tauri
            // runs its OWN handler before ours and that handler is what emits the JS
            // `tauri://drag-drop` the frontend listens on (tauri-2.11.5/src/manager/
            // window.rs:100 — `on_window_event(&window_, event)` first, THEN the
            // listeners registered here). So a grant on Drop alone is racing the
            // frontend's `readFile`; it wins by orders of magnitude — an IPC round trip
            // versus a few instructions — but it is still a race, and "wins in practice"
            // is how a wire like this ends up crossed. Enter carries the same paths and
            // precedes Drop by human-scale time, which settles it. Cost of the Enter
            // grant: read access to an image the user dragged onto our window and then
            // did not release. Idempotent, so the pair costs nothing.
            WindowEvent::DragDrop(DragDropEvent::Enter { paths, .. } | DragDropEvent::Drop { paths, .. }) => {
                if let Some(scope) = window.try_fs_scope() {
                    dnd::grant_dropped_images(&scope, paths);
                }
            }

            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build Quacket")
        .run(|_app, event| {
            // Hiding the last window must not exit — the tray is the app.
            if let RunEvent::ExitRequested { api, code: None, .. } = event {
                api.prevent_exit();
            }
        });
}
