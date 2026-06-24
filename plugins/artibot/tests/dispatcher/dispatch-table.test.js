/**
 * dispatch-table.json + loader contract tests.
 *
 * v4.8.0 P1: dispatch-table.json is the single source of truth for every
 * dispatcher's HOOKS array. These tests guarantee:
 *
 *   1. The JSON is well-formed and every slot has the expected handler count.
 *   2. Every handler has the required fields (name/script/timeoutMs).
 *   3. Every `script` resolves to a real file on disk.
 *   4. The loader's resolved output matches each dispatcher's exported HOOKS
 *      array byte-for-byte (name/timeoutMs/args/tools). A drift in either side
 *      breaks this test, enforcing "edit JSON once, dispatcher stays in sync".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  _resetCacheForTests,
  getHooksDir,
  getSlotMetadata,
  getTablePath,
  listSlots,
  loadDispatchTable,
} from '../../lib/dispatcher/dispatch-table-loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');

const EXPECTED_HANDLER_COUNTS = {
  SessionStart: 9,
  // Bumped 6 → 7 in v4.8.0 backlog: auto-command-suggest.js joined the
  // UserPromptSubmit slot to suggest /adr and /migrate from natural-language
  // prompts (alongside the existing auto-team-trigger and autopilot-nlu).
  UserPromptSubmit: 7,
  PostToolUse: 10,
  Stop: 6,
  SessionEnd: 6,
  SubagentStop: 3,
  PreCompact: 0,
};

const SPAWN_SLOTS = ['SessionStart', 'PostToolUse', 'Stop', 'SessionEnd', 'SubagentStop'];

describe('dispatch-table.json', () => {
  it('exists at the expected path', () => {
    const tablePath = getTablePath();
    expect(fs.existsSync(tablePath)).toBe(true);
    expect(tablePath).toContain(path.join('hooks', 'dispatch-table.json'));
  });

  it('parses as JSON', () => {
    const raw = fs.readFileSync(getTablePath(), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('declares all 7 expected slots', () => {
    const slots = listSlots();
    expect(slots.sort()).toEqual(Object.keys(EXPECTED_HANDLER_COUNTS).sort());
  });

  it.each(Object.entries(EXPECTED_HANDLER_COUNTS))(
    'slot %s has %i handlers',
    (slot, expected) => {
      const handlers = loadDispatchTable(slot);
      expect(handlers).toHaveLength(expected);
    },
  );

  it('every slot has a label and strategy field', () => {
    for (const slot of listSlots()) {
      const meta = getSlotMetadata(slot);
      expect(typeof meta.label).toBe('string');
      expect(meta.label.length).toBeGreaterThan(0);
      expect(typeof meta.strategy).toBe('string');
      expect(meta.strategy.length).toBeGreaterThan(0);
    }
  });
});

describe('handler validation', () => {
  it('every handler has required fields (name/script/timeoutMs)', () => {
    for (const slot of listSlots()) {
      const handlers = loadDispatchTable(slot);
      for (const h of handlers) {
        expect(typeof h.name).toBe('string');
        expect(h.name.length).toBeGreaterThan(0);
        expect(typeof h.script).toBe('string');
        expect(h.script.length).toBeGreaterThan(0);
        expect(typeof h.timeoutMs).toBe('number');
        expect(h.timeoutMs).toBeGreaterThan(0);
      }
    }
  });

  it('every handler script path points to a real file on disk', () => {
    for (const slot of listSlots()) {
      const handlers = loadDispatchTable(slot);
      for (const h of handlers) {
        expect(
          fs.existsSync(h.script),
          `${slot} → ${h.name}: ${h.script} should exist`,
        ).toBe(true);
      }
    }
  });

  it('handler script paths are absolute and rooted under scripts/hooks/', () => {
    const hooksDir = getHooksDir();
    for (const slot of listSlots()) {
      const handlers = loadDispatchTable(slot);
      for (const h of handlers) {
        expect(path.isAbsolute(h.script)).toBe(true);
        expect(h.script.startsWith(hooksDir)).toBe(true);
      }
    }
  });

  it('args field, when present, is an array of strings', () => {
    for (const slot of listSlots()) {
      const handlers = loadDispatchTable(slot);
      for (const h of handlers) {
        if (h.args !== undefined) {
          expect(Array.isArray(h.args)).toBe(true);
          for (const a of h.args) expect(typeof a).toBe('string');
        }
      }
    }
  });

  it('tools field, when present, is an array of strings (PostToolUse only)', () => {
    const handlers = loadDispatchTable('PostToolUse');
    for (const h of handlers) {
      expect(Array.isArray(h.tools)).toBe(true);
      for (const t of h.tools) expect(typeof t).toBe('string');
    }
  });
});

describe('loader API', () => {
  it('throws on unknown slot name', () => {
    expect(() => loadDispatchTable('DoesNotExist')).toThrow(/unknown slot/);
  });

  it('throws on non-string slot name', () => {
    expect(() => loadDispatchTable('')).toThrow(/non-empty string/);
    expect(() => loadDispatchTable(null)).toThrow(/non-empty string/);
  });

  // v4.8.0 H-4: every resolved handler script lives strictly under HOOKS_DIR.
  // Crafted traversal entries are covered by the dedicated security suite
  // (tests/dispatcher/dispatch-table-loader-security.test.js) that swaps the
  // table file at runtime; here we just sanity-check production data.
  it('all real handler script paths stay strictly under getHooksDir() (H-4)', () => {
    const hooksDir = getHooksDir();
    const sep = path.sep;
    const root = hooksDir.endsWith(sep) ? hooksDir : hooksDir + sep;
    for (const slot of listSlots()) {
      const handlers = loadDispatchTable(slot);
      for (const h of handlers) {
        expect(
          h.script === hooksDir || h.script.startsWith(root),
          `${slot} → ${h.name}: ${h.script} escapes hooksDir`,
        ).toBe(true);
      }
    }
  });

  it('returns defensive copies — mutating the result does not corrupt cache', () => {
    _resetCacheForTests();
    const first = loadDispatchTable('Stop');
    first[0].name = 'mutated-name';
    if (first[0].args) first[0].args.push('extra-arg');
    const second = loadDispatchTable('Stop');
    expect(second[0].name).not.toBe('mutated-name');
  });

  it('returns the same handler count after cache hit', () => {
    _resetCacheForTests();
    const first = loadDispatchTable('SessionStart').length;
    const second = loadDispatchTable('SessionStart').length;
    expect(first).toBe(second);
  });
});

describe('dispatcher / JSON sync', () => {
  // For every spawn-based dispatcher, import its exported HOOKS array and
  // assert it equals the loader's output. This catches drift in EITHER
  // direction — if a dev edits the dispatcher's HOOKS array without updating
  // the JSON (or vice versa), this test fires.

  const slotToDispatcher = {
    SessionStart: '_sessionstart-dispatcher.js',
    PostToolUse:  '_posttooluse-dispatcher.js',
    Stop:         '_stop-dispatcher.js',
    SessionEnd:   '_sessionend-dispatcher.js',
    SubagentStop: '_subagentstop-dispatcher.js',
  };

  it.each(SPAWN_SLOTS)(
    '%s dispatcher HOOKS export matches dispatch-table.json',
    async (slot) => {
      const dispatcherPath = path.join(
        PLUGIN_ROOT, 'scripts', 'hooks', slotToDispatcher[slot],
      );
      // Use file:// URL so Node ESM imports work on Windows + Korean paths.
      const url = new URL('file:///' + dispatcherPath.replace(/\\/g, '/'));
      const mod = await import(url.href);
      const exported = mod.HOOKS;
      const loaded = loadDispatchTable(slot);

      expect(exported).toBeDefined();
      expect(Array.isArray(exported)).toBe(true);
      expect(exported.length).toBe(loaded.length);

      for (let i = 0; i < loaded.length; i++) {
        const e = exported[i];
        const l = loaded[i];
        expect(e.name, `${slot}[${i}].name`).toBe(l.name);
        expect(e.timeoutMs, `${slot}[${i}].timeoutMs`).toBe(l.timeoutMs);
        expect(e.script, `${slot}[${i}].script`).toBe(l.script);
        // args parity: both undefined OR both equal arrays
        if (l.args || e.args) {
          expect(e.args || []).toEqual(l.args || []);
        }
        if (l.tools || e.tools) {
          expect(e.tools || []).toEqual(l.tools || []);
        }
      }
    },
  );
});
