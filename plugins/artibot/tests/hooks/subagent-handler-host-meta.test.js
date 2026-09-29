/**
 * SH-19 - the SubagentStop row records the host's own spawn depth and parent,
 * read from the host-written sibling file `agent-<id>.meta.json`.
 *
 * WHY THE STOP HOOK AND NOT START. The R7 recon saw the meta file appear about
 * one second AFTER SubagentStart on 3/3 spawns, so a Start-time read would find
 * nothing. Stop is the first moment the file is expected to exist. The Start row
 * therefore stays exactly as it was (depth null, no new columns).
 *
 * WHY EVERY FAILURE IS "NO VALUE". The meta file is an UNDOCUMENTED host file.
 * A host update can rename its keys, change their types, or stop writing it. The
 * reader takes two keys by name (`spawnDepth`, `parentAgentId`), checks their
 * types, and degrades to null on anything else - missing file, garbled JSON, a
 * JSON value that is not an object, renamed keys, wrong types, an oversize file.
 * The frozen fixture `fixtures/host-files/SubagentMeta.json` holds the key names
 * this was written against; a host that changes them shows up as a fixture diff.
 *
 * THE UNIT IS THE HOST'S. `spawnDepth` is 0 for an in-process teammate. The
 * design canon (ARTIBOT-5.0-DESIGN.md section 7.2, max_depth row) counts the
 * teammate as 1. The reader records the host's number unchanged and labels it
 * `depth_source: 'host-meta'`; no conversion happens anywhere in this path.
 *
 * WHAT THIS FILE DOES NOT PROVE (rules section 9 - the gate's blind spots):
 *   - THE WRITER'S OWN COLUMN RULES. That `parent_agent_id` and `depth_source`
 *     are accepted, scrubbed, nulled on a bad type, and that unknown keys are
 *     still dropped is pinned in `subagent-spawn-ledger.test.js` (SH-19). Here
 *     the columns are read back from the row the real hook wrote.
 *   - THAT A REAL SubagentStop `agent_transcript_path` NAMES `agent-<id>.jsonl`.
 *     No Stop payload was captured for the fixture; the layout is the one
 *     `lib/economics/usage-receipt.js` documents for subagent transcripts.
 *   - THAT A HOST NEWER THAN THE FIXTURE STILL WRITES THE FILE. A missing file is
 *     tested (null, silent); whether it goes missing in production is not.
 *
 * @module tests/hooks/subagent-handler-host-meta
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSpawns, spawnLedgerPath } from '../../lib/learning/ledger/spawn-ledger.js';
import {
  HOST_META_MAX_BYTES, HOST_META_SOURCE, readHostSubagentMeta, stopDepthFields,
} from '../../scripts/hooks/subagent-handler.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'subagent-handler.js');
const FIXTURE_TEXT = readFileSync(path.join(HERE, 'fixtures', 'host-files', 'SubagentMeta.json'), 'utf-8');
const FIXTURE = JSON.parse(FIXTURE_TEXT);

/** A synthetic meta object carrying EVERY key name the frozen fixture lists. */
const metaOf = (over = {}) => ({
  ...Object.fromEntries(FIXTURE.keys_observed.map((k) => [k, `synthetic-${k}`])),
  spawnDepth: 1,
  parentAgentId: 'agent-parent-synth',
  ...over,
});

const NONE = Object.freeze({ depth: null, parentAgentId: null });

// ---------------------------------------------------------------------------
// The frozen fixture
// ---------------------------------------------------------------------------

describe('frozen fixture host-files/SubagentMeta.json', () => {
  it('lists the two keys the reader consumes among the keys it observed', () => {
    expect(FIXTURE.keys_consumed).toEqual(['spawnDepth', 'parentAgentId']);
    for (const key of FIXTURE.keys_consumed) expect(FIXTURE.keys_observed).toContain(key);
    expect(FIXTURE.missing).toEqual([]);
  });

  it('contains key names only: no user path, no tool-use id, no session-id shape', () => {
    expect(FIXTURE_TEXT).not.toMatch(/HeechangLee|toolu_|\/Users\//);
    expect(FIXTURE_TEXT).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('states what it did not measure (fail-closed: an empty list would hide the blind spots)', () => {
    expect(Array.isArray(FIXTURE.not_measured)).toBe(true);
    expect(FIXTURE.not_measured.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// readHostSubagentMeta - the reader, unit level
// ---------------------------------------------------------------------------

describe('readHostSubagentMeta', () => {
  let dir;
  const transcript = (id) => path.join(dir, 'subagents', `agent-${id}.jsonl`);
  const metaFile = (id) => path.join(dir, 'subagents', `agent-${id}.meta.json`);
  const putMeta = (id, body) => writeFileSync(
    metaFile(id),
    typeof body === 'string' ? body : JSON.stringify(body),
  );

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-sh19-unit-')));
    mkdirSync(path.join(dir, 'subagents'));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('POSITIVE CONTROL: a meta file with both keys yields depth and parent', () => {
    putMeta('p1', metaOf({ spawnDepth: 2, parentAgentId: 'agent-parent-synth' }));
    expect(readHostSubagentMeta(transcript('p1'))).toEqual({ depth: 2, parentAgentId: 'agent-parent-synth' });
  });

  it('records depth 0 as 0 (a teammate) - zero is a value, not an absence', () => {
    const { parentAgentId: _dropped, ...noParent } = metaOf({ spawnDepth: 0 });
    putMeta('t0', noParent);
    expect(readHostSubagentMeta(transcript('t0'))).toEqual({ depth: 0, parentAgentId: null });
  });

  it('keeps a parent when the depth is unusable, and the depth when the parent is absent', () => {
    putMeta('a', metaOf({ spawnDepth: 'deep' }));
    expect(readHostSubagentMeta(transcript('a'))).toEqual({ depth: null, parentAgentId: 'agent-parent-synth' });
    const { parentAgentId: _dropped, ...noParent } = metaOf({ spawnDepth: 3 });
    putMeta('b', noParent);
    expect(readHostSubagentMeta(transcript('b'))).toEqual({ depth: 3, parentAgentId: null });
  });

  it('extracts ONLY the two keys - nothing else in the file can reach the result', () => {
    putMeta('s1', metaOf({
      description: 'SENTINEL-DESC-SH19', worktreePath: 'SENTINEL-PATH-SH19', name: 'SENTINEL-NAME-SH19',
    }));
    const result = readHostSubagentMeta(transcript('s1'));
    expect(Object.keys(result).sort()).toEqual(['depth', 'parentAgentId']);
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });

  describe('NEGATIVE CONTROLS - every failure is "no value", never a throw', () => {
    it('meta file missing', () => {
      expect(readHostSubagentMeta(transcript('missing'))).toEqual(NONE);
    });

    it.each([
      ['garbled JSON', '{"spawnDepth": 1, "parentAg'],
      ['empty file', ''],
      ['a JSON array', '[1, 2, 3]'],
      ['a JSON string', '"spawnDepth"'],
      ['JSON null', 'null'],
      ['a JSON number', '7'],
    ])('%s', (_label, body) => {
      putMeta('bad', body);
      expect(readHostSubagentMeta(transcript('bad'))).toEqual(NONE);
    });

    it.each([
      ['snake_case rename', { spawn_depth: 1, parent_agent_id: 'x' }],
      ['short rename', { depth: 1, parent: 'x' }],
      ['upper-case rename', { SpawnDepth: 1, ParentAgentId: 'x' }],
      ['nested under a new key', { spawn: { spawnDepth: 1, parentAgentId: 'x' } }],
    ])('new key names (%s) are not guessed at', (_label, body) => {
      putMeta('renamed', body);
      expect(readHostSubagentMeta(transcript('renamed'))).toEqual(NONE);
    });

    it.each([
      ['string depth', { spawnDepth: '1' }],
      ['negative depth', { spawnDepth: -1 }],
      ['fractional depth', { spawnDepth: 1.5 }],
      ['null depth', { spawnDepth: null }],
      ['boolean depth', { spawnDepth: true }],
      ['array depth', { spawnDepth: [1] }],
      ['numeric parent', { parentAgentId: 7 }],
      ['empty parent', { parentAgentId: '' }],
      ['blank parent', { parentAgentId: '   ' }],
      ['object parent', { parentAgentId: { id: 'x' } }],
    ])('wrong type or shape (%s) yields null for that key', (_label, body) => {
      putMeta('typed', body);
      expect(readHostSubagentMeta(transcript('typed'))).toEqual(NONE);
    });

    it('an oversize file is not read', () => {
      putMeta('big', JSON.stringify({ spawnDepth: 1, parentAgentId: 'x', pad: 'x'.repeat(HOST_META_MAX_BYTES + 1) }));
      expect(readHostSubagentMeta(transcript('big'))).toEqual(NONE);
    });

    it('a directory where the meta file should be', () => {
      mkdirSync(metaFile('dir'));
      expect(readHostSubagentMeta(transcript('dir'))).toEqual(NONE);
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 42],
      ['an object', { path: 'x' }],
      ['an empty string', ''],
      ['a path with no extension', 'agent-x'],
      ['a non-jsonl transcript', 'agent-x.txt'],
    ])('transcript path that is %s', (_label, value) => {
      expect(readHostSubagentMeta(value)).toEqual(NONE);
    });
  });
});

// ---------------------------------------------------------------------------
// stopDepthFields - exactly what the spawn writer is handed for a STOP row
// ---------------------------------------------------------------------------

describe('stopDepthFields', () => {
  let dir;
  const transcript = (id) => path.join(dir, 'subagents', `agent-${id}.jsonl`);
  const putMeta = (id, body) => writeFileSync(path.join(dir, 'subagents', `agent-${id}.meta.json`), JSON.stringify(body));

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-sh19-fields-')));
    mkdirSync(path.join(dir, 'subagents'));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('labels a depth that came from the meta file with the source, and passes the parent', () => {
    putMeta('f1', metaOf({ spawnDepth: 1 }));
    expect(HOST_META_SOURCE).toBe('host-meta');
    expect(stopDepthFields({ agent_transcript_path: transcript('f1') })).toEqual({
      depth: 1, parent_agent_id: 'agent-parent-synth', depth_source: 'host-meta',
    });
  });

  it('a teammate (host depth 0) is recorded as 0 with the host-meta label, unconverted', () => {
    const { parentAgentId: _dropped, ...noParent } = metaOf({ spawnDepth: 0 });
    putMeta('f0', noParent);
    expect(stopDepthFields({ agent_transcript_path: transcript('f0') })).toEqual({
      depth: 0, parent_agent_id: null, depth_source: 'host-meta',
    });
  });

  it('with nothing readable every column is an explicit null (measured nothing), not absent', () => {
    expect(stopDepthFields({ agent_transcript_path: transcript('nope') })).toEqual({
      depth: null, parent_agent_id: null, depth_source: null,
    });
    expect(stopDepthFields({})).toEqual({ depth: null, parent_agent_id: null, depth_source: null });
  });

  it('a depth the payload itself carries keeps winning and is NOT relabelled host-meta', () => {
    putMeta('f2', metaOf({ spawnDepth: 1 }));
    expect(stopDepthFields({ depth: 3, agent_transcript_path: transcript('f2') })).toEqual({
      depth: 3, parent_agent_id: 'agent-parent-synth', depth_source: null,
    });
  });

  it('a parent without a depth carries no depth_source (the label describes the depth)', () => {
    putMeta('f3', metaOf({ spawnDepth: 'x' }));
    expect(stopDepthFields({ agent_transcript_path: transcript('f3') })).toEqual({
      depth: null, parent_agent_id: 'agent-parent-synth', depth_source: null,
    });
  });

  it.each([undefined, null, 42, 'text', []])('never throws on hook data %j', (value) => {
    expect(() => stopDepthFields(value)).not.toThrow();
    expect(stopDepthFields(value)).toEqual({ depth: null, parent_agent_id: null, depth_source: null });
  });
});

// ---------------------------------------------------------------------------
// The hook itself, as a child process - what actually lands on disk
// ---------------------------------------------------------------------------

describe('subagent-handler stop/start (child process)', () => {
  let tmp;
  let home;
  let repo;
  let subDir;

  const AGENT = 'sh19a1';
  const transcriptPath = () => path.join(subDir, `agent-${AGENT}.jsonl`);
  const putMeta = (body) => writeFileSync(
    path.join(subDir, `agent-${AGENT}.meta.json`),
    typeof body === 'string' ? body : JSON.stringify(body),
  );

  const stopPayload = (over = {}) => ({
    session_id: 'sess-sh19-1',
    agent_id: AGENT,
    agent_type: 'tdd-guide',
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    agent_transcript_path: transcriptPath(),
    last_assistant_message: 'ok',
    cwd: repo,
    ...over,
  });

  const startPayload = (over = {}) => ({
    session_id: 'sess-sh19-1',
    agent_id: AGENT,
    agent_type: 'tdd-guide',
    hook_event_name: 'SubagentStart',
    prompt_id: 'pid-sh19-1',
    cwd: repo,
    ...over,
  });

  function run(payload, action) {
    const res = spawnSync(process.execPath, [HOOK, action], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
      windowsHide: true,
    });
    return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
  }

  const rows = (event) => readSpawns(repo, { sessionId: 'sess-sh19-1' }).filter((r) => r.event === event);
  const lastStop = () => rows('stop').at(-1);

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-sh19-hook-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    subDir = path.join(tmp, 'projects', 'slug', 'sess', 'subagents');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(subDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('POSITIVE CONTROL: a stop with a readable meta file records depth, parent and source on the stop row', () => {
    putMeta(metaOf({ spawnDepth: 1, description: 'SENTINEL-DESC-SH19', worktreePath: 'SENTINEL-PATH-SH19' }));
    const r = run(stopPayload(), 'stop');
    expect(r.status).toBe(0);
    expect(lastStop()).toMatchObject({ depth: 1, parent_agent_id: 'agent-parent-synth', depth_source: 'host-meta' });

    // Nothing else from the meta file crosses into the ledger, stdout or stderr.
    const rawLedger = readFileSync(spawnLedgerPath(repo), 'utf-8');
    for (const text of [rawLedger, r.stdout, r.stderr]) expect(text).not.toContain('SENTINEL');
  });

  it('a teammate stop (host depth 0) records 0, not null', () => {
    const { parentAgentId: _dropped, ...noParent } = metaOf({ spawnDepth: 0 });
    putMeta(noParent);
    expect(run(stopPayload(), 'stop').status).toBe(0);
    // Unconverted host unit, labelled: the design canon counts a teammate as 1.
    expect(lastStop()).toMatchObject({ depth: 0, parent_agent_id: null, depth_source: 'host-meta' });
  });

  it('stdout and exit code are byte-identical with and without the meta file (record only)', () => {
    const without = run(stopPayload(), 'stop');
    putMeta(metaOf({ spawnDepth: 2 }));
    const withMeta = run(stopPayload(), 'stop');
    expect(withMeta.status).toBe(without.status);
    expect(withMeta.stdout).toBe(without.stdout);
    expect(withMeta.stderr).toBe(without.stderr);
    expect(rows('stop').map((r) => r.depth)).toEqual([null, 2]);
    expect(rows('stop').map((r) => r.depth_source)).toEqual([null, 'host-meta']);
  });

  describe.each([
    ['meta file missing', null],
    ['garbled JSON', '{"spawnDepth": 1, "parentAg'],
    ['a JSON array', '[1]'],
    ['new key names', JSON.stringify({ spawn_depth: 1, parent_agent_id: 'x' })],
    ['string depth', JSON.stringify({ spawnDepth: '1' })],
    ['negative depth', JSON.stringify({ spawnDepth: -1 })],
  ])('NEGATIVE CONTROL - %s', (_label, body) => {
    it('records depth null, exits 0, and prints exactly what a payload with no path prints', () => {
      const control = run(stopPayload({ agent_transcript_path: undefined }), 'stop');
      if (body !== null) putMeta(body);
      const r = run(stopPayload(), 'stop');
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(control.stdout);
      expect(r.stderr).toBe('');
      // Explicit nulls, keys present: "read it, found nothing" is not "not produced".
      expect(lastStop()).toMatchObject({ depth: null, parent_agent_id: null, depth_source: null });
    });
  });

  it('a stop payload with no agent_transcript_path at all still records depth null', () => {
    putMeta(metaOf({ spawnDepth: 1 }));
    expect(run(stopPayload({ agent_transcript_path: undefined }), 'stop').status).toBe(0);
    expect(lastStop()).toMatchObject({ depth: null, parent_agent_id: null, depth_source: null });
  });

  it('the START row is untouched: it never reads the meta file and gains no column', () => {
    const control = run(startPayload(), 'start');
    expect(control.status).toBe(0);
    const [controlRow] = rows('start');

    // Same spawn, but now the payload names a transcript with a meta file beside it.
    putMeta(metaOf({ spawnDepth: 2 }));
    const r = run(startPayload({ agent_transcript_path: transcriptPath() }), 'start');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(control.stdout);
    const startRows = rows('start');
    expect(startRows).toHaveLength(2);
    expect(startRows[1].depth).toBeNull();
    expect(Object.keys(startRows[1])).toEqual(Object.keys(controlRow));
    expect(startRows[1]).not.toHaveProperty('parent_agent_id');
    expect(startRows[1]).not.toHaveProperty('depth_source');
  });
});
