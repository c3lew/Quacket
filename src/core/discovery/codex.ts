/**
 * Codex enumeration, over a TRANSIENT `codex app-server`.
 *
 * The app-server is a JSON-RPC-over-stdio service. Quacket spawns it, asks
 * `model/list` + `account/read`, and kills it. It is never kept alive between
 * discoveries — a tray app must not leave a language-model server running.
 *
 * Two things the wire actually does (verified against 0.144.4, not assumed):
 *   - Replies carry NO `jsonrpc` field. They are bare `{id, result}`.
 *   - Replies arrive OUT OF ORDER, interleaved with unsolicited notifications
 *     (`remoteControl/status/changed`). Correlate by `id`; never by arrival.
 */

import type { ProcessRunner, ProcSession } from '../runner.ts';
import { ProviderError, type ModelInfo, type ProviderCapabilities } from '../types.ts';

/**
 * Oldest version `model/list` has actually been verified against
 * (docs/research/model-effort-discovery.md, 2026-07-16).
 */
export const CODEX_MIN_VERSION = '0.144.4';

const ID_INITIALIZE = 1;
const ID_MODEL_LIST = 2;
const ID_ACCOUNT_READ = 3;

interface RawEffort {
  reasoningEffort?: string;
}

interface RawModel {
  id?: string;
  displayName?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: RawEffort[];
}

interface ModelListResult {
  data?: RawModel[];
}

interface AccountReadResult {
  /** Schema marks this nullable; null means logged out. */
  account?: { email?: string; planType?: string } | null;
}

interface RpcLine {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

const parse = (line: string): RpcLine | null => {
  try {
    return JSON.parse(line) as RpcLine;
  } catch {
    return null;
  }
};

const send = (session: ProcSession, msg: unknown): void => session.write(JSON.stringify(msg));

const toModelInfo = (m: RawModel): ModelInfo => ({
  id: m.id as string,
  label: m.displayName ?? (m.id as string),
  // Per-model, never per-provider: gpt-5.6-sol reaches `ultra`, gpt-5.5 stops at `xhigh`.
  efforts: (m.supportedReasoningEfforts ?? [])
    .map((e) => e.reasoningEffort)
    .filter((e): e is string => typeof e === 'string'),
});

export async function enumerateCodex(
  runner: ProcessRunner,
  cliVersion: string,
): Promise<ProviderCapabilities> {
  const session = runner.session({
    cmd: 'codex',
    args: ['app-server'],
    timeoutMs: 30_000,
  });
  const results = new Map<number, unknown>();

  try {
    send(session, {
      jsonrpc: '2.0',
      id: ID_INITIALIZE,
      method: 'initialize',
      params: {
        clientInfo: { name: 'quacket', title: 'Quacket', version: '0.1.0' },
      },
    });

    for await (const line of session.lines()) {
      const msg = parse(line);
      // Notifications have no id. Only replies do.
      if (typeof msg?.id !== 'number') continue;
      if (msg.error) {
        throw new ProviderError(
          'provider_error',
          "Codex's app-server returned an error.",
          msg.error.message ?? line,
        );
      }
      results.set(msg.id, msg.result);

      if (msg.id === ID_INITIALIZE) {
        send(session, { jsonrpc: '2.0', method: 'initialized', params: {} });
        send(session, {
          jsonrpc: '2.0',
          id: ID_MODEL_LIST,
          method: 'model/list',
          params: {},
        });
        send(session, {
          jsonrpc: '2.0',
          id: ID_ACCOUNT_READ,
          method: 'account/read',
          params: {},
        });
      }
      if (results.has(ID_MODEL_LIST) && results.has(ID_ACCOUNT_READ)) break;
    }
  } finally {
    // Always, on every path: no persistent child processes, ever.
    session.kill();
  }

  const list = results.get(ID_MODEL_LIST) as ModelListResult | undefined;
  const acct = results.get(ID_ACCOUNT_READ) as AccountReadResult | undefined;
  if (!list || !acct) {
    throw new ProviderError('provider_error', "Codex's app-server didn't return a model list.");
  }

  const account = acct.account?.email
    ? `${acct.account.email}/${acct.account.planType ?? 'unknown'}`
    : null;
  if (!account) {
    throw new ProviderError(
      'not_authenticated',
      'Codex is not logged in. Log in to the Codex CLI, then try again.',
    );
  }

  return {
    provider: 'codex',
    cliVersion,
    account,
    models: (list.data ?? [])
      .filter((m) => typeof m?.id === 'string' && m.hidden !== true)
      .map(toModelInfo),
  };
}
