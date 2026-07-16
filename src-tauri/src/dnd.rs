//! The runtime fs grant behind drag-and-drop (story 5).
//!
//! `src/ui/main.tsx` reads a dropped screenshot with plugin-fs's `readFile`,
//! which is checked against plugin-fs's scope. A drop hands us an **arbitrary**
//! path the user just chose — `D:\shots\bug.png`, a network share, a USB stick —
//! so no *static* scope can honestly cover it. The old capability file tried
//! anyway with `$HOME/**` + `$TEMP/**`, which managed to be both too wide and too
//! narrow at once: a blanket read over everything the user owns, that still
//! denied a screenshot saved to a second drive.
//!
//! The file picker never hit this, which is why it went unnoticed: plugin-dialog
//! grants the picked path at RUNTIME, inside its own command, before handing the
//! path back (tauri-plugin-dialog-2.7.1/src/commands.rs:194 — `s.allow_file(&path)?`
//! on `window.try_fs_scope()`). So the picker worked and the drop didn't, through
//! the same `readFile` call.
//!
//! This module mirrors the picker exactly — same scope object, same call — because
//! a drop is the same shape of thing: the gesture *is* the consent, so it earns
//! exactly the file it names, at the moment it names it. The static scope then
//! stays pinned to the two directories Quacket owns.
//!
//! Worth knowing, because it looks like this is already handled: Tauri core does
//! call `scopes.allow_file` on drop (tauri-2.11.5/src/manager/window.rs:232) — but
//! `crate::Scopes::allow_file` only touches the **asset-protocol** scope
//! (tauri-2.11.5/src/scope/mod.rs:29-33), never plugin-fs's. Reading that line and
//! assuming we were covered is how this gap survives a skim. plugin-fs has to be
//! told separately.

use std::path::{Path, PathBuf};

/// Mirrors `IMAGE_EXTENSIONS` in `src/ui/main.tsx`, which filters on it before
/// calling `readFile`. A drop can carry anything — dropping a folder of secrets
/// on the window must not make them readable — so only the files the frontend
/// will actually read get a grant.
const IMAGE_EXTENSIONS: [&str; 3] = ["png", "jpg", "jpeg"];

/// Anything that can widen plugin-fs's scope by one file.
///
/// This exists so the decision below — *which* dropped paths earn a grant — is
/// testable. It cannot be tested against a real `tauri::fs::Scope`: building one
/// needs a `Manager`, i.e. `tauri::test::mock_app()`, and turning on tauri's
/// `test` feature makes `muda`'s comctl32-v6 imports live in the test binary,
/// which then fails to load (STATUS_ENTRYPOINT_NOT_FOUND) because a test exe gets
/// no v6 activation manifest. That takes the whole Rust suite down with it, so the
/// seam stops here.
///
/// What that leaves unproven is only that `Scope::allow_file` makes a subsequent
/// `readFile` pass — and that is not a guess: it is the identical call on the
/// identical object that plugin-dialog makes for the file picker, which works in
/// this app today. The drop was the only caller missing.
pub trait FileGrant {
    fn allow(&self, path: &Path);
}

impl FileGrant for tauri::fs::Scope {
    fn allow(&self, path: &Path) {
        // Best-effort by design: a path that fails to grant fails the same way it
        // would have without the grant — the read is denied. Nothing to report,
        // nothing to abort.
        let _ = self.allow_file(path);
    }
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| IMAGE_EXTENSIONS.iter().any(|allowed| extension.eq_ignore_ascii_case(allowed)))
}

/// Grants read access to the dropped images, and nothing else.
///
/// `is_file()` rather than `exists()`: a directory would otherwise be handed to
/// `allow_file`, and a grant is only ever for a leaf the frontend will read.
pub fn grant_dropped_images(scope: &impl FileGrant, paths: &[PathBuf]) {
    for path in paths {
        if is_image(path) && path.is_file() {
            scope.allow(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Records what was granted, so a test can ask the question that matters —
    /// "could the user's screenshot be read, and could nothing else?" — rather
    /// than assert that some function got called.
    #[derive(Default)]
    struct Recorder(RefCell<Vec<PathBuf>>);

    impl FileGrant for Recorder {
        fn allow(&self, path: &Path) {
            self.0.borrow_mut().push(path.to_path_buf());
        }
    }

    impl Recorder {
        fn granted(&self) -> Vec<PathBuf> {
            self.0.borrow().clone()
        }
    }

    /// A real file, because `grant_dropped_images` asks the filesystem whether a
    /// path is a file — a fixture of made-up strings would pass the extension
    /// check and then silently grant nothing, and the test would still look green.
    fn a_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("quacket-dnd-test");
        std::fs::create_dir_all(&dir).expect("temp dir is creatable");
        let path = dir.join(name);
        std::fs::write(&path, b"not really a screenshot").expect("temp file is writable");
        path
    }

    #[test]
    fn a_screenshot_dropped_from_outside_the_home_tree_is_granted() {
        // The defect: a screenshot saved on a second drive / share / USB stick.
        // `$HOME/**` never covered such a path, so the drop landed and `readFile`
        // threw. Nothing about the grant may depend on WHERE the file lives — a
        // path on another volume can't be created in a test, so this pins the
        // location-independent half of the decision directly.
        assert!(is_image(Path::new(r"D:\shots\bug.png")), r"D:\shots\bug.png is not recognised as a droppable screenshot");
        assert!(is_image(Path::new(r"\\nas\team\repro.png")), "a screenshot on a network share is not recognised");

        let recorder = Recorder::default();
        let dropped = a_file("bug.png");
        grant_dropped_images(&recorder, std::slice::from_ref(&dropped));

        assert_eq!(recorder.granted(), vec![dropped], "a dropped screenshot earned no grant — story 5's drag path is dead");
    }

    #[test]
    fn the_drop_grants_the_dropped_file_and_not_its_neighbours() {
        let recorder = Recorder::default();
        let dropped = a_file("dropped.png");
        let neighbour = a_file("private.png");

        grant_dropped_images(&recorder, std::slice::from_ref(&dropped));

        // The point of granting at runtime instead of widening the glob: a sibling
        // in the same directory is never named, so it never becomes readable.
        assert_eq!(recorder.granted(), vec![dropped]);
        assert!(!recorder.granted().contains(&neighbour), "the grant leaked to a neighbouring file");
    }

    #[test]
    fn dropping_a_non_image_grants_nothing() {
        let recorder = Recorder::default();
        let secrets = a_file("id_rsa.txt");

        grant_dropped_images(&recorder, std::slice::from_ref(&secrets));

        // main.tsx never reads it, so it must never become readable — dropping a
        // file on a window is not consent to read everything in the drop.
        assert!(recorder.granted().is_empty(), "a dropped non-image was granted read access");
    }

    #[test]
    fn dropping_a_directory_grants_nothing() {
        let recorder = Recorder::default();
        // Named `.png` on purpose: the extension check alone would wave this
        // through, and `allow_file` on a directory is not a grant we ever want.
        let dir = std::env::temp_dir().join("quacket-dnd-test-dir.png");
        std::fs::create_dir_all(&dir).expect("temp dir is creatable");

        grant_dropped_images(&recorder, &[dir]);

        assert!(recorder.granted().is_empty(), "a dropped directory was granted as a file");
    }

    #[test]
    fn a_mixed_drop_grants_only_the_images() {
        let recorder = Recorder::default();
        let shot = a_file("shot.png");
        let notes = a_file("notes.md");
        let photo = a_file("photo.jpeg");

        grant_dropped_images(&recorder, &[shot.clone(), notes, photo.clone()]);

        assert_eq!(recorder.granted(), vec![shot, photo]);
    }

    #[test]
    fn a_screenshot_dropped_in_any_casing_is_granted() {
        // Windows hands back whatever case the filesystem holds; main.tsx matches
        // case-insensitively (/\.(png|jpe?g)$/i), so a case-sensitive grant here
        // would let the frontend read a file it was never granted.
        for name in ["shot.JPG", "shot.Jpeg", "shot.PNG"] {
            let recorder = Recorder::default();
            let dropped = a_file(name);
            grant_dropped_images(&recorder, std::slice::from_ref(&dropped));
            assert_eq!(recorder.granted(), vec![dropped], "{name} was dropped but never granted");
        }
    }

    /// `run()` builds a real Tauri app, so the `on_window_event` closure cannot be
    /// called from a unit test — and everything above it passes with the closure
    /// gutted, which is the whole reason this exists. Every defect this codebase
    /// has shipped has been a correct engine with the last wire to the user cut,
    /// surviving because the tests exercised the engine. So this one asserts the
    /// wire, the same way `capabilities.rs` asserts the ACL: by reading the real
    /// source instead of trusting that someone kept it plugged in.
    fn lib_rs() -> String {
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
            .expect("src/lib.rs is readable")
    }

    #[test]
    fn a_drop_actually_reaches_the_grant() {
        let source = lib_rs();
        let handler = source
            .split_once(".on_window_event(")
            .expect("run() registers a window event handler")
            .1
            .split_once("\n        .build(")
            .expect("the handler ends")
            .0;

        assert!(
            handler.contains("DragDropEvent::Drop"),
            "nothing in the window event handler reacts to a drop — a dropped screenshot \
             is never granted and `readFile` throws in the shipped app"
        );
        assert!(
            handler.contains("grant_dropped_images"),
            "the window event handler sees the drop but never calls dnd::grant_dropped_images — \
             the grant is dead code and story 5's drag path is broken"
        );
        assert!(
            handler.contains("try_fs_scope"),
            "the grant is not aimed at plugin-fs's scope (`try_fs_scope`), which is the only \
             scope `readFile` is checked against — tauri core's `Scopes` is the asset-protocol \
             scope and grants readFile nothing"
        );
    }

    #[test]
    fn the_grant_lands_before_the_frontend_reads() {
        // Tauri runs its own handler — the one that emits `tauri://drag-drop` to the
        // webview — BEFORE the listeners registered via Builder::on_window_event
        // (tauri-2.11.5/src/manager/window.rs:100). So granting only on Drop races
        // the frontend's readFile. Enter carries the same paths and precedes Drop by
        // human-scale time, which removes the race rather than winning it.
        let source = lib_rs();
        let handler = source.split_once(".on_window_event(").expect("a window event handler").1;

        assert!(
            handler.contains("DragDropEvent::Enter"),
            "the grant only happens on Drop, which races the `tauri://drag-drop` event Tauri \
             emits to the webview before our listener runs"
        );
    }

    #[test]
    fn the_granted_extensions_are_the_ones_the_frontend_reads() {
        // Derived from src/ui/main.tsx rather than remembered here: if the frontend
        // starts accepting another format, this goes red instead of the user's drop
        // silently failing the scope check in the shipped app.
        let source = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("src-tauri has a parent").join("src/ui/main.tsx"),
        )
        .expect("src/ui/main.tsx is readable");

        let list = source
            .split_once("const IMAGE_EXTENSIONS = [")
            .expect("src/ui/main.tsx declares IMAGE_EXTENSIONS")
            .1
            .split_once(']')
            .expect("a closed array")
            .0;
        let frontend: Vec<String> = list
            .split(',')
            .map(|name| name.trim().trim_matches('\'').to_string())
            .filter(|name| !name.is_empty())
            .collect();

        assert_eq!(
            frontend,
            IMAGE_EXTENSIONS.to_vec(),
            "src/ui/main.tsx reads a different set of extensions than the drop grants"
        );
    }
}
