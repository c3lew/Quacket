/**
 * What the palette SAYS about a report a previous run did not finish filing.
 *
 * `core/filing` decides what is true — checking, filed, pending, failed. This
 * decides what the user reads and which single button they get, and it is a pure
 * function of the event so both halves can be pinned by tests rather than by
 * reading the .tsx.
 *
 * Two rules the whole file exists to hold:
 *
 * - **One safe next action, or none.** `pending` means duplicate safety is
 *   unknown, so the only offer is another look at GitHub — never "send it
 *   again", which is how a report gets filed twice. `checking` gets no button at
 *   all: a lookup is already in flight, and the honest next action is to keep
 *   capturing, which the non-blocking row leaves the user free to do.
 * - **No internals.** No marker, journal, receipt queue, atomic handoff, no
 *   upload progress, no transition name, no path. `no-internal-terms` in the
 *   tests fails the build on one. What the user gets is the same sentence they
 *   would say themselves: it went through, or it still needs checking.
 */

import type { FilingReceipt, RecoveryEvent } from '../filing/filing.ts';

/**
 * The one control a status row may carry.
 *
 * `check` is `recover()` run again — for BOTH pending and failed, deliberately.
 * A failed Filing is one GitHub has provably never seen, so resuming it is safe;
 * but re-running recovery re-proves that against GitHub before it creates
 * anything, where a direct resume would take a fact from the last run on faith.
 * Same button, one code path, and the safe one.
 */
export type RecoveryAction =
  /** Ask GitHub about THIS report again. Carries the id, so it asks about no other. */
  | { kind: 'check'; label: string; filingId: string }
  /** Everything the caller needs is here, so it never re-reads the event to act. */
  | { kind: 'open'; label: string; url: string };

export interface RecoveryNotice {
  text: string;
  /** Null exactly while there is nothing to do but wait. */
  action: RecoveryAction | null;
  /** Calm status, good news, or a real problem — never the same colour. */
  tone: 'busy' | 'info' | 'good' | 'warn';
}

/**
 * Where the report ended up, as a clause.
 *
 * Deliberately NOT the Done screen's wording ("Issue #42 filed" / "Added to
 * issue #42"): that is a heading standing alone, this is the tail of a sentence
 * about a report from a previous session. Same fact, two grammars, and forcing
 * one string to serve both would bend whichever one it was not written for.
 */
const landed = (receipt: FilingReceipt): string =>
  receipt.target.kind === 'comment'
    ? `added to issue #${receipt.issueNumber}`
    : `filed as issue #${receipt.issueNumber}`;

export function recoveryNotice(event: RecoveryEvent): RecoveryNotice {
  switch (event.state) {
    case 'checking':
      return { text: 'Still checking your report from last time…', tone: 'busy', action: null };

    /*
     * The message comes from the lookup and is shown as-is, because only it
     * knows WHY — offline, signed out, rate limited. It is written plainly at
     * the source ("Could not check GitHub for this report."), so restating it
     * here would be a second copy free to drift into something less true.
     */
    case 'pending':
      return {
        text: `Your report from last time is still pending. ${event.message}`,
        tone: 'info',
        action: { kind: 'check', label: 'Check again', filingId: event.filingId },
      };

    case 'filed':
      return {
        text: `Your report from last time was ${landed(event.receipt)}.`,
        tone: 'good',
        action: { kind: 'open', label: 'View on GitHub', url: event.receipt.url },
      };

    /*
     * The ONE recovery state where trying again cannot duplicate anything —
     * that is the whole meaning of `failed`, and why it is the only one that
     * gets a send-shaped button rather than a look-shaped one.
     */
    case 'failed':
      return {
        text: `Your report from last time was not sent, so it is safe to try again. ${event.message}`,
        tone: 'warn',
        action: { kind: 'check', label: 'Try again', filingId: event.filingId },
      };
  }
}

/**
 * The OS notification a resolution earns while the palette is hidden — or null
 * for one that has not resolved.
 *
 * Both conclusions notify, and only conclusions do: an uncertain report that is
 * still uncertain is not news, and a toast for it would be a nag that fires on
 * every launch of a laptop that is simply offline.
 *
 * A LIVE submit stays silent when it succeeds (the done screen is its
 * confirmation, and the user is looking at it). This one cannot be: the whole
 * situation is that the user walked away from a report they could not be told
 * about, and the conclusion arriving in the tray is the point.
 */
export const recoveryAlert = (event: RecoveryEvent): string | null => {
  if (event.state === 'filed') return `Your report from last time was ${landed(event.receipt)}.`;
  if (event.state === 'failed') return 'Your report from last time was not sent. Open Quacket to try again.';
  return null;
};

/**
 * The latest word on each Filing, in the order they were first heard of.
 *
 * Replace, never append: a Filing's events are a single row changing its mind
 * (checking → filed), and stacking them would show the user three sentences
 * about one report, two of which are already out of date.
 */
export const upsertRecovery = (list: RecoveryEvent[], event: RecoveryEvent): RecoveryEvent[] =>
  list.some((e) => e.filingId === event.filingId)
    ? list.map((e) => (e.filingId === event.filingId ? event : e))
    : [...list, event];
