/**
 * `lib/context/context-receipt` — the Context Receipt assembler (vNext PR-CX02).
 *
 * The point of this module is a REFUSAL, so the point of this file is to pin
 * that refusal. `schemas/context-receipt.schema.json` requires ten top-level
 * keys with `additionalProperties:false` at every level; a PostCompact hook
 * can honestly supply four of them. Measured 2026-09-12: `mission_id` has no
 * producer reachable from a hook (env `ARTIBOT_MISSION_ID` is referenced
 * nowhere in `lib/` or `scripts/`), `based_on.*` is produced only inside
 * mission artifacts (`lib/intent/artifact.js`, `lib/runtime/artifact-lifecycle.js`),
 * `transforms.*` is 0/5 measured, and `cache.*` has a single writer
 * (`lib/economics/usage-receipt.js`). So the assembler must report those as
 * MISSING rather than zero-fill them — a zero in `transforms` means "the
 * transform ran and changed nothing" per the schema, which would be a lie.
 *
 * The ajv layer is the only thing here that can read the schema: without it
 * "the receipt validates" is not a weaker assertion, it is ABSENT. Pattern
 * copied from `tests/schemas/receipts.test.js` — no `skipIf`, a missing
 * oracle goes RED.
 *
 * Not covered: whether any producer ever calls this (no writer is wired —
 * `lib/context/rehydration.js#reportContextReceipt` takes a null port today).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  assembleContextReceipt,
  CACHE_KEYS,
  CONTEXT_RECEIPT_SCHEMA_VERSION,
  CONTEXT_STRATEGY_VERSION,
  describeReceiptGap,
  TRANSFORM_KEYS,
} from '../../lib/context/context-receipt.js';

let Ajv = null;
try {
  Ajv = (await import('ajv')).default;
} catch {
  Ajv = null;
}
const AJV_MISSING = 'ajv is the ONLY oracle that reads context-receipt.schema.json here. '
  + 'It reaches this repo transitively (eslint -> ajv). If it is gone, DECLARE it as a devDependency; never skip this block.';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(__dirname, '../../lib/context/context-receipt.js');
const SCHEMA_PATH = path.resolve(__dirname, '../../schemas/context-receipt.schema.json');
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));

/** Input the hook can honestly supply at PostCompact (measurement 2, 2026-09-12). */
const HOOK_INPUT = Object.freeze({
  receiptId: 'ctx-sess1234-2026-09-12T00-00-00-000Z',
  missionId: null,
  inputTokens: 4096,
  outputTokens: 812,
  protectedSections: [],
});

/** The 11 schema leaves a PostCompact hook cannot fill. */
const HOOK_MISSING = Object.freeze([
  'mission_id',
  'based_on.intent_revision',
  'based_on.plan_revision',
  'transforms.dedup',
  'transforms.tool_compression',
  'transforms.history_trim',
  'transforms.memory_add',
  'transforms.project_knowledge_add',
  'cache.provider',
  'cache.hit_tokens',
  'cache.created_tokens',
]);

/**
 * @param {object} [over]
 * @returns {object}
 */
function completeInput(over = {}) {
  return {
    receiptId: 'ctx-M-20260912-001-1',
    missionId: 'M-20260912-001',
    basedOn: { intentRevision: 3, planRevision: 2 },
    inputTokens: 120_000,
    transforms: { dedup: -400, tool_compression: -12_000, history_trim: -30_000, memory_add: 900, project_knowledge_add: 0 },
    protectedSections: ['mission-brief', 'acceptance'],
    outputTokens: 78_500,
    cache: { provider: 'anthropic', hit_tokens: 61_000, created_tokens: 17_500 },
    ...over,
  };
}

describe('assembleContextReceipt — complete input', () => {
  it('returns ok with a receipt that validates against context-receipt.schema.json', () => {
    expect(Ajv, AJV_MISSING).not.toBeNull();
    const validate = new Ajv({ allErrors: true }).compile(schema);
    const result = assembleContextReceipt(completeInput());
    expect(result.missing).toEqual([]);
    expect(result.ok).toBe(true);
    expect(validate(result.receipt), JSON.stringify(validate.errors)).toBe(true);
    expect(result.receipt.schema_version).toBe(CONTEXT_RECEIPT_SCHEMA_VERSION);
    expect(result.receipt.strategy_version).toBe(CONTEXT_STRATEGY_VERSION);
  });

  it('carries the optional task_id/action_id only when they are valid, and never invents keys', () => {
    expect(Ajv, AJV_MISSING).not.toBeNull();
    const validate = new Ajv({ allErrors: true }).compile(schema);
    const withIds = assembleContextReceipt(completeInput({ taskId: 'T-7', actionId: 'A-9' }));
    expect(validate(withIds.receipt), JSON.stringify(validate.errors)).toBe(true);
    expect(Object.keys(withIds.receipt).sort()).toEqual([
      'action_id', 'based_on', 'cache', 'context_receipt_id', 'input_tokens',
      'mission_id', 'output_tokens', 'protected_sections', 'schema_version',
      'strategy_version', 'task_id', 'transforms',
    ]);
    const blank = assembleContextReceipt(completeInput({ taskId: '', actionId: 42 }));
    expect(blank.ok).toBe(true);
    expect('task_id' in blank.receipt).toBe(false);
    expect('action_id' in blank.receipt).toBe(false);
    expect(Object.keys(blank.receipt)).toHaveLength(10);
  });

  it('accepts an explicit strategyVersion and rejects a non-counter one', () => {
    expect(assembleContextReceipt(completeInput({ strategyVersion: 4 })).receipt.strategy_version).toBe(4);
    expect(assembleContextReceipt(completeInput({ strategyVersion: 0 })).receipt.strategy_version).toBe(CONTEXT_STRATEGY_VERSION);
    expect(assembleContextReceipt(completeInput({ strategyVersion: 1.5 })).receipt.strategy_version).toBe(CONTEXT_STRATEGY_VERSION);
  });

  it('is deterministic: the same input yields a deep-equal receipt', () => {
    const a = assembleContextReceipt(completeInput());
    const b = assembleContextReceipt(completeInput());
    expect(a).toEqual(b);
    expect(JSON.stringify(a.receipt)).toBe(JSON.stringify(b.receipt));
  });
});

describe('assembleContextReceipt — the PostCompact hook gap', () => {
  it('reports exactly the 11 leaves a hook cannot fill, in schema order', () => {
    const result = assembleContextReceipt(HOOK_INPUT);
    expect(result.missing).toEqual([...HOOK_MISSING]);
    expect(result.ok).toBe(false);
    expect(result.receipt).toBeNull();
  });

  it('does not zero-fill: the partial carries no transforms and no cache object', () => {
    const result = assembleContextReceipt(HOOK_INPUT);
    expect('transforms' in result.partial).toBe(false);
    expect('cache' in result.partial).toBe(false);
    expect('based_on' in result.partial).toBe(false);
    expect('mission_id' in result.partial).toBe(false);
    expect(result.partial).toEqual({
      schema_version: 1,
      context_receipt_id: HOOK_INPUT.receiptId,
      input_tokens: 4096,
      protected_sections: [],
      output_tokens: 812,
      strategy_version: CONTEXT_STRATEGY_VERSION,
    });
  });

  it('treats an absent protected_sections as the empty statement, an invalid one as missing', () => {
    const absent = assembleContextReceipt({ ...HOOK_INPUT, protectedSections: undefined });
    expect(absent.partial.protected_sections).toEqual([]);
    expect(absent.missing).toEqual([...HOOK_MISSING]);
    const bad = assembleContextReceipt({ ...HOOK_INPUT, protectedSections: 'mission-brief' });
    expect(bad.missing).toContain('protected_sections');
    expect('protected_sections' in bad.partial).toBe(false);
    const holes = assembleContextReceipt({ ...HOOK_INPUT, protectedSections: ['ok', ''] });
    expect(holes.missing).toContain('protected_sections');
  });
});

describe('assembleContextReceipt — per-leaf validity', () => {
  it('flags only the fifth transform when four of five are supplied', () => {
    const four = { dedup: -1, tool_compression: -2, history_trim: -3, memory_add: 4 };
    const result = assembleContextReceipt(completeInput({ transforms: four }));
    expect(result.missing).toEqual(['transforms.project_knowledge_add']);
    expect('transforms' in result.partial).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('rejects non-integer transform deltas one key at a time', () => {
    const result = assembleContextReceipt(completeInput({
      transforms: { dedup: -1.5, tool_compression: '0', history_trim: -3, memory_add: 4, project_knowledge_add: 0 },
    }));
    expect(result.missing).toEqual(['transforms.dedup', 'transforms.tool_compression']);
  });

  it('requires all three cache keys with the schema minimums', () => {
    expect(assembleContextReceipt(completeInput({ cache: { provider: 'anthropic', hit_tokens: 1 } })).missing)
      .toEqual(['cache.created_tokens']);
    expect(assembleContextReceipt(completeInput({ cache: { provider: '', hit_tokens: -1, created_tokens: 2.5 } })).missing)
      .toEqual([...CACHE_KEYS].map((k) => `cache.${k}`));
  });

  it('requires revisions to be counters >= 1', () => {
    expect(assembleContextReceipt(completeInput({ basedOn: { intentRevision: 0, planRevision: 2 } })).missing)
      .toEqual(['based_on.intent_revision']);
    expect(assembleContextReceipt(completeInput({ basedOn: { intentRevision: 1, planRevision: '2' } })).missing)
      .toEqual(['based_on.plan_revision']);
    expect(assembleContextReceipt(completeInput({ basedOn: null })).missing)
      .toEqual(['based_on.intent_revision', 'based_on.plan_revision']);
  });

  it('accepts zero token counts and rejects negative or fractional ones', () => {
    const zero = assembleContextReceipt(completeInput({ inputTokens: 0, outputTokens: 0 }));
    expect(zero.ok).toBe(true);
    expect(zero.receipt.input_tokens).toBe(0);
    expect(assembleContextReceipt(completeInput({ inputTokens: -1, outputTokens: 3.5 })).missing)
      .toEqual(['input_tokens', 'output_tokens']);
  });

  it('requires a non-empty receipt id', () => {
    expect(assembleContextReceipt(completeInput({ receiptId: '' })).missing).toEqual(['context_receipt_id']);
    expect(assembleContextReceipt(completeInput({ receiptId: 7 })).missing).toEqual(['context_receipt_id']);
  });

  it('orders missing leaves by the schema, not by discovery', () => {
    const result = assembleContextReceipt({});
    expect(result.missing).toEqual([
      'context_receipt_id', 'mission_id', 'based_on.intent_revision', 'based_on.plan_revision',
      'input_tokens', ...TRANSFORM_KEYS.map((k) => `transforms.${k}`),
      'output_tokens', ...CACHE_KEYS.map((k) => `cache.${k}`),
    ]);
  });
});

describe('assembleContextReceipt — total function', () => {
  it('never throws on garbage', () => {
    const garbage = [undefined, null, 0, '', 'receipt', 42, true, [], [1, 2], Symbol.iterator, () => {}, new Map()];
    for (const input of garbage) {
       
      expect(() => assembleContextReceipt(/** @type {never} */ (input)), String(String(input))).not.toThrow();
      const r = assembleContextReceipt(/** @type {never} */ (input));
      expect(r.ok).toBe(false);
      expect(r.receipt).toBeNull();
      expect(r.missing.length).toBeGreaterThan(0);
    }
  });

  it('survives hostile shapes: throwing getters and prototype pollution attempts', () => {
    const hostile = {
      receiptId: 'ctx-1',
      get missionId() { throw new Error('boom'); },
      transforms: { get dedup() { throw new Error('boom'); } },
    };
    expect(() => assembleContextReceipt(hostile)).not.toThrow();
    const r = assembleContextReceipt(hostile);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('mission_id');
    expect(Object.prototype.hasOwnProperty.call({}, '__proto__polluted')).toBe(false);
  });
});

describe('describeReceiptGap', () => {
  it('names the count and the first leaves for a log line', () => {
    const line = describeReceiptGap(assembleContextReceipt(HOOK_INPUT));
    expect(line).toContain('11 missing');
    expect(line).toContain('mission_id');
    expect(line.includes('\n')).toBe(false);
  });

  it('says so when the receipt is complete, and tolerates garbage', () => {
    expect(describeReceiptGap(assembleContextReceipt(completeInput()))).toContain('complete');
    expect(() => describeReceiptGap(null)).not.toThrow();
    expect(() => describeReceiptGap({ missing: 'nope' })).not.toThrow();
  });
});

describe('purity', () => {
  it('imports nothing impure: no fs, no clock, no randomness, no env', () => {
    const src = readFileSync(MODULE_PATH, 'utf-8');
    const body = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['node:fs', 'node:path', 'node:crypto', 'Date.', 'new Date', 'Math.random', 'process.env', 'process.hrtime']) {
      expect(body, forbidden).not.toContain(forbidden);
    }
    const imports = [...body.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports.every((s) => s.startsWith('./'))).toBe(true);
  });

  it('freezes the key lists so a caller cannot mutate the contract', () => {
    expect(Object.isFrozen(TRANSFORM_KEYS)).toBe(true);
    expect(Object.isFrozen(CACHE_KEYS)).toBe(true);
    expect([...TRANSFORM_KEYS]).toEqual(schema.properties.transforms.required);
    expect([...CACHE_KEYS]).toEqual(schema.properties.cache.required);
  });
});
