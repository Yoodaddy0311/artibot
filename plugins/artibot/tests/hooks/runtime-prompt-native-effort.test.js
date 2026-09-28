/**
 * TODO #30806 — native effort PRODUCER wiring in runtime-prompt.js.
 *
 * runtime-prompt is a UserPromptSubmit hook, so per code.claude.com/docs/en/
 * hooks.md the stdin `effort.level` field is NOT delivered to it — the operative
 * native source is the inherited `$CLAUDE_EFFORT` env var (the producer reads
 * both via lib/cognitive/native-effort.js#resolveNativeEffort).
 *
 * Split of concerns (kept deterministic, no shared-process-env flakiness):
 *   - Producer + precedence (stdin>env>heuristic) + normalization + router
 *     override are proven with INJECTED env/payload in
 *     tests/cognitive/native-effort.test.js.
 *   - CONSUMER wiring is proven HERE against the pure, exported
 *     composePromptOutput(): a native-overridden effortMeta (the exact shape
 *     resolveEffortMeta emits when the native band wins, reason='native-effort')
 *     must flow into BOTH the injected directive and the hook message; and an
 *     absent override must leave the heuristic effortMeta intact (regression-0).
 *
 * composePromptOutput is a pure function of its args (no env, no I/O, no dynamic
 * import), so these assertions are race-free under vitest's pooled workers.
 *
 * R3 (2026-09-28) adds ONE in-process integration block at the bottom: the real
 * handleUserPromptSubmit against a linked sandbox root (pattern of
 * runtime-prompt-effort-order.test.js), with the native env vars set per test
 * and restored after. It pins that the effort the tasks middleware accepts and
 * the workflow plan's parent effort are the same value.
 */

import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { composePromptOutput, handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';
import { NATIVE_EFFORT_ENV_VARS } from '../../lib/cognitive/native-effort.js';
import { readEffortRecord } from '../../lib/runtime/task-budget.js';

/** See runtime-prompt-team-inject.test.js — the host reads only this field. */
const ctxOf = (out) => out.hookSpecificOutput?.additionalContext ?? '';

/** Minimal prepared envelope (composePromptOutput only reads these fields). */
const prepared = { userPrompt: '/implement add oauth login', message: '[runtime] prompt prepared' };

describe('runtime-prompt — native effort override propagation (#30806)', () => {
  it('(a) a native-overridden effortMeta surfaces in the directive AND message', () => {
    // Shape produced by resolveEffortMeta when the native band wins: the
    // heuristic baseline is preserved but `effort` is the native band and the
    // reason flips to 'native-effort'. Here /implement's xhigh baseline is
    // overridden DOWN to low by a native signal.
    const effortMeta = {
      command: 'implement', effort: 'low', baseline: 'xhigh', shift: 0, reason: 'native-effort',
    };
    const out = composePromptOutput({
      prepared, prompt: prepared.userPrompt, effortMeta, taskBudgetDirective: '', injectPrompt: true,
    });
    // Directive reflects the native band, not the xhigh baseline — asserted on
    // the channel the host actually delivers (design §4.4).
    expect(ctxOf(out)).toMatch(/^\[artibot:effort level=low command=implement\]/);
    // Message reflects it too (this field is emitted regardless of injectPrompt).
    expect(out.message).toContain('cmd=/implement effort=low');
  });

  it('(a) native override UP (low baseline → max) also propagates', () => {
    const effortMeta = {
      command: 'update', effort: 'max', baseline: 'low', shift: 0, reason: 'native-effort',
    };
    const out = composePromptOutput({
      prepared: { userPrompt: '/update', message: '[runtime] prepared' },
      prompt: '/update', effortMeta, taskBudgetDirective: '', injectPrompt: true,
    });
    expect(ctxOf(out)).toMatch(/^\[artibot:effort level=max command=update\]/);
    expect(out.message).toContain('cmd=/update effort=max');
  });

  it('(b) regression-zero: a heuristic effortMeta (no override) is unchanged', () => {
    // When the producer returns null, resolveEffortMeta leaves effortMeta as the
    // heuristic result (reason != native-effort). composePromptOutput must emit
    // that band verbatim — proving the override path adds nothing when dormant.
    const effortMeta = {
      command: 'implement', effort: 'xhigh', baseline: 'xhigh', shift: 0, reason: 'baseline',
    };
    const out = composePromptOutput({
      prepared, prompt: prepared.userPrompt, effortMeta, taskBudgetDirective: '', injectPrompt: true,
    });
    expect(ctxOf(out)).toMatch(/^\[artibot:effort level=xhigh command=implement\]/);
    expect(out.message).toContain('cmd=/implement effort=xhigh');
    expect(out.message).not.toContain('native-effort');
  });

  it('(b) no effortMeta at all → no effort directive, base message preserved', () => {
    const out = composePromptOutput({
      prepared, prompt: prepared.userPrompt, effortMeta: null, taskBudgetDirective: '', injectPrompt: true,
    });
    expect(ctxOf(out)).not.toMatch(/\[artibot:effort/);
    expect(out.message).toBe('[runtime] prompt prepared');
  });
});

// ---------------------------------------------------------------------------
// R3 — one parent effort on the real hook path. Codex repro (2026-09-28): with
// CLAUDE_EFFORT=max the persisted task effort was `max` (reason native-effort)
// while `workflowPlan.effort` was `xhigh`, because the plan re-derived the
// parent from the static command map.
//
// WHAT THIS CANNOT SEE: `task.meta` itself never leaves the hook. The two sides
// are read where the hook leaves them — the accepted effort through the SAME
// reader the tasks middleware uses (`readEffortRecord`, same session + prompt),
// and the plan's effort from its `workflow-planned` decision row. A plan that
// was attached to `task.meta` but recorded differently would not be caught.
// ---------------------------------------------------------------------------
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LINKED_DIRS = ['lib', 'commands', 'skills', 'agents'];
const REPRO_PROMPT = '/implement add oauth login with tests and a security review of the token flow';

describe('runtime-prompt — accepted effort and workflow plan agree (R3)', () => {
  let sandboxRoot = '';
  let savedEnv;

  beforeAll(() => {
    sandboxRoot = mkdtempSync(path.join(tmpdir(), 'artibot-r3-effort-'));
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    for (const dir of LINKED_DIRS) {
      symlinkSync(path.join(PLUGIN_ROOT, dir), path.join(sandboxRoot, dir), linkType);
    }
    copyFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), path.join(sandboxRoot, 'artibot.config.json'));
    mkdirSync(path.join(sandboxRoot, 'runtime'), { recursive: true });
    mkdirSync(path.join(sandboxRoot, 'home'), { recursive: true });
    // `.git` marker: the decision store resolves to THIS root, not the repo's.
    mkdirSync(path.join(sandboxRoot, '.git'), { recursive: true });
  });

  afterAll(() => {
    if (sandboxRoot) rmSync(sandboxRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    const keys = [
      'CLAUDE_PLUGIN_ROOT', 'HOME', 'USERPROFILE',
      'ARTIBOT_RUNTIME_CHECKPOINT_DISABLE', 'ARTIBOT_RUNTIME_MEMORY_DISABLE',
      ...NATIVE_EFFORT_ENV_VARS,
    ];
    savedEnv = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    // The host session running this suite may export its own effort band.
    for (const k of NATIVE_EFFORT_ENV_VARS) delete process.env[k];
    process.env.CLAUDE_PLUGIN_ROOT = sandboxRoot;
    process.env.HOME = path.join(sandboxRoot, 'home');
    process.env.USERPROFILE = path.join(sandboxRoot, 'home');
    process.env.ARTIBOT_RUNTIME_CHECKPOINT_DISABLE = '1';
    process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE = '1';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** @returns {object[]} `workflow-planned` rows written for `sessionId`. */
  function plannedRows(sessionId) {
    const store = path.join(sandboxRoot, '.artibot', 'runtime', 'decisions');
    if (!existsSync(store)) return [];
    return readdirSync(store)
      .filter((f) => f.endsWith('.ndjson') && f.includes(sessionId))
      .flatMap((f) => readFileSync(path.join(store, f), 'utf-8').split('\n').filter((l) => l.trim()))
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'workflow-planned');
  }

  /** Fire the repro prompt and return both sides of the comparison. */
  async function fire(sessionId, nativeBand) {
    if (nativeBand) process.env.CLAUDE_EFFORT = nativeBand;
    const promptId = `${sessionId}-p1`;
    const output = await handleUserPromptSubmit({
      user_prompt: REPRO_PROMPT, event: 'UserPromptSubmit',
      session_id: sessionId, prompt_id: promptId, cwd: sandboxRoot,
    });
    const accepted = readEffortRecord(sandboxRoot, { sessionId, promptId });
    const rows = plannedRows(sessionId);
    return { output, accepted, rows };
  }

  it('runs against a sandbox that carries the linked modules', () => {
    // NEGATIVE CONTROL: without the links every dynamic import falls into its
    // catch block and no plan row is written — a vacuous "no disagreement".
    for (const dir of LINKED_DIRS) expect(existsSync(path.join(sandboxRoot, dir))).toBe(true);
    expect(existsSync(path.join(sandboxRoot, 'lib', 'runtime', 'middleware', 'workflow-mode.js'))).toBe(true);
  });

  it.each([
    ['max', 'native UP from the /implement baseline'],
    ['low', 'native DOWN from the /implement baseline'],
  ])('CLAUDE_EFFORT=%s (%s): the plan parent effort is the accepted effort', async (band) => {
    const sessionId = `sess-r3-native-${band}`;
    const { output, accepted, rows } = await fire(sessionId, band);

    expect(accepted).toMatchObject({ effort: band, reason: 'native-effort' });
    // Not anchored: a team plan puts `[artibot:team …]` ahead of this directive.
    expect(output.hookSpecificOutput?.additionalContext)
      .toContain(`[artibot:effort level=${band} command=implement]`);
    expect(rows).toHaveLength(1);
    expect(rows[0].data.effort).toBe(accepted.effort);

    // Teammates rendered by buildTeamDirective stay inside [parent−1, parent].
    // Before R3 this prompt rendered [xhigh, high, high] under BOTH max and low
    // (measured 2026-09-28) — a low leader with xhigh teammates. The repro
    // prompt elects a team under the shipped config; if that ever stops, this
    // goes red rather than checking an empty list.
    const ladder = ['low', 'medium', 'high', 'xhigh', 'max'];
    const team = (output.hookSpecificOutput?.additionalContext ?? '').match(
      /^\[artibot:team runner=team teammates=(\d+)\]((?:\[artibot:effort level=\w+\]|\[artibot:task-budget max_tokens=\d+\])*)/,
    );
    expect(team).not.toBeNull();
    const efforts = [...team[2].matchAll(/\[artibot:effort level=(\w+)\]/g)].map((m) => m[1]);
    expect(efforts).toHaveLength(Number(team[1]));
    const p = ladder.indexOf(band);
    for (const e of efforts) expect(ladder.indexOf(e)).toBeGreaterThanOrEqual(Math.max(0, p - 1));
    for (const e of efforts) expect(ladder.indexOf(e)).toBeLessThanOrEqual(p);
  });

  it('a config that fails to parse still yields the max budget directive (hook defaults carry max)', async () => {
    // The tasks middleware and the task-budget CLI recompute the budget with
    // `getTaskBudgetForEffort(effort, <raw config>)`, which falls back to
    // task-budget.js's DEFAULT_BUDGET_MAP (max 200000) when the config has no
    // map. The hook falls back to `loadRuntimeConfig`'s own defaults instead;
    // a defaults map without `max` meant NO budget directive for effort=max
    // while the other readers said 200000 — two answers in one session.
    const cfgPath = path.join(sandboxRoot, 'artibot.config.json');
    const original = readFileSync(cfgPath);
    writeFileSync(cfgPath, '{ "runtime": { "effort": ');
    try {
      const { output } = await fire('sess-r3-broken-config', 'max');
      expect(output.hookSpecificOutput?.additionalContext)
        .toContain('[artibot:effort level=max command=implement][artibot:task-budget max_tokens=200000]');
    } finally {
      writeFileSync(cfgPath, original);
    }
  });

  it('with no native signal the plan still takes the accepted (score-aware) band', async () => {
    const sessionId = 'sess-r3-no-native';
    const { accepted, rows } = await fire(sessionId, null);

    expect(accepted?.reason).not.toBe('native-effort');
    expect(rows).toHaveLength(1);
    expect(rows[0].data.effort).toBe(accepted.effort);
  });
});
