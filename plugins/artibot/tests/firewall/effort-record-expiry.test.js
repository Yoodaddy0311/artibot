/**
 * Firewall — an effort record may only be honoured by the session and the prompt
 * that wrote it, and only before it expires.
 *
 * `current-effort.json` used to be ONE file per plugin root. Two concurrent
 * sessions overwrote each other's record, and nothing in the pre-F05 record says
 * which prompt produced it — so `lib/runtime/middleware/tasks.js#readEffortMeta`
 * could hand a task the command and budget of a different session's prompt, or of
 * a prompt from an hour ago. F05 stamps `sessionId` / `promptId` / `expiresAt`
 * and gates the read.
 *
 * O2 REMOVED THE SHARED SLOT ITSELF. The record is now written to
 * `<state dir>/runtime/sessions/<session_id>/current-effort.json`
 * (`lib/core/runtime-state.js`; the state dir is `~/.claude/artibot`, which a
 * plugin update does not replace), one per session. The F05 gate stays — a session
 * can still meet a record that has expired or names another prompt, and a flat
 * `runtime/current-effort.json` still exists for payloads without a session id and
 * as a read fallback for records a pre-O2 hook left — for a reader that ALSO has no
 * session id: a reader that knows its session reads its own file and nothing else.
 * What is no longer true, and what the cases below used to pin the other way round:
 *   - there is no parallel write of a flat legacy file next to the session file
 *     (the old "the legacy parallel write is part of the contract" group). The
 *     display consumers read the session file (or, without a session id, the flat
 *     effort fallback), so the parallel write has no reader left that needs it; case (d)
 *     still pins that all three consumers name the file, and adds that the two
 *     that can read the session path do;
 *   - the per-session `runtime/effort/<sid>.json` directory and its GC are gone —
 *     a session directory is swept by age (`runtime-state.js#sweepSessionDirs`).
 * These suites point the state dir at their tmp dir (`pointStateDirAt`), which is
 * the install.sh layout where the state dir and the plugin root are one directory.
 *
 * WHAT THIS GATE CANNOT SEE
 * - It does not prove the HOST sends `prompt_id` on UserPromptSubmit. The reader
 *   treats a missing id as "no constraint", so if the host never sends one the
 *   prompt-level refusal never fires in production and only the session-level and
 *   expiry refusals do. The arrival rate of `prompt_id` is unmeasured here.
 * - It does not measure `lib/tui/dashboard.js` or `scripts/hooks/statusline.sh`
 *   behaviour; it only asserts they still name the file and read it session-first.
 *   Their behaviour is `tests/tui/dashboard.test.js` and
 *   `tests/hooks/statusline-runtime-state.test.js`.
 * - It does not exercise real concurrency. The two-session case is sequential
 *   writes, which is the failure mode observed, not an interleaved-write race.
 * - It does not prove the middleware receives a `session_id` — that comes from
 *   the hook payload and is asserted in the middleware suite with fixtures.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sweepSessionDirs } from '../../lib/core/runtime-state.js';
import {
  buildEffortRecord,
  EFFORT_RECORD_TTL_MS,
  persistEffortRecord,
  readEffortRecord,
} from '../../lib/runtime/task-budget.js';
import { pointStateDirAt } from '../helpers/state-dir.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const META = Object.freeze({
  command: 'implement', effort: 'max', baseline: 'xhigh', shift: 1, reason: 'score>=0.7 (+1)',
});

const T0 = Date.parse('2026-09-14T00:00:00.000Z');

let root;
let restoreState;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'artibot-effort-rec-'));
  restoreState = pointStateDirAt(root);
});

afterEach(() => {
  restoreState();
  rmSync(root, { recursive: true, force: true });
});

function sessionFile(sid) {
  return path.join(root, 'runtime', 'sessions', sid, 'current-effort.json');
}

function flatFile() {
  return path.join(root, 'runtime', 'current-effort.json');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** A FLAT record, as a pre-O2 hook — or a payload with no session id — leaves one. */
function writeLegacy(payload) {
  mkdirSync(path.join(root, 'runtime'), { recursive: true });
  writeFileSync(flatFile(), JSON.stringify(payload) + '\n');
}

describe('firewall/effort-record — every persisted record carries identity + expiry', () => {
  it('stamps sessionId, promptId, updatedAt, expiresAt and keeps the five legacy keys', () => {
    const { legacyPath, sessionPath } = persistEffortRecord(META, root, {
      sessionId: 'sess-A', promptId: 'prompt-1', now: T0,
    });
    expect(legacyPath).toBeNull();
    expect(sessionPath).toBe(sessionFile('sess-A'));

    const record = readJson(sessionPath);
    expect(record.sessionId).toBe('sess-A');
    expect(record.promptId).toBe('prompt-1');
    expect(record.updatedAt).toBe(new Date(T0).toISOString());
    expect(record.expiresAt).toBe(new Date(T0 + EFFORT_RECORD_TTL_MS).toISOString());
    expect(record.command).toBe('implement');
    expect(record.effort).toBe('max');
    expect(record.baseline).toBe('xhigh');
    expect(record.shift).toBe(1);
    expect(record.reason).toBe('score>=0.7 (+1)');
  });

  it('names the per-session directory after the SANITIZED session id (no traversal)', () => {
    const { sessionPath } = persistEffortRecord(META, root, {
      sessionId: '../../etc/passwd', promptId: null, now: T0,
    });
    expect(sessionPath).toBeTruthy();
    expect(path.dirname(path.dirname(sessionPath))).toBe(path.join(root, 'runtime', 'sessions'));
    expect(path.basename(path.dirname(sessionPath))).not.toContain('..');
    expect(path.basename(path.dirname(sessionPath))).toBe('etc-passwd');
  });

  it('writes the FLAT file, and no session directory, when there is no session id', () => {
    const result = persistEffortRecord(META, root, { sessionId: null, promptId: null, now: T0 });
    expect(result.sessionPath).toBeNull();
    expect(result.legacyPath).toBe(flatFile());
    expect(existsSync(result.legacyPath)).toBe(true);
    expect(existsSync(path.join(root, 'runtime', 'sessions'))).toBe(false);
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
  it('a session never sees another session\'s record: there is no shared slot to find it in', () => {
    persistEffortRecord(META, root, { sessionId: 'sess-A', promptId: null, now: T0 });
    const seen = readEffortRecord(root, { sessionId: 'sess-B', promptId: null, now: T0 });
    expect(seen).toBeNull();
  });

  it('refuses a flat record that names a different session', () => {
    writeLegacy({ ...META, sessionId: 'sess-A', promptId: null });
    expect(readEffortRecord(root, { sessionId: 'sess-B', promptId: null, now: T0 })).toBeNull();
  });

  it('refuses a record that names a different prompt (old prompt leakage = 0)', () => {
    persistEffortRecord(META, root, { sessionId: 'sess-A', promptId: 'prompt-1', now: T0 });
    const seen = readEffortRecord(root, { sessionId: 'sess-A', promptId: 'prompt-2', now: T0 });
    expect(seen).toBeNull();
  });

  it('two sessions: each reads ITS OWN effort, and neither overwrites the other\'s file', () => {
    persistEffortRecord({ ...META, command: 'implement', effort: 'max' }, root, {
      sessionId: 'sess-A', promptId: 'a1', now: T0,
    });
    persistEffortRecord({ ...META, command: 'daily', effort: 'low' }, root, {
      sessionId: 'sess-B', promptId: 'b1', now: T0 + 10,
    });

    // Pre-O2 the second write landed on the first's file (one flat file per plugin
    // root) and A's record was gone; now they are two files and there is no flat one.
    expect(readJson(sessionFile('sess-A')).effort).toBe('max');
    expect(readJson(sessionFile('sess-B')).effort).toBe('low');
    expect(existsSync(flatFile())).toBe(false);

    const forA = readEffortRecord(root, { sessionId: 'sess-A', promptId: 'a1', now: T0 + 20 });
    expect(forA?.effort).toBe('max');
    expect(forA?.command).toBe('implement');
    expect(forA?.sessionId).toBe('sess-A');

    const forB = readEffortRecord(root, { sessionId: 'sess-B', promptId: 'b1', now: T0 + 20 });
    expect(forB?.effort).toBe('low');
  });

  it('a refused session file does NOT fall through to another session\'s flat record', () => {
    persistEffortRecord({ ...META, effort: 'max' }, root, {
      sessionId: 'sess-A', promptId: 'a1', now: T0,
    });
    // A flat record naming B (what a pre-O2 hook of B's would have left).
    writeLegacy({ ...META, effort: 'low', sessionId: 'sess-B', promptId: 'b1' });
    // A's own file is expired; the flat file is B's.
    const seen = readEffortRecord(root, {
      sessionId: 'sess-A', promptId: 'a1', now: T0 + EFFORT_RECORD_TTL_MS + 1,
    });
    expect(seen).toBeNull();
  });

  it('a reader with a session id reads ONLY its own file: nothing falls through to a flat record, identity or not', () => {
    // The session's own file expired and is refused. A flat record with NO identity — how a
    // pre-F05 writer left it, and what this reader used to fall through to — is not offered.
    persistEffortRecord(META, root, { sessionId: 'sess-A', promptId: 'a1', now: T0 });
    writeLegacy({ command: 'daily', effort: 'medium' });
    expect(readEffortRecord(root, {
      sessionId: 'sess-A', promptId: 'a1', now: T0 + EFFORT_RECORD_TTL_MS + 1,
    })).toBeNull();
    // A session that has no file at all does not take the flat record either.
    expect(readEffortRecord(root, { sessionId: 'sess-Z', promptId: null, now: T0 })).toBeNull();
  });

  it('a reader with NO session id still takes a flat record — the state dir\'s, then the plugin root\'s — through the gate', () => {
    const oldRoot = path.join(root, 'old-plugin-root');
    mkdirSync(path.join(oldRoot, 'runtime'), { recursive: true });
    writeFileSync(path.join(oldRoot, 'runtime', 'current-effort.json'), JSON.stringify({ command: 'daily', effort: 'medium' }));

    // only the pre-O2 copy in the old plugin root exists: that is what is read
    expect(readEffortRecord(oldRoot, { now: T0 })?.effort).toBe('medium');

    // a flat record in the state dir outranks it
    writeLegacy({ command: 'plan', effort: 'high' });
    expect(readEffortRecord(oldRoot, { now: T0 })?.effort).toBe('high');

    // and the gate still applies: an expired flat record is refused
    writeLegacy({ ...META, effort: 'low', expiresAt: new Date(T0 - 1).toISOString() });
    expect(readEffortRecord(oldRoot, { now: T0 })).toBeNull();
  });

  it('returns null when nothing has been persisted', () => {
    expect(readEffortRecord(root, { sessionId: 'sess-A', now: T0 })).toBeNull();
  });
});

describe('firewall/effort-record — no shared slot (O2), and the consumers still name the file', () => {
  it('never writes the flat file when a session id is known, for any number of sessions', () => {
    for (const sid of ['sess-A', 'sess-B', 'sess-C']) {
      const { legacyPath, sessionPath } = persistEffortRecord(META, root, {
        sessionId: sid, promptId: `${sid}-1`, now: T0,
      });
      expect(legacyPath).toBeNull();
      expect(existsSync(sessionPath)).toBe(true);
      expect(readJson(sessionPath).sessionId).toBe(sid);
    }
    expect(existsSync(flatFile())).toBe(false);
    expect(existsSync(path.join(root, 'runtime', 'effort'))).toBe(false);
  });

  it('the three consumers still reference current-effort.json', () => {
    const consumers = [
      path.join(PLUGIN_ROOT, 'lib', 'tui', 'dashboard.js'),
      path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'statusline.sh'),
      path.join(PLUGIN_ROOT, 'commands', 'team.md'),
    ];
    for (const filePath of consumers) {
      expect(existsSync(filePath), `${filePath} must exist`).toBe(true);
      expect(readFileSync(filePath, 'utf8'), `${filePath} reads the effort file`)
        .toContain('current-effort.json');
    }
  });

  it('the two display consumers that can know a session read the SESSION path (and only that, with a session id)', () => {
    const dashboard = readFileSync(path.join(PLUGIN_ROOT, 'lib', 'tui', 'dashboard.js'), 'utf8');
    expect(dashboard).toContain('resolveSessionReadChain');
    const statusline = readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'statusline.sh'), 'utf8');
    expect(statusline).toContain('state_file current-effort.json');
  });
});

describe('firewall/effort-record — session directories are swept, not garbage-collected per record', () => {
  it('persistEffortRecord leaves the directory bounded only by the session sweep', () => {
    for (let i = 0; i < 6; i += 1) {
      persistEffortRecord(META, root, { sessionId: `sess-${i}`, promptId: null, now: T0 });
    }
    const sessions = path.join(root, 'runtime', 'sessions');
    for (let i = 0; i < 6; i += 1) {
      const t = new Date(T0 + i * 60_000);
      utimesSync(path.join(sessions, `sess-${i}`, 'current-effort.json'), t, t);
      utimesSync(path.join(sessions, `sess-${i}`), t, t);
    }

    const result = sweepSessionDirs({ now: T0 + 6 * 60_000, keep: 3 });

    expect(result).toMatchObject({ scanned: 6, removed: 3, kept: 3 });
    // The newest three survive, and a survivor's record still reads back.
    expect(existsSync(path.join(sessions, 'sess-5', 'current-effort.json'))).toBe(true);
    expect(existsSync(path.join(sessions, 'sess-0'))).toBe(false);
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

  it('no writer joins the plugin root and "runtime" for an effort record any more', () => {
    // The pre-O2 spelling, in the three files that wrote or read it by hand.
    for (const rel of [
      ['lib', 'runtime', 'task-budget.js'],
      ['scripts', 'hooks', 'runtime-prompt.js'],
    ]) {
      const source = readFileSync(path.join(PLUGIN_ROOT, ...rel), 'utf8');
      expect(source, rel.join('/')).not.toMatch(/path\.join\(\s*(pluginRoot|root),\s*'runtime'/);
    }
  });
});
