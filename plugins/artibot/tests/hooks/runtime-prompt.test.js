import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAdditionalContext, handleUserPromptSubmit, PROTECTED_BLOCK_MARKERS, stripRouterWrapper,
} from '../../scripts/hooks/runtime-prompt.js';

/**
 * runtime-prompt hook — in-process contract test.
 *
 * Historically this suite spawned the hook as a child process with
 * `execFileSync`, which inadvertently relied on the script's `isMain`
 * guard succeeding. That guard percent-decodes `process.argv[1]` and
 * compares against `new URL(import.meta.url).pathname` — the latter is
 * percent-encoded on paths with non-ASCII characters (e.g. Korean
 * `바탕 화면`), so `main()` never ran and stdout came back empty.
 *
 * The hook exports `handleUserPromptSubmit` precisely for in-process
 * callers (the userprompt dispatcher uses it too). Driving the contract
 * through the export removes the spawn/path-encoding flake, runs ~10x
 * faster, and keeps the assertions identical.
 */

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

/**
 * SETUP-ONLY ISOLATION (assertions and fixtures below are untouched).
 *
 * This suite used to point `CLAUDE_PLUGIN_ROOT` at the REAL plugin root, so
 * running it mutated the developer's live `runtime/` — `token-usage-session.json`
 * on every run, and (once the recorder-stats flush landed) a line in the real
 * decision store that `/doctor` reads. Writing fixture data into the
 * store a health check reads is worse than recording nothing.
 *
 * The sandbox LINKS the real `lib/`, `commands/`, `skills/` and `agents/` and
 * copies the real `artibot.config.json`, so the hook still resolves the REAL
 * modules and the REAL config — the runtime path these tests exercise is
 * unchanged. Only the writable `runtime/` directory is redirected.
 *
 * Links, not copies: a sandbox missing the modules would send every dynamic
 * import into its catch block, and the dual-path assertions below (which accept
 * the in-script fallback) would then pass for the wrong reason.
 */
const LINKED_DIRS = ['lib', 'commands', 'skills', 'agents'];

let sandboxRoot = '';
let savedEnv;

/** @returns {string} a fresh sandbox plugin root (see the block comment above) */
function makeSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'artibot-runtime-prompt-'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dir of LINKED_DIRS) {
    symlinkSync(path.join(PLUGIN_ROOT, dir), path.join(root, dir), linkType);
  }
  copyFileSync(
    path.join(PLUGIN_ROOT, 'artibot.config.json'),
    path.join(root, 'artibot.config.json'),
  );
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  // The decision store is anchored on the PROJECT root, not CLAUDE_PLUGIN_ROOT
  // (`decision-events.js#getDecisionStoreDir`), so redirecting the plugin root
  // alone no longer keeps this suite out of the real store. A `.git` marker
  // makes `lib/git/project-root.js#resolveProjectRoot` stop at the sandbox, and
  // the payloads below carry `cwd: sandboxRoot` so the hook resolves from here.
  mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

beforeAll(() => {
  sandboxRoot = makeSandbox();
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
});

describe('runtime-prompt hook', () => {
  it('returns null when prompt payload is missing', async () => {
    const output = await handleUserPromptSubmit({ other: 'value' });
    expect(output).toBeNull();
  });

  it('consumes a prompt already rewritten by user-prompt-handler', async () => {
    const output = await handleUserPromptSubmit({
      user_prompt: 'CRITICAL RE-VERIFICATION MODE ACTIVATED.\nCLAIM AUDIT\nEVIDENCE CHECK',
      event: 'UserPromptSubmit', cwd: sandboxRoot,
    });

    expect(output).not.toBeNull();
    expect(output.message).toContain('[runtime]');
    // The rewritten text still flows through the pipeline (internal surface)…
    expect(output.user_prompt).toContain('CRITICAL RE-VERIFICATION MODE ACTIVATED.');
    // …but this hook does NOT echo the prompt body into the host channel. The
    // `!rv` protocol reaches the model from user-prompt-handler's own
    // additionalContext (design §2.1 A), not from here.
    const ctx = output.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).not.toContain('CRITICAL RE-VERIFICATION MODE ACTIVATED.');
  });

  it('emits the runtime envelope on the host channel, without the prompt body', async () => {
    const output = await handleUserPromptSubmit({
      user_prompt: 'fix typo in readme',
      event: 'UserPromptSubmit', cwd: sandboxRoot,
    });

    expect(output).not.toBeNull();
    const ctx = output.hookSpecificOutput?.additionalContext ?? '';
    // The routing verdict survives the move, as a directive rather than as the
    // 'System N mode: … / Original request:' prompt wrapper the host ignores.
    expect(ctx).toMatch(/^\[artibot:route system[12]\] /);
    expect(ctx).not.toContain('Original request:');
    expect(ctx).not.toContain('fix typo in readme');
  });

  it('rewrites a simple prompt through the Phase 1 runtime path', async () => {
    const output = await handleUserPromptSubmit({
      user_prompt: 'fix typo in readme',
      event: 'UserPromptSubmit', cwd: sandboxRoot,
    });

    // Accept both the real runtime path (returns `route=SYSTEM1`) and the
    // in-script fallback (returns `[runtime] SYSTEM1 | fallback`). The
    // fallback triggers in fresh-checkout environments (CI) where the full
    // runtime state cache isn't populated. Both paths correctly classify
    // "fix typo" as SYSTEM1.
    expect(output).not.toBeNull();
    expect(output.message).toContain('[runtime]');
    expect(output.message).toMatch(/route=SYSTEM1|SYSTEM1\s*\|\s*fallback/);
    expect(output.user_prompt).toContain('fix typo in readme');
  });

  // 호스트 2.1.259 스키마 형태 — 회귀 방지.
  // 이 훅이 라이브에서 죽어 있던 형태가 정확히 이것이다: 페이로드에 `user_prompt` 가
  // 없고 `prompt` 만 있는데, 훅은 `user_prompt`/`content` 만 읽어 매번 null 을 반환했다.
  // 위 케이스들은 전부 `user_prompt` 픽스처라 그 상태에서도 green 이었다.
  it('prepares the envelope from the host `prompt` key alone (no user_prompt)', async () => {
    const output = await handleUserPromptSubmit({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'fix typo in readme',
      session_id: '9120048e-3385-4855-a35b-09c89e5dd684',
      cwd: sandboxRoot,
    });

    expect(output).not.toBeNull();
    expect(output.message).toContain('[runtime]');
    expect(output.user_prompt).toContain('fix typo in readme');
  });

  it('rewrites a complex prompt through the Phase 1 runtime path', async () => {
    const output = await handleUserPromptSubmit({
      user_prompt: 'analyze security vulnerabilities, then refactor auth flow, then deploy to production',
      event: 'UserPromptSubmit', cwd: sandboxRoot,
    });

    // Same dual-path acceptance as the SYSTEM1 test above.
    expect(output).not.toBeNull();
    expect(output.message).toContain('[runtime]');
    expect(output.message).toMatch(/route=SYSTEM2|SYSTEM2\s*\|\s*fallback/);
    expect(output.user_prompt).toContain('analyze security vulnerabilities');
  });
});
/** 8,000 B — `ADDITIONAL_CONTEXT_MAX_BYTES`, module-private, so it is restated here. */
const CAP_BYTES = 8000;

describe('buildAdditionalContext — 8 KB cap', () => {
  it('leaves an envelope under the cap byte-identical', () => {
    const ctx = buildAdditionalContext(['[artibot:effort level=high]'], 'body');
    expect(ctx).toBe('[artibot:effort level=high]\n\nbody');
  });

  it('truncates an oversized envelope to the cap', () => {
    const ctx = buildAdditionalContext([], 'x'.repeat(CAP_BYTES * 2));
    expect(Buffer.byteLength(ctx, 'utf-8')).toBeLessThanOrEqual(CAP_BYTES);
    expect(ctx.length).toBeGreaterThan(0);
  });

  it('never cuts an astral character in half', () => {
    // REGRESSION, measured 2026-09-04 (independent review). The cap walks the
    // string 64 CODE UNITS at a time, but JS strings are UTF-16 and an emoji is
    // two units — so the cut landed between a surrogate pair and left a lone
    // high surrogate (0xd83d) as the final unit. `JSON.stringify` emits that
    // happily, and the host then receives an ill-formed string.
    //
    // FIXTURE MUST REACH THE FAILURE REGION: the payload has to be astral AND
    // long enough to actually trip the cap, and the pre-fix cut must land on an
    // ODD unit offset. The trailing 'a' is what makes it odd — drop it, or swap
    // the emoji for ASCII, and this test goes vacuous.
    const body = '\u{1F680}'.repeat(2100) + 'a';
    expect(body.length % 2, 'fixture must put the cut on an odd unit offset').toBe(1);

    const ctx = buildAdditionalContext([], body);

    // NECESSARY: the cap really fired, so the repair path was exercised.
    expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(CAP_BYTES);
    expect(Buffer.byteLength(ctx, 'utf-8')).toBeLessThanOrEqual(CAP_BYTES);

    // The defect, stated three ways so a partial fix cannot pass.
    expect(ctx.isWellFormed()).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(ctx)).toBe(false);
    // And it survives the JSON round-trip the dispatcher actually performs.
    expect(JSON.parse(JSON.stringify(ctx))).toBe(ctx);
  });

  it('leaves a well-formed astral string alone when it fits', () => {
    // NEGATIVE CONTROL: the repair must not shave a character off output that
    // never needed cutting.
    const body = '\u{1F680}'.repeat(10);
    expect(buildAdditionalContext([], body)).toBe(body);
  });
});

/**
 * Directive blocks the pipeline appends after the prompt body — the CA-15
 * question-gate (`tasks.js#applyQuestionGateDirective`) and the agentTeam
 * Execution contract (`tasks.js#createTasksMiddleware`). Copied from those
 * appends; the last describe below cross-pins them against the real output.
 */
const WRAP = 'System 2 mode: deliberate\nOriginal request:\n';
const ROUTE = '[artibot:route system2] deliberate';
const EXEC = '\n\nExecution contract:\n- Create a plan first.\n- Execute in clear phases.\n- Validate before final answer.';
const GATE = [
  '\n\n[artibot:question-gate required kind=product_decision at=adr_start]',
  'This is a product decision the evidence cannot settle, and a wrong assumption is costly.',
  'Do not assume an answer: ASK the user, in ONE batch of questions, before starting the work.',
].join('\n');
const MEMORY = '\n\nRelevant memory context:\n- ';
const GUARD = '\n\n⚠️ Guardrail: tools denied by policy — Bash';

describe('stripRouterWrapper — directive blocks on the unrecoverable-body path', () => {
  // The body does not match `originalPrompt`, so the recovery anchors on the
  // appended-block markers. Before the fix these had no memory/guardrail
  // marker to anchor on and the whole tail was dropped ('').
  it.each([
    ['the question-gate block', GATE],
    ['the Execution contract block', EXEC],
    ['both blocks, in pipeline order', EXEC + GATE],
    ['both blocks, ahead of a guardrail block', EXEC + GATE + GUARD],
  ])('keeps %s and still drops the prompt text', (_name, blocks) => {
    const env = stripRouterWrapper(`${WRAP}rewritten body${blocks}`, 'not the body');
    expect(env).toBe(`${ROUTE}${blocks}`);
  });

  it('is unchanged for a tail with no directive block (byte invariance)', () => {
    expect(stripRouterWrapper(`${WRAP}rewritten body`, 'x')).toBe(ROUTE);
    expect(stripRouterWrapper(`${WRAP}rewritten body${GUARD}`, 'x')).toBe(`${ROUTE}${GUARD}`);
    expect(stripRouterWrapper(`${WRAP}body${MEMORY}m${GUARD}`, 'x')).toBe(`${ROUTE}${MEMORY}m${GUARD}`);
  });
});

describe('buildAdditionalContext — the cap cuts memory, not directive blocks', () => {
  const HEAD = '[artibot:effort level=high]';

  it('keeps the directive blocks whole and cuts the memory block past 8 KB', () => {
    const env = `${ROUTE}${MEMORY}${'m'.repeat(9000)}${EXEC}${GATE}`;
    expect(Buffer.byteLength(env, 'utf-8'), 'fixture must trip the cap').toBeGreaterThan(CAP_BYTES);

    const ctx = buildAdditionalContext([HEAD], env);

    expect(Buffer.byteLength(ctx, 'utf-8')).toBeLessThanOrEqual(CAP_BYTES);
    expect(ctx.endsWith(`m${EXEC}${GATE}`)).toBe(true);
    expect(ctx.startsWith(`${HEAD}\n\n${ROUTE}${MEMORY}mmm`)).toBe(true);
    expect(ctx.isWellFormed()).toBe(true);
  });

  it('keeps the surrogate repair on the cut memory block', () => {
    // Same odd-offset construction as the astral regression above, moved into
    // the memory block so the cut lands there and not in the kept tail.
    const env = `${ROUTE}${MEMORY}${'\u{1F680}'.repeat(2100)}a${GATE}`;
    const ctx = buildAdditionalContext([], env);

    expect(Buffer.byteLength(ctx, 'utf-8')).toBeLessThanOrEqual(CAP_BYTES);
    expect(ctx.endsWith(GATE)).toBe(true);
    expect(ctx.isWellFormed()).toBe(true);
    expect(JSON.parse(JSON.stringify(ctx))).toBe(ctx);
  });

  it('still cuts from the end when no directive block is present (byte invariance)', () => {
    const env = `${ROUTE}${MEMORY}${'m'.repeat(9000)}${GUARD}`;
    const joined = `${HEAD}\n\n${env}`;
    const ctx = buildAdditionalContext([HEAD], env);
    // The pre-fix algorithm: strip 64 code units at a time off the end.
    let expected = joined;
    while (Buffer.byteLength(expected, 'utf-8') > CAP_BYTES) expected = expected.slice(0, -64);
    expect(ctx).toBe(expected);
  });
});

describe('directive markers — cross-pin against the real pipeline output', () => {
  /** Carries a cue for all four question-gate conditions (tasks-compile-mission.test.js). */
  const ALL_FOUR = 'Which should we pick for the public API contract? It is a '
    + 'product decision with no right answer, and a wrong call is costly rework.';
  const COMPLEX = 'analyze security vulnerabilities, then refactor auth flow, then deploy to production';
  let gateRoot = '';

  beforeAll(() => {
    gateRoot = makeSandbox();
    const cfgPath = path.join(gateRoot, 'artibot.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    cfg.runtime = { ...cfg.runtime, questionGate: { enforce: true } };
    writeFileSync(cfgPath, JSON.stringify(cfg));
  });

  afterAll(() => {
    if (gateRoot) rmSync(gateRoot, { recursive: true, force: true });
  });

  it('every marker is the head of a block the pipeline really appends', async () => {
    process.env.CLAUDE_PLUGIN_ROOT = gateRoot;
    // ALL_FOUR fires the gate; the multi-step prompt routes agentTeam (Execution contract).
    // Sequential: the hook writes runtime/current-effort.json before it reads it.
    const outputs = [];
    for (const user_prompt of [ALL_FOUR, COMPLEX]) {
      outputs.push(await handleUserPromptSubmit({ user_prompt, event: 'UserPromptSubmit', cwd: gateRoot }));
    }

    for (const marker of PROTECTED_BLOCK_MARKERS) {
      const output = outputs.find((o) => o.user_prompt.includes(marker));
      expect(output, `pipeline output lacks ${JSON.stringify(marker)}`).toBeDefined();
      const envelope = output.user_prompt;
      const ctx = output.hookSpecificOutput?.additionalContext ?? '';
      // The block (marker to the next blank line) reaches the host channel verbatim.
      const block = envelope.slice(envelope.indexOf(marker)).split('\n\n')[1];
      expect(ctx).toContain(`\n\n${block}`);
    }
  });
});
