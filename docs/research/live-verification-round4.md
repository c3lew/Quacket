# Live Verification — Round 4

**The first time any Quacket code has been run against the real CLIs.** Rounds 1–3 were
verified against fixtures; this report settles, against reality, the assumptions the
adapter still rested on.

Everything below was **executed on 2026-07-16** on the reference machine. Every transcript
is real captured output. Where something is not settled, it says so.

| Tool | Version | Install shape found locally |
|---|---|---|
| Claude Code | **2.1.211** (`claude --version`) | native `C:\Users\user\.local\bin\claude.exe` |
| Codex CLI | 0.144.4 (`codex --version`) | **npm shim** `C:\Users\user\AppData\Roaming\npm\codex.cmd` |
| GitHub CLI | 2.90.0 (2026-04-16) | native `C:\Program Files\GitHub CLI\gh.exe` |
| Rust | rustc 1.95.0 / cargo 1.95.0 | used to reproduce `proc.rs`'s real spawn |
| Node | v24.14.1 | probe harness only |
| OS | Windows 11 Pro 10.0.26200 | |

> Claude is **2.1.211**, not the 2.1.210 the earlier docs pin. No contract difference was
> observed, but the version floor in `headless-cli-invocation-contract.md` is now stale.

**Method.** The core is headless and injectable, so the probes imported the **real**
modules (`createCodexAdapter`, `createClaudeAdapter`, `buildSystemPrompt`,
`buildUserPrompt`, `REFINE_SCHEMA`, `parseRefined`) and handed them a `ProcessRunner`
backed by `node:child_process`, plus — for the spawn questions — a standalone Rust binary
issuing the exact `std::process::Command` call `src-tauri/src/proc.rs` makes. Probes lived
in a temp dir and are deleted; nothing was shipped.

`gh` was used **read-only only**. No issue, comment, branch or write of any kind was made
against any repository.

---

## Verdicts

| # | Question | Verdict |
|---|---|---|
| 1 | Claude `api_retry` event shape | **CONFIRMED** — code reads it correctly |
| 1b | `api_retry` category enum completeness | **MISMATCH** — `oauth_org_not_allowed` unmapped (not fixed, not in lane) |
| 2 | `codex exec resume` accepts `--skip-git-repo-check` / `--output-schema` | **CONFIRMED** — both accepted, resume round-trip works |
| **3** | **Codex prompt delivery on Windows** | **MISMATCH — BLOCKER. Every Codex refine failed to spawn. FIXED.** |
| 4 | `--ignore-user-config` (spec-mandated, absent) | **MISMATCH** — user config steered every refine. **FIXED** |
| 5 | Claude golden path (prompt + image + schema → `parseRefined`) | **CONFIRMED** |
| 6 | No-fabrication rule against a live model | **CONFIRMED** (both providers, 3 live runs) |
| 7 | Codex golden path + `AGENTS.md` system prompt | **CONFIRMED** (after fix 3) |
| 8 | `gh` read-only argv (`repo`/`issue`/`label list`) | **CONFIRMED** |
| 9 | `github.ts:86` "empty listing prints empty stdout" | **MISMATCH** — false claim; code is defensive, no defect |
| 10 | Claude refine latency vs. the 120 s timeout | **UNSETTLED — concern.** 90.7 s measured vs. 6.3 s documented |

---

## 1. Claude's `api_retry` event shape — CONFIRMED

`errors.ts` maps error categories out of this event, and its shape had never been verified.

### Provoking a real error (safe, cheap, no rate-limit involved)

```
claude -p "say hi" --output-format stream-json --verbose \
  --tools "" --setting-sources "" --disable-slash-commands \
  --model claude-not-a-real-model-9
```

Real output (abridged), **exit 1**:

```json
{"type":"assistant","message":{...,"content":[{"type":"text","text":"There's an issue with the selected model (claude-not-a-real-model-9). It may not exist or you may not have access to it. Run --model to pick a different model."}]},"session_id":"d5047c63-...","error":"model_not_found","request_id":"req_011Cd4kPCoUFUujGq7FJy5T1"}
{"type":"result","subtype":"success","is_error":true,"api_error_status":404,"result":"There's an issue with the selected model (claude-not-a-real-model-9)...","terminal_reason":"api_error","stop_reason":"stop_sequence","total_cost_usd":0,...}
```

**Two findings from this transcript:**

1. **A non-retryable failure emits NO `api_retry` event at all.** The category
   `model_not_found` rides on an **`assistant`** event as a top-level `error` string —
   a place `retryCategory()` (claude.ts:86) does not look. This is harmless: the
   `result` event still carries `api_error_status: 404`, and `claudeError()` falls
   through to the status branch. Verified end-to-end through the real adapter below.
2. `subtype` stays `"success"` on a hard error, exactly as documented. `is_error` /
   exit code remain the only safe discriminators.

### The definitive shape

`api_retry` fires only on *retryable* failures, which cannot be provoked safely (the
brief forbids provoking a rate limit). Rather than guess, the shape was lifted from the
**CLI's own embedded Zod schema** inside `claude.exe`:

```js
peS = be(() => A.object({
  type: A.literal("system"),
  subtype: A.literal("api_retry"),
  attempt: A.number(),
  max_retries: A.number(),
  retry_delay_ms: A.number(),
  error_status: A.number().nullable(),
  error: XWa(),
  uuid: kl(),
  session_id: A.string()
}).describe("Emitted when an API request fails with a retryable error and will be retried
after a delay. error_status is null for connection errors (e.g. timeouts) that had no HTTP response."))

XWa = be(() => A.enum(["authentication_failed","oauth_org_not_allowed","billing_error",
  "rate_limit","overloaded","invalid_request","model_not_found","server_error","unknown",
  "max_output_tokens"]))
```

So a real `api_retry` line is:

```json
{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":1000,
 "error_status":429,"error":"rate_limit","uuid":"...","session_id":"..."}
```

**`error` is a BARE ENUM STRING, not an object with `.category`.** `claude.ts:93` reads
`str(event.error) ?? str(rec(event.error).category)` — the **first** branch is the correct
one. The `.category` fallback is dead code, but harmless; it is left alone.

Note the field is **`error_status`** on this event, while the *result* event uses
**`api_error_status`**. Two names for the HTTP status on two different events.
`claude.ts:117` reads `api_error_status` off the result event, which is right.

Fixture locked in: `claude.test.ts` → *"reads the category out of the real, complete
api_retry event"*, carrying every field above.

### 1b. MISMATCH — an unmapped category (reported, NOT fixed)

The real enum has **10** members. `headless-cli-invocation-contract.md:88` lists **9**, and
`errors.ts:57` `CLAUDE_KIND` maps those same 9. Missing from both:

**`oauth_org_not_allowed`**

Consequence: `CLAUDE_KIND['oauth_org_not_allowed']` is `undefined`, so mapping falls
through to the status/text heuristics. It would likely arrive with a 401/403 and land on
`not_authenticated` anyway — but that is inference, not verification, and if it arrives
with no status the user gets the generic `Claude failed: <text>`. The correct mapping is
`not_authenticated` (an org policy rejected the OAuth identity → the user must re-auth
with an allowed account).

**Not fixed: `src/core/llm/errors.ts` is outside this agent's lane.** One line:

```ts
oauth_org_not_allowed: 'not_authenticated',
```

### Live error mapping through the real adapter — CONFIRMED

`createClaudeAdapter(...).refine({ model: 'claude-not-a-real-model-9', ... })`:

```
>>> exit=1 timedOut=false in 2.4s
===== BAD MODEL => ProviderError
kind   : model_unavailable
message: The model "claude-not-a-real-model-9" isn't available on your Claude account. Pick a different one in Settings.
```

The taxonomy holds against reality, end to end.

---

## 2. `codex exec resume` accepts `--skip-git-repo-check` and `--output-schema` — CONFIRMED

`codex exec resume --help` (0.144.4) lists both, plus `-i/--image`, `-m/--model`, `-c`,
`--json`, `-o`, `--ephemeral`, `--ignore-user-config`. It confirms the doc's note that
resume has **no `-C` and no `-s`** — the adapter's `-c sandbox_mode=read-only` + spawn-cwd
workaround remains necessary.

Live round-trip (after fix 3), real argv and result:

```
codex exec resume 019f6843-e594-7c63-bcf7-edc805acc79d --skip-git-repo-check \
  --ignore-user-config --json -c sandbox_mode=read-only -c model_reasoning_effort=low \
  --output-schema <dir>/schema.json -
==> exit 0 in 11.0s, schema-conforming JSON returned
```

`followUp` is **not** broken. The flags are real and the resumed turn honours
`--output-schema`.

---

## 3. BLOCKER — the Codex prompt could never reach the CLI on Windows. FIXED.

**This is the round-4 defect, and it has the codebase's signature shape:** prompt
assembly, schema, parsing, error mapping and argv assembly are all correct — and the last
wire, actually handing the text to the process, was cut. All 598 tests were green while
**every single Codex refine was structurally incapable of starting.**

### Root cause

`codex.ts` passed the user prompt as a **command-line argument** (`'--', input.text`).

On Windows, npm ships codex as a `.cmd` **batch shim**, so `proc.rs::shim()` (src-tauri/
src/proc.rs:78) resolves `codex` → `codex.cmd`, and `proc.rs:128` calls
`Command::new("codex.cmd")`. Rust's `std::process::Command` **refuses to spawn a batch
file when any argument contains a newline** (CVE-2024-24576 hardening). Not a mangled
argument — a hard spawn error.

Reproduced with rustc 1.95.0 issuing the exact call `proc.rs` makes:

```
single line                        => spawned ok; child saw: ARG1=[--] | ARG2=[LINE-ALPHA] | TOTAL=2
single line with spaces            => spawned ok; child saw: ARG1=[--] | ARG2=[clicked export 3 times] | TOTAL=2
MULTI-LINE (\n)                    => SPAWN ERROR: batch file arguments are invalid
MULTI-LINE (\r\n)                  => SPAWN ERROR: batch file arguments are invalid
Quacket's real prompt shape        => SPAWN ERROR: batch file arguments are invalid
non-ASCII single line              => spawned ok
```

`buildUserPrompt()` (refine/prompt.ts:185) is **multi-line by construction** — it always
emits `<raw_report>\n…\n</raw_report>`. Even a one-word report is multi-line after
tag-wrapping. So the trigger fired on **100 % of refines**, and on every follow-up
carrying an answer (`followUpPrompt()` is multi-line as soon as one answer is given).

Against the real `codex.cmd` through the real Rust spawn:

```
########## A: prompt as argv (codex.ts TODAY)
argv: codex.cmd ["exec", ..., "--", "LINE-ALPHA\nLINE-BRAVO\nLINE-CHARLIE\nRepeat all four tokens back.\nLINE-DELTA"]
==> SPAWN ERROR: batch file arguments are invalid

########## B: prompt via stdin (`-`)
argv: codex.cmd ["exec", ..., "--", "-"]
stdin: Some("74 bytes")
==> exit Some(0)
agent_message: {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"LINE-ALPHA\nLINE-BRAVO\nLINE-CHARLIE\nLINE-DELTA"}}
==> tokens survived: ALPHA, BRAVO, CHARLIE, DELTA
```

`claude` and `gh` are native `.exe` on this machine and are **immune** — this defect is
scoped precisely to codex's npm shim.

> **A trap worth recording.** An early probe routed `codex.cmd` through `cmd.exe` (as
> `shell: true` does). cmd.exe does **not** refuse a multi-line argument — it silently
> **truncates at the first newline** and exits 0. That produced a *plausible but wrong*
> draft describing only the screenshot, and a follow-up that appeared to succeed while the
> model never saw the answer. A harness that lies is worse than one that fails; the probe
> runner was corrected to reproduce Rust's hard error before any conclusion was drawn.

### Fix

Deliver the prompt on **stdin**, using codex's own documented sentinel. `codex exec --help`:

> `[PROMPT]` — Initial instructions for the agent. If not provided as an argument (**or if
> `-` is used**), instructions are read from stdin. If stdin is piped and a prompt is also
> provided, stdin is appended as a `<stdin>` block.

`codex exec resume [SESSION_ID] [PROMPT]` documents the same `-`.

This is the route codex designs for exactly this, not a workaround: it also lifts the
prompt out of the ~32 KB Windows command-line limit, which a long report plus a
100-issue candidate list can genuinely approach. `ProcSpec.stdin` already existed and the
seam already guarantees stdin is written **and closed**.

`-` still goes after `--` on refine, because `-i` is variadic and would otherwise swallow
the sentinel. On resume nothing variadic precedes it, so it stays bare positional.

### Before / after, same input, live

Real product input (messy mixed Chinese/English + screenshot + 2 open-issue candidates):

```
匯出按鈕點了沒反應 clicked export 3 times nothing
然後跳紅色的錯誤 banner 看截圖
超怪 之前明明可以 昨天還好好的
可能跟上次那個 update 有關? 不確定
```

| | Before (argv → truncated at `<raw_report>`) | After (stdin) |
|---|---|---|
| title | "Interface displays blank red and white blocks" | "Export button does nothing and shows an error banner" |
| sections | 1 — describes only the image | Repro steps / Expected / Actual |
| similar_issues | `[]` — never saw the list | **#41**, with a reason |

After, verbatim:

```json
{"type":"bug","title":"Export button does nothing and shows an error banner",
 "sections":[{"heading":"Repro steps","body":"Click the Export button three times."},
  {"heading":"Expected","body":"Export works as it did previously, including yesterday."},
  {"heading":"Actual","body":"Nothing happens after clicking Export, then a red error banner appears.\n\n![red error banner after clicking Export](quacket-image:img1)"}],
 "follow_ups":["How large was the project being exported?","Which update might have introduced the problem?"],
 "similar_issues":[{"number":41,"title":"Export button does nothing on large projects","reason":"Also reports the Export button doing nothing, though only on large projects."}]}
```

`parseRefined()` accepted it unchanged. Follow-up via `exec resume` folded the answer in:
title → *"Export does nothing for projects over 500 rows"*, repro step gained *"Open a
project with more than 500 rows"*, `follow_ups` correctly emptied.

### Tests

- `codex.test.ts` → *"never puts a newline in argv — Windows cannot spawn the .cmd shim
  with one"* — the root-cause guard, written from the OS's rule, feeding a realistic
  `<raw_report>\n…` prompt.
- `codex.test.ts` → *"delivers the prompt on stdin, marked by the `-` sentinel after --"*
  — asserts the report actually **reaches** codex, so the wire cannot be cut silently.
- `codex.test.ts` → *"never puts a newline in resume argv"* and *"passes the resume
  sentinel positionally, with the answers on stdin"*.

**Two existing tests had enshrined the bug** and were rewritten, not deleted:
`codex.test.ts:119` asserted `args.at(-1)` **was** the prompt text, and `:396` asserted the
same for resume — both asserting argv the OS provably refuses to spawn, while `FakeRunner`
stubbed away the spawn that would have failed. They now assert the real contract.

**Mutation result:** restoring `'--', input.text` and `followUpPrompt(answers)` into argv
→ **4 tests fail** (2 refine, 2 followUp), 27 pass. Restored → 31/31 green.

---

## 4. MISMATCH — `--ignore-user-config` was missing. FIXED.

Spec #16 pins it: *"Codex: spawn-per-call `codex exec` … `--ignore-user-config`, always
`-c model_reasoning_effort=…` and read-only sandbox"*. `codex.ts` never passed it. Claude's
adapter got its hermetic flag set (`HERMETIC`, claude.ts:23); Codex did not — the same
asymmetry, one wire short.

The reference machine's `~/.codex/config.toml` is not hypothetical:

```toml
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
personality = "pragmatic"
sandbox_mode = "danger-full-access"
approval_policy = "never"
notify = [ "…\codex-computer-use.exe", "turn-ended" ]
service_tier = "fast"
```

Measured consequences, live:

- **Every refine fired the user's `notify` hook**, spawning `codex-computer-use.exe` on
  turn-ended. A background tray app should not be triggering the user's personal
  automation on every ticket.
- **~5.8 k tokens of personal config on every call**: input_tokens **26 226 → 20 418**
  with the flag, same prompt.
- `personality`, `service_tier`, and (when `model` is null) the user's model all steered
  a Quacket refine.

The dangerous part was already handled — `-s read-only` (refine) and `-c
sandbox_mode=read-only` (resume) override `danger-full-access` — so this is defence in
depth plus spec compliance, not a new safety hole.

**Verified safe before shipping:** `--ignore-user-config` does **not** break auth (`codex
exec --help`: *"Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`"*).
Live: refine exit 0 and `exec resume` exit 0 with the flag on both turns, correct draft,
#41 still matched, output still English.

**Partial, and honestly so:** the flag does **not** suppress `~/.codex/skills/`. This
`item.completed` error item appears with **and** without it:

> `"Skill descriptions were shortened to fit the 2% skills context budget. Codex can still
> see every skill, but some descriptions are shorter."`

So a Quacket refine still loads the user's skill descriptions. Not fixed — no codex flag
found that suppresses them. Harmless today (the drafts were correct), but it is context
Quacket neither wants nor controls. **UNSETTLED.**

Test: `codex.test.ts` → *"ignores the user config on both turns, so a personal config
cannot steer a refine"*. **Mutation:** removing both flags → test fails; restored → green.

### A leak that did NOT bite (worth knowing)

`~/.codex/AGENTS.md` on this machine opens with:

> 請永遠使用繁體中文回覆我，除非我明確要求使用其他語言。
> *(Always reply in Traditional Chinese unless I explicitly ask otherwise.)*

That directly contradicts story 15 / *"Output always English"*. **`--ignore-user-config`
does not suppress it** (the flag covers `config.toml` only). In all live runs Quacket's own
`AGENTS.md` in the `-C` dir won and output stayed English — but the mechanism is prompt
precedence, not isolation. Filed here as a known, currently-benign hazard.

---

## 5–7. Golden paths — CONFIRMED

### Codex: `AGENTS.md` via `-C` is genuinely read

The system prompt has no flag; `AGENTS.md` in the `-C` dir is the only delivery route, and
it had never been tested. Probe: an `AGENTS.md` saying *"when the user says ping, reply
exactly ZANZIBAR77"*, prompt `ping`.

```
A: -C <dir with AGENTS.md>   (ADAPTER BEHAVIOUR)  => agent_message: "ZANZIBAR77"  ==> AGENTS.md WAS read
B: -C <git repo with AGENTS.md>                   => agent_message: "ZANZIBAR77"  ==> AGENTS.md WAS read
```

Read in a plain temp dir **and** in a git repo — `--skip-git-repo-check` does not gate it.

Also confirmed live: the positional prompt after `--` does arrive (with and without `-i`
present), so the `--` separator guard against variadic `-i` is real and correct.

### Claude: prompt + base64 image + `--json-schema` over stream-json

Real argv assembled by the adapter (abridged):

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --tools "" --setting-sources "" --disable-slash-commands \
  --system-prompt "<the real bundled prompt>" --json-schema "<the real REFINE_SCHEMA>" \
  --model haiku
# stdin: 2054 bytes — one JSONL user message with text + base64 image block
==> exit 0
```

- `structured_output` came back as **`object`** — a parsed object, not a string. Confirmed.
- Schema-conforming; the **real** `parseRefined()` accepted it with no massaging.
- `session_id` present, so `--resume` has its handle.

> Note: the empty-string flags (`--tools ""`, `--setting-sources ""`) are load-bearing and
> fragile. An early probe using `shell: true` silently **deleted** them, and claude then
> failed with `Error processing --setting-sources: Invalid setting source:
> --disable-slash-commands`. `proc.rs` spawns without a shell, so production is fine — but
> anything that ever routes claude through a shell will break in exactly this way.

### 6. The no-fabrication rule against a LIVE model — CONFIRMED

Story 12 had only ever been tested against fixtures. The input names **no** OS, browser,
version, or device, so an `Environment` section would be pure invention.

Across **3 live runs** (Claude ×2, Codex ×1):

```
>>> Environment section present? NO (correct — nothing to say)
>>> title is English + prefix-free? "Export button shows error banner and does not respond"
```

Every run: `Environment` **omitted**, not padded with "Unknown"/"N/A". Titles single-line,
prefix-free, under 70 chars, English from mixed Chinese/English input (story 15). Images
embedded inline as `![…](quacket-image:img1)` in the section they support. Similar-issue
detection found **#41** and ignored the unrelated #12 — on both providers.

The bundled prompt + schema hold up against real models.

---

## 8. `gh` read-only paths — CONFIRMED

Exact argv from `github.ts`, run live against gh 2.90.0 (authed as `c3lew`):

```
$ gh auth status
  ✓ Logged in to github.com account c3lew (keyring)
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'
```

`repo` scope is present — it covers the Contents API the assets-branch upload needs (#4).

```
$ gh repo list --limit 100 --json nameWithOwner,isPrivate,viewerPermission     # github.ts:289
[{"isPrivate":true,"nameWithOwner":"c3lew/Quacket","viewerPermission":"ADMIN"}, …]
```
`viewerPermission` is present and populated, so the push-access filter (story 17) has real
data: **79** repos are ADMIN/WRITE. The account has exactly 79 repos total, so `--limit
100` does not truncate *here* — but it is a real ceiling for a busier account.

```
$ gh issue list --repo c3lew/Quacket --limit 100 --json number,title,labels,updatedAt   # github.ts:302
[{"labels":[{"id":"LA_kwDOTZfR2c8AAAACr2jNvg","name":"ready-for-agent","description":"Fully specified, AFK-ready","color":"0e8a16"}],"number":16,"title":"Spec: Quacket v1 …","updatedAt":"2026-07-15T20:09:05Z"}]
```
`labels` are **objects**, not strings — and `github.ts:309` correctly maps
`r.labels.map((l) => l.name)` onto `OpenIssue.labels: string[]`. Correct.

```
$ gh label list --repo c3lew/Quacket --limit 100 --json name                     # github.ts:215
[{"name":"bug"},{"name":"documentation"},{"name":"duplicate"},{"name":"enhancement"}, …]
```
`bug` and `enhancement` both exist, so the label mapping (#48) has real targets.

### 9. MISMATCH — `github.ts:86`'s "verified" claim is false (no defect)

The comment states:

> `gh <cmd> --json` prints an empty stdout (not `[]`) when a listing is empty — **verified
> against gh 2.90.0**. `JSON.parse('')` would throw.

Against a repo with genuinely zero open issues (`c3lew/AIO_V3`), gh 2.90.0 prints:

```
$ gh issue list --repo c3lew/AIO_V3 --limit 100 --json number,title,labels,updatedAt | xxd
00000000: 5b5d 0a                                  [].
--- exit=0
```

`[]\n`, exit 0. **Not** empty stdout. (Empty stdout *is* what you get **without** `--json`
— that is the classic behaviour the comment seems to be remembering.)

**No defect:** `parseJson` is defensive and handles both `''` → fallback and `[]` →
`JSON.parse`. Reported because the comment asserts a verification that did not happen —
the precise failure mode this codebase keeps hitting. `github.ts` is outside this agent's
lane; the fix is to correct the comment, not the code.

---

## 10. UNSETTLED — Claude refine latency has a thin margin

`DEFAULT_TIMEOUT_MS` is 120 s (adapter.ts:87), sized from the doc's measurement:

> Golden path (system prompt + image + schema, haiku) — **6.3 s**

Measured today on the same shape (real prompt + real schema + image, `--model haiku`):

```
>>> exit=0 timedOut=false in 90.7s
usage: {"inputTokens":3962,"cachedInputTokens":0,"outputTokens":8083,"costUsd":0.045119}
```

**90.7 s — roughly 14× the documented figure, against a 120 s timeout.** The output-token
count (8 083) suggests the current haiku does substantially more internal generation than
the 2026-05 measurement captured. A second run behaved comparably.

This is a single machine on a single day and network variance is not excluded, so it is
recorded as **UNSETTLED, not a defect**. But the headroom is ~1.3×, and story 26/27 (Esc
mid-flight, notify on failure) get exercised a lot more often if a normal refine sits at
90 s. Codex, by contrast, ran **11–23 s** at `model_reasoning_effort=low`.

Worth a decision by someone who owns `adapter.ts`'s timeout: re-measure, or raise it.

---

## What changed in code

Only `src/core/llm/codex.ts` (findings 3 and 4), plus tests in `codex.test.ts` and
`claude.test.ts` (finding 1's real-shape fixture).

Reported but **not** fixed, being outside this agent's lane:
- `errors.ts` — `oauth_org_not_allowed` unmapped (finding 1b).
- `github.ts:86` — false "verified" comment (finding 9).
- `headless-cli-invocation-contract.md:88` — lists 9 of the 10 real categories; version
  floor now says 2.1.210 vs. the installed 2.1.211.
- `adapter.ts` — the 120 s timeout vs. 90.7 s measured (finding 10).

Gates after the change: **631 TS tests pass**, `npx tsc --noEmit` clean.
