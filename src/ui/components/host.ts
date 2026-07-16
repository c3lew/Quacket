/**
 * The reducer HOST: the plumbing that carries the machine's effects to the
 * outside world without dropping any.
 *
 * `src/core/ui/reducer.ts` hands every side effect back as data, which is what
 * makes it testable. That guarantee is only worth as much as the thing that
 * drains it — and the naive host loses effects.
 *
 * The trap: `Next` bundles `{ state, effects }`, so hosting it directly as the
 * reducer's accumulator makes `effects` STATE. React batches every dispatch in
 * one tick into a single commit, so two dispatches in one batch mean the second
 * `Next` REPLACES the first, and the first's effects are rendered-over before
 * any of them ran. A real instance of that in v1: a submit failing while the
 * window was hidden dispatched `submit-failed` (effect: notify) and then
 * `images-uploaded` (no effects) in the same async continuation — so the OS
 * notification that is the whole point of story 27 was silently swallowed.
 *
 * The fix is to stop treating effects as a value to be replaced and start
 * treating them as a QUEUE to be drained: `pending` only ever grows by append,
 * and shrinks only when the host says it has actually performed something.
 *
 * Kept here, pure and reducer-shaped, so the guarantee is a unit test rather
 * than a claim about how React batches.
 */

import {
  initialState,
  reduce,
  type Action,
  type Effect,
  type UiState,
} from '../../core/ui/reducer.ts';

/** Removes the effects the host has performed. Not a domain action — hence the sigil. */
export interface DrainAction {
  type: '@drain';
  /** How many effects, from the front, have been handed to the performer. */
  count: number;
}

export type HostAction = Action | DrainAction;

export interface Host {
  state: UiState;
  /**
   * Effects awaiting performance, oldest first. Appended to by every dispatch
   * and emptied only by `@drain`, so no batch can swallow another's effects.
   */
  pending: Effect[];
}

export const initialHost = (): Host => ({ state: initialState(), pending: [] });

export const drain = (count: number): DrainAction => ({ type: '@drain', count });

export function hostReduce(host: Host, action: HostAction): Host {
  if (action.type === '@drain') {
    return action.count === 0 ? host : { ...host, pending: host.pending.slice(action.count) };
  }

  const next = reduce(host.state, action);
  // Append, never replace: this one line is the whole guarantee.
  return {
    state: next.state,
    pending: next.effects.length === 0 ? host.pending : [...host.pending, ...next.effects],
  };
}
