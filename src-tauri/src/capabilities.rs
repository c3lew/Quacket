//! Tests over `capabilities/default.json`.
//!
//! The capability file is the only thing standing between the frontend and the
//! machine, and it is the one part of Quacket that **no other test can see**:
//! vitest fakes `window.__TAURI_INTERNALS__`, so every `src/**` test runs as if
//! the ACL had granted everything. A permission missing here is invisible until
//! the shipped app throws.
//!
//! It really was missing. The file granted `fs:allow-read-file` and nothing
//! else, while plugin-fs permissions are strictly **per-command** — so seven of
//! the eight `FileStore` methods (and `exists`, which `readBytes` needs to tell
//! a miss from an IO error) were denied at runtime. Draft persistence, the
//! discovery cache and codex's AGENTS.md scratch dir were all dead in the
//! shipped app while 470 tests stayed green.
//!
//! So these tests derive what is *needed* from the frontend source itself
//! rather than from a list someone remembered to update: import a new plugin-fs
//! API and forget the permission, and this goes red here instead of in the
//! user's hands.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

/// plugin-fs JS API → the IPC command it invokes → the permission that enables
/// that command. An import this table does not know is a hard failure, not a
/// skip: a silent pass is the exact hole this file exists to close.
///
/// The third column is not taken on trust — `the_permission_table_matches_the_
/// plugins_own_manifest` checks each one against plugin-fs's generated ACL
/// manifest, so a table that merely looks right cannot make the other tests lie.
const FS_PERMISSION: &[(&str, &str, &str)] = &[
    ("exists", "exists", "fs:allow-exists"),
    ("mkdir", "mkdir", "fs:allow-mkdir"),
    ("readDir", "read_dir", "fs:allow-read-dir"),
    ("readFile", "read_file", "fs:allow-read-file"),
    ("readTextFile", "read_text_file", "fs:allow-read-text-file"),
    ("remove", "remove", "fs:allow-remove"),
    ("rename", "rename", "fs:allow-rename"),
    ("writeFile", "write_file", "fs:allow-write-file"),
    ("writeTextFile", "write_text_file", "fs:allow-write-text-file"),
];

/// The two directories Quacket owns. **Everything** static has to stay inside
/// them — there is no exception for the dragged-in screenshot any more. That
/// read is granted per-file at runtime by `crate::dnd` at the moment of the
/// drop, the same way plugin-dialog grants a picked path inside its own command.
const OWNED: [&str; 4] = ["$APPDATA", "$APPDATA/**", "$TEMP/quacket", "$TEMP/quacket/**"];

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("src-tauri has a parent").to_path_buf()
}

fn capability() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities/default.json");
    let raw = std::fs::read_to_string(&path).expect("capabilities/default.json is readable");
    serde_json::from_str(&raw).expect("capabilities/default.json is valid JSON")
}

/// identifier → the scope paths that entry declares (empty when it declares none).
fn granted() -> BTreeMap<String, Vec<String>> {
    let capability = capability();
    let permissions = capability["permissions"].as_array().expect("permissions is a list");
    permissions
        .iter()
        .map(|entry| match entry {
            Value::String(id) => (id.clone(), Vec::new()),
            Value::Object(map) => {
                let id = map["identifier"].as_str().expect("identifier is a string").to_string();
                let paths = map
                    .get("allow")
                    .and_then(Value::as_array)
                    .map(|allow| {
                        allow
                            .iter()
                            .filter_map(|e| e.get("path").and_then(Value::as_str))
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                (id, paths)
            }
            other => panic!("a permission is neither a string nor an object: {other}"),
        })
        .collect()
}

fn frontend_sources(dir: &Path, into: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("src/ is readable").flatten() {
        let path = entry.path();
        if path.is_dir() {
            frontend_sources(&path, into);
        } else if matches!(path.extension().and_then(|e| e.to_str()), Some("ts" | "tsx")) {
            into.push(path);
        }
    }
}

/// The plugin-fs APIs the frontend actually imports, read out of the real
/// `import { … } from '@tauri-apps/plugin-fs'` statements.
fn imported_fs_apis() -> BTreeSet<String> {
    let mut files = Vec::new();
    frontend_sources(&repo().join("src"), &mut files);

    let mut apis = BTreeSet::new();
    for file in files {
        let source = std::fs::read_to_string(&file).expect("source is readable");
        for (before, _) in source.match_indices("} from '@tauri-apps/plugin-fs'").map(|(i, _)| (&source[..i], ())) {
            let names = before.rsplit_once("import {").expect("a braced import").1;
            apis.extend(
                names
                    .split(',')
                    .map(|name| name.trim().to_string())
                    .filter(|name| !name.is_empty() && !name.starts_with("type ")),
            );
        }
    }
    assert!(!apis.is_empty(), "found no plugin-fs imports at all — the scan is broken, not the ACL");
    apis
}

/// plugin-fs's own generated ACL manifest — the ground truth for which
/// permission enables which command. Written by `tauri-build` on every build,
/// so it is always present and always current with the installed plugin.
fn plugin_fs_manifest() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("gen/schemas/acl-manifests.json");
    let raw = std::fs::read_to_string(&path).expect("tauri-build writes gen/schemas/acl-manifests.json");
    let manifests: Value = serde_json::from_str(&raw).expect("valid JSON");
    manifests["fs"].clone()
}

#[test]
fn the_permission_table_matches_the_plugins_own_manifest() {
    let manifest = plugin_fs_manifest();

    for (api, command, permission) in FS_PERMISSION {
        let name = permission.strip_prefix("fs:").expect("an fs permission");
        let enables = &manifest["permissions"][name]["commands"]["allow"];
        let enables = enables
            .as_array()
            .unwrap_or_else(|| panic!("{permission} is not a real plugin-fs permission"));

        // The link the other tests rest on: `{permission}` really is what turns
        // `{command}` on, per the plugin rather than per my memory.
        assert!(
            enables.iter().any(|c| c.as_str() == Some(*command)),
            "{permission} does not enable `{command}` (which is what plugin-fs's `{api}` calls); \
             it enables {enables:?}"
        );
    }
}

#[test]
fn every_plugin_fs_api_the_frontend_imports_is_granted() {
    let table: BTreeMap<&str, &str> =
        FS_PERMISSION.iter().map(|(api, _, permission)| (*api, *permission)).collect();
    let granted = granted();

    for api in imported_fs_apis() {
        let permission = table.get(api.as_str()).unwrap_or_else(|| {
            panic!("{api} is imported from plugin-fs but this test has no permission mapped for it")
        });
        assert!(
            granted.contains_key(*permission),
            "src/ calls plugin-fs `{api}`, but capabilities/default.json never grants `{permission}` \
             — plugin-fs permissions are per-command, so this call throws in the shipped app"
        );
    }
}

#[test]
fn no_fs_permission_reaches_outside_quackets_own_directories() {
    for (id, paths) in granted() {
        if !id.starts_with("fs:") {
            continue;
        }
        for path in paths {
            // `fs:allow-read-file` used to be exempted here, "because a dragged
            // screenshot is an arbitrary path". It is — which is exactly why a
            // static glob was the wrong tool: $HOME/** handed a tray app read
            // access to everything the user owns and STILL denied a screenshot
            // on D:. The drop grants itself now (`crate::dnd`), so the exemption
            // is gone and no fs entry gets to name a path out here.
            assert!(
                OWNED.contains(&path.as_str()),
                "{id} is scoped to {path}, outside $APPDATA and $TEMP/quacket — a path the user \
                 supplies at runtime is granted at runtime by crate::dnd, never pre-granted here"
            );
        }
    }
}

#[test]
fn the_global_fs_scope_is_exactly_the_two_directories_quacket_owns() {
    let granted = granted();
    let scope = granted.get("fs:scope").expect("fs:scope declares the global fs scope");

    // `fs:scope` enables no command, so its paths land in the GLOBAL scope —
    // the one every fs permission above is checked against. A $HOME here would
    // silently widen all nine of them, which is how a tray app ends up able to
    // rewrite the user's home directory.
    assert_eq!(scope, &OWNED, "the global fs scope drifted");
}

#[test]
fn no_fs_permission_carries_a_scope_of_its_own() {
    let granted = granted();

    // The previous version of this test asserted the OPPOSITE of the truth — that
    // `fs:allow-read-file` MUST carry a `$HOME` scope, "because drag-and-drop needs
    // to read arbitrary paths". It does need that; a static glob just cannot supply
    // it. So the test pinned a blanket filesystem grant in place and, worse, made
    // the remaining hole invisible: $HOME/** never covered D:\shots\bug.png either,
    // and the test asserting the flawed scope was present is the reason nobody
    // looked. Reading a scope out of the code and asserting the code has it proves
    // only that the code is the code.
    //
    // Written from the spec instead: every path Quacket may touch statically is a
    // path Quacket owns (`fs:scope`), and a path the USER names at runtime is
    // granted at runtime. So no per-entry scope should exist at all.
    for (id, paths) in granted.iter().filter(|(id, _)| id.starts_with("fs:") && *id != "fs:scope") {
        assert!(
            paths.is_empty(),
            "{id} carries its own scope ({paths:?}); every fs command is checked against the \
             global fs:scope, which is Quacket's own directories"
        );
    }
}

#[test]
fn no_shell_permission_survives() {
    for id in granted().keys() {
        // Quacket spawns through quacket_run / quacket_spawn, whose allowlist is
        // enforced in Rust (src-tauri/src/proc.rs). Re-granting a plugin-shell
        // permission would put a second, softer spawn path next to it.
        assert!(!id.starts_with("shell:"), "{id} re-opens tauri-plugin-shell as a spawn path");
    }
}
