# Model & Effort Discovery from Installed CLIs

Research for issue #3. All commands below were **run and verified locally** on 2026-07-16 against:

| CLI | Version tested | Install shape found locally |
|---|---|---|
| Claude Code | 2.1.210 (`claude --version`) | native build, `%USERPROFILE%\.local\bin\claude.exe` |
| Codex CLI | 0.144.4 (`codex --version`) | npm shim, `%APPDATA%\npm\codex.cmd` |

## TL;DR — recommended mechanism per provider

| Question | Claude Code | Codex CLI |
|---|---|---|
| Installed? | PATH lookup (`where claude`) + `claude --version` | PATH lookup (`where codex`, handle `.cmd` shim) + `codex --version` |
| Authenticated? | `claude auth status --json` → JSON with `loggedIn`, `authMethod`, `subscriptionType`; exit 0 logged in / 1 not (documented) | `codex app-server` → `account/read` (returns `account: null` when logged out); quick check: `codex login status` exit 0/1 |
| Model enumeration | stream-json **control protocol**: spawn `claude -p --input-format stream-json --output-format stream-json`, send `initialize` control request → response carries `models[]` with `value`, `displayName`, `description`, `supportedEffortLevels` | `codex app-server` JSON-RPC: `initialize` → `model/list` → `data[]` with `id`, `displayName`, `isDefault`, `hidden`, `defaultReasoningEffort`, `supportedReasoningEfforts[]` |
| Effort enumeration | per-model `supportedEffortLevels` in the same `initialize` response; passed with `--effort <level>` | per-model `supportedReasoningEfforts[].reasoningEffort` in `model/list`; passed with `-c model_reasoning_effort=<level>` |
| Measured latency | ~1.1 s for the full initialize round-trip | ~0.2 s for initialize + model/list |

**Both CLIs expose a genuine machine-readable enumeration surface. No hardcoded model or effort list is needed on the happy path.** The lists are dynamic in practice: effort levels differ per model on the same machine (e.g. Codex `gpt-5.6-sol` supports 6 levels incl. `ultra`, `gpt-5.5` only 4; Claude `haiku` supports none), which is exactly why enumeration — not assumption — is required.

---

## Provider 1: Claude Code

### Installed detection

- PATH lookup for `claude` (on Windows resolve `claude.exe` / `claude.cmd` — native build installs `claude.exe` under `~\.local\bin`, npm installs a `.cmd` shim).
- `claude --version` → `2.1.210 (Claude Code)`, exit 0. Cheap (<0.5 s), also gives the version string used for cache keying.

### Authenticated detection

`claude auth status` (verified; also in the official CLI reference — "Exits with code 0 if logged in, 1 if not"):

```json
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "…",
  "orgId": "…",
  "subscriptionType": "max"
}
```

- JSON is the default output (`--json` documented as default; `--text` for humans). Measured 0.3 s.
- Parse `loggedIn` from JSON rather than relying only on the exit code.
- `subscriptionType` + `orgId` are useful as part of the model-cache key (available models depend on plan).

### Model + effort enumeration (verified live)

Claude Code has **no `list models` CLI command** (confirmed against the CLI reference). The machine-readable surface is the stream-json **control protocol** — the same one `@anthropic-ai/claude-agent-sdk` uses for its `supportedModels()` API:

1. Spawn `claude -p --input-format stream-json --output-format stream-json --verbose`.
2. Write one line: `{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}`.
3. Read the `control_response`; its `response` object contains `models`, `account`, `commands`, `agents`, …
4. Kill the process (no prompt was ever sent → no tokens consumed).

Verified response on 2.1.210 (abridged):

```json
"models": [
  { "value": "default",   "resolvedModel": "claude-opus-4-8[1m]", "displayName": "Default (recommended)",
    "supportsEffort": true, "supportedEffortLevels": ["low","medium","high","xhigh","max"] },
  { "value": "opus[1m]",  "resolvedModel": "claude-opus-4-8[1m]", "supportedEffortLevels": ["low","medium","high","xhigh","max"] },
  { "value": "claude-fable-5[1m]", "resolvedModel": "claude-fable-5", "supportedEffortLevels": ["low","medium","high","xhigh","max"] },
  { "value": "sonnet",    "resolvedModel": "claude-sonnet-5",     "supportedEffortLevels": ["low","medium","high","xhigh","max"] },
  { "value": "haiku",     "resolvedModel": "claude-haiku-4-5-20251001" }
]
```

Notes:

- `value` is what you pass to `--model`; `resolvedModel` is the concrete model id; `displayName`/`description` are UI-ready.
- **Effort support is per-model**: `haiku` has no `supportsEffort`/`supportedEffortLevels` → hide the effort picker for it. Never assume the 5-level set.
- The same response's `account` object duplicates auth info, so a single spawn answers "authenticated?" and "which models/efforts?" together. Measured 1.1 s end-to-end.
- If Quacket's runner is built on the Agent SDK anyway, `query.supportedModels()` is the same data via a supported API (note: known issue #117 — the SDK type filters some aliases; the raw control response is the complete list).

### Passing the selection at invocation time

```
claude -p "<prompt>" --model <value> --effort <level>
```

`--effort` choices on 2.1.210: `low, medium, high, xhigh, max` (plus `ultracode` ≥ 2.1.203 per docs) — but always render only the enumerated `supportedEffortLevels` for the chosen model.

---

## Provider 2: Codex CLI

### Installed detection

- PATH lookup for `codex`. On Windows the npm install exposes `codex` + `codex.cmd` under `%APPDATA%\npm` — spawn must resolve the `.cmd` shim (or use `shell: true` equivalent).
- `codex --version` → `codex-cli 0.144.4`, exit 0.

### Authenticated detection

Two options, both verified:

1. **Quick:** `codex login status` → prints `Logged in using ChatGPT` / `Logged in using an API key` / `Not logged in`; exit 0 when logged in, 1 when not. Measured 0.1 s. No `--json` yet (open feature request openai/codex#19866). Caveat: reports "Not logged in" for non-OAuth setups (env-var API key, Azure/custom `model_providers`) even when `codex exec` would work — openai/codex-plugin-cc#21.
2. **Robust (recommended, since the app-server is already needed for model/list):** `account/read` over the app-server returns `{"account": {"type":"chatgpt","email":"…","planType":"pro"}, "requiresOpenaiAuth": true}`; schema marks `account` nullable → `null` = logged out. This also distinguishes `apiKey` vs `chatgpt` account types.

### Model + effort enumeration (verified live)

`codex app-server` is a JSON-RPC-over-stdio service (the surface the IDE extension uses) with a first-class **`model/list`** method:

1. Spawn `codex app-server`.
2. Send `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"quacket","title":"Quacket","version":"…"}}}`, then the `initialized` notification.
3. Send `{"jsonrpc":"2.0","id":2,"method":"model/list","params":{}}` (params support `includeHidden`, `limit`, `cursor`).
4. Kill the process.

Verified response on 0.144.4 (7 models, abridged):

| id | default effort | supported efforts |
|---|---|---|
| `gpt-5.6-sol` (isDefault) | low | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | medium | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna` | medium | low, medium, high, xhigh, max |
| `gpt-5.5` | medium | low, medium, high, xhigh |
| `gpt-5.4` / `gpt-5.4-mini` | medium | low, medium, high, xhigh |
| `gpt-5.3-codex-spark` | high | low, medium, high, xhigh |

Each entry carries `id`, `model`, `displayName`, `description`, `isDefault`, `hidden`, `defaultReasoningEffort`, `supportedReasoningEfforts[].{reasoningEffort, description}` (the per-effort descriptions are UI-ready), plus `serviceTiers`. Measured 0.2 s.

The protocol is self-describing: `codex app-server generate-json-schema --out <dir>` emits the full JSON Schema bundle (that is how the shapes above were confirmed), so Quacket can pin/validate against the schema of the installed version.

**Secondary signal (do not use as primary):** codex caches the same server catalog at `~/.codex/models_cache.json` (`fetched_at`, `etag`, `models[]` with `slug`, `default_reasoning_level`, `supported_reasoning_levels`, `visibility`). It's an undocumented internal file — fine as a read-only cross-check or last-ditch fallback, but `model/list` is the supported surface and reflects auth/plan state.

### Passing the selection at invocation time

```
codex exec "<prompt>" -m <model-id> -c model_reasoning_effort=<effort>
```

(`model` / `model_reasoning_effort` are the documented config keys; `-c` overrides `~/.codex/config.toml` per-invocation, so Quacket never mutates the user's config. `config.toml` also shows the user's current defaults — e.g. `model = "gpt-5.6-sol"`, `model_reasoning_effort = "high"` on this machine — useful for pre-selecting Quacket's default.)

---

## When enumeration is impossible

Enumeration can fail on: older CLI versions (no `app-server`/control-protocol support), a broken install, or a logged-out CLI (Codex `model/list` may fail or return stale data without auth). Strategy, in order:

1. **Version-gate, then degrade explicitly.** If `--version` parses below the earliest version Quacket has tested enumeration against, mark the provider "installed, enumeration unsupported" rather than silently guessing.
2. **Curated-but-verified fallback list.** Ship a small curated list per provider (aliases only: `sonnet`/`opus`/`haiku`/`default` for Claude; the CLI's own configured default from `~/.codex/config.toml` for Codex). Before showing an entry as selectable, verify it with one cheap probe: a minimal headless invocation (`claude -p "ok" --model X --max-budget-usd <tiny>` / `codex exec "say ok" -m X`) run once, in the background, result cached. Entries that fail the probe are hidden, not greyed — the locked decision is "never assume".
3. **Never present unverified entries as available.** If neither enumeration nor probe verification has succeeded, the UI shows the provider's model picker as "using CLI default" (no model flag passed at all — the CLI then applies its own default, which always works if the CLI is authenticated). This is the safest degraded mode: zero assumptions, still functional.
4. **Effort fallback:** if effort levels can't be enumerated for a model, omit the effort flag entirely (CLI default applies) and hide the effort picker for that model.

## Refresh (staleness) strategy

Cache the enumeration result keyed by `(provider, CLI version string, account identity: email/org/plan)` and re-enumerate when any of these fire:

1. **App start** — run both enumerations async in the background (measured ≤1.1 s; never block the tray UI on it; show cached data immediately, swap in fresh data when it lands).
2. **CLI version change** — `--version` is cheap; check it on app start and on window focus after long idle. Version change invalidates the cache unconditionally (Codex's own `models_cache.json` is keyed by `client_version` for the same reason).
3. **Auth change** — if `auth status`/`account/read` identity differs from the cached key (login, logout, plan change), re-enumerate: available models depend on plan.
4. **On failure** — if a refinement invocation fails with a model/effort-related error (unknown model, deprecated slug), immediately re-enumerate and surface the refreshed picker instead of retrying blind.
5. **TTL backstop** — e.g. 24 h, matching the ETag'd daily refresh codex itself performs on its model cache. No user-facing "refresh" button needed beyond a retry affordance on the error state.

## Sources

- Claude Code CLI reference (documents `claude auth status` exit codes/JSON, `--model`, `--effort` levels; confirms no list-models command): https://code.claude.com/docs/en/cli-reference
- Agent SDK TypeScript reference — `Query.supportedModels()` (same control-protocol data): https://code.claude.com/docs/en/agent-sdk/typescript ; alias-filtering caveat: https://github.com/anthropics/claude-agent-sdk-typescript/issues/117
- Codex CLI repo (app-server protocol source of truth; `codex app-server generate-json-schema` run locally from v0.144.4 to extract `model/list`, `account/read` schemas): https://github.com/openai/codex
- Codex config keys `model`, `model_reasoning_effort`: https://github.com/openai/codex/blob/main/docs/config.md
- `codex login status` exit-code + no-JSON caveats: https://github.com/openai/codex/issues/19866 , https://github.com/openai/codex-plugin-cc/issues/21
- Local empirical verification (2026-07-16, Windows 11): `claude auth status`, control-protocol `initialize` dump (Claude Code 2.1.210); `codex login status`, app-server `initialize` → `model/list` → `account/read` live JSON-RPC round-trip, `~/.codex/models_cache.json` inspection (codex-cli 0.144.4). Latencies measured with wall-clock timing of the spawned processes.
