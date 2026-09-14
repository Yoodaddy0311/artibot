/**
 * Ruling gate — `scripts/hooks/auto-team-trigger.js` is the THIRD routing
 * producer in a UserPromptSubmit turn (it runs in the same dispatcher batch as
 * runtime-prompt, `scripts/hooks/_userprompt-dispatcher.js#runUserPromptSubmit`)
 * and is EXCLUDED from the plan/mode mismatch denominator. The rationale is
 * pinned in that hook's `evaluatePrompt` JSDoc; this file pins that the code
 * still matches the rationale.
 *
 * WHAT THIS GATE CANNOT SEE: it does not measure whether the hook's
 * `[auto-team-suggested]` hint AGREES with the plan the middleware built. It
 * only proves the hook has no plan/mode surface to disagree on. "Suggestion
 * fired vs plan.trigger.fired" is a different measurement, and this suite stays
 * green whatever that agreement rate turns out to be — do not read a pass here
 * as evidence the hook and the planner concur.
 *
 * WHY THE SCAN IS RAW-SOURCE: the forbidden-symbol scan below reads the hook
 * file verbatim, comments included. So the ruling comment in the hook refers to
 * the plan builder and the decisions-store recorder in prose instead of naming
 * them. Adding a literal symbol name to that comment is what will fail this
 * test — the fix is to keep the prose, not to loosen the scan (a
 * comment-stripping scan would have to parse this hook's regex literals, which
 * contain `/` and would mis-tokenise).
 */

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluatePrompt } from '../../scripts/hooks/auto-team-trigger.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK_PATH = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'auto-team-trigger.js');
const PRODUCER_PATH = path.join(PLUGIN_ROOT, 'lib', 'runtime', 'middleware', 'tasks.js');

const RULING_MARKER = 'THIRD PRODUCER — EXCLUDED FROM THE plan/mode MISMATCH DENOMINATOR';

/**
 * Symbols that mark a real plan/mode producer. Presence of any of these in the
 * hook would mean the hook DOES have a plan or a mode, and the exclusion ruling
 * would no longer hold.
 */
const PRODUCER_SYMBOLS = ['buildWorkflowPlan', 'recordWorkflowPlanDecision', 'decision-events', 'task.mode'];

const hookSource = readFileSync(HOOK_PATH, 'utf-8');
const producerSource = readFileSync(PRODUCER_PATH, 'utf-8');

describe('auto-team-trigger — excluded from the plan/mode mismatch denominator', () => {
  it('POSITIVE CONTROL: the same scan finds the producer symbols in the real producer', () => {
    // Without this, an all-absent result below is indistinguishable from a scan
    // that reads nothing (wrong path, empty file, typo'd needle).
    expect(producerSource.length).toBeGreaterThan(1000);
    expect(producerSource).toContain('buildWorkflowPlan');
    expect(producerSource).toContain('recordWorkflowPlanDecision');
  });

  it('the hook references no plan/mode producer symbol', () => {
    expect(hookSource.length).toBeGreaterThan(1000);
    const found = PRODUCER_SYMBOLS.filter((symbol) => hookSource.includes(symbol));
    expect(found).toEqual([]);
  });

  it('the hook imports only the shared trigger evaluator from the planner module', () => {
    // It is allowed to reach into workflow-plan.js — but only for
    // `evaluateTrigger`, which returns a fired/reasons decision and no mode.
    const imports = hookSource.match(/^import[\s\S]*?from '[^']+';$/gm) ?? [];
    const plannerImports = imports.filter((line) => line.includes('workflow-plan.js'));
    expect(plannerImports).toHaveLength(1);
    expect(plannerImports[0]).toContain('evaluateTrigger');
  });

  it('carries the ruling marker so the exclusion cannot be silently dropped', () => {
    expect(hookSource).toContain(RULING_MARKER);
  });

  it('evaluatePrompt yields a reason string or null — never a plan or a mode', () => {
    const fired = evaluatePrompt(
      'refactor the frontend components and migrate the database schema and write tests for the api',
      {},
    );
    expect(typeof fired).toBe('string');
    expect(fired).not.toContain('mode');

    const notFired = evaluatePrompt('hi', {});
    expect(notFired).toBeNull();
  });
});
