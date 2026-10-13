/**
 * The SubagentStop row records the model that was actually SERVED, read from the
 * subagent's own transcript, beside the policy tier it already carried.
 *
 * WHY THIS EXISTS. `canonicalModel` is the agent definition's POLICY tier
 * (`resolveModel`, or the bound receipt's definition re-resolved). It is not what
 * the host served: `/model-routing` passes `model: "sonnet"` on the Agent call, the
 * host serves `claude-sonnet-5-5`, and the row kept saying `opus`. Measured
 * 2026-10-13 on this repo's spawn ledger: `requestedModel` was null on 0 of 1,527
 * start rows and 0 of 8,270 stop rows, `modelMismatch` was true on 0 of 9,797.
 * Neither SubagentStart nor SubagentStop carries a model key, so START cannot know;
 * the transcript named by the STOP payload's `agent_transcript_path` can.
 *
 * WHAT IS PINNED HERE
 *   - `readServedModel` returns the id of the last REAL assistant turn and the
 *     catalog tier of that id (qualifiers `[1m]` and `-YYYYMMDD` stripped), and
 *     nothing else from the transcript can reach its result.
 *   - `servedFields` adds `servedDrift` (served tier versus policy tier, intended
 *     routes included, not an error signal) and does not touch `modelMismatch`,
 *     which keeps its START meaning (requested model versus policy tier). Under
 *     `/model-routing` a sonnet build teammate is an intended route: it reads
 *     `servedDrift: true` and `modelMismatch: false`.
 *   - The hook, as a child process, writes those columns on the STOP row and the
 *     state entry, leaves the START row byte-shaped as before, and prints exactly
 *     what it printed before.
 *
 * WHAT THIS FILE DOES NOT PROVE (rules section 9 - the gate's blind spots):
 *   - THAT THE HOST HAS FLUSHED THE LAST ASSISTANT ROW BEFORE SubagentStop FIRES.
 *     The fixtures are complete files. If the final row is late, the read still
 *     finds the earlier turns of the same model; if there is none it records null.
 *   - THAT A REAL SubagentStop PAYLOAD NAMES THE SUBAGENT TRANSCRIPT in
 *     `agent_transcript_path`. The payloads below are hand-written to that shape.
 *     Live evidence is indirect: stop rows with `depth_source: host-meta` exist only
 *     when that path named `agent-<id>.jsonl` beside a readable meta file.
 *   - TRANSCRIPT SIZES OF PRODUCTION. Fixtures are a few hundred bytes; the window
 *     cases size their filler from the exported SERVED_TAIL_BYTES instead.
 *
 * @module tests/hooks/subagent-handler-served-model
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../lib/core/config.js';
import { getModel } from '../../lib/core/model-catalog.js';
import { resolveModel } from '../../lib/core/model-policy.js';
import { readSpawns, spawnLedgerPath } from '../../lib/learning/ledger/spawn-ledger.js';
import {
  readServedModel, SERVED_TAIL_BYTES, servedFields,
} from '../../scripts/hooks/subagent-handler.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'subagent-handler.js');

const SONNET = getModel('sonnet').id;
const OPUS = getModel('opus').id;
const NONE = Object.freeze({ servedModel: null, servedTier: null });

const userRow = (text = 'the prompt') => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const assistantRow = (model, text = 'ok') => JSON.stringify({
  type: 'assistant', message: { model, role: 'assistant', content: [{ type: 'text', text }] },
});

// ---------------------------------------------------------------------------
// readServedModel - the reader, unit level
// ---------------------------------------------------------------------------

describe('readServedModel', () => {
  let dir;
  const file = (name = 'agent-x.jsonl') => path.join(dir, name);
  const put = (rows, name) => writeFileSync(file(name), `${rows.join('\n')}\n`);

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-served-unit-')));
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('POSITIVE CONTROL: the id and tier of the assistant turn', () => {
    put([userRow(), assistantRow(SONNET)]);
    expect(readServedModel(file())).toEqual({ servedModel: SONNET, servedTier: 'sonnet' });
  });

  it('the LAST real turn wins when the transcript holds more than one', () => {
    put([userRow(), assistantRow(OPUS), userRow('again'), assistantRow(SONNET)]);
    expect(readServedModel(file())).toEqual({ servedModel: SONNET, servedTier: 'sonnet' });
  });

  it('scans past the host placeholder <synthetic> to the real turn before it', () => {
    put([userRow(), assistantRow(OPUS), assistantRow('<synthetic>', 'No response requested.')]);
    expect(readServedModel(file())).toEqual({ servedModel: OPUS, servedTier: 'opus' });
  });

  it('a transcript with only <synthetic> turns is unobservable, not "synthetic"', () => {
    put([userRow(), assistantRow('<synthetic>')]);
    expect(readServedModel(file())).toEqual(NONE);
  });

  it('keeps the id as served and resolves the tier through the transcript qualifiers', () => {
    // `[1m]` is the 1M-context variant; `-YYYYMMDD` a dated snapshot. The bare catalog id
    // is not what the transcript carries, and tierForModelId alone would answer null.
    put([assistantRow(`${OPUS}[1m]`)]);
    expect(readServedModel(file())).toEqual({ servedModel: `${OPUS}[1m]`, servedTier: 'opus' });
    const dated = `${getModel('haiku').id}-20251001`;
    put([assistantRow(dated)]);
    expect(readServedModel(file())).toEqual({ servedModel: dated, servedTier: 'haiku' });
  });

  it('an id the catalog does not name is recorded as served with a null tier', () => {
    put([assistantRow('claude-mystery-9')]);
    expect(readServedModel(file())).toEqual({ servedModel: 'claude-mystery-9', servedTier: null });
  });

  it('only assistant rows count: a model on a user or attachment row is not a served model', () => {
    put([
      assistantRow(SONNET),
      JSON.stringify({ type: 'user', message: { role: 'user', model: OPUS, content: 'x' } }),
      JSON.stringify({ type: 'attachment', message: { model: OPUS } }),
    ]);
    expect(readServedModel(file())).toEqual({ servedModel: SONNET, servedTier: 'sonnet' });
  });

  it('an assistant row without a usable model is skipped for the one before it', () => {
    put([
      assistantRow(SONNET),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }),
      assistantRow(''),
      assistantRow(7),
    ]);
    expect(readServedModel(file())).toEqual({ servedModel: SONNET, servedTier: 'sonnet' });
  });

  it('extracts ONLY message.model - nothing else in the transcript can reach the result', () => {
    put([
      userRow('SENTINEL-PROMPT-SERVED'),
      JSON.stringify({
        type: 'assistant',
        cwd: 'SENTINEL-CWD-SERVED',
        message: { model: SONNET, role: 'assistant', content: [{ type: 'text', text: 'SENTINEL-TEXT-SERVED' }] },
      }),
    ]);
    const result = readServedModel(file());
    expect(Object.keys(result).sort()).toEqual(['servedModel', 'servedTier']);
    expect(JSON.stringify(result)).not.toContain('SENTINEL');
  });

  it('caps the id at 128 characters - the only length bound on the live row', () => {
    // The ledger writer scrubs string columns and caps none of them.
    put([assistantRow('m'.repeat(300))]);
    expect(readServedModel(file()).servedModel).toBe('m'.repeat(128));
  });

  describe('the tail window', () => {
    const filler = (n) => Array.from({ length: n }, (_, i) => userRow(`filler-${i}-${'x'.repeat(900)}`));
    const rowsFor = (bytes) => filler(Math.ceil(bytes / 950));

    it('finds the last turn of a transcript larger than the window', () => {
      put([assistantRow(OPUS), ...rowsFor(SERVED_TAIL_BYTES * 2), assistantRow(SONNET)]);
      expect(readServedModel(file())).toEqual({ servedModel: SONNET, servedTier: 'sonnet' });
    });

    it('a turn older than the window is not found: null, never the wrong model', () => {
      put([assistantRow(OPUS), ...rowsFor(SERVED_TAIL_BYTES * 2)]);
      expect(readServedModel(file())).toEqual(NONE);
    });

    it('one line larger than the window yields null and does not throw', () => {
      put([assistantRow(OPUS), assistantRow(SONNET, 'y'.repeat(SERVED_TAIL_BYTES + 4096))]);
      expect(() => readServedModel(file())).not.toThrow();
      expect(readServedModel(file())).toEqual(NONE);
    });
  });

  describe('NEGATIVE CONTROLS - every failure is "no value", never a throw', () => {
    it('file missing', () => {
      expect(readServedModel(file('agent-missing.jsonl'))).toEqual(NONE);
    });

    it('empty file', () => {
      writeFileSync(file(), '');
      expect(readServedModel(file())).toEqual(NONE);
    });

    it('garbled lines are skipped and the rest still read', () => {
      put(['{"type":"assistant","message":{"model":', '[1,2,3]', '"text"', 'null', assistantRow(SONNET), '{"type":"assis']);
      expect(readServedModel(file())).toEqual({ servedModel: SONNET, servedTier: 'sonnet' });
    });

    it('a directory where the transcript should be', () => {
      mkdirSync(file('agent-dir.jsonl'));
      expect(readServedModel(file('agent-dir.jsonl'))).toEqual(NONE);
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 42],
      ['an object', { path: 'x' }],
      ['an empty string', ''],
      ['a path with no extension', 'agent-x'],
      ['a non-jsonl path', 'agent-x.txt'],
    ])('transcript path that is %s', (_label, value) => {
      expect(readServedModel(value)).toEqual(NONE);
    });

    it('a non-jsonl file is not read even when it exists and holds an assistant row', () => {
      put([assistantRow(SONNET)], 'agent-x.txt');
      expect(readServedModel(file('agent-x.txt'))).toEqual(NONE);
    });
  });
});

// ---------------------------------------------------------------------------
// servedFields - what a STOP adds to the tracked START entry
// ---------------------------------------------------------------------------

describe('servedFields', () => {
  const served = (tier, model = `served-${tier}`) => ({ servedModel: model, servedTier: tier });

  it('passes the served model and tier through; canonicalModel and modelMismatch are not its to return', () => {
    const out = servedFields({ canonicalModel: 'opus', modelMismatch: false }, served('opus'));
    expect(out).toEqual({ servedModel: 'served-opus', servedTier: 'opus', servedDrift: false });
    expect(out).not.toHaveProperty('canonicalModel');
    expect(out).not.toHaveProperty('modelMismatch');
  });

  it('servedDrift is true when the served tier is not the policy tier', () => {
    expect(servedFields({ canonicalModel: 'opus', modelMismatch: false }, served('sonnet')).servedDrift).toBe(true);
  });

  it('NEGATIVE CONTROL: drift is not a mismatch - it never reaches modelMismatch', () => {
    // An intended route (a sonnet build teammate under /model-routing) must not read as a START-meaning mismatch.
    const out = servedFields({ canonicalModel: 'opus', modelMismatch: false }, served('sonnet'));
    expect(out.servedDrift).toBe(true);
    expect(out).not.toHaveProperty('modelMismatch');
  });

  it('servedDrift answers only the tier comparison: a START flag already raised does not make it true', () => {
    expect(servedFields({ canonicalModel: 'opus', modelMismatch: true }, served('opus')).servedDrift).toBe(false);
  });

  it.each([
    ['no served tier (unobservable)', { canonicalModel: 'opus' }, NONE],
    ['a served id the catalog does not name', { canonicalModel: 'opus' }, { servedModel: 'claude-mystery-9', servedTier: null }],
    ['no policy tier (not a policy agent)', { canonicalModel: null }, served('sonnet')],
    ['an empty policy tier', { canonicalModel: '' }, served('sonnet')],
    ['an untracked stop', undefined, served('sonnet')],
  ])('cannot judge drift with %s: servedDrift stays false', (_label, tracked, servedIn) => {
    expect(servedFields(tracked, servedIn).servedDrift).toBe(false);
  });

  it('an untracked stop still carries the served model it observed', () => {
    expect(servedFields(undefined, served('sonnet'))).toEqual({
      servedModel: 'served-sonnet', servedTier: 'sonnet', servedDrift: false,
    });
  });

  it('does not mutate its inputs', () => {
    const tracked = Object.freeze({ canonicalModel: 'opus', modelMismatch: false });
    const input = Object.freeze({ ...served('sonnet') });
    expect(() => servedFields(tracked, input)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The hook itself, as a child process - what actually lands on disk
// ---------------------------------------------------------------------------

describe('subagent-handler start/stop (child process) - served model', () => {
  let tmp;
  let home;
  let repo;
  let subDir;
  let policyTier;
  let otherTier;
  let otherId;

  const AGENT = 'srv1';
  const SESSION = 'sess-served-1';
  const transcriptPath = () => path.join(subDir, `agent-${AGENT}.jsonl`);
  const putTranscript = (rows) => writeFileSync(transcriptPath(), `${rows.join('\n')}\n`);

  const startPayload = (over = {}) => ({
    session_id: SESSION,
    agent_id: AGENT,
    agent_type: 'tdd-guide',
    hook_event_name: 'SubagentStart',
    prompt_id: 'pid-served-1',
    cwd: repo,
    ...over,
  });
  const stopPayload = (over = {}) => ({
    session_id: SESSION,
    agent_id: AGENT,
    agent_type: 'tdd-guide',
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    agent_transcript_path: transcriptPath(),
    last_assistant_message: 'ok',
    cwd: repo,
    ...over,
  });

  function run(payload, action) {
    const res = spawnSync(process.execPath, [HOOK, action], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      // The host session ids must not leak into the child: both are blanked.
      env: {
        ...process.env, HOME: home, USERPROFILE: home, CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '',
      },
      windowsHide: true,
    });
    return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
  }

  const rows = (event) => readSpawns(repo, { sessionId: SESSION }).filter((r) => r.event === event);
  const lastStop = () => rows('stop').at(-1);
  const stateEntry = () => JSON.parse(
    readFileSync(path.join(home, '.claude', 'artibot-state.json'), 'utf-8'),
  ).agents[AGENT];

  beforeEach(async () => {
    tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-served-hook-')));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    subDir = path.join(tmp, 'projects', 'slug', 'sess', 'subagents');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(subDir, { recursive: true });
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
    // The policy tier of the agent under test, from the policy itself so a tier change
    // cannot rot the fixtures; the "other" tier is any tier it is not.
    policyTier = resolveModel('tdd-guide', {}, await loadConfig());
    otherTier = policyTier === 'sonnet' ? 'opus' : 'sonnet';
    otherId = getModel(otherTier).id;
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  });

  it('POSITIVE CONTROL: served tier differs from policy -> served columns and servedDrift, modelMismatch untouched', () => {
    expect(run(startPayload(), 'start').status).toBe(0);
    putTranscript([userRow(), assistantRow(otherId)]);
    const r = run(stopPayload(), 'stop');
    expect(r.status).toBe(0);

    const [start] = rows('start');
    const stop = lastStop();
    // An intended route (a sonnet build teammate under /model-routing) is drift, not a START-meaning mismatch.
    expect(stop).toMatchObject({
      servedModel: otherId, servedTier: otherTier, servedDrift: true, modelMismatch: false,
    });
    // canonicalModel keeps its meaning (policy) and the two rows of one spawn agree on it.
    expect(stop.canonicalModel).toBe(policyTier);
    expect(stop.canonicalModel).toBe(start.canonicalModel);

    // The state entry (what `artibot-state.json#agents[id]` shows) carries the same facts.
    expect(stateEntry()).toMatchObject({
      active: false,
      canonicalModel: policyTier,
      servedModel: otherId,
      servedTier: otherTier,
      servedDrift: true,
      modelMismatch: false,
    });
  });

  it('served tier equals policy -> served columns present, servedDrift false, no mismatch', () => {
    const policyId = getModel(policyTier).id;
    expect(run(startPayload(), 'start').status).toBe(0);
    putTranscript([userRow(), assistantRow(policyId)]);
    expect(run(stopPayload(), 'stop').status).toBe(0);
    const expected = { servedModel: policyId, servedTier: policyTier, servedDrift: false, modelMismatch: false };
    expect(lastStop()).toMatchObject(expected);
    expect(stateEntry()).toMatchObject(expected);
  });

  it('a [1m] served variant is compared by tier, not by string', () => {
    const policyId = getModel(policyTier).id;
    expect(run(startPayload(), 'start').status).toBe(0);
    putTranscript([assistantRow(`${policyId}[1m]`)]);
    expect(run(stopPayload(), 'stop').status).toBe(0);
    expect(lastStop()).toMatchObject({
      servedModel: `${policyId}[1m]`, servedTier: policyTier, servedDrift: false, modelMismatch: false,
    });
  });

  it('modelMismatch keeps its START meaning: a flag raised on a requested model stays raised and servedDrift stays false', () => {
    expect(run(startPayload({ model: otherTier }), 'start').status).toBe(0);
    expect(rows('start')[0].modelMismatch).toBe(true);
    putTranscript([assistantRow(getModel(policyTier).id)]);
    expect(run(stopPayload(), 'stop').status).toBe(0);
    expect(lastStop()).toMatchObject({ modelMismatch: true, servedDrift: false });
    expect(stateEntry()).toMatchObject({ modelMismatch: true, servedDrift: false });
  });

  it('the two flags are independent: a raised START flag and a served drift both read true', () => {
    expect(run(startPayload({ model: otherTier }), 'start').status).toBe(0);
    putTranscript([assistantRow(otherId)]);
    expect(run(stopPayload(), 'stop').status).toBe(0);
    expect(lastStop()).toMatchObject({ modelMismatch: true, servedDrift: true });
  });

  it('the START row is untouched: it gains no served column and no servedDrift', () => {
    expect(run(startPayload(), 'start').status).toBe(0);
    const [start] = rows('start');
    expect(start).not.toHaveProperty('servedModel');
    expect(start).not.toHaveProperty('servedTier');
    expect(start).not.toHaveProperty('servedDrift');
    expect(start.requestedModel).toBeNull();
    expect(start.modelMismatch).toBe(false);
  });

  it('stdout and exit code are byte-identical with and without a readable transcript (record only)', () => {
    expect(run(startPayload(), 'start').status).toBe(0);
    const without = run(stopPayload(), 'stop');
    putTranscript([assistantRow(otherId, 'SENTINEL-TEXT-SERVED')]);
    const withTranscript = run(stopPayload(), 'stop');
    expect(withTranscript.status).toBe(without.status);
    expect(withTranscript.stdout).toBe(without.stdout);
    expect(withTranscript.stderr).toBe(without.stderr);
    expect(rows('stop').map((r) => r.servedModel)).toEqual([null, otherId]);

    // Nothing from the transcript body crosses into the ledger, stdout or stderr.
    const rawLedger = readFileSync(spawnLedgerPath(repo), 'utf-8');
    for (const text of [rawLedger, withTranscript.stdout, withTranscript.stderr]) {
      expect(text).not.toContain('SENTINEL');
    }
  });

  describe.each([
    ['no transcript file', null],
    ['an empty transcript', []],
    ['only <synthetic> turns', [assistantRow('<synthetic>')]],
    ['only user turns', [userRow(), userRow('again')]],
  ])('NEGATIVE CONTROL - %s', (_label, body) => {
    it('records explicit nulls (read, found nothing), servedDrift false, no mismatch, exit 0', () => {
      expect(run(startPayload(), 'start').status).toBe(0);
      if (body !== null) putTranscript(body);
      const r = run(stopPayload(), 'stop');
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      const stop = lastStop();
      expect(stop).toHaveProperty('servedModel', null);
      expect(stop).toHaveProperty('servedTier', null);
      expect(stop).toHaveProperty('servedDrift', false);
      expect(stop.modelMismatch).toBe(false);
      expect(stop.canonicalModel).toBe(policyTier);
    });
  });

  it('a served id the catalog does not name is recorded as served and judged neither way', () => {
    expect(run(startPayload(), 'start').status).toBe(0);
    putTranscript([assistantRow('claude-mystery-9')]);
    expect(run(stopPayload(), 'stop').status).toBe(0);
    expect(lastStop()).toMatchObject({
      servedModel: 'claude-mystery-9', servedTier: null, servedDrift: false, modelMismatch: false,
    });
  });

  it('a stop payload with no agent_transcript_path records explicit nulls', () => {
    expect(run(startPayload(), 'start').status).toBe(0);
    putTranscript([assistantRow(otherId)]);
    expect(run(stopPayload({ agent_transcript_path: undefined }), 'stop').status).toBe(0);
    expect(lastStop()).toMatchObject({ servedModel: null, servedTier: null, servedDrift: false, modelMismatch: false });
  });

  it('an untracked stop (no START) still records what it served, and no drift or mismatch', () => {
    putTranscript([assistantRow(otherId)]);
    expect(run(stopPayload({ agent_id: AGENT }), 'stop').status).toBe(0);
    expect(lastStop()).toMatchObject({
      servedModel: otherId, servedTier: otherTier, servedDrift: false, modelMismatch: false, canonicalModel: null,
    });
  });
});
