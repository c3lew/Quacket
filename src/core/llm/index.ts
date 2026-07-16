import type { ProviderId } from '../types.ts';
import type { AdapterDeps, LlmAdapter } from './adapter.ts';
import { createClaudeAdapter } from './claude.ts';
import { createCodexAdapter } from './codex.ts';

export type {
  AdapterDeps,
  LlmAdapter,
  RefineInput,
  RefineResult,
  Thread,
  Usage,
} from './adapter.ts';
export { DEFAULT_TIMEOUT_MS } from './adapter.ts';

/** The module's front door: a provider id in, one uniform adapter out. */
export const createAdapter = (provider: ProviderId, deps: AdapterDeps): LlmAdapter =>
  provider === 'claude' ? createClaudeAdapter(deps) : createCodexAdapter(deps);
