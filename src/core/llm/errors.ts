import { ProviderError } from '../types.ts';
import type { ErrorKind } from '../types.ts';

/**
 * Two providers' failure vocabularies collapsed into `ErrorKind`.
 *
 * Every message here is shown to the user verbatim, so it says what happened and
 * what to do about it in plain language — no status codes, no flag names, no
 * "the CLI returned". The machine-readable original goes in `detail`.
 *
 * `ErrorKind` is deliberately narrower than what the CLIs report: billing,
 * overloaded, server_error and max_output_tokens all land on `provider_error`
 * because the UI does the same thing for all of them — show the message, let the
 * user retry. The kind keeps the distinction the UI branches on; the message
 * keeps the one the user can act on.
 */

type Name = 'Claude' | 'Codex';

const SIGN_IN: Record<Name, string> = {
  Claude: 'Claude isn’t signed in. Open a terminal, run `claude`, sign in there, then try again.',
  Codex: 'Codex isn’t signed in. Open a terminal, run `codex login`, then try again.',
};

export const timeoutError = (provider: Name, timeoutMs: number): ProviderError =>
  new ProviderError(
    'timeout',
    `${provider} took longer than ${Math.round(timeoutMs / 1000)} seconds, so Quacket stopped it. ` +
      'Try again, or pick a faster model in Settings.',
  );

const notAuthenticated = (provider: Name, detail: string): ProviderError =>
  new ProviderError('not_authenticated', SIGN_IN[provider], detail);

const rateLimited = (provider: Name, detail: string): ProviderError =>
  new ProviderError(
    'rate_limited',
    `You’ve hit your ${provider} usage limit. Wait a few minutes and try again, or switch provider in Settings.`,
    detail,
  );

const modelUnavailable = (provider: Name, model: string | null, detail: string): ProviderError =>
  new ProviderError(
    'model_unavailable',
    model === null
      ? `That model isn’t available on your ${provider} account. Pick a different one in Settings.`
      : `The model “${model}” isn’t available on your ${provider} account. Pick a different one in Settings.`,
    detail,
  );

// ── Claude ──────────────────────────────────────────────────────────────────

/**
 * `system`/`api_retry` `.error` categories (stream-json mode only). The richest
 * signal Claude gives us, so it wins over status/text whenever it is present.
 *
 * All TEN of them. The list is not ours to shorten: it is claude 2.1.211's own
 * embedded Zod enum, read out of the binary (see
 * `docs/research/live-verification-round4.md`). It used to carry nine — the
 * missing `oauth_org_not_allowed` fell through to the status/text heuristics,
 * which is a silent downgrade to guessing on the one signal that does not need
 * to guess.
 */
const CLAUDE_KIND: Record<string, ErrorKind> = {
  authentication_failed: 'not_authenticated',
  rate_limit: 'rate_limited',
  model_not_found: 'model_unavailable',
  /*
   * NOT `not_authenticated`, though it is an auth failure and that is where a
   * one-line fix naturally lands. `notAuthenticated()` ignores the message it is
   * handed and always states "Claude isn't signed in… run `claude`, sign in" —
   * and for this category the user IS signed in. The sign-in they are being sent
   * to do will succeed and change nothing, and the app will have told them
   * something false about their own machine to get them there.
   *
   * It goes where `billing_error` goes, for the same reason: an account-level
   * refusal that a re-login does not fix, so it earns its own sentence below.
   */
  oauth_org_not_allowed: 'provider_error',
  billing_error: 'provider_error',
  overloaded: 'provider_error',
  server_error: 'provider_error',
  invalid_request: 'provider_error',
  max_output_tokens: 'provider_error',
  unknown: 'provider_error',
};

/** For the categories that all collapse to `provider_error`: same kind, different fix. */
const CLAUDE_PROVIDER_MESSAGE: Record<string, string> = {
  oauth_org_not_allowed:
    'Your Claude account’s organization isn’t allowed to use Claude Code this way. Ask whoever manages the organization, or sign in with a different account.',
  billing_error:
    'Your Claude account has a billing problem, so the request was refused. Check your plan at claude.ai, then try again.',
  overloaded: 'Claude is overloaded right now. Wait a moment and try again.',
  server_error: 'Claude hit a server error. Wait a moment and try again.',
  invalid_request: 'Claude rejected the request. This is a bug in Quacket — please report it.',
  max_output_tokens: 'Your report was too long for Claude to finish writing up. Trim it down and try again.',
  unknown: 'Claude failed for an unknown reason. Try again.',
};

export interface ClaudeFailure {
  /** `system`/`api_retry` `.error` category, when one was emitted. */
  category: string | null;
  /** `.api_error_status`. */
  status: number | null;
  /** `.result` text, or stderr when no result event parsed. */
  text: string;
  /** `.terminal_reason`. Carried into `detail`; `is_error` already told us it failed. */
  terminalReason: string | null;
  model: string | null;
}

const build = (provider: Name, kind: ErrorKind, message: string, model: string | null, detail: string) => {
  switch (kind) {
    case 'not_authenticated':
      return notAuthenticated(provider, detail);
    case 'rate_limited':
      return rateLimited(provider, detail);
    case 'model_unavailable':
      return modelUnavailable(provider, model, detail);
    default:
      return new ProviderError(kind, message, detail);
  }
};

export const claudeError = (f: ClaudeFailure): ProviderError => {
  const detail = JSON.stringify(f);

  const kind = f.category === null ? undefined : CLAUDE_KIND[f.category];
  if (kind !== undefined) {
    const message = (f.category !== null && CLAUDE_PROVIDER_MESSAGE[f.category]) || CLAUDE_PROVIDER_MESSAGE.unknown!;
    return build('Claude', kind, message, f.model, detail);
  }

  // Verified: not-logged-in reports no status at all, only this text.
  if (/not logged in/i.test(f.text)) return notAuthenticated('Claude', detail);
  if (f.status === 401 || f.status === 403) return notAuthenticated('Claude', detail);
  if (f.status === 429) return rateLimited('Claude', detail);
  if (f.status === 404) return modelUnavailable('Claude', f.model, detail); // verified: bad model → 404
  if (f.status !== null && f.status >= 500) {
    return new ProviderError('provider_error', CLAUDE_PROVIDER_MESSAGE.server_error!, detail);
  }

  return new ProviderError(
    'provider_error',
    f.text.trim() === '' ? 'Claude failed without saying why. Try again.' : `Claude failed: ${f.text.trim()}`,
    detail,
  );
};

// ── Codex ───────────────────────────────────────────────────────────────────

/**
 * `turn.failed.error.message` is a JSON *string* holding the upstream API error:
 *   {"type":"error","status":400,"error":{"type":"invalid_request_error",...}}
 * It is not always JSON (arg-parse failures are bare text), so unwrapping is
 * best-effort and the raw message is the fallback.
 */
const unwrap = (message: string): { status: number | null; type: string | null; text: string } => {
  const bare = { status: null, type: null, text: message };
  try {
    const parsed: unknown = JSON.parse(message);
    if (typeof parsed !== 'object' || parsed === null) return bare;
    const outer = parsed as { status?: unknown; error?: unknown };
    const inner = (typeof outer.error === 'object' && outer.error !== null ? outer.error : {}) as {
      type?: unknown;
      message?: unknown;
    };
    return {
      status: typeof outer.status === 'number' ? outer.status : null,
      type: typeof inner.type === 'string' ? inner.type : null,
      text: typeof inner.message === 'string' ? inner.message : message,
    };
  } catch {
    return bare;
  }
};

export const codexError = (raw: string, model: string | null): ProviderError => {
  const { status, type, text } = unwrap(raw);

  // Verified: "The 'X' model is not supported when using Codex with a ChatGPT
  // account." — reported as a plain 400, so status alone cannot catch it.
  if (/model is not supported|unsupported model|unknown model/i.test(text)) {
    return modelUnavailable('Codex', model, raw);
  }
  if (status === 401 || status === 403 || /unauthor|not logged in|logged out/i.test(text)) {
    return notAuthenticated('Codex', raw);
  }
  if (status === 429 || type === 'rate_limit_error' || /rate.?limit|quota/i.test(text)) {
    return rateLimited('Codex', raw);
  }
  if (status === 404) return modelUnavailable('Codex', model, raw);
  if (status !== null && status >= 500) {
    return new ProviderError('provider_error', 'Codex hit a server error. Wait a moment and try again.', raw);
  }

  return new ProviderError(
    'provider_error',
    text.trim() === '' ? 'Codex failed without saying why. Try again.' : `Codex failed: ${text.trim()}`,
    raw,
  );
};

/** Exit 0, nothing reported a failure, and still no draft came back. */
export const noDraftError = (provider: Name, detail: string): ProviderError =>
  new ProviderError('provider_error', `${provider} didn’t return a usable draft. Try again.`, detail);
