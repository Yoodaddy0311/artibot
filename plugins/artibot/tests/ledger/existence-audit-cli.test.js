/**
 * Real-process contract for `scripts/ledger/existence-audit.mjs` — the first
 * production caller of `lib/replay/existence-audit.js#buildExistenceAudit`.
 *
 * WHY THE CASES SPAWN A PROCESS AND SEED A REAL LEDGER. The fold has its own
 * pure suite (`tests/replay/existence-audit.test.js`) that proves the counting
 * over a given array. What only a real run can show is the part this CLI adds:
 * that the inventory it ENUMERATES is the one the fold receives, that the rows
 * survive the writer's allowlist on the way in, and that nothing is written on
 * the way out. Every seed goes through the real `appendLedgerEvent`, and the
 * first seeded case asserts zero `ledger.rejected` lines before any count.
 *
 * THE INVENTORY IS ALWAYS A FIXTURE. Every case builds a throwaway plugin root
 * (`commands/`, `skills/`, `hooks/`, `lib/`) and passes it as `--plugin-root`.
 * The repository's own `skills/` is being edited by another limb, and a test
 * pinned to its contents would fail for reasons unrelated to this script. The
 * DEFAULT plugin root (this script's own) is therefore NOT exercised here.
 *
 * ABSENT AND EMPTY ARE DIFFERENT ANSWERS, AND BOTH ARE PINNED. A missing
 * source dir must reach the fold as a MISSING inventory key (`enumerated:
 * false`); an existing dir with zero items must reach it as `[]`
 * (`enumerated: true`, no entries). Collapsing either into the other turns
 * "never looked" into "looked and found nothing", which reads as a clean audit.
 *
 * READ-ONLY IS ASSERTED ON BYTES. The ledger's sha256 and a sha256 of every
 * file in the fixture plugin root are taken before and after a run.
 *
 * ── WHAT THIS FILE CANNOT SEE ───────────────────────────────────────────────
 *  - THE LIVE SPELLINGS. Seeds here are chosen by the test; the header of the
 *    script records what the central ledger held when it was written.
 *  - THE CASE-COLLISION REFUSAL on a case-insensitive filesystem, where two
 *    command files differing only in case cannot coexist; that case is skipped
 *    there rather than faked.
 *  - THE INSTALLED COPY, and any ledger larger than a handful of rows.
 *
 * @module tests/ledger/existence-audit-cli
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendLedgerEvent } from '../../lib/runtime/ledger.js';
import { ledgerFilePath } from '../../lib/runtime/event-writer.js';
import { DIRECT_HOOK_SLOTS } from '../../scripts/hooks/_main-entry.js';

// This file spawns child processes; the budget is headroom for load only.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'existence-audit.mjs');

/** The exact key set the script header promises. */
const STDOUT_KEYS = [
  'measuredAt', 'inputPath', 'since', 'pluginRoot', 'sources',
  'hooksOutsideCarrier', 'unmatched', 'skillCarrierCommands', 'aliasesFolded',
  'kinds', 'summary',
];

/** @type {string} */
let tmp;

/** A project root (ledger side) the Artibot guards will run inside. */
function makeProject(name) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, 'artibot.config.json'), '{}\n', 'utf-8');
  return root;
}

/** Write a file, creating its parent directories. */
function put(root, rel, text = '') {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf-8');
}

/** A dispatch table with two dispatcher slots and one single-hook slot. */
const DISPATCH_TABLE = {
  version: 3,
  slots: {
    SessionStart: {
      dispatcher: 'scripts/hooks/_sessionstart-dispatcher.js',
      handlers: [
        { name: 'session-start', script: 'session-start.js', timeoutMs: 5000 },
        { name: 'memory-tracker', script: 'memory-tracker.js', timeoutMs: 5000 },
      ],
    },
    Stop: {
      dispatcher: 'scripts/hooks/_stop-dispatcher.js',
      handlers: [
        { name: 'memory-tracker', script: 'memory-tracker.js', timeoutMs: 5000 },
        { name: 'quiet-hook', script: 'quiet-hook.js', timeoutMs: 5000 },
      ],
    },
    PreCompact: { strategy: 'single-hook', dispatcher: null, handlers: [] },
  },
};

/**
 * hooks.json: two dispatchers, two hooks registered directly (their events are in
 * DIRECT_HOOK_SLOTS), and ONE stray: `stray.js` under `SessionEnd`, which is
 * neither a dispatcher script nor a direct-slot event, so it is the only command
 * `hooksOutsideCarrier` can list. It keeps that branch tested.
 */
const HOOKS_JSON = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/_sessionstart-dispatcher.js' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-bash.js' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/_stop-dispatcher.js' }] }],
    Notification: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/workflow-status.js notification' }] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/stray.js' }] }],
  },
};

/** What a direct-only entry reads on a ledger with no direct-slot row: unmeasured, not "unused". */
const NOT_YET_SHIPPED = 'unmeasured:direct-carrier-not-yet-shipped';

/**
 * A full fixture plugin root. Each source holds one item the enumerator must
 * SKIP, so a regression that stops filtering is visible in the counts.
 */
function makePlugin(name) {
  const root = path.join(tmp, name);
  put(root, '.claude-plugin/plugin.json', `${JSON.stringify({ name: 'artibot', version: '0.0.0' })}\n`);
  put(root, 'commands/split.md', '# split\n');
  put(root, 'commands/Team.md', '# Team\n');
  put(root, 'commands/notes.txt', 'not a command\n');
  put(root, 'skills/alpha/SKILL.md', '---\nname: alpha\n---\n');
  put(root, 'skills/beta/SKILL.md', '---\nname: beta\n---\n');
  put(root, 'skills/loose/README.md', 'no SKILL.md here\n');
  put(root, 'hooks/dispatch-table.json', `${JSON.stringify(DISPATCH_TABLE)}\n`);
  put(root, 'hooks/hooks.json', `${JSON.stringify(HOOKS_JSON)}\n`);
  put(root, 'lib/a.js', 'export {};\n');
  put(root, 'lib/sub/b.mjs', 'export {};\n');
  put(root, 'lib/readme.md', 'not a module\n');
  return root;
}

/** Run the CLI with the child cwd inside the project root. */
function runCli(args, cwd) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8', windowsHide: true, cwd, env: { ...process.env },
  });
  return { status: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || '') };
}

/** The one JSON line, parsed, with the stream discipline checked first. */
function parseOne(out) {
  expect(out.stderr).toBe('');
  expect(out.status).toBe(0);
  expect(out.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(out.stdout);
}

/** Find one audit entry by name. */
function entry(printed, kind, name) {
  return printed.kinds[kind].entries.find((e) => e.name === name);
}

/** Append one row through the real writer and require it to be accepted. */
function seed(root, event, data, opts = {}) {
  const res = appendLedgerEvent(root, {
    event, session_id: 'sessExistAudit01', source: 'hook', data,
  }, opts);
  expect(res.ok).toBe(true);
}

/**
 * Two dispatches and three slash commands; no `tool.used` at all.
 *   hooks     2 rows: memory-tracker in both, session-start in one,
 *             quiet-hook in none, `ghost-hook` not in the inventory
 *   commands  3 rows: split twice, `missing-cmd` not in the inventory
 *   skills    0 rows: the carrier event is absent from the ledger
 */
function seedLedger(root) {
  seed(root, 'hook.fired', { slot: 'SessionStart', hooks: ['session-start', 'memory-tracker'], count: 2 });
  seed(root, 'hook.fired', { slot: 'Stop', hooks: ['memory-tracker', 'ghost-hook'], count: 2 });
  for (const command of ['split', 'split', 'missing-cmd']) {
    seed(root, 'intent.detected', { type: 'slash-command', confidence: 1, command });
  }
}

/** Every line in a ledger file, rejections included. */
function ledgerLines(root) {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

/** sha256 of a file's bytes. */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Relative path to sha256 for every file under `dir`. */
function treeDigest(dir, rel = '') {
  const out = {};
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, treeDigest(dir, child));
    else out[child] = sha256(path.join(dir, child));
  }
  return out;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-exaudit-')));
});
afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('existence-audit: a seeded ledger against a fixture plugin root', () => {
  it('reports fired numbers where the carrier has rows, and reasons where it has none', () => {
    const project = makeProject('P1');
    const plugin = makePlugin('plug1');
    seedLedger(project);
    expect(ledgerLines(project).filter((e) => e.event === 'ledger.rejected')).toEqual([]);

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    // hooks: a multi-valued carrier with rows -> real numbers, including a
    // measured zero for the handler no dispatch named.
    expect(printed.kinds.hooks.enumerated).toBe(true);
    expect(printed.kinds.hooks.denominator).toBe(2);
    expect(entry(printed, 'hooks', 'memory-tracker')).toMatchObject({ fired: 2, measured: true, reason: null });
    expect(entry(printed, 'hooks', 'session-start').fired).toBe(1);
    expect(entry(printed, 'hooks', 'quiet-hook')).toMatchObject({ fired: 0, measured: true });
    // The two hooks registered directly are IN the inventory now, but this ledger holds no row whose slot is
    // a direct slot: the direct writer has not shipped for it, so they are unmeasured, never "unused".
    for (const name of ['pre-bash', 'workflow-status']) {
      expect(entry(printed, 'hooks', name), name).toMatchObject({ fired: null, measured: false, reason: NOT_YET_SHIPPED });
    }
    // commands: bare stems, lowercased (`Team.md` -> `team`).
    expect(printed.kinds.commands.denominator).toBe(3);
    expect(printed.kinds.commands.entries.map((e) => e.name)).toEqual(['split', 'team']);
    expect(entry(printed, 'commands', 'split').fired).toBe(2);
    expect(entry(printed, 'commands', 'team')).toMatchObject({ fired: 0, measured: true });
    // skills: carried, but the ledger holds no tool.used row -> null, not 0.
    expect(printed.kinds.skills.denominator).toBe(0);
    for (const e of printed.kinds.skills.entries) {
      expect(e.fired).toBeNull();
      expect(e.reason).toBe('unmeasured:carrier-event-absent-from-ledger');
    }
    // modules: no carrier at all -> enumerated anyway, so the reason is visible.
    expect(printed.kinds.modules.enumerated).toBe(true);
    expect(printed.kinds.modules.entries.map((e) => e.name)).toEqual(['lib/a.js', 'lib/sub/b.mjs']);
    for (const e of printed.kinds.modules.entries) {
      expect(e.fired).toBeNull();
      expect(e.reason).toBe('unmeasured:no-event-carries-module');
    }
  });

  it('names the ledger it read, the event count and the census', () => {
    const project = makeProject('P2');
    const plugin = makePlugin('plug2');
    seedLedger(project);

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    expect(Number.isFinite(Date.parse(printed.measuredAt))).toBe(true);
    expect(printed.inputPath).toBe(ledgerFilePath(project));
    expect(printed.inputPath).toBe(printed.summary.census.file.path);
    expect(printed.pluginRoot).toBe(plugin);
    expect(printed.since).toBeNull();
    expect(printed.summary.eventsReceived).toBe(5);
    expect(printed.summary.census.survivors).toBe(5);
    expect(printed.summary.census.file.present).toBe(true);
    // hooks: 3 dispatch-table names + 2 directly registered ones.
    expect(printed.summary.entries).toBe(5 + 2 + 2 + 2);
  });

  it('lists what it skipped and what the carrier counted outside the inventory', () => {
    const project = makeProject('P3');
    const plugin = makePlugin('plug3');
    seedLedger(project);

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    expect(printed.sources.commands).toMatchObject({ status: 'enumerated', count: 2, skipped: 1 });
    expect(printed.sources.skills).toMatchObject({ status: 'enumerated', count: 2, skipped: 1 });
    // memory-tracker sits in two slots: 4 handler entries, 3 distinct dispatch-table hooks; the two hooks
    // registered directly (events in DIRECT_HOOK_SLOTS) make 5 in the inventory.
    expect(printed.sources.hooks).toMatchObject({
      status: 'enumerated', count: 5, handlerEntries: 4, directEntries: 2, directStatus: 'enumerated',
    });
    expect(printed.sources.modules).toMatchObject({ status: 'enumerated', count: 2 });
    // What is left outside the carrier is neither a dispatcher nor a command on a direct-slot event.
    expect(printed.hooksOutsideCarrier).toEqual({
      path: 'hooks/hooks.json',
      status: 'enumerated',
      count: 1,
      entries: ['SessionEnd stray.js'],
    });
    // The other half of a false zero: names the rows hold that nothing lists.
    expect(printed.unmatched).toEqual({
      hooks: { 'ghost-hook': 1 },
      commands: { 'missing-cmd': 1 },
      skills: {},
      modules: null,
    });
  });

  it('prints one line of JSON with the fixed key set', () => {
    const project = makeProject('P4');
    const plugin = makePlugin('plug4');
    seedLedger(project);

    const out = runCli(['--cwd', project, '--plugin-root', plugin], project);

    expect(out.stdout.trimEnd()).not.toContain('\n');
    expect(Object.keys(JSON.parse(out.stdout)).sort()).toEqual([...STDOUT_KEYS].sort());
  });
});

describe('existence-audit: an absent source is not an empty one', () => {
  it('omits the key for a missing dir and passes [] for an empty one', () => {
    const project = makeProject('P5');
    const plugin = path.join(tmp, 'plug5');
    // commands/ EXISTS with nothing in it; skills/, hooks/ and lib/ do not exist.
    mkdirSync(path.join(plugin, 'commands'), { recursive: true });
    seedLedger(project);

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    expect(printed.kinds.commands.enumerated).toBe(true);
    expect(printed.kinds.commands.entries).toEqual([]);
    expect(printed.sources.commands).toMatchObject({ status: 'enumerated', count: 0 });
    for (const kind of ['skills', 'hooks', 'modules']) {
      expect(printed.kinds[kind].enumerated).toBe(false);
      expect(printed.kinds[kind].entries).toEqual([]);
      expect(printed.sources[kind]).toMatchObject({ status: 'absent', count: null });
      expect(printed.unmatched[kind]).toBeNull();
    }
    // An empty inventory still sees every command the rows hold.
    expect(printed.unmatched.commands).toEqual({ split: 2, 'missing-cmd': 1 });
    expect(printed.hooksOutsideCarrier.status).toBe('unmeasured:dispatch-table-not-enumerated');
    expect(printed.hooksOutsideCarrier.count).toBeNull();
  });

  it.each([
    ['not JSON', '{ nope'],
    ['a handler without a name', JSON.stringify({ slots: { Stop: { handlers: [{ name: 'ok' }, { script: 'x.js' }] } } })],
    ['slots as an array', JSON.stringify({ slots: [] })],
  ])('refuses the whole dispatch table when it is %s', (_label, text) => {
    const project = makeProject('P6');
    const plugin = makePlugin('plug6');
    put(plugin, 'hooks/dispatch-table.json', text);
    seedLedger(project);

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    // Fail-closed: a partial handler list would be a complete-looking audit of
    // the wrong set, so the kind is not enumerated at all.
    expect(printed.sources.hooks.status).toBe('malformed');
    expect(typeof printed.sources.hooks.error).toBe('string');
    expect(printed.kinds.hooks.enumerated).toBe(false);
    expect(printed.kinds.hooks.entries).toEqual([]);
    expect(printed.hooksOutsideCarrier.count).toBeNull();
    // The other kinds are unaffected.
    expect(printed.kinds.commands.enumerated).toBe(true);
  });

  const probeDir = mkdtempSync(path.join(os.tmpdir(), 'artibot-exaudit-case-'));
  writeFileSync(path.join(probeDir, 'X.md'), '');
  const caseInsensitive = existsSync(path.join(probeDir, 'x.md'));
  rmSync(probeDir, { recursive: true, force: true });

  it.skipIf(caseInsensitive)('refuses commands whose stems collide once lowercased', () => {
    const project = makeProject('P7');
    const plugin = makePlugin('plug7');
    put(plugin, 'commands/team.md', '# team\n');

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    expect(printed.sources.commands.status).toBe('malformed');
    expect(printed.kinds.commands.enumerated).toBe(false);
  });
});

/**
 * A hooks.json with one `node <plugin>/scripts/hooks/<command>` entry per listed command, per event.
 * `quoted` spells the script path the way the shipped hooks.json does (`node "<path>" args`); the
 * default keeps the unquoted spelling the older fixtures were written against.
 */
function hooksJsonOf(byEvent, { quoted = false } = {}) {
  const hooks = {};
  for (const [event, commands] of Object.entries(byEvent)) {
    hooks[event] = commands.map((command) => {
      const [script, ...args] = command.split(' ');
      const scriptPath = `\${CLAUDE_PLUGIN_ROOT}/scripts/hooks/${script}`;
      const spelled = quoted ? `"${scriptPath}"` : scriptPath;
      return { hooks: [{ type: 'command', command: `node ${spelled}${args.length > 0 ? ` ${args.join(' ')}` : ''}` }] };
    });
  }
  return `${JSON.stringify({ hooks })}\n`;
}

/** The fixture's two dispatchers plus whatever the case registers, so only its entries are direct or stray. */
function withHooksJson(plugin, byEvent, options = {}) {
  put(plugin, 'hooks/hooks.json', hooksJsonOf({
    SessionStart: ['_sessionstart-dispatcher.js'], Stop: ['_stop-dispatcher.js'], ...byEvent,
  }, options));
}

describe('existence-audit: hooks registered directly in hooks.json (OB-24)', () => {
  /** A direct row as `recordDirectHookFired` writes it: `slot` is the hook event itself. */
  const seedDirect = (root, hook, slot = 'PreToolUse') => seed(root, 'hook.fired', { slot, hooks: [hook], count: 1 });

  it('counts a hook only hooks.json runs once a direct-slot row exists, and leaves the ghost visible', () => {
    const project = makeProject('D1');
    const plugin = makePlugin('dplug1');
    seedLedger(project);
    seedDirect(project, 'pre-bash');
    expect(ledgerLines(project).filter((e) => e.event === 'ledger.rejected')).toEqual([]);

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    expect(entry(printed, 'hooks', 'pre-bash')).toMatchObject({ fired: 1, measured: true, reason: null });
    // The gate belongs to the carrier, not to one hook: from the first direct-slot row on, a silent direct
    // hook is a MEASURED zero (what an Existence Audit exists to find), not "unmeasured".
    expect(entry(printed, 'hooks', 'workflow-status')).toMatchObject({ fired: 0, measured: true, reason: null });
    expect(printed.kinds.hooks.denominator).toBe(3);
    // pre-bash is listed now, so it is not unmatched; only the name nothing lists remains.
    expect(printed.unmatched.hooks).toEqual({ 'ghost-hook': 1 });
  });

  it('lists a hook once when the dispatch table AND hooks.json run it, and never gates it', () => {
    const project = makeProject('D2');
    const plugin = makePlugin('dplug2');
    // memory-tracker is dispatched (SessionStart, Stop) and registered directly: the dual-path scripts.
    withHooksJson(plugin, { PreToolUse: ['pre-bash.js', 'memory-tracker.js'] });
    seedLedger(project);

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    expect(printed.kinds.hooks.entries.filter((e) => e.name === 'memory-tracker')).toHaveLength(1);
    // Someone WAS listening (the dispatcher), so it is a count although no direct-slot row exists yet.
    expect(entry(printed, 'hooks', 'memory-tracker')).toMatchObject({ fired: 2, measured: true, reason: null });
    expect(entry(printed, 'hooks', 'pre-bash')).toMatchObject({ fired: null, measured: false, reason: NOT_YET_SHIPPED });
    expect(printed.sources.hooks).toMatchObject({ count: 4, handlerEntries: 4, directEntries: 2 });
  });

  it('reads the QUOTED command spelling hooks.json ships exactly like the unquoted one', () => {
    // hooks.json quotes the script path (an unquoted path splits on a space in the plugin
    // root). With the closing quote left in the command, `script` read `_stop-dispatcher.js"`,
    // no dispatcher matched its basename and every dispatcher became a direct or stray hook.
    const project = makeProject('D5');
    const byEvent = {
      PreToolUse: ['pre-bash.js', 'memory-tracker.js'], SessionEnd: ['stray-a.js'], UserPromptSubmit: ['stray-b.mjs arg'],
    };
    const plain = makePlugin('dplug5u');
    withHooksJson(plain, byEvent);
    const quoted = makePlugin('dplug5q');
    withHooksJson(quoted, byEvent, { quoted: true });
    const raw = readFileSync(path.join(quoted, 'hooks/hooks.json'), 'utf-8');
    expect(raw, 'the fixture must really carry the quoted spelling').toContain('node \\"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/_stop-dispatcher.js\\"');
    seedLedger(project);

    const a = parseOne(runCli(['--cwd', project, '--plugin-root', plain], project));
    const b = parseOne(runCli(['--cwd', project, '--plugin-root', quoted], project));

    expect(b.kinds.hooks).toEqual(a.kinds.hooks);
    expect(b.sources.hooks).toEqual(a.sources.hooks);
    expect(b.hooksOutsideCarrier).toEqual(a.hooksOutsideCarrier);
    // Positive control: the two dispatchers were skipped, so only the two PreToolUse hooks are direct.
    expect(b.sources.hooks).toMatchObject({ directEntries: 2 });
    expect(b.hooksOutsideCarrier.entries).toEqual(['SessionEnd stray-a.js', 'UserPromptSubmit stray-b.mjs arg']);
  });

  it.each([
    ['absent', null, 'absent'],
    ['not JSON', '{ nope', 'malformed'],
    ['without a hooks object', JSON.stringify({ hooks: [] }), 'malformed'],
  ])('keeps the dispatch-table inventory and names the missing half when hooks.json is %s', (_label, text, status) => {
    const project = makeProject('D3');
    const plugin = makePlugin('dplug3');
    if (text === null) rmSync(path.join(plugin, 'hooks', 'hooks.json'));
    else writeFileSync(path.join(plugin, 'hooks', 'hooks.json'), text, 'utf-8');
    seedLedger(project);
    seedDirect(project, 'pre-bash');

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    // Same hooks kind as before this change; the direct half is reported, not silently dropped.
    expect(printed.kinds.hooks.enumerated).toBe(true);
    expect(printed.kinds.hooks.entries.map((e) => e.name).sort()).toEqual(['memory-tracker', 'quiet-hook', 'session-start']);
    expect(printed.sources.hooks).toMatchObject({
      status: 'enumerated', count: 3, handlerEntries: 4, directEntries: null, directStatus: status,
    });
    expect(printed.hooksOutsideCarrier).toMatchObject({ status, count: null, entries: null });
    // Unlisted, so the direct row surfaces as unmatched instead of vanishing.
    expect(printed.unmatched.hooks).toEqual({ 'ghost-hook': 1, 'pre-bash': 1 });
  });

  it('takes the slot list from the hook tap: every allowlisted event is direct, anything else is outside', () => {
    const project = makeProject('D4');
    const plugin = makePlugin('dplug4');
    const byEvent = Object.fromEntries(DIRECT_HOOK_SLOTS.map((event, i) => [event, [`direct-${i}.js`]]));
    byEvent[DIRECT_HOOK_SLOTS[0]].push('unnamed.sh'); // on a direct slot, but no script to name: outside
    byEvent.SessionEnd = ['stray-a.js']; // an event the tap does not record: outside
    byEvent.UserPromptSubmit = ['stray-b.mjs arg']; // a dispatcher-owned event: outside, args kept
    withHooksJson(plugin, byEvent);

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    const names = printed.kinds.hooks.entries.map((e) => e.name);
    DIRECT_HOOK_SLOTS.forEach((event, i) => expect(names, event).toContain(`direct-${i}`));
    expect(names.filter((n) => n.startsWith('stray') || n.startsWith('unnamed'))).toEqual([]);
    expect(printed.sources.hooks).toMatchObject({
      count: 3 + DIRECT_HOOK_SLOTS.length, directEntries: DIRECT_HOOK_SLOTS.length,
    });
    expect(printed.hooksOutsideCarrier).toEqual({
      path: 'hooks/hooks.json',
      status: 'enumerated',
      count: 3,
      entries: [
        `${DIRECT_HOOK_SLOTS[0]} node \${CLAUDE_PLUGIN_ROOT}/scripts/hooks/unnamed.sh`,
        'SessionEnd stray-a.js',
        'UserPromptSubmit stray-b.mjs arg',
      ],
    });
  });

  it('imports the slot list instead of keeping a copy that can drift from the tap', () => {
    const source = readFileSync(CLI, 'utf-8');
    expect(source).toMatch(/import\s*\{[^}]*\bDIRECT_HOOK_SLOTS\b[^}]*\}\s*from\s*'\.\.\/hooks\/_main-entry\.js'/);
    for (const event of DIRECT_HOOK_SLOTS) expect(source, event).not.toContain(`'${event}'`);
  });
});

/**
 * The fold fixture: `save` is a command only, `split` and `team` are both a
 * command and a skill, `alpha` and `beta` are skills only.
 */
function makeFoldPlugin(name) {
  const root = makePlugin(name);
  put(root, 'commands/save.md', '# save\n');
  put(root, 'skills/split/SKILL.md', '---\nname: split\n---\n');
  put(root, 'skills/team/SKILL.md', '---\nname: team\n---\n');
  return root;
}

/** One Skill tool row, shaped as `scripts/hooks/tool-used-record.js` writes it. */
function seedSkill(root, skill) {
  const data = { tool: 'Skill', ok: true, duration_ms: 7 };
  seed(root, 'tool.used', skill === undefined ? { ...data, tool: 'Bash' } : { ...data, skill });
}

/**
 * Every spelling the fold has to tell apart.
 *   tool.used 11행 중 Skill carrier 10행 (Bash 1행은 where 밖, absent 아님)
 *                         Skill: artibot:split x2, split, artibot:alpha,
 *                         artibot-cowork:beta, artibot:save x2, save,
 *                         `artibot:` alone, claude-api; the 11th row is a Bash
 *                         row with no skill, outside the carrier's `where`
 *   intent.detected (3)   artibot:team, split, artibot:ghost
 */
function seedFoldLedger(root) {
  for (const skill of [
    'artibot:split', 'artibot:split', 'split', 'artibot:alpha', 'artibot-cowork:beta',
    'artibot:save', 'artibot:save', 'save', 'artibot:', 'claude-api', undefined,
  ]) seedSkill(root, skill);
  for (const command of ['artibot:team', 'split', 'artibot:ghost']) {
    seed(root, 'intent.detected', { type: 'slash-command', confidence: 1, command });
  }
}

describe('existence-audit: the own-plugin namespace fold', () => {
  it('counts namespaced and bare spellings as one name, and says which it folded', () => {
    const project = makeProject('F1');
    const plugin = makeFoldPlugin('fold1');
    seedFoldLedger(project);
    expect(ledgerLines(project).filter((e) => e.event === 'ledger.rejected')).toEqual([]);

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    // 10, not 11: the Bash row is not a Skill row, so it is neither counted nor "absent".
    expect(printed.kinds.skills.denominator).toBe(10);
    expect(entry(printed, 'skills', 'split')).toMatchObject({ fired: 3, measured: true });
    expect(entry(printed, 'skills', 'alpha').fired).toBe(1);
    // Another plugin's `beta` is not this plugin's `beta`.
    expect(entry(printed, 'skills', 'beta')).toMatchObject({ fired: 0, measured: true });
    expect(entry(printed, 'skills', 'team').fired).toBe(0);
    expect(printed.kinds.commands.denominator).toBe(3);
    expect(entry(printed, 'commands', 'team').fired).toBe(1);
    expect(entry(printed, 'commands', 'split').fired).toBe(1);
    // Skill-tool `save` calls are NOT added to the typed-command count.
    expect(entry(printed, 'commands', 'save')).toMatchObject({ fired: 0, measured: true });

    expect(printed.unmatched.skills).toEqual({ 'artibot-cowork:beta': 1, 'artibot:': 1, 'claude-api': 1 });
    expect(printed.unmatched.commands).toEqual({ ghost: 1 });
    expect(printed.skillCarrierCommands).toEqual({ save: 3 });
    expect(printed.aliasesFolded).toEqual({
      foldPrefix: { value: 'artibot:', source: '.claude-plugin/plugin.json', status: 'resolved' },
      skills: {
        'artibot:alpha': { to: 'alpha', count: 1 },
        'artibot:save': { to: 'save', count: 2 },
        'artibot:split': { to: 'split', count: 2 },
      },
      commands: {
        'artibot:ghost': { to: 'ghost', count: 1 },
        'artibot:team': { to: 'team', count: 1 },
      },
    });
    // The census is the reader's, not the fold's.
    expect(printed.summary.census.survivors).toBe(14);
    expect(printed.summary.eventsReceived).toBe(14);
  });

  it('writes nothing: the ledger still holds the original spellings, byte for byte', () => {
    const project = makeProject('F2');
    const plugin = makeFoldPlugin('fold2');
    seedFoldLedger(project);
    const file = ledgerFilePath(project);
    const before = sha256(file);

    parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    expect(sha256(file)).toBe(before);
    expect(ledgerLines(project).filter((e) => e.data?.skill === 'artibot:split')).toHaveLength(2);
  });

  it('folds only the audited plugin\'s own prefix', () => {
    const project = makeProject('F3');
    const plugin = makeFoldPlugin('fold3');
    put(plugin, '.claude-plugin/plugin.json', `${JSON.stringify({ name: 'artibot-cowork' })}\n`);
    seedFoldLedger(project);

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    expect(printed.aliasesFolded.foldPrefix.value).toBe('artibot-cowork:');
    expect(printed.aliasesFolded.skills).toEqual({ 'artibot-cowork:beta': { to: 'beta', count: 1 } });
    expect(entry(printed, 'skills', 'beta').fired).toBe(1);
    expect(entry(printed, 'skills', 'split').fired).toBe(1);
    expect(printed.unmatched.skills['artibot:split']).toBe(2);
  });

  it.each([
    ['missing', null, 'absent'],
    ['not JSON', '{ nope', 'malformed'],
    ['without a string name', JSON.stringify({ name: 42 }), 'malformed'],
    ['with a blank name', JSON.stringify({ name: '  ' }), 'malformed'],
    // Trimming would fold a prefix the manifest does not spell.
    ['with whitespace around the name', JSON.stringify({ name: ' artibot' }), 'malformed'],
  ])('folds nothing and says why when the manifest is %s', (_label, text, status) => {
    const project = makeProject('F4');
    const plugin = makeFoldPlugin('fold4');
    const manifest = path.join(plugin, '.claude-plugin', 'plugin.json');
    if (text === null) rmSync(manifest);
    else writeFileSync(manifest, text, 'utf-8');
    seedFoldLedger(project);

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    expect(printed.aliasesFolded.foldPrefix).toMatchObject({
      value: null, source: '.claude-plugin/plugin.json', status,
    });
    expect(printed.aliasesFolded.skills).toBeNull();
    expect(printed.aliasesFolded.commands).toBeNull();
    // Unfolded: only the bare row counts, the namespaced ones stay visible.
    expect(entry(printed, 'skills', 'split').fired).toBe(1);
    expect(printed.unmatched.skills).toMatchObject({ 'artibot:split': 2, 'artibot:save': 2 });
    expect(printed.unmatched.commands).toEqual({ 'artibot:team': 1, 'artibot:ghost': 1 });
    expect(printed.skillCarrierCommands).toEqual({ save: 1 });
  });

  it('strips the prefix once, never repeatedly', () => {
    const project = makeProject('F6');
    const plugin = makeFoldPlugin('fold6');
    seedSkill(project, 'artibot:artibot:alpha');

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    expect(printed.aliasesFolded.skills).toEqual({
      'artibot:artibot:alpha': { to: 'artibot:alpha', count: 1 },
    });
    expect(printed.unmatched.skills).toEqual({ 'artibot:alpha': 1 });
    expect(entry(printed, 'skills', 'alpha')).toMatchObject({ fired: 0, measured: true });
  });

  it('does not guess "command only" without a commands inventory', () => {
    const project = makeProject('F5');
    const plugin = makeFoldPlugin('fold5');
    rmSync(path.join(plugin, 'commands'), { recursive: true, force: true });
    seedFoldLedger(project);

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    expect(printed.skillCarrierCommands).toBeNull();
    expect(printed.unmatched.skills.save).toBe(3);
  });
});

describe('existence-audit: it writes nothing', () => {
  it('leaves the ledger and the plugin root byte-identical', () => {
    const project = makeProject('P8');
    const plugin = makePlugin('plug8');
    seedLedger(project);
    const file = ledgerFilePath(project);
    const ledgerBefore = sha256(file);
    const pluginBefore = treeDigest(plugin);

    parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    expect(sha256(file)).toBe(ledgerBefore);
    expect(treeDigest(plugin)).toEqual(pluginBefore);
  });

  it('creates no ledger when there is none, and says so', () => {
    const project = makeProject('P9');
    const plugin = makePlugin('plug9');
    const file = ledgerFilePath(project);

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    expect(printed.inputPath).toBe(file);
    expect(printed.summary.census.file.present).toBe(false);
    expect(printed.summary.eventsReceived).toBe(0);
    expect(entry(printed, 'hooks', 'quiet-hook')).toMatchObject({
      fired: null, reason: 'unmeasured:carrier-event-absent-from-ledger',
    });
    // A direct-only hook keeps the GENERAL reason here: the kind is unmeasured before the direct gate is asked.
    expect(entry(printed, 'hooks', 'pre-bash')).toMatchObject({
      fired: null, measured: false, reason: 'unmeasured:carrier-event-absent-from-ledger',
    });
    expect(existsSync(file)).toBe(false);
  });
});

describe('existence-audit: --since', () => {
  it('excludes older rows and says so in the census', () => {
    const project = makeProject('P10');
    const plugin = makePlugin('plug10');
    const old = { now: () => new Date('2026-09-01T00:00:00Z') };
    const recent = { now: () => new Date('2026-09-20T00:00:00Z') };
    seed(project, 'hook.fired', { slot: 'Stop', hooks: ['quiet-hook'], count: 1 }, old);
    seed(project, 'hook.fired', { slot: 'Stop', hooks: ['memory-tracker'], count: 1 }, recent);

    const printed = parseOne(runCli([
      '--cwd', project, '--plugin-root', plugin, '--since', '2026-09-10T00:00:00Z',
    ], project));

    expect(printed.since).toBe('2026-09-10T00:00:00.000Z');
    expect(printed.kinds.hooks.denominator).toBe(1);
    expect(entry(printed, 'hooks', 'quiet-hook').fired).toBe(0);
    expect(printed.summary.census.dropped.selection.filtered_out).toBe(1);
  });

  it('reads an all-digit cutoff as epoch ms, the same instant as its ISO spelling', () => {
    const project = makeProject('P12');
    const plugin = makePlugin('plug12');
    seed(project, 'hook.fired', { slot: 'Stop', hooks: ['quiet-hook'], count: 1 }, { now: () => new Date('2026-09-01T00:00:00Z') });
    seed(project, 'hook.fired', { slot: 'Stop', hooks: ['memory-tracker'], count: 1 }, { now: () => new Date('2026-09-20T00:00:00Z') });
    const base = ['--cwd', project, '--plugin-root', plugin, '--since'];

    const iso = parseOne(runCli([...base, '2026-09-10T00:00:00Z'], project));
    const ms = parseOne(runCli([...base, String(Date.parse('2026-09-10T00:00:00Z'))], project));

    // Date.parse does not read an all-digit string as a stamp, so this is the
    // case that catches a regression to a bare Date.parse.
    expect(ms.since).toBe('2026-09-10T00:00:00.000Z');
    expect(ms.since).toBe(iso.since);
    expect(ms.summary.eventsReceived).toBe(1);
    expect(ms.summary.eventsReceived).toBe(iso.summary.eventsReceived);
  });
});

describe('existence-audit: --cwd is the ledger root, not the process cwd', () => {
  it('reads the ledger --cwd names even when spawned inside another project', () => {
    const bystander = makeProject('P13a');
    const target = makeProject('P13b');
    const plugin = makePlugin('plug13');
    seed(bystander, 'hook.fired', { slot: 'Stop', hooks: ['quiet-hook'], count: 1 });
    seedLedger(target);

    const printed = parseOne(runCli(['--cwd', target, '--plugin-root', plugin], bystander));

    expect(printed.inputPath).toBe(ledgerFilePath(target));
    expect(printed.inputPath).not.toBe(ledgerFilePath(bystander));
    expect(printed.summary.eventsReceived).toBe(5);
    expect(printed.kinds.hooks.denominator).toBe(2);
  });
});

describe('existence-audit: what it refuses to answer', () => {
  it.each([
    ['an unknown flag is passed', () => ['--oops']],
    ['--plugin-root has no value', () => ['--plugin-root']],
    ['--plugin-root is not a directory', () => ['--plugin-root', path.join(tmp, 'nowhere')]],
    ['--since does not parse to a time', () => ['--since', 'nonsense']],
    // Finite, but past the Date range: toISOString would throw after parsing.
    ['--since is outside the Date range', () => ['--since', '9999999999999999']],
    ['--since is negative past the Date range', () => ['--since', '-8640000000000001']],
    // Empty or blank must not fall back to the process cwd / own plugin root.
    ['--cwd is empty', () => ['--cwd', '']],
    ['--cwd is blank', () => ['--cwd', '   ']],
    ['--plugin-root is empty', () => ['--plugin-root', '']],
  ])('exits 2 with an empty stdout when %s', (_label, args) => {
    const project = makeProject('P11');

    const out = runCli(args(), project);

    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
    expect(out.stderr.startsWith('existence-audit:')).toBe(true);
  });
});

describe('existence-audit: it is safe to import', () => {
  it('exposes main and runs nothing when imported', async () => {
    const mod = await import(`file:///${CLI.replace(/\\/g, '/')}`);
    expect(typeof mod.main).toBe('function');
  });
});
