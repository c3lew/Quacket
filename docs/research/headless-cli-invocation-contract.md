# Headless CLI Invocation Contract — Claude Code & Codex

Research for issue #2. All commands below were **run and verified locally** on 2026-07-16 against:

| CLI | Version tested | Auth mode during tests |
|---|---|---|
| Claude Code | 2.1.210 (`claude --version`) | claude.ai subscription (`subscriptionType: "max"`) |
| Codex CLI | 0.144.4 (`codex --version`) | ChatGPT subscription (`codex login status` → "Logged in using ChatGPT") |

## TL;DR — adapter surface

| Concern | Claude Code (`claude -p`) | Codex (`codex exec`) |
|---|---|---|
| Non-interactive shape | `claude -p [prompt] --output-format json` | `codex exec [OPTIONS] -- "<prompt>"` |
| Structured (JSON) output | `--output-format json` → one JSON object; add `--json-schema '<inline schema>'` → parsed object in `structured_output` field | `--output-schema <schema-file>` constrains the final message; `--json` → JSONL event stream; `-o <file>` writes bare final message |
| Final message field | `.result` (string); `.structured_output` (object, when schema given) | `item.completed` event where `item.type == "agent_message"` → `.item.text`; or read the `-o` file |
| Usage / cost metadata | `.usage` (tokens incl. cache), `.total_cost_usd`, `.modelUsage`, `.duration_ms`, `.num_turns` | `turn.completed.usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`). **No cost field** (subscription) |
| System / refine prompt | `--system-prompt "<text>"` (replace) or `--append-system-prompt "<text>"` (+ `-file` variants). Verified working | **No flag.** `AGENTS.md` in the working dir (verified: instructions followed) or `$CODEX_HOME/AGENTS.md` / `AGENTS.override.md`; otherwise prepend to the prompt |
| **Image input headless** | **YES** — base64 `image` content block via `--input-format stream-json` (requires `--output-format stream-json`). Verified end-to-end. (Alt: file path + `Read` tool) | **YES** — native `-i/--image <FILE>...` flag. Verified end-to-end. `-i` is variadic: put the prompt after `--` |
| Model selection | `--model haiku\|sonnet\|opus\|<full-name>` | `-m <model>` (default here: `gpt-5.6-sol`) |
| Reasoning effort | `--effort low\|medium\|high\|xhigh\|max` | `-c model_reasoning_effort="low"` etc. **Default is `high` — set lower for latency** |
| Exit codes | 0 success; 1 on error — but the JSON is still emitted with `is_error: true`, `api_error_status`, `terminal_reason` | 0 success; 1 on failure — `turn.failed` event carries the upstream API error JSON in `.error.message` |
| Auth probe | `claude auth status` → JSON (`loggedIn`, `authMethod`, `subscriptionType`); exit 0/1 | `codex login status` → text, exit 0/1 |
| Timeout | **None built-in.** Adapter must enforce (kill process). `--max-budget-usd` caps cost only | **None built-in.** Adapter must enforce |
| Measured latency (this machine) | 2.3–6.3 s (haiku/sonnet, minimal flags, incl. image+schema golden path) | 4–16 s at `low` effort; **14–48 s at default `high`** |
| Hermetic / minimal flags | `--tools "" --setting-sources "" --disable-slash-commands` (**NOT `--bare`** — see caveat) | `--skip-git-repo-check --ephemeral --ignore-user-config -s read-only` |
| stdin gotcha | If stdin is piped-but-empty, waits 3 s then proceeds with a warning. Close stdin or redirect `</dev/null` | Piped stdin is read and appended as a `<stdin>` block ("Reading additional input from stdin..."). Close stdin |
| Follow-up round (2nd turn) | `--resume <session_id>` (`session_id` is in every result; lookup scoped to same cwd) | `codex exec resume <THREAD_ID>` / `resume --last` (`thread_id` from `thread.started`; **incompatible with `--ephemeral`**) |

---

## Provider 1: Claude Code (`claude -p`)

### Canonical refine invocation (verified "golden path")

This exact shape — system prompt + text + base64 screenshot in, schema-constrained draft out — ran in 6.3 s / $0.0037 (haiku):

```bash
printf '%s\n' "$USER_MESSAGE_JSON" | claude -p \
  --input-format stream-json --output-format stream-json --verbose \
  --tools "" --setting-sources "" --disable-slash-commands \
  --system-prompt "You are Quacket's ticket refiner. ..." \
  --json-schema "$SCHEMA_JSON" \
  --model haiku
```

where `$USER_MESSAGE_JSON` is one line of newline-delimited JSON in Anthropic Messages format:

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"text","text":"User bug report: ..."},
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"<base64>"}}
]}}
```

The **last line** of stdout is the `result` event — same schema as `--output-format json` below. If no image is needed, skip stream-json entirely: `claude -p "<prompt>" --output-format json`.

### Output schema (`--output-format json`, verified fields)

```json
{
  "type": "result", "subtype": "success",
  "is_error": false, "api_error_status": null,
  "duration_ms": 3956, "duration_api_ms": 3455, "num_turns": 1,
  "result": "hi",
  "structured_output": {"title": "...", "labels": ["..."]},
  "stop_reason": "end_turn",
  "session_id": "3191331c-...",
  "total_cost_usd": 0.0292,
  "usage": {"input_tokens": 10, "cache_creation_input_tokens": 13137, "cache_read_input_tokens": 20993, "output_tokens": 157},
  "modelUsage": {"claude-haiku-4-5-20251001": {"inputTokens": 10, "costUSD": 0.0292, "contextWindow": 200000}},
  "permission_denials": [],
  "terminal_reason": "completed",
  "uuid": "..."
}
```

- `structured_output` appears only with `--json-schema` and is a **parsed object**, not a string. `result` still holds the JSON as a string.
- Invalid schema → immediate exit with `Error: --json-schema is not a valid JSON Schema` (since v2.1.205).

### Error signaling (verified)

| Case | Exit | JSON |
|---|---|---|
| Invalid/unavailable model | 1 | `is_error: true`, `api_error_status: 404`, `terminal_reason: "api_error"`, human message in `result` |
| Not logged in | 1 | `is_error: true`, `result: "Not logged in · Please run /login"`, `terminal_reason: "api_error"` |

**Gotcha:** `subtype` stays `"success"` even on errors — branch on `is_error` / exit code, not `subtype`. In stream-json mode, retryable failures emit `system/api_retry` events with an `error` category: `authentication_failed`, `billing_error`, `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `unknown` — a ready-made taxonomy for adapter error mapping.

### Image input: YES (two routes)

1. **Base64 content block via stream-json input** (verified: model correctly described a red test PNG). Requires `--output-format stream-json`; `--input-format stream-json` with `--output-format json` is rejected: `Error: --input-format=stream-json requires output-format=stream-json.`
2. Workaround route: file path in the prompt + `--allowedTools Read` (Read tool handles images). Not recommended for Quacket — route 1 avoids tool round-trips and filesystem coupling.

### Auth / subscription caveats

- Subscription OAuth is the default; `claude auth status` gives machine-readable state (see `docs/research/model-effort-discovery.md`).
- **`--bare` breaks subscription auth** (verified: `is_error: true`, "Not logged in"). Bare mode reads only `ANTHROPIC_API_KEY`/`apiKeyHelper` — never OAuth/keychain. Docs recommend `--bare` for scripting and it may become the `-p` default in a future release, so pin the non-bare flag set explicitly (`--setting-sources "" --tools "" --disable-slash-commands` gives the same hermeticity while keeping OAuth).
- Rate limiting: stream-json emits `rate_limit_event` (`rateLimitType: "five_hour"`, `status`, `resetsAt`, `overageStatus`) — surfaceable in Quacket's UI when a user is near their cap.
- `total_cost_usd` is reported even on subscription (notional API-equivalent cost).
- Piped stdin capped at 10 MB (v2.1.128+). Irrelevant for route-1 images? No — the stream-json line **is** stdin, so a pathological number of screenshots could hit it; ~7.5 MB of raw image per message is the practical ceiling.

### Latency (measured, warm)

| Shape | Wall time |
|---|---|
| Minimal haiku (`--tools "" --setting-sources ""`) | 2.4 s ($0.014) |
| Minimal sonnet | 2.3 s ($0.035) |
| Default flags, haiku (loads user plugins/CLAUDE.md → 34 k cache-creation tokens) | 6.2 s ($0.029) |
| Golden path (system prompt + image + schema, haiku) | 6.3 s ($0.0037) |

Minimal flags cut prompt-cache creation from ~34 k to ~6.5 k tokens — use them.

---

## Provider 2: Codex (`codex exec`)

### Canonical refine invocation (components verified individually)

```bash
codex exec --skip-git-repo-check --json \
  -C <session-temp-dir> \
  -s read-only \
  -c model_reasoning_effort="low" \
  --output-schema schema.json \
  -o last-message.json \
  -i shot1.png -i shot2.png \
  -- "Raw bug report: ..."
```

with the refine system prompt written to `<session-temp-dir>/AGENTS.md` beforehand. Close stdin (`</dev/null` equivalent) — otherwise codex reads it and appends a `<stdin>` block.

### JSONL event stream (`--json`, verified)

```json
{"type":"thread.started","thread_id":"019f66a7-..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"..."}}
{"type":"turn.completed","usage":{"input_tokens":23498,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}
```

- Other item types: `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `error`.
- **Noise tolerance required:** non-fatal `item.type: "error"` events appear routinely (e.g. a skills-context-budget warning showed up in every run, even hermetic ones) while the turn still succeeds. Never treat an `error` *item* as fatal — only `turn.failed` / top-level `error` events with exit 1.
- On failure: `{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"...\"}}"}}` — the upstream API error is a JSON string embedded in `.error.message`; exit code 1.
- `-o/--output-last-message <file>` writes the bare final message (verified) — simplest extraction path; pair with exit code + `turn.failed` for errors.

### Structured output: `--output-schema <file>` (verified)

Takes a **file path** (not inline). The final `agent_message.text` / `-o` file content is the conforming JSON string — parse it yourself; there is no pre-parsed field like Claude's `structured_output`. Verified: returned exactly `{"title":"...","labels":["bug"]}` with `additionalProperties:false` respected.

### System / refine prompt: no flag — AGENTS.md (verified)

- No `--system-prompt` equivalent exists on `codex exec`.
- **Verified:** an `AGENTS.md` in the working dir (`-C <dir>`) is injected as user instructions and followed (test instruction "always end with QUACK" → reply "4。QUACK").
- Global fallback: `$CODEX_HOME/AGENTS.override.md`, then `$CODEX_HOME/AGENTS.md` (confirmed in source: `codex-rs/codex-home/src/instructions/mod.rs`). Don't touch these from Quacket — they're the user's.
- The old `experimental_instructions_file` config key no longer exists in the codebase (0 hits). Adapter contract: **write AGENTS.md to a temp dir + `-C`**, or prepend instructions to the prompt.

### Image input: YES — `-i/--image <FILE>...` (verified)

Verified: red test PNG correctly described. **Gotcha:** `-i` is variadic, so `codex exec -i img.png "prompt"` swallows the prompt as a second image path and then blocks/fails on stdin. Always separate: `codex exec -i img.png -- "prompt"` (or prompt before `-i`). File paths only — no base64/stdin image route.

### Model & reasoning effort

- Default on this machine: `model: gpt-5.6-sol`, `reasoning effort: high` (printed in the non-JSON header).
- `-m <model>`; effort via `-c model_reasoning_effort="minimal|low|medium|high|xhigh|..."` (per-model list — enumerate via `model/list`, see `docs/research/model-effort-discovery.md`). Verified: `low` works and cut latency ~4-10x.

### Error signaling (verified)

| Case | Exit | Signal |
|---|---|---|
| Invalid model | 1 | `error` + `turn.failed` events; message: "The 'X' model is not supported when using Codex with a ChatGPT account." |
| Missing prompt (arg-parse trap) | non-zero | "No prompt provided via stdin." on stderr, no JSONL |
| Logged out | (`codex login status` exit ≠ 0) | probe before invoking |

### Auth / subscription caveats

- ChatGPT-subscription login is the default; `CODEX_API_KEY=<key>` env switches a single invocation to API-key mode.
- Model availability differs by auth mode (error message above is explicit about "with a ChatGPT account").
- No cost/USD reporting at all — Quacket can only show token counts for Codex.
- `codex exec` defaults to `approval: never`; sandbox comes from user config (this machine's config had `danger-full-access`!) — **always pass `-s read-only` explicitly** for refine calls so a hallucinated command can't write anywhere.
- User-level hooks and skills run inside `codex exec` (SessionStart hooks fired in default runs) and add latency/noise; `--ignore-user-config` skips user config but keeps auth ("auth still uses CODEX_HOME"). Trade-off: `--ignore-user-config` may also change model/effort defaults the user chose — safer to keep user config and pin `-m`/`-c` explicitly.

### Latency (measured, warm)

| Shape | Wall time |
|---|---|
| Default (high effort, user hooks+skills) | 14–48 s |
| `--ignore-user-config --ephemeral` + `low` effort | 4.2 s |
| `low` effort with user config + AGENTS.md | 16 s |

Effort level dominates. At default `high`, Codex is 3–8x slower than Claude for the same one-shot refine.

---

## Adapter design implications for Quacket

1. **One adapter interface, two very different transports.** Suggested surface:
   `refine(input: {text, images: PngBytes[], systemPrompt, schema}) → {draft: object, thread: {sessionId|threadId}, usage, costUsd?}`
   - Claude: single spawn, everything inline (stdin JSON line + flags), parse last stdout line.
   - Codex: needs a **session temp dir** (AGENTS.md + schema.json + image files + `-o` output file) — the adapter owns a per-invocation scratch directory anyway, so this is cheap.
2. **Images: both YES, no blocker.** Claude = base64 in-band; Codex = temp files + `-i`. Quacket holds pasted screenshots as bytes, so Codex needs a write-to-temp step; Claude doesn't.
3. **Timeout is 100% Quacket's job.** Neither CLI has a timeout flag. Enforce with process kill (suggest ~120 s default given Codex high-effort tail); on kill, report "provider timed out" distinctly from provider errors.
4. **Error taxonomy:** map from (exit code, `is_error`/`terminal_reason`, `api_retry.error` category) for Claude and (exit code, `turn.failed.error.message` embedded JSON `status`/`error.type`) for Codex into a small shared enum: `not_authenticated | model_unavailable | rate_limited | timeout | provider_error`. Auth-probe (`claude auth status` / `codex login status`) *before* invoking gives cleaner "not logged in" UX than parsing failure output.
5. **Follow-up questions round-trip** (Quacket's "one batch of skippable follow-ups") can reuse provider-native session resume — `--resume <session_id>` / `codex exec resume <thread_id>` — instead of re-sending context. Caveats: Claude resume is cwd-scoped (run both calls from the same cwd); Codex resume requires **not** passing `--ephemeral`.
6. **Pin the flag sets now; they are version-sensitive.** Two live risks: Claude's `--bare` becoming the `-p` default (would silently break subscription auth) and Codex model/effort defaults drifting. Always pass `--model`/`-m` and effort explicitly; never adopt `--bare`.
7. **Latency budget for UX:** show streaming/progress affordance sized to ~3–8 s (Claude) and ~5–20 s (Codex at low/medium effort). Default Codex effort to `low` or `medium` for refine — `high` costs 30+ s for no gain on a summarization-shaped task.

## Sources

- Claude Code headless docs: https://code.claude.com/docs/en/headless (flags, `structured_output`, `api_retry` categories, `--bare` auth note, stdin 10 MB cap)
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Codex non-interactive docs: https://developers.openai.com/codex/noninteractive (→ learn.chatgpt.com/docs/non-interactive-mode) (JSONL event types, `--output-schema`, `CODEX_API_KEY`, resume)
- Codex source (instructions loading): https://github.com/openai/codex — `codex-rs/codex-home/src/instructions/mod.rs`
- Local verification: Claude Code 2.1.210 + codex-cli 0.144.4, Windows 11, 2026-07-16 — all invocation shapes, image tests, schema tests, error/exit-code probes, and latency numbers in this doc were executed, not quoted.
