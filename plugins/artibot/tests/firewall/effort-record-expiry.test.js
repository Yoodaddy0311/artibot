/**
 * Firewall — an effort record may only be honoured by the session and the prompt
 * that wrote it, and only before it expires.
 *
 * `runtime/current-effort.json` is ONE file per plugin root. Two concurrent
 * sessions overwrite each other's record, and nothing in the pre-F05 record says
 * which prompt produced it — so `lib/runtime/middleware/tasks.js#readEffortMeta`
 * could hand a task the command and budget of a different session's prompt, or of
 * a prompt from an hour ago. F05 stamps `sessionId` / `promptId` / `expiresAt`,
 * writes a per-session file next to the legacy one, and gates the read.
 *
 * The legacy parallel write is part of the contract, not a transition step:
 * three consumers read that literal path. Case (d) below pins them, so whoever
 * deletes the parallel write sees the three names first.
 *
 * WHAT THIS GATE CANNOT SEE
 * - It does not prove the HOST sends `prompt_id` on UserPromptSubmit. The reader
 *   treats a missing id as "no constraint", so if the host never sends one the
 *   prompt-level refusal never fires in production and only the session-level and
 *   expiry refusals do. The arrival rate of `prompt_id` is unmeasured here.
 * - It does not measure `lib/tui/dashboard.js` or `scripts/hooks/statusline.sh`
 *   behaviour; it only asserts they still name the legacy file.
 * - It does not exercise real concurrency. The two-session case is sequential
 *   writes, which is the failure mode observed, not an interleaved-write race.
 * - It does not prove the middleware receives a `session_id` — that comes from
 *   the hook payload and is asserted in the middleware suite with fixtures.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildEffortRecord,
  EFFORT_RECORD_TTL_MS,
  EFFORT_RECORDS_DIRNAME,
  gcEffortRecords,
  persistEffortRecord,
  readEffortRecord,
} from '../../lib/runtime/task-budget.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const META = Object.freeze({
  command: 'implement', effort: 'max', baseline: 'xhigh', shift: 1, reason: 'score>=0.7 (+1)',
});

const T0 = Date.parse('2026-09-14T00:00:00.000Z');

let root;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'artibot-effort-rec-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function recordsDir(pluginRoot = root) {
  return path.join(pluginRoot, 'runtime', EFFORT_RECORDS_DIRNAME);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeLegacy(payload) {
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  writeFileSync(path.join(root, 'runtime', 'current-effort.json'), JSON.stringify(payload) + '\n');
}

describe('firewall/effort-record — every persisted record carries identity + expiry', () => {
  it('stamps sessionId, promptId, updatedAt, expiresAt and keeps the five legacy keys in BOTH files', () => {
    const { legacyPath, sessionPath } = persistEffortRecord(META, root, {
      sessionId: 'sess-A', promptId: 'prompt-1', now: T0,
    });
    expect(legacyPath).toBeTruthy();
    expect(sessionPath).toBeTruthy();

    for (const filePath of [legacyPath, sessionPath]) {
      const record = readJson(filePath);
      expect(record.sessionId).toBe('sess-A');
      expect(record.promptId).toBe('prompt-1');
      expect(record.updatedAt).toBe(new Date(T0).toISOString());
      expect(record.expiresAt).toBe(new Date(T0 + EFFORT_RECORD_TTL_MS).toISOString());
      expect(record.command).toBe('implement');
      expect(record.effort).toBe('max');
      expect(record.baseline).toBe('xhigh');
      expect(record.shift).toBe(1);
      expect(record.reason).toBe('score>=0.7 (+1)');
    }
  });

  it('names the per-session file after the SANITIZED session id (no traversal)', () => {
    const { sessionPath } = persistEffortRecord(META, root, {
      sessionId: '../../etc/passwd', promptId: null, now: T0,
    });
    expect(sessionPath).toBeTruthy();
    expect(path.dirname(sessionPath)).toBe(recordsDir());
    expect(path.basename(sessionPath)).not.toContain('..');
  });

  it('writes no session file when there is no session id, but still writes the legacy file', () => {
    const result = persistEffortRecord(META, root, { sessionId: null, promptId: null, now: T0 });
    expect(result.sessionPath).toBeNull();
    expect(existsSync(result.legacyPath)).toBe(true);
    expect(existsSync(recordsDir())).toBe(false);
  });

  it('buildEffortRecord is pure — same meta + same clock = same payload', () => {
    const a = buildEffortRecord(META, { sessionId: 's', promptId: 'p', now: T0 });
    const b = buildEffortRecord(META, { sessionId: 's', promptId: 'p', now: T0 });
    expect(a).toEqual(b);
  });
});

describe('firewall/effort-record — the expiry gate', () => {
  it('refuses a record whose expiresAt has passed', () => {
    persistEffortRecord(META, root, { sessionId: 'sess-A', promptId: 'p1', now: T0 });

    const fresh = readEffortRecord(root, { sessionId: 'sess-A', promptId: 'p1', now: T0 + 1000 });
    expect(fresh?.effort).toBe('max');

    const expired = readEffortRecord(root, {
      sessionId: 'sess-A', promptId: 'p1', now: T0 + EFFORT_RECORD_TTL_MS + 1,
    });
    expect(expired).toBeNull();
  });

  it('honours a legacy record that has no expiresAt at all', () => {
    writeLegacy({ command: 'daily', effort: 'medium', shift: null, reason: null });
    const record = readEffortRecord(root, { sessionId: null, promptId: null, now: T0 });
    expect(record?.effort).toBe('medium');
    expect(record?.command).toBe('daily');
  });

  it('honours a legacy record with an unparseable expiresAt (no silent refusal on junk)', () => {
    writeLegacy({ command: 'daily', effort: 'medium', expiresAt: 'not-a-date' });
    expect(readEffortRecord(root, { now: T0 })?.effort).toBe('medium');
  });
});

describe('firewall/effort-record — the identity gate', () => {
  it('refuses a record that names a different session', () => {
    persistEffortRecord(META, root, { sessionId: 'sess-A', promptId: null, now: T0 });
    const seen = readEffortRecord(root, { sessionId: 'sess-B', promptId: null, now: T0 });
    expect(seen).toBeNull();
  });

  it('refuses a record that names a different prompt (old prompt leakage = 0)', () => {
    persistEffortRecord(META, root, { sessionId: 'sess-A', promptId: 'prompt-1', now: T0 });
    const seen = readEffortRecord(root, { sessionId: 'sess-A', promptId: 'prompt-2', now: T0 });
    expect(seen).toBeNull();
  });

  it('two sessions: A still reads ITS OWN effort after B overwrites the legacy file', () => {
    persistEffortRecord({ ...META, command: 'implement', effort: 'max' }, root, {
      sessionId: 'sess-A', promptId: 'a1', now: T0,
    });
    persistEffortRecord({ ...META, command: 'daily', effort: 'low' }, root, {
      sessionId: 'sess-B', promptId: 'b1', now: T0 + 10,
    });

    // The legacy file now belongs to B — that is exactly the pre-F05 bug.
    expect(readJson(path.join(root, 'runtime', 'current-effort.json')).effort).toBe('low');

    const forA = readEffortRecord(root, { sessionId: 'sess-A', promptId: 'a1', now: T0 + 20 });
    expect(forA?.effort).toBe('max');
    expect(forA?.command).toBe('implement');
    expect(forA?.sessionId).toBe('sess-A');

    const forB = readEffortRecord(root, { sessionId: 'sess-B', promptId: 'b1', now: T0 + 20 });
    expect(forB?.effort).toBe('low');
  });

  it('a refused session file does NOT fall through to another session\'s legacy record', () => {
    persistEffortRecord({ ...META, effort: 'max' }, root, {
      sessionId: 'sess-A', promptId: 'a1', now: T0,
    });
    persistEffortRecord({ ...META, effort: 'low' }, root, {
      sessionId: 'sess-B', promptId: 'b1', now: T0 + 10,
    });
    // A's own file is expired; the legacy file is B's.
    const seen = readEffortRecord(root, {
      sessionId: 'sess-A', promptId: 'a1', now: T0 + EFFORT_RECORD_TTL_MS + 1,
    });
    expect(seen).toBeNull();
  });

  it('falls through to a legacy record with NO identity when the session file is refused', () => {
    persistEffortRecord(META, root, { sessionId: 'sess-A', promptId: 'a1', now: T0 });
    writeLegacy({ command: 'daily', effort: 'medium' });
    const seen = readEffortRecord(root, {
      sessionId: 'sess-A', promptId: 'a1', now: T0 + EFFORT_RECORD_TTL_MS + 1,
    });
    expect(seen?.effort).toBe('medium');
  });

  it('returns null when nothing has been persisted', () => {
    expect(readEffortRecord(root, { sessionId: 'sess-A', now: T0 })).toBeNull();
  });
});

describe('firewall/effort-record — the legacy parallel write is part of the contract', () => {
  it('writes the legacy file on EVERY persist, including when a session file is written', () => {
    for (const sid of ['sess-A', 'sess-B', 'sess-C']) {
      const { legacyPath, sessionPath } = persistEffortRecord(META, root, {
        sessionId: sid, promptId: `${sid}-1`, now: T0,
      });
      expect(existsSync(legacyPath)).toBe(true);
      expect(existsSync(sessionPath)).toBe(true);
      expect(readJson(legacyPath).sessionId).toBe(sid);
    }
  });

  it('the three legacy consumers still reference runtime/current-effort.json', () => {
    const consumers = [
      path.join(PLUGIN_ROOT, 'lib', 'tui', 'dashboard.js'),
      path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'statusline.sh'),
      path.join(PLUGIN_ROOT, 'commands', 'team.md'),
    ];
    for (const filePath of consumers) {
      expect(existsSync(filePath), `${filePath} must exist`).toBe(true);
      expect(readFileSync(filePath, 'utf8'), `${filePath} reads the legacy effort file`)
        .toContain('current-effort.json');
    }
  });
});

describe('firewall/effort-record — GC', () => {
  it('removes expired records and keeps at most `keep` of the rest (newest by mtime)', () => {
    mkdirSync(recordsDir(), { recursive: true });
    // Three live records, oldest mtime first; one already expired.
    for (const [index, sid] of ['old', 'mid', 'new'].entries()) {
      const filePath = path.join(recordsDir(), `${sid}.json`);
      writeFileSync(filePath, JSON.stringify(buildEffortRecord(META, {
        sessionId: sid, promptId: null, now: T0,
      })) + '\n');
      const seconds = (T0 + index * 60_000) / 1000;
      utimesSync(filePath, seconds, seconds);
    }
    const expiredPath = path.join(recordsDir(), 'gone.json');
    writeFileSync(expiredPath, JSON.stringify(buildEffortRecord(META, {
      sessionId: 'gone', promptId: null, now: T0 - EFFORT_RECORD_TTL_MS * 2,
    })) + '\n');

    const result = gcEffortRecords(recordsDir(), { now: T0 + 1000, keep: 2 });

    expect(existsSync(expiredPath)).toBe(false);
    const remaining = readdirSync(recordsDir()).sort();
    expect(remaining).toEqual(['mid.json', 'new.json']);
    expect(result.kept).toBe(2);
    expect(result.removed).toBe(2);
  });

  it('is a no-op on a missing directory and never throws', () => {
    expect(gcEffortRecords(path.join(root, 'nope'), { now: T0, keep: 1 }))
      .toEqual({ removed: 0, kept: 0 });
    expect(gcEffortRecords('', { now: T0 })).toEqual({ removed: 0, kept: 0 });
  });

  it('persistEffortRecord runs GC so the records directory cannot grow without bound', () => {
    for (let i = 0; i < 6; i += 1) {
      persistEffortRecord(META, root, { sessionId: `sess-${i}`, promptId: null, now: T0, keep: 3 });
    }
    expect(readdirSync(recordsDir()).length).toBeLessThanOrEqual(3);
  });
});

describe('firewall/effort-record — source tripwire', () => {
  it('the UserPromptSubmit hook persists through persistEffortRecord', () => {
    const source = readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'runtime-prompt.js'), 'utf8');
    expect(source).toContain('persistEffortRecord');
  });

  it('the tasks middleware reads through readEffortRecord', () => {
    const source = readFileSync(
      path.join(PLUGIN_ROOT, 'lib', 'runtime', 'middleware', 'tasks.js'), 'utf8',
    );
    expect(source).toContain('readEffortRecord');
  });
});
