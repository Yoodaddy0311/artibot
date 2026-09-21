/**
 * Wave 12 — the UserPromptSubmit hook now writes an `activation-observed`
 * record, and this suite is the proof that the record reaches the decisions
 * store with the values the §3.7 slash-agreement axis folds.
 *
 * WHY THIS EXISTS. `scripts/evals/nl-activation-report.mjs` reported
 * `activation.slash-agreement` as `0/0, ratio null — UNMEASURED` because no
 * writer recorded either side of the comparison. This suite drives the hook
 * end to end and then runs that same reporter against the sandbox store, so
 * "the writer exists" and "the instrument can read it" are one measurement
 * rather than two hopeful halves.
 *
 * WHAT THIS SUITE CANNOT SEE (stated next to the gate so the gate cannot become
 * the next false assurance):
 *
 *  1. It says nothing about whether the predicted activation is CORRECT.
 *     `lib/topology/topology-router.js` is an Observe-stage sighting function
 *     with uncalibrated weights by its own header. This checks only that what
 *     the router returned is what reached disk, and that the observed slash is
 *     what the user actually typed.
 *  2. The agreement ratio measured in the reporter round trip is a ratio over
 *     FOUR SYNTHETIC PROMPTS chosen by this file. It is a schema check, not
 *     evidence about the §3.7 ≥90% bar, which needs live prompts.
 *  3. Everything runs under a temp sandbox pinned by its own `.git` marker. A
 *     regression that only appears at the real plugin root is invisible here,
 *     and no assertion in this file may ever read the real decisions store.
 *  4. Byte-identity of the hook's stdout is NOT re-proven here. That invariant
 *     lives in tests/hooks/runtime-prompt-decision-wiring.test.js against a
 *     frozen pre-wiring fixture; this file would only restate it weakly.
 *  5. Case (e) asserts a KNOWN GAP, not a desired behavior: a namespaced slash
 *     (`/artibot:split`) is not detected by `detectSlashCommand`, so nothing is
 *     observed for it. The assertion exists so a future change is visible.
 */

import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, symlinkSync,
} from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { composePromptParts, handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';
import {
  ACTIVATION_OBSERVED,
  MEMORY_INJECTION_MEASURED,
  TOPOLOGY_RECOMMENDED,
  UNATTRIBUTED_RUN_ID,
} from '../../lib/observability/decision-events.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_CONFIG_PATH = path.join(PLUGIN_ROOT, 'artibot.config.json');
const REPORTER_REL = path.join('scripts', 'evals', 'nl-activation-report.mjs');

/** Directories the hook resolves through `getPluginRoot()` at runtime. */
const LINKED_DIRS = ['lib', 'commands', 'skills', 'agents'];

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

let sandboxRoot = '';
let savedEnv;

/**
 * Build a sandbox plugin root: real modules LINKED in (not copied, so the real
 * code runs and a missing link cannot make an assertion pass for the wrong
 * reason) plus a real config file, which `getPluginRoot()` validates for.
 *
 * The `.git` marker is load-bearing, not decoration. The decision store hangs
 * off the PROJECT root resolved by `lib/git/project-root.js#resolveProjectRoot`,
 * whose first rule is "nearest ancestor holding .git". Without one the walk
 * climbs out of tmpdir and could land on the real repository — which is how a
 * suite like this silently writes fixture lines into the live store.
 *
 * @param {string} prefix
 * @returns {string}
 */
function makeSandbox(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  for (const dir of LINKED_DIRS) {
    symlinkSync(path.join(PLUGIN_ROOT, dir), path.join(root, dir), linkType);
  }
  copyFileSync(REAL_CONFIG_PATH, path.join(root, 'artibot.config.json'));
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

/**
 * A sandbox where EXACTLY ONE module is missing: `activation-observed.js`.
 *
 * This is the shape an older installed tree has after a partial update, and it
 * is the only shape that tests the inner try/catch in
 * `recordObserveOnlyDecisions`. A root with no `lib/` at all cannot: there every
 * import fails, so "the older writers survived" is unobservable and a passing
 * assertion would mean nothing.
 *
 * `lib/` and `lib/observability/` are therefore REAL directories here — every
 * other lib subtree is linked to the real one, and observability is copied
 * whole (including `exporters/`) minus the one file. The copied modules' own
 * relative imports (`../core/redaction.js`, `../git/project-root.js`) resolve
 * through the links, so the real code still runs.
 *
 * @param {string} prefix
 * @returns {string}
 */
function makeSandboxWithoutActivationModule(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  copyFileSync(REAL_CONFIG_PATH, path.join(root, 'artibot.config.json'));
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  mkdirSync(path.join(root, '.git'), { recursive: true });
  for (const dir of LINKED_DIRS.filter((d) => d !== 'lib')) {
    symlinkSync(path.join(PLUGIN_ROOT, dir), path.join(root, dir), linkType);
  }

  const realLib = path.join(PLUGIN_ROOT, 'lib');
  const sandboxLib = path.join(root, 'lib');
  mkdirSync(sandboxLib, { recursive: true });
  for (const entry of readdirSync(realLib, { withFileTypes: true })) {
    if (entry.name === 'observability') continue;
    const from = path.join(realLib, entry.name);
    const to = path.join(sandboxLib, entry.name);
    if (entry.isDirectory()) symlinkSync(from, to, linkType);
    else copyFileSync(from, to);
  }
  cpSync(path.join(realLib, 'observability'), path.join(sandboxLib, 'observability'), {
    recursive: true,
  });
  rmSync(path.join(sandboxLib, 'observability', 'activation-observed.js'), { force: true });
  return root;
}

beforeAll(() => {
  sandboxRoot = makeSandbox('artibot-activation-wiring-');
});

afterAll(() => {
  if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
});

beforeEach(() => {
  savedEnv = {
    CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
    ARTIBOT_RUNTIME_CHECKPOINT_DISABLE: process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE,
    ARTIBOT_RUNTIME_MEMORY_DISABLE: process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE,
  };
  process.env.CLAUDE_PLUGIN_ROOT = sandboxRoot;
  process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE = '1';
  process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE = '1';
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Per-test store reset: every case below asserts EXACT counts, which would
  // otherwise accumulate across cases in the shared vitest worker.
  rmSync(decisionStore(), { recursive: true, force: true });
});

/** @returns {string} the sandbox's decision store, per getDecisionStoreDir. */
function decisionStore() {
  return path.join(sandboxRoot, '.artibot', 'runtime', 'decisions');
}

/** @returns {string[]} every raw ndjson line in the sandbox store. */
function readSandboxLines() {
  const store = decisionStore();
  if (!existsSync(store)) return [];
  return readdirSync(store)
    .filter((f) => f.endsWith('.ndjson'))
    .flatMap((f) => readFileSync(path.join(store, f), 'utf-8').split('\n'))
    .filter((l) => l.trim());
}

/** @returns {object[]} every decision event written under the sandbox store. */
function readSandboxDecisions() {
  return readSandboxLines().map((l) => JSON.parse(l));
}

/** @returns {object[]} just the activation-observed events. */
function activationEvents() {
  return readSandboxDecisions().filter((e) => e.type === ACTIVATION_OBSERVED);
}

/**
 * Fire one prompt through the exported handler with a complete payload.
 * @param {{prompt: string, sid?: string|null, pid?: string}} args
 * @returns {Promise<object|null>}
 */
function submit({ prompt, sid, pid }) {
  const payload = {
    user_prompt: prompt,
    event: 'UserPromptSubmit',
    cwd: sandboxRoot,
    prompt_id: pid,
  };
  if (sid) payload.session_id = sid;
  return handleUserPromptSubmit(payload);
}

describe('activation sandbox seam', () => {
  it('carries the linked modules the wiring imports', () => {
    // NEGATIVE CONTROL. Without the links every dynamic import in the hook falls
    // into its catch block, and "nothing recorded" would look identical to
    // "recorder correctly skipped".
    for (const dir of LINKED_DIRS) {
      expect(existsSync(path.join(sandboxRoot, dir))).toBe(true);
    }
    expect(existsSync(path.join(sandboxRoot, 'lib', 'observability', 'activation-observed.js')))
      .toBe(true);
    expect(existsSync(path.join(sandboxRoot, '.git'))).toBe(true);
  });
});

describe('activation-observed reaches <projectRoot>/.artibot/runtime/decisions/', () => {
  it('records an NL split phrase as predicted split with nothing observed', async () => {
    const out = await submit({
      prompt: '대규모 변경을 파일별로 병렬 처리해줘',
      sid: 'sess-act-a',
      pid: 'prompt-act-a',
    });
    expect(out).not.toBeNull();

    const events = activationEvents();
    expect(events).toHaveLength(1);
    const [ev] = events;
    expect(ev.data.command_activation)
      .toEqual({ autopilot: false, autopilot_fast: false, split: true });
    expect(ev.data.predicted_mode).toBe('split');
    expect(ev.data.predicted_signal).toBe('nl-explicit');
    // A NATURAL-LANGUAGE pattern id, not the `/split` flag one — this is the
    // case the §3.7 axis exists to measure.
    expect(ev.data.predicted_nl_match).toMatch(/^nl-split-/);
    // Nothing observed: the user typed no slash, so the numerator side is empty
    // and this record counts in the denominator only.
    expect(ev.data.activation_observed).toEqual({});
    expect(ev.data.prompt_id).toBe('prompt-act-a');
    expect(ev.data.observe_only).toBe(true);
    expect(ev.phase).toBe('ROUTE');
    // The key is rebuilt by the recorder from the RUN ID it resolved, not from
    // whatever the caller passed, so this also pins session_id → run id.
    expect(ev.data.idempotency_key).toBe('activation:sess-act-a:prompt-act-a');
  });

  it('records the slash the user actually typed for /split', async () => {
    await submit({ prompt: '/split status', sid: 'sess-act-b', pid: 'prompt-act-b' });

    const [ev] = activationEvents();
    expect(ev.data.activation_observed.slash).toBe('split');
    expect(ev.data.command_activation.split).toBe(true);
    // SELF-MATCH, documented rather than hidden: the router's `flag-split`
    // pattern matched the very `/split` the user typed, so this record agrees
    // with itself. It is a schema round trip, not evidence that the NL
    // classifier predicted anything.
    expect(ev.data.predicted_nl_match).toBe('flag-split');
  });

  it('records a non-activating slash with every activation key false', async () => {
    await submit({ prompt: '/implement add oauth login', sid: 'sess-act-c', pid: 'prompt-act-c' });

    const [ev] = activationEvents();
    expect(ev.data.activation_observed.slash).toBe('implement');
    expect(ev.data.command_activation)
      .toEqual({ autopilot: false, autopilot_fast: false, split: false });
    expect(ev.data.predicted_signal).toBe('config-default');
  });

  it('records a plain prompt with nothing predicted and nothing observed', async () => {
    await submit({
      prompt: 'explain how the router works',
      sid: 'sess-act-d',
      pid: 'prompt-act-d',
    });

    const [ev] = activationEvents();
    expect(ev.data.activation_observed).toEqual({});
    expect(ev.data.command_activation)
      .toEqual({ autopilot: false, autopilot_fast: false, split: false });
  });

  it('observes nothing for a NAMESPACED slash — a known gap, pinned', async () => {
    // `lib/mission/mission-id.js#detectSlashCommand` requires whitespace or end
    // after the command word, so `/artibot:split` returns null. The record is
    // still written; only the observed side is empty. If namespace support ever
    // lands, this assertion goes red and the reader learns why.
    await submit({ prompt: '/artibot:split status', sid: 'sess-act-e', pid: 'prompt-act-e' });

    const [ev] = activationEvents();
    expect(ev.data.activation_observed).toEqual({});
  });

  it('records nothing when the payload carries no session id', async () => {
    // Since 후속 12 안 B the session-less flush prints one stderr line; muted
    // here so the vitest console stays quiet.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const out = await submit({ prompt: '/split status', sid: null, pid: 'prompt-act-f' });
      expect(out).not.toBeNull();
    } finally {
      stderrSpy.mockRestore();
    }
    expect(activationEvents()).toHaveLength(0);
    // No date-bucket fallback: an absent session is counted as skipped, never
    // bucketed into a file that would make the store look alive.
    expect(existsSync(path.join(decisionStore(), `${UNATTRIBUTED_RUN_ID}.events.ndjson`)))
      .toBe(false);
  });

  it('still writes exactly one topology-recommended per prompt', async () => {
    // REGRESSION GUARD for the sibling recorder: the activation writer was
    // added next to it inside the same try, and a botched refactor could
    // duplicate or drop the topology record without any activation test noticing.
    await submit({
      prompt: '대규모 변경을 파일별로 병렬 처리해줘',
      sid: 'sess-act-g',
      pid: 'prompt-act-g',
    });
    expect(readSandboxDecisions().filter((e) => e.type === TOPOLOGY_RECOMMENDED))
      .toHaveLength(1);
  });

  it('never writes prompt text or slash arguments to disk', async () => {
    // PRIVACY. The record carries pattern ids and a command NAME, never the
    // prompt. Asserted on the RAW ndjson bytes, not on a parsed field, so a
    // leak into any other key of any other event is still caught.
    await submit({
      prompt: '대규모 변경을 파일별로 병렬 처리해줘',
      sid: 'sess-act-h1',
      pid: 'prompt-act-h1',
    });
    await submit({ prompt: '/split status', sid: 'sess-act-h2', pid: 'prompt-act-h2' });
    // The HINT path writes a second user-derived value; a YouTube URL is the
    // one hint input that carries user content, so it rides in this sweep too.
    await submit({ prompt: `이 영상 봐줘 ${YT}`, sid: 'sess-act-h3', pid: 'prompt-act-h3' });

    const raw = readSandboxLines();
    expect(raw.length).toBeGreaterThan(0);
    for (const line of raw) {
      for (const secret of ['대규모 변경', '파일별로', 'status', 'oauth', 'youtu', '이 영상']) {
        expect(line).not.toContain(secret);
      }
    }
  });

  it('measures the on-disk size of one activation record', async () => {
    await submit({
      prompt: '대규모 변경을 파일별로 병렬 처리해줘',
      sid: 'sess-act-k',
      pid: 'prompt-act-k',
    });
    const [line] = readSandboxLines().filter((l) => l.includes(`"${ACTIVATION_OBSERVED}"`));
    const bytes = Buffer.byteLength(line, 'utf-8');
    // Printed, not gated: this is a measurement for the storage-budget question,
    // and a byte-count assertion would go red on any harmless field rename.
    // eslint-disable-next-line no-console
    console.info(`[activation-wiring] one activation-observed line = ${bytes} B`);
    expect(bytes).toBeGreaterThan(0);
  });

  it('keeps the two OLDER writers alive when only the activation module is absent', async () => {
    // THE CASE THE INNER TRY/CATCH EXISTS FOR, and the one an all-lib-absent
    // sandbox cannot express. Before the inner catch, a failed
    // `activation-observed.js` import threw past `recordMemoryInjection`, so
    // adding the new writer would have SILENTLY REMOVED two pre-existing ones
    // on any tree that had not been updated yet.
    const partial = makeSandboxWithoutActivationModule('artibot-activation-partial-');
    // PRECONDITION: exactly one module is gone and its siblings are not. Without
    // this the assertions below could pass because the whole tree was broken.
    expect(existsSync(path.join(partial, 'lib', 'observability', 'decision-events.js'))).toBe(true);
    expect(existsSync(path.join(partial, 'lib', 'topology', 'topology-router.js'))).toBe(true);
    expect(existsSync(path.join(partial, 'lib', 'observability', 'activation-observed.js')))
      .toBe(false);

    process.env.CLAUDE_PLUGIN_ROOT = partial;
    try {
      const out = await handleUserPromptSubmit({
        user_prompt: '/split status',
        session_id: 'sess-act-partial',
        prompt_id: 'prompt-act-partial',
        event: 'UserPromptSubmit',
        cwd: partial,
      });
      expect(out).not.toBeNull();

      const store = path.join(partial, '.artibot', 'runtime', 'decisions');
      const events = readdirSync(store)
        .filter((f) => f.endsWith('.ndjson'))
        .flatMap((f) => readFileSync(path.join(store, f), 'utf-8').split('\n'))
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
      const countOf = (type) => events.filter((e) => e.type === type).length;

      expect(countOf(TOPOLOGY_RECOMMENDED)).toBe(1);
      expect(countOf(MEMORY_INJECTION_MEASURED)).toBe(1);
      expect(countOf(ACTIVATION_OBSERVED)).toBe(0);
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }
  });

  it('still returns output when the WHOLE lib tree is absent', async () => {
    // Point the root at a sandbox with NO lib/, so every dynamic import throws.
    // This covers the OUTER catch only — it says nothing about which writers
    // survive, because none of them can run. The case above is the one that
    // measures survival.
    const bare = mkdtempSync(path.join(tmpdir(), 'artibot-activation-bare-'));
    copyFileSync(REAL_CONFIG_PATH, path.join(bare, 'artibot.config.json'));
    mkdirSync(path.join(bare, '.git'), { recursive: true });
    process.env.CLAUDE_PLUGIN_ROOT = bare;
    try {
      const out = await handleUserPromptSubmit({
        user_prompt: '/implement add a feature',
        session_id: 'sess-act-import-fail',
        prompt_id: 'prompt-act-j',
        event: 'UserPromptSubmit',
        cwd: bare,
      });
      expect(out).not.toBeNull();
      expect(out.user_prompt).toContain('add a feature');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

/**
 * Minimal `prepared` envelope for the pure half — `composePromptParts` reads
 * only `userPrompt`, `message` and `context.tasks.meta.workflowPlan`.
 *
 * @param {{recommendation?: string|null, userPrompt?: string}} [o]
 * @returns {object}
 */
function preparedWith({ recommendation = null, userPrompt = 'do the thing' } = {}) {
  return {
    userPrompt,
    message: '[runtime] prompt prepared',
    context: { tasks: { meta: { workflowPlan: recommendation === null ? {} : { recommendation } } } },
  };
}

/** @param {object} o @returns {{output: object, shownHint: string|null}} */
function parts(o) {
  return composePromptParts({
    prepared: preparedWith(o),
    prompt: o.userPrompt ?? 'do the thing',
    effortMeta: null,
    taskBudgetDirective: '',
    injectPrompt: o.injectPrompt !== false,
  });
}

const YT = 'https://youtu.be/dQw4w9WgXcQ';

describe('shownHint is the hint the turn ACTUALLY showed (pure half)', () => {
  // WHY PURE. A `recommendation` reaches the plan only through the tasks
  // middleware's complexity classification, which no synthetic prompt can pin
  // deterministically. Injecting the plan is what makes the five-value table
  // and the precedence rule assertable at all; the two integration cases below
  // prove the same value survives the real pipeline to disk.
  for (const rec of ['split', 'autopilot', 'workflow']) {
    it(`reports ${rec} when the plan recommends it`, () => {
      const { output, shownHint } = parts({ recommendation: rec });
      expect(shownHint).toBe(rec);
      // SINGLE SOURCE: the value handed to the writer and the value the model
      // read off the directive are the same derivation. String-matching here is
      // the test's job — the production path never re-parses the directive.
      expect(output.hookSpecificOutput.additionalContext)
        .toContain(`[artibot:hint recommend=${rec}]`);
    });
  }

  it('reports watch when only a YouTube link is present', () => {
    const { output, shownHint } = parts({ userPrompt: `이 영상 봐줘 ${YT}` });
    expect(shownHint).toBe('watch');
    expect(output.hookSpecificOutput.additionalContext).toContain('recommend=watch');
  });

  it('prefers the recommendation when a rec and a watch hint both fire', () => {
    // The key is single-valued and `directives` emits the recommendation first,
    // so the FIRST hint the reader meets is the one recorded.
    const { output, shownHint } = parts({ recommendation: 'split', userPrompt: `${YT} 를 쪼개줘` });
    expect(shownHint).toBe('split');
    const ctx = output.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('[artibot:hint recommend=split]');
    expect(ctx).toContain('recommend=watch');
    expect(ctx.indexOf('recommend=split')).toBeLessThan(ctx.indexOf('recommend=watch'));
  });

  it('reports null when injectPrompt is off — nothing was shown to anyone', () => {
    const { output, shownHint } = parts({ recommendation: 'split', injectPrompt: false });
    expect(shownHint).toBeNull();
    expect(output.user_prompt).not.toContain('artibot:hint');
    expect(output.hookSpecificOutput).toBeUndefined();
  });

  it('reports null for a plain prompt', () => {
    expect(parts({}).shownHint).toBeNull();
  });
});

describe('the shown hint reaches the activation record', () => {
  it('writes both hint keys as null for a prompt with no hint', async () => {
    await submit({ prompt: 'explain how the router works', sid: 'sess-hint-a', pid: 'prompt-hint-a' });

    const [ev] = activationEvents();
    expect(ev.data.hint_recommend).toBeNull();
    expect(ev.data.hint_resolved_by).toBeNull();
  });

  it('records a YouTube prompt as watch/slash-map with the URL nowhere on disk', async () => {
    await submit({ prompt: `이 영상 봐줘 ${YT}`, sid: 'sess-hint-b', pid: 'prompt-hint-b' });

    const [ev] = activationEvents();
    expect(ev.data.hint_recommend).toBe('watch');
    expect(ev.data.hint_resolved_by).toBe('slash-map');
    // PRIVACY, on the RAW bytes: the hint value is a constant, and the URL that
    // produced it stays in memory. A leak into any key of any event is caught.
    for (const line of readSandboxLines()) {
      expect(line).not.toContain('youtu');
      expect(line).not.toContain('dQw4w9WgXcQ');
    }
  });

  it('measures the on-disk size of an activation record carrying a hint', async () => {
    await submit({ prompt: `이 영상 봐줘 ${YT}`, sid: 'sess-hint-c', pid: 'prompt-hint-c' });
    const [line] = readSandboxLines().filter((l) => l.includes(`"${ACTIVATION_OBSERVED}"`));
    // Printed, not gated — same reason as the sibling size case above.
    // eslint-disable-next-line no-console
    console.info(`[activation-wiring] one hint-carrying line = ${Buffer.byteLength(line, 'utf-8')} B`);
    expect(line).toContain('hint_recommend');
  });
});

describe('the NL-activation reporter can read what the hook wrote', () => {
  it('folds the four prompts into a measured slash-agreement axis', async () => {
    // END TO END, and the whole point of the limb: before this wiring the axis
    // read `0/0, ratio null, UNMEASURED`. The reporter is run as a CHILD
    // PROCESS against the sandbox root, exactly as an operator would run it.
    await submit({
      prompt: '대규모 변경을 파일별로 병렬 처리해줘',
      sid: 'sess-rep-a',
      pid: 'prompt-rep-a',
    });
    await submit({ prompt: '/split status', sid: 'sess-rep-b', pid: 'prompt-rep-b' });
    await submit({ prompt: '/implement add oauth login', sid: 'sess-rep-c', pid: 'prompt-rep-c' });
    await submit({
      prompt: 'explain how the router works',
      sid: 'sess-rep-d',
      pid: 'prompt-rep-d',
    });

    const res = spawnSync(process.execPath, [REPORTER_REL, '--project-root', sandboxRoot], {
      cwd: PLUGIN_ROOT,
      encoding: 'utf-8',
    });
    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout);

    // All four records are visible to the instrument.
    expect(report.stores.decisions.events_by_type[ACTIVATION_OBSERVED]).toBe(4);

    const slash = report.axes.find((a) => a.axis === 'activation.slash-agreement');
    // Denominator = records with ≥1 true activation key: the NL split phrase and
    // `/split`. The `/implement` and plain prompts predict nothing, so they are
    // correctly absent from the denominator rather than counted as misses.
    expect(slash.denominator).toBe(2);
    // Numerator = the one record whose observed slash is a predicted true key.
    expect(slash.numerator).toBe(1);
    expect(slash.ratio).toBe(0.5);
    // The note must have FLIPPED: a denominator > 0 means the reporter no longer
    // claims nobody looked. A stale UNMEASURED sentence on a row carrying real
    // numbers is exactly the frozen claim that report exists to avoid.
    expect(slash.note).not.toContain('UNMEASURED');

    // The hint axis is Wave 13 and is still honestly unmeasured. Pinned so that
    // landing the slash writer cannot be mistaken for landing both.
    const hint = report.axes.find((a) => a.axis === 'activation.hint-acceptance');
    expect(hint.numerator).toBe(0);
    expect(hint.denominator).toBe(0);
    expect(hint.ratio).toBeNull();
    expect(hint.note).toContain('UNMEASURED');
  });
});
