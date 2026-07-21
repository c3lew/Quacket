//! The production half of the `ProcessRunner` seam (`src/core/runner.ts`).
//!
//! Spawn, IO, kill, allowlist. Nothing else — no arg assembly, no parsing, no
//! decision about which CLI to call. All of that is the TS core's job and stays
//! testable behind the seam; this module only has to make the seam's promises
//! true on a real machine.
//!
//! ── Why this exists instead of tauri-plugin-shell ────────────────────────────
//!
//! plugin-shell 2.3.5 exposes five IPC commands — `execute`, `spawn`,
//! `stdin_write`, `kill`, `open` — and **no way to close a child's stdin**.
//! `execute()` closes stdin but accepts none and hands back no pid; `spawn()`
//! can write stdin but its `CommandChild::stdin_writer` is private and only
//! drops when the child dies. Neither is enough, and the shortfall is not
//! cosmetic:
//!
//!   - `gh api graphql --input -` with stdin written but never closed returns
//!     **HTTP 400** after 10.3 s. Closed: correct body in 0.6 s.
//!   - `claude -p --input-format stream-json` with stdin written but never
//!     closed emits its complete `result` event at 2.8 s and then **never
//!     exits** (still alive at 45 s).
//!
//! Both are silently wrong answers, not degradation. And `execute()`'s missing
//! pid meant a timeout could report `timedOut: true` while the child kept
//! running — neither CLI has a built-in timeout
//! (docs/research/headless-cli-invocation-contract.md: "Adapter must enforce
//! (kill process)"), so an un-killable timeout is a lie in a tray app that
//! sells a 40–80 MB idle footprint.
//!
//! Both gaps are the same gap: we never owned the child. Here we do.
//!
//! ── What replaces plugin-shell's scope ───────────────────────────────────────
//!
//! A spawn command that runs whatever the webview names is strictly worse than
//! the plugin it replaces. `ALLOWED` is the replacement, and it is enforced
//! here, in Rust — a frontend-side check is not a security boundary.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// Quacket's entire outside world. Exactly the three CLIs the spec names, and
/// nothing the webview says can add a fourth.
const ALLOWED: [&str; 3] = ["claude", "codex", "gh"];

/// How often a timed run checks whether the child is done. Adds at most this
/// much latency to a call that already costs seconds.
const POLL: Duration = Duration::from_millis(10);

/// Resolves a webview-supplied program name to the program we actually spawn.
///
/// The return type is the point: `&'static str` can only be one of the literals
/// in `ALLOWED`, so the string handed to `Command::new` is never webview data —
/// it is a compile-time constant selected by an equality test.
fn allow(program: &str) -> Result<&'static str, String> {
    let name = ALLOWED
        .iter()
        .copied()
        .find(|allowed| *allowed == program)
        .ok_or_else(|| format!("program not allowed: {program}"))?;
    Ok(shim(name))
}

/// npm ships codex as a `.cmd` shim, and `std::process::Command` appends only
/// `.exe` when it resolves PATH — a bare `codex` is "program not found". This
/// lives here rather than in TS because the frontend sniffing `navigator
/// .userAgent` to pick a binary name is both fragile and the wrong layer:
/// `cfg!(windows)` is the truth, and the allowlist stays three names wide.
#[cfg(windows)]
fn shim(name: &'static str) -> &'static str {
    if name == "codex" {
        "codex.cmd"
    } else {
        name
    }
}

#[cfg(not(windows))]
fn shim(name: &'static str) -> &'static str {
    name
}

/// Mirrors `ProcSpec` in `src/core/runner.ts`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    program: String,
    args: Vec<String>,
    /// Written to stdin, which is then closed. Closing happens either way — see
    /// `run_blocking`.
    stdin: Option<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
}

/// Mirrors `ProcResult` in `src/core/runner.ts`.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcResult {
    /// `null` when we killed the child rather than letting it exit.
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

/// What a `session` streams back. Matches the `Event` union in `src/app/runner.ts`.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum Event {
    /// One line of stdout. Split here so the frontend never has to reassemble a
    /// half-arrived JSON line of a control protocol.
    Stdout(String),
    Stderr(String),
    Terminated { code: Option<i32> },
}

fn build(program: &str, spec: &Spec) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(&spec.args);
    if let Some(cwd) = &spec.cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A tray app has no console to reuse, so spawning one — especially
        // `codex`, which goes through cmd.exe — would flash a black window in
        // the user's face on every refine.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Reads a pipe to EOF on its own thread.
///
/// `from_utf8_lossy` rather than `read_to_string`: a CLI that emits one invalid
/// byte must not cost us the whole stream, and core parses text.
fn drain<R: Read + Send + 'static>(mut pipe: R) -> JoinHandle<String> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

/// Waits for the child, killing it if `timeout_ms` elapses first.
/// `None` means we killed it.
fn wait(child: &mut Child, tree: &Option<tree::Tree>, timeout_ms: Option<u64>) -> Option<ExitStatus> {
    let Some(ms) = timeout_ms else {
        return child.wait().ok();
    };
    let deadline = Instant::now() + Duration::from_millis(ms);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() >= deadline {
            kill(child, tree);
            // Reap, so the pid is not left as a zombie and the pipes close —
            // which is what unblocks the drain threads below.
            let _ = child.wait();
            return None;
        }
        thread::sleep(POLL);
    }
}

fn kill(child: &mut Child, tree: &Option<tree::Tree>) {
    if let Some(tree) = tree {
        tree.kill();
    }
    let _ = child.kill();
}

/// `run` from the seam: spawn, deliver stdin, **close stdin**, collect output,
/// enforce the timeout by killing the child.
fn run_blocking(program: &str, spec: Spec) -> Result<ProcResult, String> {
    let mut child = build(program, &spec)
        .spawn()
        .map_err(|e| format!("failed to spawn {program}: {e}"))?;
    let tree = tree::Tree::attach(&child);

    let stdout = drain(child.stdout.take().expect("stdout was piped"));
    let stderr = drain(child.stderr.take().expect("stderr was piped"));

    // THE ENTIRE POINT OF THIS COMMAND. `take()` moves the pipe out of the
    // Child so that dropping it at the end of this closure closes it, and that
    // close is the EOF both CLIs need to answer at all.
    //
    // It happens even when there is no payload: `claude` stalls 3 s on a
    // piped-but-empty stdin and `codex` reads it and appends a bogus `<stdin>`
    // block to the prompt. "Always closed" is the seam's promise, not an
    // optimisation.
    //
    // On its own thread because the payload is a base64 screenshot often enough:
    // a pipe holds ~64 KB, so writing inline would deadlock a child that is
    // blocked writing stdout nobody has started draining.
    let mut pipe = child.stdin.take().expect("stdin was piped");
    let payload = spec.stdin.unwrap_or_default();
    let writer = thread::spawn(move || {
        // A child that exits without draining stdin is not an error, just an
        // early EOF on its side.
        let _ = pipe.write_all(payload.as_bytes());
        drop(pipe);
    });

    let Some(status) = wait(&mut child, &tree, spec.timeout_ms) else {
        // A timed-out run reports no output and does not wait to collect any.
        // Joining here would be the timeout's own trapdoor: the reader threads
        // are attached to pipes a grandchild we cannot see may still hold open,
        // so "we killed it" would become a hang. Nothing is lost — every caller
        // in core branches on `timedOut` and never looks at stdout (and the
        // FakeRunner the whole suite is written against returns exactly this).
        return Ok(ProcResult {
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: true,
        });
    };

    // The child is gone, so the pipes are closed and all three threads are
    // already finishing.
    let _ = writer.join();
    Ok(ProcResult {
        exit_code: status.code(),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
        timed_out: false,
    })
}

#[tauri::command]
pub async fn quacket_run(spec: Spec) -> Result<ProcResult, String> {
    let program = allow(&spec.program)?;
    // Blocking IO and a poll loop have no business on the async runtime that
    // also drives the UI's IPC.
    tauri::async_runtime::spawn_blocking(move || run_blocking(program, spec))
        .await
        .map_err(|e| e.to_string())?
}

/// Live sessions, by id. Only `session` needs a registry: `run` owns its child
/// start to finish on one blocking task, so there is nothing to look up.
#[derive(Default)]
pub struct Sessions(Mutex<HashMap<u32, Session>>);

pub struct Session {
    child: Arc<Mutex<Child>>,
    /// Never closed while the session lives — that is the whole difference from
    /// `run`. It closes when the Session is dropped from the registry.
    stdin: ChildStdin,
    tree: Option<tree::Tree>,
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// `session` from the seam: spawn, stream stdout lines out, keep stdin open for
/// writes, kill on demand. The discovery control protocols (claude stream-json
/// `initialize`, transient `codex app-server` JSON-RPC) write a request, read
/// replies, and kill — they never want stdin EOF, which is the one thing that
/// makes this shape different from `run`.
#[tauri::command]
pub fn quacket_spawn(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    spec: Spec,
    on_event: Channel<Event>,
) -> Result<u32, String> {
    let program = allow(&spec.program)?;
    let mut child = build(program, &spec)
        .spawn()
        .map_err(|e| format!("failed to spawn {program}: {e}"))?;
    let tree = tree::Tree::attach(&child);

    let stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let child = Arc::new(Mutex::new(child));
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

    let out_channel = on_event.clone();
    let out = thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if out_channel.send(Event::Stdout(line)).is_err() {
                break;
            }
        }
    });

    let err_channel = on_event.clone();
    let err = thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if err_channel.send(Event::Stderr(line)).is_err() {
                break;
            }
        }
    });

    let waiting = child.clone();
    // Registered BEFORE the waiter exists. A CLI that dies instantly — a bad
    // flag, a PATH miss — would otherwise have its `remove` run before this
    // `insert`, and the entry it failed to find would then sit in the map with
    // a job handle and a pipe nobody ever closes.
    sessions.0.lock().unwrap().insert(id, Session { child, stdin, tree });

    thread::spawn(move || {
        // Joining the readers first is what orders `Terminated` last: both pipes
        // hit EOF when the child dies, so by here there is no line left to lose.
        let _ = out.join();
        let _ = err.join();
        let code = loop {
            // Scoped so the guard is released before the sleep — `quacket_kill`
            // needs this same lock, and holding it across a wait would deadlock.
            let status = { waiting.lock().unwrap().try_wait() };
            match status {
                Ok(Some(status)) => break status.code(),
                Ok(None) => thread::sleep(POLL),
                Err(_) => break None,
            }
        };
        // Dropping the Session closes the job handle and the stdin pipe. Leaving
        // it would leak both for the lifetime of the app.
        app.state::<Sessions>().0.lock().unwrap().remove(&id);
        let _ = on_event.send(Event::Terminated { code });
    });

    Ok(id)
}

#[tauri::command]
pub fn quacket_stdin_write(sessions: State<'_, Sessions>, id: u32, buffer: String) -> Result<(), String> {
    let mut live = sessions.0.lock().unwrap();
    let session = live.get_mut(&id).ok_or("session already ended")?;
    session.stdin.write_all(buffer.as_bytes()).map_err(|e| e.to_string())?;
    // The control protocols are request/response: an unflushed request is a hang.
    session.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn quacket_kill(sessions: State<'_, Sessions>, id: u32) {
    let mut live = sessions.0.lock().unwrap();
    // Killing an already-finished session is a no-op, not an error: the caller
    // races the child's own exit every time.
    if let Some(session) = live.get_mut(&id) {
        if let Some(tree) = &session.tree {
            tree.kill();
        }
        let _ = session.child.lock().unwrap().kill();
    }
}

/// Killing a `Child` kills exactly one process.
///
/// That is not enough on Windows: `codex` is an npm `.cmd` shim, so std runs it
/// through `cmd.exe` — killing the child kills cmd.exe and leaves the real codex
/// running, which is precisely the orphan the timeout exists to prevent. A job
/// object with `KILL_ON_JOB_CLOSE` kills the whole tree, and kills it again if
/// Quacket itself dies, because the handle closes with the process.
#[cfg(windows)]
mod tree {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Tree(HANDLE);

    // The handle is owned by this struct and only ever passed to the two Win32
    // calls below, both of which are thread-safe on a job handle.
    unsafe impl Send for Tree {}
    unsafe impl Sync for Tree {}

    impl Tree {
        /// `None` if the OS refused, in which case the caller falls back to
        /// `Child::kill` — the same reach plugin-shell had.
        pub fn attach(child: &Child) -> Option<Tree> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(limits).cast(),
                    std::mem::size_of_val(&limits) as u32,
                ) != 0
                    && AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) != 0;
                if !ok {
                    CloseHandle(job);
                    return None;
                }
                Some(Tree(job))
            }
        }

        pub fn kill(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// v1 targets Windows. Elsewhere `Child::kill` is the whole story — the same
/// reach tauri-plugin-shell had, so this is not a regression anywhere.
#[cfg(not(windows))]
mod tree {
    pub struct Tree;

    impl Tree {
        pub fn attach(_child: &std::process::Child) -> Option<Tree> {
            None
        }

        pub fn kill(&self) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `node` is not on the allowlist and never will be. It is here as a
    /// *subject*: the engine below the allowlist has to be provable against a
    /// real process, and node is the one interpreter guaranteed installed
    /// alongside this repo's toolchain.
    fn spec(args: &[&str]) -> Spec {
        Spec {
            program: "node".into(),
            args: args.iter().map(|a| (*a).to_string()).collect(),
            stdin: None,
            cwd: None,
            timeout_ms: None,
        }
    }

    fn node(spec: Spec) -> ProcResult {
        run_blocking("node", spec).expect("node should spawn")
    }

    /// Echoes stdin back, but only once stdin reaches EOF. If we never close the
    /// pipe, `end` never fires, node never exits, and the run times out — which
    /// is exactly how this proves EOF landed.
    const ECHO_AT_EOF: &str = "let d='';\
        process.stdin.on('data',c=>{d+=c});\
        process.stdin.on('end',()=>{process.stdout.write('got:'+d)});";

    #[test]
    fn delivers_stdin_and_closes_it() {
        let mut s = spec(&["-e", ECHO_AT_EOF]);
        s.stdin = Some("hello world".into());
        s.timeout_ms = Some(20_000);

        let r = node(s);

        // A child that exited at all is the proof EOF arrived; the echo is the
        // proof the payload arrived first.
        assert_eq!(r.stdout, "got:hello world");
        assert_eq!(r.exit_code, Some(0));
        assert!(!r.timed_out, "child never saw EOF: {r:?}");
    }

    #[test]
    fn closes_stdin_even_with_no_payload() {
        let mut s = spec(&["-e", ECHO_AT_EOF]);
        s.stdin = None;
        s.timeout_ms = Some(20_000);

        let r = node(s);

        // The seam promises stdin is ALWAYS closed: `claude` stalls 3s on a
        // piped-but-empty stdin and `codex` appends a junk <stdin> block.
        assert_eq!(r.stdout, "got:");
        assert!(!r.timed_out, "an empty stdin was left open: {r:?}");
    }

    #[test]
    fn survives_a_payload_larger_than_the_pipe_buffer() {
        // ~1 MB: past the ~64 KB a pipe holds, so an inline write would deadlock
        // against a child writing stdout nobody is draining. Base64 screenshots
        // are routinely this size.
        let payload = "x".repeat(1_000_000);
        let mut s = spec(&[
            "-e",
            "let n=0;process.stdin.on('data',c=>{n+=c.length});\
             process.stdin.on('end',()=>{process.stdout.write(String(n))});\
             process.stdout.write('noise'.repeat(20000));",
        ]);
        s.stdin = Some(payload.clone());
        s.timeout_ms = Some(30_000);

        let r = node(s);

        assert!(r.stdout.ends_with(&payload.len().to_string()), "stdin was truncated");
        assert!(!r.timed_out);
    }

    #[test]
    fn reports_exit_code_stdout_and_stderr() {
        let r = node(spec(&[
            "-e",
            "process.stdout.write('out');process.stderr.write('boom');process.exit(3);",
        ]));

        assert_eq!(r.exit_code, Some(3));
        assert_eq!(r.stdout, "out");
        assert_eq!(r.stderr, "boom");
        assert!(!r.timed_out);
    }

    #[test]
    fn forwards_cwd_and_inherits_env() {
        let dir = std::env::temp_dir().join("quacket-proc-cwd");
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = spec(&["-e", "process.stdout.write(process.cwd())"]);
        s.cwd = Some(dir.to_string_lossy().into_owned());

        let r = node(s);

        assert!(r.stdout.to_lowercase().contains("quacket-proc-cwd"), "cwd ignored: {r:?}");
        // The ambient environment still reaches the child; only renderer-supplied
        // overrides are forbidden, so PATH and CLI authentication remain intact.
        let probe = spec(&["-e", "process.stdout.write(process.env.PATH?'has-path':'no-path')"]);
        assert_eq!(node(probe).stdout, "has-path");
    }

    /// Writes its own pid where the test can read it, then hangs forever.
    const HANG: &str =
        "require('fs').writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},600000);";

    /// Asks the OS, not our own return value, whether a pid is still alive.
    #[cfg(windows)]
    fn alive(pid: &str) -> bool {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .expect("tasklist is on every Windows box");
        String::from_utf8_lossy(&out.stdout).contains(pid)
    }

    #[cfg(not(windows))]
    fn alive(pid: &str) -> bool {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }

    fn wait_until_gone(pid: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if !alive(pid) {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        false
    }

    fn pid_file(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("quacket-{name}-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn timeout_actually_kills_the_child() {
        let pid_path = pid_file("hang");
        let mut s = spec(&["-e", HANG, &pid_path.to_string_lossy()]);
        s.timeout_ms = Some(700);

        let started = Instant::now();
        let r = node(s);

        assert!(r.timed_out);
        assert_eq!(r.exit_code, None, "a killed child has no exit code of its own");
        assert!(started.elapsed() < Duration::from_secs(20), "timeout did not fire");

        // The whole finding: `execute()` could report this and leave the CLI
        // running. Ask the OS instead of believing the struct.
        let pid = std::fs::read_to_string(&pid_path).expect("child never wrote its pid");
        assert!(wait_until_gone(&pid), "child pid {pid} outlived the timeout it reported");
        let _ = std::fs::remove_file(&pid_path);
    }

    /// The codex case. A `.cmd` shim is spawned through cmd.exe, so `Child::kill`
    /// reaches only cmd.exe — the CLI underneath survives. This asserts the job
    /// object takes the whole tree.
    #[cfg(windows)]
    #[test]
    fn timeout_kills_the_grandchild_behind_a_cmd_shim() {
        let pid_path = pid_file("shim");
        let shim = std::env::temp_dir().join(format!("quacket-shim-{}.cmd", std::process::id()));
        std::fs::write(&shim, format!("@echo off\r\nnode -e \"{HANG}\" \"%~1\"\r\n")).unwrap();

        let mut s = spec(&[]);
        s.args = vec![pid_path.to_string_lossy().into_owned()];
        s.timeout_ms = Some(1_500);
        let r = run_blocking(&shim.to_string_lossy(), s).expect("shim should spawn");

        assert!(r.timed_out);
        let pid = std::fs::read_to_string(&pid_path).expect("grandchild never wrote its pid");
        assert!(
            wait_until_gone(&pid),
            "node grandchild {pid} survived: killing cmd.exe is not killing the CLI"
        );
        let _ = std::fs::remove_file(&pid_path);
        let _ = std::fs::remove_file(&shim);
    }

    #[test]
    fn a_child_that_finishes_inside_its_timeout_is_not_killed() {
        let mut s = spec(&["-e", "process.stdout.write('done')"]);
        s.timeout_ms = Some(30_000);

        let r = node(s);

        assert_eq!(r, ProcResult {
            exit_code: Some(0),
            stdout: "done".into(),
            stderr: String::new(),
            timed_out: false,
        });
    }

    #[test]
    fn allows_exactly_the_three_clis() {
        assert_eq!(allow("claude"), Ok("claude"));
        assert_eq!(allow("gh"), Ok("gh"));
        assert!(allow("codex").is_ok());
    }

    #[test]
    fn rejects_every_other_program() {
        for program in [
            "node",
            "cmd",
            "powershell",
            "gh.exe",
            "./gh",
            "C:\\Windows\\System32\\cmd.exe",
            "",
            "GH",
            "gh ",
        ] {
            assert!(
                allow(program).is_err(),
                "{program} must not be spawnable from the webview"
            );
        }
        // The frontend cannot name the shim either — resolving it is Rust's job.
        #[cfg(windows)]
        assert!(allow("codex.cmd").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn resolves_codex_to_its_npm_shim() {
        // Bare `codex` is "program not found": std only appends `.exe`.
        assert_eq!(allow("codex"), Ok("codex.cmd"));
        assert_eq!(allow("claude"), Ok("claude"));
    }

    #[test]
    fn the_command_refuses_a_program_off_the_allowlist() {
        let err = tauri::async_runtime::block_on(quacket_run(spec(&[
            "-e",
            "process.stdout.write('pwned')",
        ])))
        .expect_err("node is not allowlisted");

        assert!(err.contains("not allowed"), "{err}");
        // The check must precede the spawn, not judge its output.
        assert!(!err.contains("pwned"));
    }
}
