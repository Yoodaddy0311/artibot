/**
 * T-37 — memory-injection instrumentation, and the MEASURED reason it is not a
 * ledger `context.compiled` receipt.
 *
 * WHAT THIS SUITE CANNOT SEE (stated next to the gate, so the gate cannot
 * become the next false assurance):
 *
 *  1. It does not prove any real prompt gets memory injected. The live case
 *     below asserts that a measurement was RECORDED, not that `injected` is
 *     true — whether the memory store has hits depends on the developer's own
 *     memory files, and asserting a value that varies per machine would be a
 *     test that passes for the wrong reason.
 *  2. It does not test the measurement itself. `measureMemoryInjection` and
 *     both recorders live in lib/observability/decision-events.js and are
 *     covered by tests/observability/decision-events-t37.test.js. What is left
 *     here is only the LIVE path: the hook runs, and an event appears.
 *  3. `approx_tokens_chars_div4` is chars/4. It is NOT a tokenizer count and no
 *     assertion here compares it to one. Its error against a real tokenizer is
 *     unmeasured.
 *  4. Nothing here detects drift in `MEMORY_BLOCK_HEAD`. If memory.js changes
 *     the marker it prepends, these stay green while the instrumentation
 *     silently reports `injected:false` on every prompt forever.
 *  5. The ledger cases measure THIS repository's allowlist and receipt schema at
 *     the time they run. They are a tripwire on the decision, not a claim about
 *     any other deployment. They also do not prove the hook never writes to the
 *     ledger — only that it would be refused if it tried.
 */

import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, symlinkSync,
} from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleUserPromptSubmit } from '../../scripts/hooks/runtime-prompt.js';
import {
  MEMORY_BLOCK_HEAD,
  MEMORY_INJECTION_MEASURED,
} from '../../lib/observability/decision-events.js';
import { writeEvent } from '../../lib/runtime/event-writer.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_CONFIG_PATH = path.join(PLUGIN_ROOT, 'artibot.config.json');
const LINKED_DIRS = ['lib', 'commands', 'skills', 'agents'];

let sandboxRoot = '';
let savedEnv;

beforeAll(() => {
  sandboxRoot = mkdtempSync(path.join(tmpdir(), 'artibot-t37-memory-'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dir of LINKED_DIRS) {
    symlinkSync(path.join(PLUGIN_ROOT, dir), path.join(sandboxRoot, dir), linkType);
  }
  copyFileSync(REAL_CONFIG_PATH, path.join(sandboxRoot, 'artibot.config.json'));
  mkdirSync(path.join(sandboxRoot, 'runtime'), { recursive: true });
  // The decision store hangs off the PROJECT root now, and the project root is
  // resolved by `lib/git/project-root.js#resolveProjectRoot`, whose first rule
  // is "nearest ancestor holding .git". Planting one here pins the sandbox as
  // its own root: without it the walk climbs out of tmpdir and could land on
  // whatever ancestor happens to carry a weak marker, which is how this suite
  // would silently write fixture lines into the real repository store.
  mkdirSync(path.join(sandboxRoot, '.git'), { recursive: true });
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
  // Memory deliberately LEFT ENABLED here — this suite is about the memory path.
  delete process.env.ARTIBOT_RUNTIME_MEMORY_DISABLE;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(decisionStore(), { recursive: true, force: true });
});

/** @returns {string} the sandbox's decision store, per getDecisionStoreDir. */
function decisionStore() {
  return path.join(sandboxRoot, '.artibot', 'runtime', 'decisions');
}

/** @returns {object[]} every decision event written under the sandbox store. */
function readSandboxDecisions() {
  const store = decisionStore();
  if (!existsSync(store)) return [];
  return readdirSync(store)
    .filter((f) => f.endsWith('.ndjson'))
    .flatMap((f) => readFileSync(path.join(store, f), 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l)));
}

describe('the measurement is recorded on a live prompt', () => {
  it('writes exactly one memory-injection-measured event', async () => {
    const out = await handleUserPromptSubmit({
      user_prompt: 'summarize the current architecture',
      session_id: 'sess-t37-memory-a',
      event: 'UserPromptSubmit',
      cwd: sandboxRoot,
    });
    expect(out).not.toBeNull();

    const events = readSandboxDecisions().filter((e) => e.type === MEMORY_INJECTION_MEASURED);
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('CONTEXT');
    // `injected` is deliberately NOT asserted to a value: it depends on the
    // machine's memory store. What must hold is that the field was measured and
    // recorded rather than omitted.
    expect(typeof events[0].data.injected).toBe('boolean');
    expect(events[0].data.measured_by).toBe('prompt-marker-extraction');
  });

  it('leaves the injection itself untouched (measure-only)', async () => {
    // The instrumentation reads the produced prompt; it must never edit it. If
    // memory was injected, the block is still present in the returned prompt.
    const out = await handleUserPromptSubmit({
      user_prompt: 'summarize the current architecture',
      session_id: 'sess-t37-memory-b',
      event: 'UserPromptSubmit',
      cwd: sandboxRoot,
    });
    const [evt] = readSandboxDecisions().filter((e) => e.type === MEMORY_INJECTION_MEASURED);
    expect(out.user_prompt.includes(MEMORY_BLOCK_HEAD)).toBe(evt.data.injected);
  });
});

describe('why this is not a ledger context.compiled receipt (measured)', () => {
  let projectRoot = '';

  beforeEach(() => {
    projectRoot = mkdtempSync(path.join(tmpdir(), 'artibot-t37-ledger-'));
  });

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  // The receipt repeats mission_id, and the writer requires the two to AGREE
  // (event-writer.js#receipt-identity). Supplying it on the envelope too is what
  // makes each case below fail for the reason it names instead of for this one.
  const RECEIPT_MISSION_ID = 'M-20260902-S12345678';

  /** A context receipt that satisfies every required key of the schema. */
  function validReceipt() {
    return {
      schema_version: 1,
      context_receipt_id: 'ctx-1',
      mission_id: RECEIPT_MISSION_ID,
      based_on: { intent_revision: 1, plan_revision: 1 },
      input_tokens: 100,
      transforms: {
        dedup: 0, tool_compression: 0, history_trim: 0, memory_add: 12, project_knowledge_add: 0,
      },
      protected_sections: [],
      output_tokens: 112,
      cache: { provider: 'anthropic', hit_tokens: 0, created_tokens: 0 },
      strategy_version: 1,
    };
  }

  it('refuses topology.selected from a hook source', () => {
    const r = writeEvent(projectRoot, {
      event: 'topology.selected',
      session_id: 'sess-ledger-1',
      source: 'hook',
      data: { mode: 'solo', observe_only: true },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('source-not-allowed:hook');
    // And the refusal is NOT silent: a ledger.rejected line is written in its
    // place, which is why wiring this anyway would add one rejection per prompt.
    expect(r.recorded).toBe(true);
  });

  it('refuses context.compiled from a hook source', () => {
    const r = writeEvent(projectRoot, {
      event: 'context.compiled',
      mission_id: RECEIPT_MISSION_ID,
      session_id: 'sess-ledger-2',
      source: 'hook',
      data: validReceipt(),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('source-not-allowed:hook');
  });

  it('accepts a complete receipt from the worker source (the contract is not broken)', () => {
    // The control. Without this, the two refusals above could be read as "the
    // receipt schema is unsatisfiable" rather than "this emitter is not allowed".
    const r = writeEvent(projectRoot, {
      event: 'context.compiled',
      mission_id: RECEIPT_MISSION_ID,
      session_id: 'sess-ledger-3',
      source: 'worker',
      data: validReceipt(),
    });
    expect(r.ok).toBe(true);
  });

  it('refuses a receipt carrying an extra memory field', () => {
    // context-receipt.schema.json is additionalProperties:false at every level,
    // so memory bytes/items/fired have no home in it. Only transforms.memory_add
    // exists, and it is a signed TOKEN delta.
    const r = writeEvent(projectRoot, {
      event: 'context.compiled',
      mission_id: RECEIPT_MISSION_ID,
      session_id: 'sess-ledger-4',
      source: 'worker',
      data: { ...validReceipt(), memory_bytes: 48 },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('receipt-additional:memory_bytes');
  });

  it('refuses a receipt missing the keys this hook cannot produce', () => {
    // The hook has no context_receipt_id, no based_on revisions, and no cache
    // numbers (their single declared writer is lib/economics/usage-receipt.js).
    // Inventing them to satisfy `required` would fabricate measurements.
    const { cache: _cache, ...withoutCache } = validReceipt();
    const r = writeEvent(projectRoot, {
      event: 'context.compiled',
      mission_id: RECEIPT_MISSION_ID,
      session_id: 'sess-ledger-5',
      source: 'worker',
      data: withoutCache,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing-required-data:cache');
  });
});
