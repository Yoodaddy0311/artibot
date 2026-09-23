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

// This file spawns child processes; the budget is headroom for load only.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'ledger', 'existence-audit.mjs');

/** The exact key set the script header promises. */
const STDOUT_KEYS = [
  'measuredAt', 'inputPath', 'since', 'pluginRoot', 'sources',
  'hooksOutsideCarrier', 'unmatched', 'kinds', 'summary',
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

/** hooks.json: two dispatchers plus two hooks registered directly. */
const HOOKS_JSON = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/_sessionstart-dispatcher.js' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/pre-bash.js' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/_stop-dispatcher.js' }] }],
    Notification: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/workflow-status.js notification' }] }],
  },
};

/**
 * A full fixture plugin root. Each source holds one item the enumerator must
 * SKIP, so a regression that stops filtering is visible in the counts.
 */
function makePlugin(name) {
  const root = path.join(tmp, name);
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
    expect(printed.summary.entries).toBe(3 + 2 + 2 + 2);
  });

  it('lists what it skipped and what the carrier counted outside the inventory', () => {
    const project = makeProject('P3');
    const plugin = makePlugin('plug3');
    seedLedger(project);

    const printed = parseOne(runCli(['--cwd', project, '--plugin-root', plugin], project));

    expect(printed.sources.commands).toMatchObject({ status: 'enumerated', count: 2, skipped: 1 });
    expect(printed.sources.skills).toMatchObject({ status: 'enumerated', count: 2, skipped: 1 });
    // memory-tracker sits in two slots: 4 handler entries, 3 distinct hooks.
    expect(printed.sources.hooks).toMatchObject({ status: 'enumerated', count: 3, handlerEntries: 4 });
    expect(printed.sources.modules).toMatchObject({ status: 'enumerated', count: 2 });
    // The hooks no hook.fired row can ever name are counted, not audited.
    expect(printed.hooksOutsideCarrier).toEqual({
      path: 'hooks/hooks.json',
      status: 'enumerated',
      count: 2,
      entries: ['PreToolUse pre-bash.js', 'Notification workflow-status.js notification'],
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
