/**
 * OB-24 / R1 `ob24-direct-hook-carrier` -- the IN-PROCESS half of the direct-hook
 * suite: the slot allowlist, the pure envelope, the payload snapshot, the
 * session rule, the recording switch, the tap itself, the repository finder, the
 * import-graph pins of `_main-entry.js` and its sibling `_hook-seen-marker.js`,
 * and the no-spawn guarantee. The spawned half (every registration run for real,
 * byte identity, fail-silent, linked worktree, double count) is
 * `hook-fired-direct.test.js`; the deny-branch bytes are
 * `hook-fired-direct-deny.test.js`; what the marker module costs a firing is
 * read from the process's module log in `hook-fired-direct-marker-load.test.js`;
 * shared plumbing is `tests/helpers/hook-fired-harness.js`.
 *
 * WHAT THIS FILE CANNOT SEE (rules section 9)
 *   - IT DOES NOT RUN A HOOK. Everything here calls exported functions. That the
 *     21 scripts actually call the tap, and that a row survives a real process
 *     exit, is the sibling file's job; a green run here says only that the
 *     pieces behave.
 *   - THE VITEST DEFAULT IS THIS RUNNER'S. `directRecordingEnabled` reads
 *     `VITEST`, which this process has because it is a vitest worker; the cases
 *     pass an explicit `env` so they do not depend on that, except the one that
 *     says so.
 *
 * @module tests/hooks/hook-fired-direct-unit
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DISPATCHER_SLOTS, HOOKS_DIR, MAIN_ENTRY_URL, makeLinkedWorktree, makeSandbox, PER_EVENT, PLUGIN_ROOT,
  RECORDER_URL, removeSandboxes, TABLE,
} from '../helpers/hook-fired-harness.js';
import { ledgerFilePath } from '../../lib/runtime/ledger.js';

// Namespace imports, read lazily: on a tree without the R1 change the suite
// must fail on BEHAVIOUR, not die at link time on a missing name.
let rec;
let entry;

beforeAll(async () => {
  rec = await import(RECORDER_URL);
  entry = await import(MAIN_ENTRY_URL);
});

afterEach(() => {
  vi.doUnmock('node:child_process');
  removeSandboxes();
});

const SID = randomUUID();
const payload = (over = {}) => ({
  session_id: SID,
  transcript_path: '/tmp/t.jsonl',
  cwd: '/tmp/some-repo',
  permission_mode: 'default',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_use_id: 'toolu_r1_unit',
  ...over,
});

describe('DIRECT_HOOK_SLOTS: an allowlist of the host events that have no dispatcher', () => {
  it('is exactly the set of events with a direct registration, and disjoint from the dispatcher slots', () => {
    expect([...entry.DIRECT_HOOK_SLOTS].sort()).toEqual(Object.keys(PER_EVENT).sort());
    for (const slot of DISPATCHER_SLOTS) expect(entry.DIRECT_HOOK_SLOTS).not.toContain(slot);
  });

  it('is a frozen array, so nothing widens it at runtime', () => {
    // `Object.isFrozen(undefined)` is true, so assert that the export exists first.
    expect(Array.isArray(entry.DIRECT_HOOK_SLOTS)).toBe(true);
    expect(Object.isFrozen(entry.DIRECT_HOOK_SLOTS)).toBe(true);
  });
});

describe('buildDirectHookFiredEnvelope: one row for one hook (which firing earns it is the tap\'s marker)', () => {
  it('builds the hook.fired envelope with a single-element hooks array', () => {
    const env = rec.buildDirectHookFiredEnvelope({ hook: 'pre-bash', payload: payload() });
    expect(env).toMatchObject({
      event: 'hook.fired',
      session_id: SID,
      source: 'hook',
      action_id: 'toolu_r1_unit',
      data: { slot: 'PreToolUse', hooks: ['pre-bash'], failed: [], count: 1 },
    });
    expect(env.mission_id).toMatch(/^M-\d{8}-S[0-9A-Za-z]{8}$/);
    // `tool` is documented for the PostToolUse slot only; an omitted key is the honest record.
    expect('tool' in env.data).toBe(false);
  });

  it('omits action_id rather than writing an empty one when the payload has no correlation key', () => {
    const env = rec.buildDirectHookFiredEnvelope({
      hook: 'context-tracker',
      payload: payload({ hook_event_name: 'Notification', tool_use_id: undefined }),
    });
    expect(env).not.toBeNull();
    expect('action_id' in env).toBe(false);
  });

  it.each(DISPATCHER_SLOTS)('refuses the dispatcher-owned slot %s: the dispatcher writes that row', (slot) => {
    expect(rec.buildDirectHookFiredEnvelope({ hook: 'tool-tracker', payload: payload({ hook_event_name: slot }) })).toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['blank', ''],
    ['wrong case', 'pretooluse'],
    ['padded', 'PreToolUse '],
    ['a number', 42],
    ['null', null],
    ['an unknown event', 'FutureHostEvent'],
  ])('refuses hook_event_name that is %s (allowlist, fail-closed)', (_label, value) => {
    expect(rec.buildDirectHookFiredEnvelope({ hook: 'pre-bash', payload: payload({ hook_event_name: value }) })).toBeNull();
  });

  it.each([
    ['no session id', { session_id: undefined }],
    ['a blank session id', { session_id: '   ' }],
    ['a session id with fewer than 8 alphanumerics', { session_id: 'abc-12' }],
  ])('refuses a payload with %s', (_label, over) => {
    expect(rec.buildDirectHookFiredEnvelope({ hook: 'pre-bash', payload: payload(over) })).toBeNull();
  });

  it('refuses a missing or blank hook name', () => {
    expect(rec.buildDirectHookFiredEnvelope({ hook: '', payload: payload() })).toBeNull();
    expect(rec.buildDirectHookFiredEnvelope({ payload: payload() })).toBeNull();
  });

  it('never throws, whatever it is handed (the builder and the writer)', () => {
    for (const bad of [undefined, null, 'x', 7, [], {}, { hook: 'a' }, { payload: null }]) {
      expect(() => rec.buildDirectHookFiredEnvelope(bad)).not.toThrow();
      expect(() => rec.recordDirectHookFired(bad)).not.toThrow();
      expect(rec.recordDirectHookFired(bad)).toEqual({ ok: false, reason: 'not-recordable' });
    }
  });

  it('names the hook from the script file: stem without extension, the dispatch table spelling', () => {
    expect(entry.directHookName(pathToFileURL(path.join(HOOKS_DIR, 'pre-bash.js')).href)).toBe('pre-bash');
    expect(entry.directHookName(pathToFileURL(path.join(HOOKS_DIR, 'session-ledger.mjs')).href)).toBe('session-ledger');
    for (const t of Object.values(TABLE.slots).flatMap((d) => d.handlers ?? [])) {
      expect(entry.directHookName(pathToFileURL(path.join(HOOKS_DIR, t.script)).href), t.name).toBe(t.name);
    }
  });
});

describe('snapshotFiring: the tap hands the recorder a copy, not the live payload', () => {
  it('builds the same row from the snapshot as from the full payload: no key the recorder reads is left out', () => {
    const full = payload({
      mission_id: 'M-20260929-001',
      prompt_id: 'prompt-1',
      tool_input: { command: 'echo hello' },
      unrelated: { big: 'x'.repeat(2000) },
    });
    const snap = entry.snapshotFiring(full);
    expect(Object.keys(snap).every((k) => entry.FIRING_PAYLOAD_KEYS.includes(k))).toBe(true);
    expect('tool_input' in snap).toBe(false);
    expect('unrelated' in snap).toBe(false);
    expect(rec.buildDirectHookFiredEnvelope({ hook: 'pre-bash', payload: snap }))
      .toEqual(rec.buildDirectHookFiredEnvelope({ hook: 'pre-bash', payload: full }));
    // A declared mission id survives, so the snapshot is not just the fallback path.
    expect(rec.buildDirectHookFiredEnvelope({ hook: 'pre-bash', payload: snap }).mission_id).toBe('M-20260929-001');
  });

  it('snapshots by value: a later mutation of the payload cannot change what is recorded', () => {
    const live = payload();
    const snap = entry.snapshotFiring(live);
    live.session_id = 'mutated-after-the-tap';
    live.hook_event_name = 'Stop';
    expect(snap.session_id).toBe(SID);
    expect(snap.hook_event_name).toBe('PreToolUse');
  });

  it('keeps only string values, so a hostile payload cannot smuggle an object into the envelope', () => {
    expect(entry.snapshotFiring({ session_id: 5, cwd: { a: 1 }, hook_event_name: ['PreToolUse'], tool_use_id: 'ok' }))
      .toEqual({ tool_use_id: 'ok' });
  });
});

describe('firingSessionId: the one rule for "this firing has a session"', () => {
  // The tap asks it before it loads the marker module, and the marker module asks it again as the
  // first decision of fireOnceDirect. Two callers, one function: they cannot disagree.
  it('takes the first NON-BLANK string of session_id, then sessionId', () => {
    expect(entry.firingSessionId({ session_id: 'abc', sessionId: 'xyz' })).toBe('abc');
    expect(entry.firingSessionId({ sessionId: 'xyz' })).toBe('xyz');
    expect(entry.firingSessionId({ session_id: '', sessionId: 'xyz' })).toBe('xyz');
    expect(entry.firingSessionId({ session_id: '  \t', sessionId: 'xyz' })).toBe('xyz');
  });

  it('is null for anything that is not a usable session, and never throws', () => {
    for (const bad of [
      undefined, null, {}, 'text', 7, [], { session_id: 5 }, { session_id: { a: 1 } },
      { session_id: ' ', sessionId: '\t' }, { session_id: undefined, sessionId: null },
    ]) {
      expect(() => entry.firingSessionId(bad)).not.toThrow();
      expect(entry.firingSessionId(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('returns the id as given, untrimmed: the marker and the row must key the same string', () => {
    expect(entry.firingSessionId({ session_id: ' abc ' })).toBe(' abc ');
  });

  it('is what the snapshot carries: a payload the tap would skip, the recorder would refuse too', () => {
    for (const over of [{ session_id: undefined }, { session_id: '   ' }, { session_id: 5 }]) {
      const full = payload(over);
      expect(entry.firingSessionId(entry.snapshotFiring(full)), JSON.stringify(over)).toBeNull();
      expect(rec.buildDirectHookFiredEnvelope({ hook: 'pre-bash', payload: full }), JSON.stringify(over)).toBeNull();
    }
    expect(entry.firingSessionId(entry.snapshotFiring(payload()))).toBe(SID);
  });
});

describe('directRecordingEnabled: three literals of ARTIBOT_HOOK_FIRED_DIRECT decide it', () => {
  const RUNNER = { VITEST: 'true' };

  it.each([[{}], [RUNNER]])('"off" is never, in production or inside the runner (%j)', (base) => {
    expect(entry.directRecordingEnabled({ ...base, ARTIBOT_HOOK_FIRED_DIRECT: 'off' })).toBe(false);
  });

  it.each([[{}], [RUNNER]])('"on" is always, in production and inside the runner (%j)', (base) => {
    expect(entry.directRecordingEnabled({ ...base, ARTIBOT_HOOK_FIRED_DIRECT: 'on' })).toBe(true);
  });

  it.each([undefined, '', 'ON', 'Off', '0', 'false', 'no', 'true', 'yes'])(
    'anything else (%j) is ON in production, so a typo cannot silence the audit, and OFF inside the runner',
    (value) => {
      const set = value === undefined ? {} : { ARTIBOT_HOOK_FIRED_DIRECT: value };
      expect(entry.directRecordingEnabled(set)).toBe(true);
      expect(entry.directRecordingEnabled({ ...set, ...RUNNER })).toBe(false);
    },
  );

  it('reads process.env by default: inside this very runner it is off unless the suite says on', () => {
    expect(process.env.VITEST, 'this premise is what makes the default off here').toBeTruthy();
    const saved = process.env.ARTIBOT_HOOK_FIRED_DIRECT;
    try {
      delete process.env.ARTIBOT_HOOK_FIRED_DIRECT;
      expect(entry.directRecordingEnabled()).toBe(false);
      process.env.ARTIBOT_HOOK_FIRED_DIRECT = 'on';
      expect(entry.directRecordingEnabled()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.ARTIBOT_HOOK_FIRED_DIRECT;
      else process.env.ARTIBOT_HOOK_FIRED_DIRECT = saved;
    }
  });
});

describe('tapDirectFiring: a tap, not a transformation', () => {
  it('returns its payload untouched, for garbage and for a fully recordable payload alike', () => {
    const sb = makeSandbox('tap');
    const recordable = payload({ cwd: sb.repo });
    for (const value of [null, undefined, 'text', 12, [], {}, recordable]) {
      expect(entry.tapDirectFiring(import.meta.url, value)).toBe(value);
    }
  });

  it('does nothing when the calling module is not the process entry (tests and sibling imports never record)', async () => {
    const sb = makeSandbox('tap');
    const saved = process.env.ARTIBOT_HOOK_FIRED_DIRECT;
    process.env.ARTIBOT_HOOK_FIRED_DIRECT = 'on'; // recording enabled, so only the entry check stands in the way
    try {
      entry.tapDirectFiring(import.meta.url, payload({ cwd: sb.repo }));
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
    } finally {
      if (saved === undefined) delete process.env.ARTIBOT_HOOK_FIRED_DIRECT;
      else process.env.ARTIBOT_HOOK_FIRED_DIRECT = saved;
    }
    expect(existsSync(ledgerFilePath(sb.repo))).toBe(false);
  });

  it('never throws on a hostile module url', () => {
    for (const bad of [undefined, null, 42, '', 'not a url', {}]) {
      expect(() => entry.tapDirectFiring(bad, payload())).not.toThrow();
    }
  });
});

describe('nearestGitRoot: asks the ledger writer\'s own resolver, never the marker name', () => {
  it('finds the work-tree root from a subdirectory, and from the root itself', () => {
    const sb = makeSandbox('root');
    expect(rec.nearestGitRoot(path.join(sb.repo, 'src'))).toBe(sb.repo);
    expect(rec.nearestGitRoot(sb.repo)).toBe(sb.repo);
  });

  it('finds a linked worktree root (its .git is a pointer FILE) and stops there, not at the main repository', () => {
    const sb = makeSandbox('root');
    const wt = makeLinkedWorktree(sb);
    expect(rec.nearestGitRoot(wt)).toBe(wt);
  });

  it('gives up on a directory with no repository above it, and on blank or non-string input', () => {
    const sb = makeSandbox('root');
    const bare = path.join(sb.root, 'bare');
    mkdirSync(bare);
    expect(rec.nearestGitRoot(bare)).toBeNull();
    for (const bad of [undefined, null, '', '   ', 42, {}, []]) expect(rec.nearestGitRoot(bad)).toBeNull();
  });

  it('the leaf walk takes its resolver as an argument and never throws on a bad one', () => {
    const sb = makeSandbox('root');
    const asked = [];
    const only = (want) => (dir) => { asked.push(dir); return dir === want ? 'common' : null; };
    // Walks up from the start directory, asking about each ancestor in turn, and stops at the first yes.
    expect(entry.nearestWorkTreeRoot(path.join(sb.repo, 'src'), only(sb.repo))).toBe(sb.repo);
    expect(asked).toEqual([path.join(sb.repo, 'src'), sb.repo]);
    expect(entry.nearestWorkTreeRoot(sb.repo, () => null)).toBeNull();
    for (const bad of [undefined, null, 'nope', 7, {}]) expect(entry.nearestWorkTreeRoot(sb.repo, bad)).toBeNull();
    expect(entry.nearestWorkTreeRoot(sb.repo, () => { throw new Error('resolver blew up'); })).toBeNull();
  });
});

/**
 * Every module specifier a source loads at LINK time: `import ... from '...'`, a bare
 * `import '...'`, and a re-export (`export { a } from '...'`, `export * from '...'`), which is
 * a static import too. A dynamic `import('...')` is deliberately NOT one: that is the on-demand
 * edge these pins protect. Line-anchored, so a specifier quoted in a comment or a string is
 * not read as one. (The scan that stood here before saw `import ... from` only, so a
 * back-compat re-export of the marker functions from `_main-entry.js` would have walked past it.)
 *
 * @param {string} src
 * @returns {string[]}
 */
function staticSpecifiers(src) {
  const pattern = /^import\s[^;]*?from\s+'([^']+)';|^import\s+'([^']+)';|^export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+'([^']+)';/gm;
  return [...src.matchAll(pattern)].map((m) => m[1] ?? m[2] ?? m[3]);
}

describe('_main-entry.js and _hook-seen-marker.js stay leaves', () => {
  // A static import of anything under lib/ broke scripts that copy _main-entry.js into a minimal tree
  // (tests/scripts/sync-marketplace-meta.test.js: ERR_MODULE_NOT_FOUND, measured 2026-09-29). The same
  // holds for the sibling marker module: tests/hooks/runtime-prompt-decision-wiring.test.js copies
  // _main-entry.js ALONE, so _main-entry.js may reach the marker module only with a dynamic import().
  const read = (name) => readFileSync(path.join(HOOKS_DIR, name), 'utf-8');

  it('the specifier scan sees every static form and skips the dynamic one (detector self-check)', () => {
    const sample = [
      "import a from 'node:fs';",
      "import { b,",
      "  c } from './multi-line.js';",
      "import './bare.js';",
      "export { d } from './re-export.js';",
      "export * from './star.js';",
      "export * as e from './star-as.js';",
      "// import x from './in-a-comment.js';",
      "const lazy = () => import('./dynamic.js');",
      "export function f() { return 'from \"./in-a-string.js\";'; }",
    ].join('\n');
    expect(staticSpecifiers(sample)).toEqual([
      'node:fs', './multi-line.js', './bare.js', './re-export.js', './star.js', './star-as.js',
    ]);
  });

  it('_main-entry.js imports nothing statically except node: builtins; lib/ and the marker module load on demand', () => {
    const src = read('_main-entry.js');
    const specs = staticSpecifiers(src);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((s) => !s.startsWith('node:'))).toEqual([]);
    expect(src).toMatch(/import\('\.\.\/\.\.\/lib\/project-state\/git-common-dir\.js'\)/);
    expect(src).toMatch(/import\('\.\/_hook-seen-marker\.js'\)/);
  });

  it('_main-entry.js takes only realpathSync from node:fs and nothing from node:module', () => {
    // The read-only CLIs (scripts/ledger/*) import isMainEntry from here, and
    // tests/ledger/recovery-journal-census.test.js says this file "takes only realpathSync" so that
    // their import graph holds no writer. That sentence was true when written (2026-09-22), false
    // from the day the marker code (mkdirSync, openSync, rmSync, createRequire) landed here, and
    // true again once it moved out. This is what keeps it true.
    const src = read('_main-entry.js');
    const fsNames = [...src.matchAll(/^import\s*\{([^}]*)\}\s*from\s+'node:fs';/gm)]
      .flatMap((m) => m[1].split(',').map((name) => name.trim()).filter(Boolean));
    expect(fsNames).toEqual(['realpathSync']);
    expect(staticSpecifiers(src)).not.toContain('node:module');
  });

  it('_hook-seen-marker.js takes node: builtins and ./_main-entry.js, and nothing under lib/', () => {
    const specs = staticSpecifiers(read('_hook-seen-marker.js'));
    expect(specs.length).toBeGreaterThan(1);
    expect(specs.filter((s) => !s.startsWith('node:'))).toEqual(['./_main-entry.js']);
  });
});

describe('no spawn: the direct path never starts a process', () => {
  it('finds the repository by walking up, and gives up on a bare directory without asking git', async () => {
    vi.resetModules();
    const spawned = [];
    const trap = (name) => (...args) => { spawned.push(`${name}(${String(args[0]).slice(0, 40)})`); throw new Error(`unexpected ${name}`); };
    vi.doMock('node:child_process', () => {
      const api = {
        execSync: trap('execSync'),
        execFileSync: trap('execFileSync'),
        spawnSync: trap('spawnSync'),
        spawn: trap('spawn'),
        execFile: trap('execFile'),
        exec: trap('exec'),
        fork: trap('fork'),
      };
      return { ...api, default: api };
    });

    const sb = makeSandbox('nospawn');
    const bare = path.join(sb.root, 'bare');
    mkdirSync(bare);

    const mod = await import(RECORDER_URL);
    expect(mod.nearestGitRoot(path.join(sb.repo, 'src'))).toBe(sb.repo);
    expect(mod.nearestGitRoot(bare)).toBeNull();
    expect(mod.recordDirectHookFired({ hook: 'pre-bash', payload: payload({ cwd: bare }) }))
      .toEqual({ ok: false, reason: 'no-git-root' });
    expect(spawned).toEqual([]);

    // Positive control in the SAME mocked graph: the dispatcher's resolver does ask git for a bare directory,
    // so a spawn on the direct path would have been caught above.
    const { resolveProjectRoot } = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'git', 'project-root.js')).href);
    resolveProjectRoot(bare);
    expect(spawned.length).toBeGreaterThan(0);
  });
});
