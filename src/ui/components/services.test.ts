/**
 * The joint between the two halves of the effort story.
 *
 * Round 5 fixed "the card discards its own pick" at the card (`Onboarding.tsx`'s
 * `use()` reconciled against `null`), and the adapters have always pinned
 * `effort -> argv` (`codex.test.ts`'s "passes model and effort unquoted",
 * `claude.test.ts`'s "passes --effort when the model takes one"). Both halves
 * were green. Neither owned the line between them.
 *
 * `createUiServices` is built ONLY in `main.tsx`; `App.test.tsx` imports just its
 * TYPE and hands the component a fake. So the one line that carries the user's
 * choice from the settings object into the adapter call —
 *
 *     effort: settings.effort
 *
 * — was executed by no test at all. Changing it to `effort: null` silently
 * disables reasoning effort across the whole app, on every refine, for both
 * providers, and leaves all 669 tests and `tsc --noEmit` green. That was measured
 * on this tree, not reasoned about.
 *
 * That is the same defect round 5 was convened to fix, one layer down: a level
 * the user deliberately picked, thrown away by code between the control and the
 * CLI. The card's fix does not reach here, because this is a different file — and
 * "fixed per-file, so it moved" is this repo's recurring failure, written up at
 * length in `Picker.tsx` and `raw-select.guard.test.ts`.
 *
 * ── Why the REAL adapter and not a fake one ─────────────────────────────────
 *
 * A fake adapter would assert that `services.refine` passes `effort` to a
 * function we also wrote — which is the assertion the two green halves already
 * make separately, and it is exactly what let the gap exist. These drive the real
 * `createAdapter` and the real `createGitHub` over `FakeRunner`, so the assertion
 * lands where the spec puts it: **the argv handed to `codex`/`claude`**. The
 * whole chain from a `Settings` object to the process argv runs, unmocked.
 *
 * This is deliberately NOT a re-draw of the pipeline. `App.test.tsx` already
 * notes it reproduces "the real submit bracket, exactly as `components/services.ts`
 * writes it" — a route drawn twice is how the halves came apart in the first
 * place. Here the route IS the thing under test.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discover } from '../../core/discovery/discovery.ts';
import { DraftStore } from '../../core/drafts/store.ts';
import { createGitHub } from '../../core/github/github.ts';
import { createAdapter } from '../../core/llm/index.ts';
import { FakeRunner } from '../../core/testing/fake-runner.ts';
import { nodeFiles } from '../../core/testing/node-files.ts';
import { DEFAULT_SETTINGS, type Settings } from '../../core/types.ts';
import type { Services as AppServices } from '../../app/services.ts';
import { createUiServices, type Platform, type UiServices } from './services.ts';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'quacket-uisvc-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A schema-conforming Codex stream: what a real refine actually returns. */
const codexStream = (): string =>
  [
    '{"type":"thread.started","thread_id":"019f66a7-dead-beef"}',
    '{"type":"turn.started"}',
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'agent_message',
        text: JSON.stringify({
          type: 'bug',
          title: 'Login button does nothing',
          sections: [{ heading: 'Actual', body: 'Nothing happens on click.' }],
        }),
      },
    }),
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
  ].join('\n');

/**
 * A schema-conforming Claude `result` event. A text-only refine takes the plain
 * `--output-format json` route (no images ⇒ no stream-json), so this arrives as
 * `stdout`, not as session lines.
 */
const claudeResult = (): string => {
  // `--json-schema` is what puts the parsed object in `structured_output`, and
  // that — not `result` — is the field the adapter reads.
  const draft = {
    type: 'bug',
    title: 'Login button does nothing',
    sections: [{ heading: 'Actual', body: 'Nothing happens on click.' }],
  };
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    result: JSON.stringify(draft),
    structured_output: draft,
    session_id: 'sess-abc-123',
    terminal_reason: 'completed',
  });
};

/**
 * The real composition, with the real core modules — only the PROCESS is faked,
 * which is the repo's one seam. Nothing here stands in for code under test.
 */
const wire = (runner: FakeRunner): UiServices => {
  const core: AppServices = {
    settings: { get: () => DEFAULT_SETTINGS, set: async () => DEFAULT_SETTINGS },
    drafts: new DraftStore(base, nodeFiles),
    github: createGitHub(runner),
    autostart: { isEnabled: async () => false, set: async () => {} },
    adapter: (s) => createAdapter(s.provider, { runner, files: nodeFiles, tempDirBase: base }),
    discover: (provider, force = false) =>
      discover(provider, { runner, files: nodeFiles, baseDir: base, force }),
    ghAuth: { ok: true },
  };

  const platform = {} as Platform; // refine touches none of it.
  return createUiServices({ core, platform, runner });
};

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  provider: 'codex',
  model: 'gpt-5.1-codex',
  effort: 'max',
  ...over,
});

const request = (s: Settings) => ({
  raw: 'the login button does nothing',
  images: [],
  repo: 'c3lew/Quacket',
  settings: s,
});

/** `gh issue list` really does print `[]\n` on an empty repo — verified round 4. */
const withGh = (runner: FakeRunner): FakeRunner => runner.on({ cmd: 'gh' }, { stdout: '[]\n' });

describe('the effort the user picked reaches the CLI', () => {
  /**
   * `max` is deliberately neither `'medium'` (`reconcileEffort`'s fallback) nor
   * the first level offered, so a value that arrives by defaulting rather than by
   * carrying the user's pick cannot produce this argv.
   */
  it('carries a deliberate Codex effort all the way into argv', async () => {
    const runner = withGh(new FakeRunner().on({ cmd: 'codex' }, { stdout: codexStream() }));

    await wire(runner).refine(request(settings({ provider: 'codex', effort: 'max' })));

    const spawn = runner.calls.find((c) => c.cmd === 'codex');
    expect(spawn).toBeDefined();
    expect(spawn?.args).toContain('model_reasoning_effort=max');
    expect(spawn?.args).not.toContain('model_reasoning_effort=medium');
  });

  it('carries a deliberate Claude effort all the way into argv', async () => {
    const runner = withGh(new FakeRunner().on({ cmd: 'claude' }, { stdout: claudeResult() }));

    await wire(runner).refine(
      request(settings({ provider: 'claude', model: 'sonnet', effort: 'max' })),
    );

    const spawn = runner.calls.find((c) => c.cmd === 'claude');
    expect(spawn).toBeDefined();
    expect(spawn?.args[spawn.args.indexOf('--effort') + 1]).toBe('max');
  });

  /**
   * The other direction: a model that takes no levels must send no flag. Pinning
   * only the positive case would let `effort: 'max'` hardcoded here pass both.
   */
  it('sends no effort flag when the user has picked none', async () => {
    const runner = withGh(new FakeRunner().on({ cmd: 'codex' }, { stdout: codexStream() }));

    await wire(runner).refine(request(settings({ provider: 'codex', effort: null })));

    const spawn = runner.calls.find((c) => c.cmd === 'codex');
    expect(spawn?.args.join(' ')).not.toContain('model_reasoning_effort');
  });

  /** The model has the identical shape of route, and the identical exposure. */
  it('carries the picked model into argv too', async () => {
    const runner = withGh(new FakeRunner().on({ cmd: 'codex' }, { stdout: codexStream() }));

    await wire(runner).refine(request(settings({ provider: 'codex', model: 'gpt-5.1-codex' })));

    const spawn = runner.calls.find((c) => c.cmd === 'codex');
    expect(spawn?.args[spawn.args.indexOf('-m') + 1]).toBe('gpt-5.1-codex');
  });
});

/**
 * `detect()` must never reject.
 *
 * It is the ONE thing standing between the user and the capture box: the boot
 * effect in `App.tsx` awaits it with no catch, deliberately — round 3 made draft
 * loading resilient by giving it its own slot, on the reasoning that "only
 * detection may stand between the user and the capture box". That leaves
 * `detect()` itself carrying the whole boot. A rejection there is a palette stuck
 * on "Checking your setup…" forever: no capture box, no error card, not even
 * Discard — the same brick round 3 called a blocker for `loadDraft`.
 *
 * Two of its three inputs already degraded (`ghState` to not-installed,
 * `capabilitiesOf` to absent). `core.autostart.isEnabled()` did not, and could
 * brick boot on its own — one producer not knowing an invariant its siblings
 * keep, which is this repo's most-repeated defect.
 *
 * So these reject EVERY input in turn, not just the one that was broken: the next
 * input added to `detect()` has to degrade too, and this is what makes that
 * non-optional rather than a comment someone might read.
 */
describe('detect never rejects', () => {
  const boom = () => Promise.reject(new Error('the OS said no'));

  /** Every input healthy except the one under test. */
  const detectWith = (over: Partial<AppServices>, runner = withGh(new FakeRunner())) =>
    createUiServices({
      core: {
        settings: { get: () => DEFAULT_SETTINGS, set: async () => DEFAULT_SETTINGS },
        drafts: new DraftStore(base, nodeFiles),
        github: createGitHub(runner),
        autostart: { isEnabled: async () => false, set: async () => {} },
        adapter: (s) => createAdapter(s.provider, { runner, files: nodeFiles, tempDirBase: base }),
        discover: async () => {
          throw new Error('no CLI');
        },
        ghAuth: { ok: true },
        ...over,
      } as AppServices,
      platform: {} as Platform,
      runner,
    }).detect();

  it('survives autostart rejecting, and reports it off', async () => {
    const state = await detectWith({ autostart: { isEnabled: boom, set: async () => {} } });

    // Resolving at all IS the assertion; `false` is the honest answer to "is it
    // on?" when the Run key cannot be read.
    expect(state.autostart).toBe(false);
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('survives discovery rejecting, and reports no providers', async () => {
    const state = await detectWith({
      discover: () => Promise.reject(new Error('claude exploded')),
    });

    expect(state.providers).toEqual([]);
  });

  it('survives gh being absent entirely', async () => {
    const runner = new FakeRunner().on({ cmd: 'gh' }, { exitCode: 1, stderr: 'not found' });

    const state = await detectWith({}, runner);

    expect(state.gh).toEqual({ installed: false, authenticated: false });
  });

  /**
   * The real brick: everything failing at once still has to produce a usable
   * DetectedState, because that is the machine a user with a fresh laptop and no
   * tools installed actually has — the exact person onboarding exists for.
   */
  it('survives every input failing at once', async () => {
    const runner = new FakeRunner().on({ cmd: 'gh' }, { exitCode: 1 });

    const state = await detectWith(
      {
        autostart: { isEnabled: boom, set: async () => {} },
        discover: () => Promise.reject(new Error('nothing installed')),
      },
      runner,
    );

    expect(state).toEqual({
      gh: { installed: false, authenticated: false },
      providers: [],
      settings: DEFAULT_SETTINGS,
      autostart: false,
    });
  });
});
