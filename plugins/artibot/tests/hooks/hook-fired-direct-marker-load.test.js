/**
 * OB-24 / R1 follow-up (review R1 SHOULD 2, 2026-09-30) -- what the marker MODULE
 * costs a firing.
 *
 * The session-day marker moved out of `_main-entry.js` (which ~all hooks import
 * for one boolean) into the sibling `_hook-seen-marker.js`. The tap reaches it
 * with a dynamic `import()`, and only for a firing that has cleared its cheap
 * gates, so a hook that never gets that far must not load it. A module that is
 * loaded lazily is only lazy if something shows it is NOT loaded where it should
 * not be; the import-graph pins in `hook-fired-direct-unit.test.js` read the
 * source, this file reads the RUN. The evidence is the one
 * `hook-fired-direct.test.js` uses for the ledger writer: the list of modules the
 * spawned process really loaded, taken from an ESM load hook
 * (`makeLoadLogger`), so "was not loaded" is a fact about the process and not a
 * timing inference.
 *
 * WHAT IS PINNED. Every "not loaded" below has a "loaded" control in this file,
 * run through the same logger, sandbox and spawn path, so a logger that saw
 * nothing could not pass for free.
 *   1. A firing with a session in a work tree loads the marker module; the FIRST
 *      one goes on to load the ledger writer, the SECOND (marker present) stops
 *      at the marker and does not.
 *   2. Nothing that stops before the marker decision loads the marker module: a
 *      payload with no session id (the tap asks `firingSessionId` first), the
 *      recorder switched off, and a dispatcher slot in `hook_event_name` (the
 *      dispatched child of a script that is also a handler).
 *
 * WHAT THIS FILE CANNOT SEE (rules section 9 -- read a green run as no more)
 *   - COST IN TIME. A module list says what loaded, not how long it took. The
 *     extra hop on the marker-present path (one small module loaded before the two
 *     resolvers) was timed by hand and reported with the change, not asserted.
 *   - ONE HOOK. `instructions-loaded.js` stands for the 21 tapping scripts: they
 *     call the same tap through the same line, but only this one is spawned here.
 *   - A NODE WITHOUT `module.register` (before 20.6): the cases skip, as in the
 *     sibling file.
 *
 * @module tests/hooks/hook-fired-direct-marker-load
 */

import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  firedRows, hookSeenDirOf, LOAD_LOGGER_AVAILABLE, makeLoadLogger, makeSandbox, removeSandboxes, spawnScript,
} from '../helpers/hook-fired-harness.js';

afterEach(removeSandboxes);

const MARKER_MODULE = '/scripts/hooks/_hook-seen-marker.js';
const HOOK_MODULE = '/scripts/hooks/instructions-loaded.js';
const WRITER = ['/scripts/hooks/_hook-fired-record.js', '/lib/runtime/ledger.js', '/lib/runtime/event-writer.js'];
const RESOLVERS = ['/lib/project-state/git-common-dir.js', '/lib/project-state/store-location.js'];

const ON = { ARTIBOT_HOOK_FIRED_DIRECT: 'on' };

/** The InstructionsLoaded payload a host sends; `sid` undefined leaves the session id out. */
const payloadFor = (sb, sid, over = {}) => JSON.stringify({
  ...(sid === undefined ? {} : { session_id: sid }),
  transcript_path: path.join(sb.root, 'transcript.jsonl'),
  cwd: sb.repo,
  permission_mode: 'default',
  hook_event_name: 'InstructionsLoaded',
  file_path: path.join(sb.repo, 'CLAUDE.md'),
  memory_type: 'Project',
  load_reason: 'session_start',
  ...over,
});

/** A spawn that records every module the process loads, and a reader for that record. */
function rig(sb) {
  const logger = makeLoadLogger(sb);
  const run = (name, input, env = ON) => spawnScript(sb, 'instructions-loaded.js', {
    input, env: { ...env, ...logger.env(name) }, nodeArgs: logger.nodeArgs,
  });
  const has = (name, tail) => logger.loaded(name).some((url) => url.endsWith(tail));
  return { run, has };
}

// The whole block skips, loudly, on a Node that cannot register the load logger: a case that
// returned early instead would be a green that proved nothing.
describe.skipIf(!LOAD_LOGGER_AVAILABLE)('the marker module is loaded on demand, by a firing that reaches the marker', () => {
  it('first firing: the marker module and the writer load; second (marker present): the marker module only', () => {
    const sb = makeSandbox('mload');
    const { run, has } = rig(sb);
    const sid = randomUUID();

    expect(run('first', payloadFor(sb, sid)).status).toBe(0);
    expect(run('second', payloadFor(sb, sid)).status).toBe(0);

    expect(has('first', HOOK_MODULE), 'the logger really saw the hook load').toBe(true);
    expect(has('first', MARKER_MODULE), 'the first firing loads the marker module').toBe(true);
    for (const m of [...RESOLVERS, ...WRITER]) expect(has('first', m), `the first firing loads ${m}`).toBe(true);

    expect(has('second', MARKER_MODULE), 'the second firing still has to ask the marker').toBe(true);
    for (const m of RESOLVERS) expect(has('second', m), `the second firing loads ${m}`).toBe(true);
    for (const m of WRITER) expect(has('second', m), `the second firing must not load ${m}`).toBe(false);
    expect(firedRows(sb)).toHaveLength(1);
  });

  it.each([
    ['no session id (the tap asks firingSessionId before it imports anything)', { env: ON, sid: undefined, over: {} }],
    ['a blank session id', { env: ON, sid: '   ', over: {} }],
    ['the recorder switched off', { env: { ARTIBOT_HOOK_FIRED_DIRECT: 'off' }, sid: randomUUID(), over: {} }],
    ['a dispatcher slot as hook_event_name (a dispatched child)', { env: ON, sid: randomUUID(), over: { hook_event_name: 'PostToolUse' } }],
    ['an unknown hook_event_name', { env: ON, sid: randomUUID(), over: { hook_event_name: 'FutureHostEvent' } }],
  ])('%s: the marker module is never loaded, nothing is recorded', (_label, { env, sid, over }) => {
    const sb = makeSandbox('mload');
    const { run, has } = rig(sb);

    expect(run('quiet', payloadFor(sb, sid, over), env).status).toBe(0);

    expect(has('quiet', HOOK_MODULE), 'the logger really saw the hook load').toBe(true);
    expect(has('quiet', MARKER_MODULE), 'the marker module must stay unloaded').toBe(false);
    for (const m of [...RESOLVERS, ...WRITER]) expect(has('quiet', m), `${m} must stay unloaded too`).toBe(false);
    expect(existsSync(hookSeenDirOf(sb)), 'no marker directory appears').toBe(false);
    expect(firedRows(sb)).toEqual([]);
  });
});
