/**
 * The TASK (action-class) layer of `/model-routing`: the spec parsers of
 * scripts/model-routing/model-routing-task.mjs as plain functions, and the
 * `set task` / `reset task` / `resolve --task` / `show --task` / `apply`
 * surface driven as a real child process.
 *
 * Isolation is the same as model-routing-cli.test.js: HOME/USERPROFILE and the
 * `ARTIBOT_STATE_DIR` + `ARTIBOT_STATE_DIR_HOME` pair point into a temp dir,
 * both host session id variables are deleted, and the cowork roster is a temp
 * fixture passed with `--cowork-root`.
 *
 * WHAT THIS DOES NOT SEE: whether a leader passes `resolve --task` output to
 * Agent(model=…), and which task a live spawn really was — `validate --live`
 * judges every spawn under its agent's DEFAULT task, not the `action_class`
 * its route.bound line recorded.
 *
 * @module tests/scripts/model-routing-task
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_NAMES } from '../../lib/core/model-overrides.js';
import { ACTION_CLASSES, AGENT_ACTION_CLASS, AGENT_CLASS_EXEMPT } from '../../lib/routing/action-classifier.js';
import {
  parseApplyChanges,
  parseResetSpec,
  parseSetSpec,
  Refusal,
  requireTask,
  rowTask,
  taskSummary,
  UsageError,
} from '../../scripts/model-routing/model-routing-task.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'model-routing', 'model-routing.mjs');
const REAL_FILE = path.join(homedir(), '.claude', 'artibot', 'model-routing.json');
const SHIPPED_CONFIG = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf8'));
const TIMEOUT = 60_000;
const EXPECTED = `(expected ${ACTION_CLASSES.join('|')})`;

/** @param {string} file @returns {string|null} sha256 of the bytes, or null when absent */
function fingerprint(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
}

/** @returns {Error} what `fn` threw (fails the test when nothing was thrown) */
function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

/** A spec-parser context: the shipped config and two small rosters. */
const CTX = {
  config: SHIPPED_CONFIG,
  rosters: {
    artibot: new Map([['planner', 'opus'], ['code-reviewer', 'opus'], ['backend-developer', 'opus']]),
    'artibot-cowork': new Map([['planner', 'sonnet'], ['case-study-writer', 'haiku']]),
  },
};

describe('requireTask', () => {
  it('accepts exactly the eight action classes, imported not re-listed', () => {
    expect(ACTION_CLASSES).toHaveLength(8);
    for (const task of ACTION_CLASSES) expect(requireTask(task)).toBe(task);
  });

  it('refuses a near miss with the full expected list, | separated', () => {
    const err = thrown(() => requireTask('complex-debugging'));
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toBe(`unknown task: complex-debugging ${EXPECTED}`);
    expect(thrown(() => requireTask('Review')).message).toBe(`unknown task: Review ${EXPECTED}`);
    expect(thrown(() => requireTask(undefined)).message).toBe(`missing task ${EXPECTED}`);
  });
});

describe('parseSetSpec / parseResetSpec — task scope', () => {
  it('--plugin defaults to all: one spec per plugin, same tier', () => {
    expect(parseSetSpec(CTX, ['task', 'review', 'haiku'])).toEqual(
      PLUGIN_NAMES.map((plugin) => ({ scope: 'task', plugin, key: 'review', tier: 'haiku' })),
    );
    expect(parseSetSpec(CTX, ['task', 'review', 'haiku'], { plugin: 'artibot-cowork' })).toEqual([
      { scope: 'task', plugin: 'artibot-cowork', key: 'review', tier: 'haiku' },
    ]);
    expect(parseResetSpec(CTX, ['task', 'review'], {})).toEqual(
      PLUGIN_NAMES.map((plugin) => ({ scope: 'task', plugin, key: 'review', tier: null })),
    );
  });

  it('--plugin on any other scope is still the unknown-flag error', () => {
    for (const parse of [
      () => parseSetSpec(CTX, ['agent', 'artibot:planner', 'sonnet'], { plugin: 'artibot' }),
      () => parseSetSpec(CTX, ['phase', 'build', 'sonnet'], { plugin: 'artibot' }),
      () => parseResetSpec(CTX, [], { all: true, plugin: 'artibot' }),
    ]) {
      expect(thrown(parse).message).toBe('unknown flag: --plugin');
    }
  });

  it('refuses fable with the very text of the agent path while the gate is off', () => {
    const agent = thrown(() => parseSetSpec(CTX, ['agent', 'artibot:planner', 'fable']));
    const task = thrown(() => parseSetSpec(CTX, ['task', 'review', 'fable']));
    expect(task).toBeInstanceOf(UsageError);
    expect(task.message).toBe(agent.message);
    expect(task.message).toContain('fable gate is off');
  });

  it('lists task among the scopes of an unknown one', () => {
    expect(thrown(() => parseSetSpec(CTX, ['role', 'x', 'opus'])).message).toBe(
      'unknown set scope: role (expected agent|task|phase|plugin)',
    );
    expect(thrown(() => parseResetSpec(CTX, ['role', 'x'], {})).message).toBe(
      'unknown reset scope: role (expected agent|task|phase|plugin|--all)',
    );
  });
});

describe('rowTask / taskSummary', () => {
  it('defaults to AGENT_ACTION_CLASS for either plugin prefix; an explicit task wins', () => {
    expect(rowTask('artibot:code-reviewer')).toBe(AGENT_ACTION_CLASS['code-reviewer']);
    expect(rowTask('artibot-cowork:planner')).toBe(AGENT_ACTION_CLASS.planner);
    expect(rowTask('artibot-cowork:case-study-writer')).toBeNull();
    expect(rowTask('artibot-cowork:long-form-writer')).toBeNull();
    expect(AGENT_CLASS_EXEMPT).toContain('general-purpose');
    expect(rowTask('artibot:general-purpose')).toBeNull();
    expect(rowTask('artibot:planner', 'status')).toBe('status');
    // An explicit task applies to ANY agent, one without a default included.
    expect(rowTask('artibot-cowork:case-study-writer', 'review')).toBe('review');
  });

  it('keeps an agent without a default task out of every tasks[].agents list', () => {
    const listed = taskSummary(CTX, [...PLUGIN_NAMES], null).flatMap((t) => t.agents);
    expect(listed).not.toContain('artibot-cowork:case-study-writer');
    expect(listed).toContain('artibot-cowork:planner');
  });

  it('groups agents by default task and reports each plugin override (null when unset)', () => {
    const overrides = { schemaVersion: 1, plugins: { artibot: { tasks: { review: 'haiku' } } } };
    const tasks = taskSummary(CTX, [...PLUGIN_NAMES], overrides);
    expect(tasks.map((t) => t.task)).toEqual([...ACTION_CLASSES]);
    expect(tasks.find((t) => t.task === 'architecture').agents).toEqual(['artibot:planner', 'artibot-cowork:planner']);
    expect(tasks.find((t) => t.task === 'review')).toEqual({
      task: 'review',
      agents: ['artibot:code-reviewer'],
      overrides: { artibot: 'haiku', 'artibot-cowork': null },
    });
    expect(taskSummary(CTX, ['artibot-cowork'], null).find((t) => t.task === 'architecture').agents).toEqual([
      'artibot-cowork:planner',
    ]);
  });
});

describe('parseApplyChanges — the §C-3 field table', () => {
  /** @param {object} change @returns {object[]} specs of a single accepted change, index stripped */
  const accept = (change) => parseApplyChanges(CTX, { changes: [change] }, 'f.json').map(({ index: _index, ...s }) => s);
  /** @param {*} change @returns {string} the reason line of a single rejected change */
  const reject = (change) => {
    const err = thrown(() => parseApplyChanges(CTX, { changes: [change] }, 'f.json'));
    expect(err).toBeInstanceOf(Refusal);
    return err.message.split('\n')[1];
  };
  const agent = (over) => ({ scope: 'agent', key: 'artibot:planner', tier: 'sonnet', ...over });
  const task = (over) => ({ scope: 'task', key: 'review', tier: 'haiku', ...over });
  const phase = (over) => ({ scope: 'phase', key: 'build', tier: 'opus', ...over });
  const plug = (over) => ({ scope: 'plugin', plugin: 'artibot', tier: 'opus', ...over });
  const both = (spec) => PLUGIN_NAMES.map((plugin) => ({ ...spec, plugin }));

  it('accepts every allowed shape', () => {
    const planner = { scope: 'agent', plugin: 'artibot', key: 'planner', tier: 'sonnet' };
    expect(accept(agent())).toEqual([planner]);
    expect(accept(agent({ plugin: 'artibot' }))).toEqual([planner]);
    expect(accept(agent({ key: 'artibot-cowork:planner', plugin: 'artibot-cowork' }))).toEqual([
      { ...planner, plugin: 'artibot-cowork' },
    ]);
    // A reset needs no roster entry, like `reset agent` (clears a stale name).
    expect(accept(agent({ key: 'artibot:ghost', tier: null }))).toEqual([{ ...planner, key: 'ghost', tier: null }]);
    const review = { scope: 'task', key: 'review', tier: 'haiku' };
    expect(accept(task())).toEqual(both(review));
    expect(accept(task({ plugin: 'all' }))).toEqual(both(review));
    expect(accept(task({ plugin: 'artibot-cowork', tier: null }))).toEqual([{ ...review, plugin: 'artibot-cowork', tier: null }]);
    const build = { scope: 'phase', plugin: 'artibot', key: 'build', tier: 'opus' };
    expect(accept(phase())).toEqual([build]);
    expect(accept(phase({ plugin: 'artibot', key: 'review' }))).toEqual([{ ...build, key: 'review' }]);
    expect(accept(plug())).toEqual([{ scope: 'plugin', plugin: 'artibot', tier: 'opus' }]);
    expect(accept(plug({ plugin: 'artibot-cowork', key: null, tier: null }))).toEqual([
      { scope: 'plugin', plugin: 'artibot-cowork', tier: null },
    ]);
  });

  it('reads plugin: null as omitted on agent/task/phase; the plugin scope refuses it as missing', () => {
    expect(accept(agent({ plugin: null, key: 'artibot-cowork:planner' }))).toEqual([
      { scope: 'agent', plugin: 'artibot-cowork', key: 'planner', tier: 'sonnet' },
    ]);
    expect(accept(task({ plugin: null }))).toEqual(both({ scope: 'task', key: 'review', tier: 'haiku' }));
    expect(accept(phase({ plugin: null }))).toEqual([{ scope: 'phase', plugin: 'artibot', key: 'build', tier: 'opus' }]);
    expect(reject(plug({ plugin: null }))).toBe('change 1: missing plugin (expected artibot|artibot-cowork)');
  });

  it('rejects every disallowed shape with its reason', () => {
    const cases = [
      [agent({ key: 'planner' }), "change 1: ambiguous agent name 'planner': it exists in artibot and artibot-cowork — use artibot:planner or artibot-cowork:planner"],
      [agent({ key: 'code-reviewer' }), "change 1: agent name must be qualified as <plugin:name>, got 'code-reviewer' — use artibot:code-reviewer"],
      [agent({ key: undefined }), 'change 1: missing agent name (expected <plugin:name>)'],
      [agent({ plugin: 'all' }), "change 1: plugin all does not match the key's plugin artibot"],
      [agent({ plugin: 'artibot-cowork' }), "change 1: plugin artibot-cowork does not match the key's plugin artibot"],
      [agent({ key: 'artibot:nobody' }), 'change 1: unknown agent: artibot:nobody'],
      [task({ key: undefined }), `change 1: missing task ${EXPECTED}`],
      [task({ key: 'deploy' }), `change 1: unknown task: deploy ${EXPECTED}`],
      [task({ plugin: 'other' }), 'change 1: unknown plugin: other (expected artibot|artibot-cowork|all)'],
      [phase({ plugin: 'artibot-cowork' }), 'change 1: phase overrides exist only for plugin artibot, got: artibot-cowork'],
      [phase({ plugin: 'all' }), 'change 1: phase overrides exist only for plugin artibot, got: all'],
      [phase({ key: undefined }), 'change 1: unknown phase: undefined (expected build|review)'],
      [phase({ key: 'deploy' }), 'change 1: unknown phase: deploy (expected build|review)'],
      [plug({ key: 'x' }), 'change 1: plugin scope takes no key'],
      [plug({ plugin: undefined }), 'change 1: missing plugin (expected artibot|artibot-cowork)'],
      [plug({ plugin: 'all' }), 'change 1: unknown plugin: all (expected artibot|artibot-cowork)'],
      [task({ tier: 'fable' }), 'change 1: unknown tier: fable (expected haiku|sonnet|opus) — the fable gate is off in the shipped config'],
      [task({ tier: undefined }), 'change 1: missing tier (expected haiku|sonnet|opus)'],
      [task({ tier: 'deep-async' }), 'change 1: unknown tier: deep-async (expected haiku|sonnet|opus)'],
      [task({ extra: 1 }), 'change 1: unknown key "extra" (expected scope|plugin|key|tier)'],
      [{ scope: 'role', key: 'x', tier: 'opus' }, 'change 1: unknown scope: role (expected agent|task|phase|plugin)'],
      ['not-an-object', 'change 1: must be an object'],
    ];
    for (const [change, reason] of cases) expect(reject(change), JSON.stringify(change)).toBe(reason);
  });

  it('collects EVERY bad change, each named by its 1-based index', () => {
    const err = thrown(() =>
      parseApplyChanges(CTX, { changes: [task(), task({ key: 'nope' }), agent(), plug({ plugin: 'all' })] }, 'f.json'),
    );
    expect(err.message.split('\n')).toEqual([
      'refusing to apply f.json: 2 of 4 change(s) invalid; nothing was changed.',
      `change 2: unknown task: nope ${EXPECTED}`,
      'change 4: unknown plugin: all (expected artibot|artibot-cowork)',
    ]);
    expect(parseApplyChanges(CTX, { changes: [task(), agent()] }, 'f.json').map((s) => s.index)).toEqual([1, 1, 2]);
  });

  it('refuses a document without a non-empty changes array', () => {
    for (const doc of [null, [], {}, { changes: [] }, { changes: 'x' }]) {
      expect(thrown(() => parseApplyChanges(CTX, doc, 'f.json'))).toBeInstanceOf(Refusal);
    }
  });
});

// ---------------------------------------------------------------------------
// The CLI, as a child process
// ---------------------------------------------------------------------------

let realBefore;
let root;
let env;
let stateFile;
let coworkRoot;

beforeAll(() => {
  realBefore = fingerprint(REAL_FILE);
});

afterAll(() => {
  // The suite must never touch the user's real overrides file.
  expect(fingerprint(REAL_FILE)).toBe(realBefore);
});

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-model-routing-task-'));
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  mkdirSync(home, { recursive: true });
  env = { ...process.env, HOME: home, USERPROFILE: home, ARTIBOT_STATE_DIR: state, ARTIBOT_STATE_DIR_HOME: home };
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_CODE_SESSION_ID;
  stateFile = path.join(state, 'model-routing.json');
  coworkRoot = path.join(root, 'cowork');
  mkdirSync(path.join(coworkRoot, 'agents'), { recursive: true });
  // planner defaults to `architecture`; case-study-writer has no default task.
  for (const [name, model] of [['planner', 'sonnet'], ['case-study-writer', 'haiku']]) {
    writeFileSync(path.join(coworkRoot, 'agents', `${name}.md`), `---\nname: ${name}\nmodel: ${model}\n---\n`, 'utf8');
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** @returns {{ code: number|null, stdout: string, stderr: string }} */
function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--cowork-root', coworkRoot], { env, encoding: 'utf8', timeout: TIMEOUT });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** @returns {object} parsed `show --json` */
function showJson(...args) {
  const r = run('show', '--json', ...args);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

/** @returns {object} one row of `show --json` */
function row(json, plugin, agent) {
  return json.plugins[plugin].rows.find((x) => x.agent === agent);
}

/** @param {object} doc @returns {string} path of a written apply file */
function applyFile(doc) {
  const file = path.join(root, `apply-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(doc), 'utf8');
  return file;
}

/** @param {object} plugins @returns {void} writes a v1 overrides document */
function writeOverrides(plugins) {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, plugins }), 'utf8');
}

describe('CLI: set task → resolve → show → reset', () => {
  it('sets both plugins by default and applies to agents whose DEFAULT task it is', { timeout: TIMEOUT }, () => {
    const set = run('set', 'task', 'review', 'haiku');
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout).toContain('artibot:code-reviewer: opus → haiku');
    expect(set.stdout).not.toContain('artibot:planner');
    const doc = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(doc.plugins.artibot.tasks).toEqual({ review: 'haiku' });
    expect(doc.plugins['artibot-cowork'].tasks).toEqual({ review: 'haiku' });

    expect(run('resolve', 'artibot:code-reviewer')).toMatchObject({ code: 0, stdout: 'haiku\n' });
    expect(run('resolve', 'artibot:planner').stdout).toBe('opus\n');
    expect(run('resolve', 'artibot:planner', '--task', 'review')).toMatchObject({ code: 0, stdout: 'haiku\n', stderr: '' });
    expect(run('resolve', 'artibot:code-reviewer', '--task', 'implement').stdout).toBe('opus\n');

    const reset = run('reset', 'task', 'review');
    expect(reset.code, reset.stderr).toBe(0);
    expect(reset.stdout).toContain('artibot:code-reviewer: haiku → opus');
    const after = JSON.parse(readFileSync(stateFile, 'utf8'));
    // Back to the plain v1 shape: no empty `tasks` key is left behind.
    for (const p of PLUGIN_NAMES) expect(Object.hasOwn(after.plugins[p], 'tasks')).toBe(false);
  });

  it('--plugin narrows the write to one plugin', { timeout: TIMEOUT }, () => {
    expect(run('set', 'task', 'architecture', 'sonnet', '--plugin', 'artibot-cowork').code).toBe(0);
    expect(run('resolve', 'artibot-cowork:planner').stdout).toBe('sonnet\n');
    expect(run('resolve', 'artibot:planner').stdout).toBe('opus\n');
    const doc = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(Object.hasOwn(doc.plugins.artibot, 'tasks')).toBe(false);
  });

  it('explicit --task applies to any agent; without it an agent with no default task skips the layer (2×2)', { timeout: TIMEOUT }, () => {
    // review → sonnet in both plugins. case-study-writer's frontmatter is haiku
    // and it has no default task; code-reviewer defaults to review (shipped opus).
    expect(run('set', 'task', 'review', 'sonnet').code).toBe(0);
    const out = (...args) => run('resolve', ...args).stdout;
    expect({
      'mapped, no --task': out('artibot:code-reviewer'),
      'mapped, --task review': out('artibot:code-reviewer', '--task', 'review'),
      'unmapped, no --task': out('artibot-cowork:case-study-writer'),
      'unmapped, --task review': out('artibot-cowork:case-study-writer', '--task', 'review'),
    }).toEqual({
      'mapped, no --task': 'sonnet\n',
      'mapped, --task review': 'sonnet\n',
      'unmapped, no --task': 'haiku\n',
      'unmapped, --task review': 'sonnet\n',
    });
    // Positive control: the mapped agent under a task with no override is shipped.
    expect(out('artibot:code-reviewer', '--task', 'implement')).toBe('opus\n');
  });

  it('an agent with no default task shows task null / — and is in no tasks[].agents list', { timeout: TIMEOUT }, () => {
    expect(run('set', 'task', 'review', 'sonnet').code).toBe(0);
    const json = showJson();
    expect(row(json, 'artibot-cowork', 'case-study-writer')).toMatchObject({ task: null, effective: 'haiku', source: 'cowork-frontmatter' });
    expect(json.tasks.flatMap((t) => t.agents)).not.toContain('artibot-cowork:case-study-writer');
    expect(run('show', '--plugin', 'artibot-cowork').stdout).toMatch(/artibot-cowork\s+case-study-writer\s+haiku\s+haiku\s+—\s+haiku \[cowork-frontmatter\]\s+frontmatter\s+—$/m);
    // With --task, it is resolved like any other agent.
    expect(row(showJson('--task', 'review'), 'artibot-cowork', 'case-study-writer')).toMatchObject({ task: 'review', effective: 'sonnet' });
  });

  it('show --task X row.effective equals resolve <name> --task X for every sampled agent', { timeout: TIMEOUT }, () => {
    expect(run('set', 'task', 'review', 'haiku', '--plugin', 'artibot').code).toBe(0);
    expect(run('set', 'agent', 'artibot:architect', 'sonnet').code).toBe(0);
    for (const task of ['review', 'implement']) {
      const json = showJson('--task', task);
      for (const name of ['artibot:code-reviewer', 'artibot:architect', 'artibot:backend-developer', 'artibot-cowork:planner', 'artibot-cowork:case-study-writer']) {
        const [plugin, agent] = name.split(':');
        expect(run('resolve', name, '--task', task).stdout, `${name} --task ${task}`).toBe(`${row(json, plugin, agent).effective}\n`);
      }
    }
  });

  it('validate warns about a stored fable task pick that no agent defaults to (gate off)', { timeout: TIMEOUT }, () => {
    // No agent defaults to `status`, so only the stored-override check can see this.
    writeOverrides({
      artibot: { default: null, agents: {}, phaseRoles: {}, tasks: { status: 'fable', review: 'sonnet' } },
      'artibot-cowork': { default: null, agents: {}, tasks: { status: 'fable' } },
    });
    const r = run('validate');
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain('WARN  artibot [task=status]: fable demoted to opus (fable-gate) for 29 of 30 agent(s) with --task status');
    expect(r.stdout).toContain('WARN  artibot [task=status]: fable demoted to opus (denylist) for 1 of 30 agent(s) with --task status');
    expect(r.stdout).toContain('WARN  artibot-cowork [task=status]: fable demoted to opus (fable-gate) for 2 of 2 agent(s) with --task status');
    expect(r.stdout).not.toContain('[task=review]');
    expect(run('resolve', 'artibot:planner', '--task', 'status').stdout).toBe('opus\n');
    // Positive control: the same file without the fable pick has no task warning at all.
    writeOverrides({ artibot: { default: null, agents: {}, phaseRoles: {}, tasks: { status: 'sonnet' } } });
    expect(run('validate').stdout).not.toContain('[task=');
  });

  it('validate warns about a stored task key that is not an action class', { timeout: TIMEOUT }, () => {
    writeOverrides({ artibot: { default: null, agents: {}, phaseRoles: {}, tasks: { deploy: 'haiku', review: 'sonnet' } } });
    const r = run('validate');
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain(`WARN  artibot: task override "deploy" is not an action class ${EXPECTED} — it never applies`);
    expect(r.stdout).not.toContain('"review" is not');
    expect(JSON.parse(run('validate', '--json').stdout).warnings).toHaveLength(1);
  });

  it('show --json: per-row task, top-level tasks, and --task resolves every row as resolve --task does', { timeout: TIMEOUT }, () => {
    expect(run('set', 'task', 'review', 'haiku', '--plugin', 'artibot').code).toBe(0);
    const json = showJson();
    expect(json.task).toBeNull();
    expect(row(json, 'artibot', 'code-reviewer')).toMatchObject({
      task: 'review', effective: 'haiku', source: 'override-task', override: 'haiku (task)', hostPath: 'needs-spawn-param',
    });
    expect(row(json, 'artibot', 'planner')).toMatchObject({ task: 'architecture', effective: 'opus', source: 'shipped' });
    expect(row(json, 'artibot-cowork', 'case-study-writer').task).toBeNull();
    expect(json.tasks.map((t) => t.task)).toEqual([...ACTION_CLASSES]);
    const review = json.tasks.find((t) => t.task === 'review');
    expect(review.overrides).toEqual({ artibot: 'haiku', 'artibot-cowork': null });
    expect(review.agents).toContain('artibot:code-reviewer');
    expect(review.agents).not.toContain('artibot:planner');

    const as = showJson('--task', 'review', '--plugin', 'artibot');
    expect(as.task).toBe('review');
    for (const r of as.plugins.artibot.rows) expect(r).toMatchObject({ task: 'review', effective: 'haiku' });
    expect(run('resolve', 'artibot:architect', '--task', 'review').stdout).toBe(`${row(as, 'artibot', 'architect').effective}\n`);
  });

  it('show text gains a trailing task column and a task overrides line', { timeout: TIMEOUT }, () => {
    expect(run('show', '--plugin', 'artibot').stdout).toContain('task overrides: (none)');
    expect(run('set', 'task', 'review', 'haiku').code).toBe(0);
    const text = run('show', '--task', 'review').stdout;
    expect(text).toMatch(/^overrides: .* · task=review$/m);
    expect(text).toMatch(/plugin\s+agent\s+frontmatter\s+shipped\s+override\s+effective\s+host path\s+task/);
    expect(text).toMatch(/artibot\s+code-reviewer\s+opus\s+opus\s+haiku \(task\)\s+haiku \[override-task\]\s+needs-spawn-param\s+review/);
    expect(text).toContain('task overrides: review=artibot haiku, artibot-cowork haiku');
  });

  it('validate accepts a stored task override', { timeout: TIMEOUT }, () => {
    expect(run('set', 'task', 'review', 'haiku').code).toBe(0);
    const r = run('validate');
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain('needs-spawn-param artibot:code-reviewer: effective haiku ≠ frontmatter opus');
  });
});

describe('CLI: precedence agent > task > phase > plugin > shipped', () => {
  // artibot:backend-developer, role build, default task implement. Each row of
  // the table stores the layers marked 1; the source must be the first of them.
  // Every layer is also its own positive control: drop it and the row changes.
  const LAYERS = ['agent', 'task', 'phase', 'plugin'];
  const MATRIX = Array.from({ length: 16 }, (_, bits) => LAYERS.filter((layer, i) => bits & (1 << (3 - i))));

  it('pins the first present layer for all 16 combinations', { timeout: TIMEOUT * 4 }, () => {
    const seen = [];
    for (const present of MATRIX) {
      writeOverrides({
        artibot: {
          default: present.includes('plugin') ? 'haiku' : null,
          agents: present.includes('agent') ? { 'backend-developer': 'sonnet' } : {},
          phaseRoles: present.includes('phase') ? { build: 'haiku' } : {},
          ...(present.includes('task') ? { tasks: { implement: 'sonnet' } } : {}),
        },
      });
      const r = row(showJson('--plugin', 'artibot', '--role', 'build'), 'artibot', 'backend-developer');
      seen.push([present.join('+') || '(none)', r.source]);
    }
    expect(Object.fromEntries(seen)).toEqual({
      '(none)': 'shipped',
      plugin: 'override-plugin',
      phase: 'override-phase',
      'phase+plugin': 'override-phase',
      task: 'override-task',
      'task+plugin': 'override-task',
      'task+phase': 'override-task',
      'task+phase+plugin': 'override-task',
      agent: 'override-agent',
      'agent+plugin': 'override-agent',
      'agent+phase': 'override-agent',
      'agent+phase+plugin': 'override-agent',
      'agent+task': 'override-agent',
      'agent+task+plugin': 'override-agent',
      'agent+task+phase': 'override-agent',
      'agent+task+phase+plugin': 'override-agent',
    });
  });

  it('a task override for another task does not apply', { timeout: TIMEOUT }, () => {
    writeOverrides({ artibot: { default: null, agents: {}, phaseRoles: {}, tasks: { review: 'haiku' } } });
    expect(run('resolve', 'artibot:backend-developer').stdout).toBe('opus\n');
    expect(run('resolve', 'artibot:backend-developer', '--task', 'review').stdout).toBe('haiku\n');
  });
});

describe('CLI: task usage errors (exit 2, one stderr line, nothing written)', () => {
  /** @param {string[]} args @returns {string} stderr */
  function expectUsage(...args) {
    const r = run(...args);
    expect(r.code, `${args.join(' ')} → ${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(existsSync(stateFile)).toBe(false);
    return r.stderr;
  }

  it('unknown task: exact text on set, reset, resolve and show', { timeout: TIMEOUT }, () => {
    const text = `model-routing: unknown task: bogus ${EXPECTED}\n`;
    expect(expectUsage('set', 'task', 'bogus', 'haiku')).toBe(text);
    expect(expectUsage('reset', 'task', 'bogus')).toBe(text);
    expect(expectUsage('resolve', 'artibot:planner', '--task', 'bogus')).toBe(text);
    expect(expectUsage('show', '--task', 'bogus')).toBe(text);
  });

  it('fable is refused with the agent-path text; --plugin stays unknown elsewhere', { timeout: TIMEOUT }, () => {
    expect(expectUsage('set', 'task', 'review', 'fable')).toBe(expectUsage('set', 'agent', 'artibot:architect', 'fable'));
    expect(expectUsage('set', 'agent', 'artibot:planner', 'sonnet', '--plugin', 'artibot')).toBe(
      'model-routing: unknown flag: --plugin\n',
    );
    expectUsage('set', 'task', 'review', 'haiku', '--plugin', 'other');
    expectUsage('apply');
  });

  it('--plugin outside the task scope keeps the pre-task stderr byte for byte, value or not', { timeout: TIMEOUT }, () => {
    const old = 'model-routing: unknown flag: --plugin\n';
    // A truly value-less trailing --plugin: nothing may follow it, so no --cowork-root.
    const bare = spawnSync(process.execPath, [CLI, 'set', 'agent', 'artibot:planner', 'sonnet', '--plugin'], { env, encoding: 'utf8', timeout: TIMEOUT });
    expect({ code: bare.status, stderr: bare.stderr }).toEqual({ code: 2, stderr: old });
    const bareReset = spawnSync(process.execPath, [CLI, 'reset', 'phase', 'build', '--plugin'], { env, encoding: 'utf8', timeout: TIMEOUT });
    expect({ code: bareReset.status, stderr: bareReset.stderr }).toEqual({ code: 2, stderr: old });
    expect(expectUsage('set', 'agent', 'artibot:planner', 'sonnet', '--plugin')).toBe(old);
    expect(expectUsage('set', 'phase', 'build', 'sonnet', '--plugin=artibot')).toBe(old);
    expect(expectUsage('reset', 'agent', 'artibot:planner', '--plugin')).toBe(old);
    expect(expectUsage('reset', '--all', '--plugin', 'artibot')).toBe(old);
    // On the task scope a flag before the scope still counts.
    expect(run('set', '--dry-run', 'task', 'review', 'haiku', '--plugin', 'artibot').code).toBe(0);
  });

  it('pins the three list texts that changed (§C exceptions, leader-approved)', { timeout: TIMEOUT }, () => {
    expect(expectUsage('set', 'role', 'x', 'opus')).toBe('model-routing: unknown set scope: role (expected agent|task|phase|plugin)\n');
    expect(expectUsage('reset', 'role', 'x')).toBe('model-routing: unknown reset scope: role (expected agent|task|phase|plugin|--all)\n');
    expect(expectUsage('frobnicate')).toBe(
      'model-routing: unknown subcommand: frobnicate (expected show|set|reset|apply|validate|resolve)\n',
    );
  });

  it('validate --live prints the two existing caveats byte for byte plus the default-task one', { timeout: TIMEOUT }, () => {
    const r = run('validate', '--live', '--cwd', path.join(root, 'no-ledger'), '--json');
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).caveats).toEqual([
      "expected tier = TODAY's config, rosters and overrides as read from the plugin root above, which may differ from the installed plugin that served the spawns — pass --plugin-root (and --cowork-root) to judge against the installed copy; a spawn from before the last change is judged against them — window with --since",
      'honored mostly means the frontmatter default was served; only an override-* row whose override differs from the frontmatter says anything about an override',
      "expected tier uses each agent's DEFAULT task, not the task the spawn was resolved with (e.g. `resolve --task`); a spawn routed for another task can read as unhonored",
    ]);
  });
});

describe('CLI: apply', () => {
  it('applies mixed scopes (incl. a null reset) in ONE write with one .bak', { timeout: TIMEOUT }, () => {
    expect(run('set', 'agent', 'artibot:planner', 'sonnet').code).toBe(0);
    const before = readFileSync(stateFile);
    const r = run('apply', applyFile({
      changes: [
        { scope: 'task', plugin: 'all', key: 'review', tier: 'haiku' },
        { scope: 'agent', plugin: null, key: 'artibot:planner', tier: null },
        { scope: 'phase', plugin: 'artibot', key: 'build', tier: 'sonnet' },
        { scope: 'plugin', plugin: 'artibot-cowork', tier: 'opus' },
      ],
    }));
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^effective changes \(\d+\):\n/);
    expect(r.stdout).toContain('artibot:code-reviewer: opus → haiku');
    // The cleared agent pick falls to the new build-phase pick under role=build only.
    expect(r.stdout).toContain('artibot:planner [role=none]: sonnet → opus');
    expect(r.stdout).not.toContain('artibot:planner [role=build]');
    expect(r.stdout).toContain('artibot-cowork:case-study-writer: haiku → opus');
    expect(r.stdout).toContain(`written: ${stateFile}`);
    expect(readFileSync(`${stateFile}.bak`)).toEqual(before);
    const doc = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(doc.plugins.artibot).toEqual({ default: null, agents: {}, phaseRoles: { build: 'sonnet' }, tasks: { review: 'haiku' } });
    expect(doc.plugins['artibot-cowork']).toMatchObject({ default: 'opus', tasks: { review: 'haiku' } });
  });

  it('one bad change in the middle writes nothing: bytes identical, no .bak', { timeout: TIMEOUT }, () => {
    expect(run('set', 'agent', 'artibot:planner', 'sonnet').code).toBe(0);
    const sha = fingerprint(stateFile);
    const r = run('apply', applyFile({
      changes: [
        { scope: 'task', plugin: 'all', key: 'review', tier: 'haiku' },
        { scope: 'task', plugin: 'all', key: 'reviews', tier: 'haiku' },
        { scope: 'agent', plugin: 'artibot', key: 'artibot:architect', tier: 'haiku' },
      ],
    }));
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^model-routing: refusing to apply .*: 1 of 3 change\(s\) invalid; nothing was changed\.\n/);
    expect(r.stderr).toContain(`change 2: unknown task: reviews ${EXPECTED}\n`);
    expect(fingerprint(stateFile)).toBe(sha);
    expect(existsSync(`${stateFile}.bak`)).toBe(false);
  });

  it('--dry-run prints the diff and writes nothing; a missing file stays missing', { timeout: TIMEOUT }, () => {
    const r = run('apply', applyFile({ changes: [{ scope: 'task', plugin: 'artibot', key: 'review', tier: 'sonnet' }] }), '--dry-run');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('artibot:code-reviewer: opus → sonnet');
    expect(r.stdout).toContain('dry-run: nothing written');
    expect(existsSync(stateFile)).toBe(false);
  });

  it('refuses unreadable and non-JSON files and a damaged overrides file (exit 1)', { timeout: TIMEOUT }, () => {
    expect(run('apply', path.join(root, 'nope.json')).code).toBe(1);
    const bad = path.join(root, 'bad.json');
    writeFileSync(bad, '{ "changes": ', 'utf8');
    expect(run('apply', bad).stderr).toContain('invalid JSON');
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, 'not json', 'utf8');
    const sha = fingerprint(stateFile);
    const r = run('apply', applyFile({ changes: [{ scope: 'task', plugin: 'all', key: 'review', tier: 'haiku' }] }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refusing to write');
    expect(fingerprint(stateFile)).toBe(sha);
  });
});

describe('CLI: effective changes under an explicit task context (MR1)', () => {
  /** @param {string} stdout @returns {{ header: string, lines: string[] }} the diff block (header + indented rows) */
  function diffOf(stdout) {
    const [header, ...rest] = stdout.split('\n');
    return { header, lines: rest.filter((l) => l.startsWith('  ')) };
  }

  /** @param {string} cls @param {string} [plugin] @returns {string} an apply file with one task change to haiku */
  const taskApply = (cls, plugin = 'all') => applyFile({ changes: [{ scope: 'task', plugin, key: cls, tier: 'haiku' }] });

  /** @returns {string[]} every artibot roster agent, from `show --json` */
  const artibotRoster = () => showJson('--plugin', 'artibot').plugins.artibot.rows.map((r) => r.agent);

  it.each(['status', 'classify'])('a %s pick no agent defaults to is not "none": one [task=] row per plugin, N = row count', (cls) => {
    const n = artibotRoster().length;
    const r = run('apply', taskApply(cls), '--dry-run');
    expect(r.code, r.stderr).toBe(0);
    const { header, lines } = diffOf(r.stdout);
    expect(lines).toEqual([
      `  artibot [task=${cls}]: opus → haiku for ${n} of ${n} agent(s) not defaulting to ${cls}`,
      // case-study-writer is haiku already: 1 of the 2 fixture agents changes.
      `  artibot-cowork [task=${cls}]: sonnet → haiku for 1 of 2 agent(s) not defaulting to ${cls}`,
    ]);
    expect(header).toBe(`effective changes (${lines.length}):`);
    expect(existsSync(stateFile)).toBe(false);
  }, TIMEOUT);

  it('set task / reset task go through the same diff (dry-run and real write)', { timeout: TIMEOUT }, () => {
    const viaApply = diffOf(run('apply', taskApply('status'), '--dry-run').stdout);
    expect(diffOf(run('set', 'task', 'status', 'haiku', '--dry-run').stdout)).toEqual(viaApply);
    expect(diffOf(run('set', 'task', 'status', 'haiku').stdout)).toEqual(viaApply);
    const reset = diffOf(run('reset', 'task', 'status', '--plugin', 'artibot').stdout);
    expect(reset.lines).toEqual([expect.stringMatching(/^ {2}artibot \[task=status\]: haiku → opus for (\d+) of \1 agent\(s\) not defaulting to status$/)]);
    expect(reset.header).toBe('effective changes (1):');
  });

  it('re-setting the stored value is still none (setting unchanged)', { timeout: TIMEOUT }, () => {
    writeOverrides({
      artibot: { default: null, agents: {}, phaseRoles: {}, tasks: { status: 'haiku' } },
      'artibot-cowork': { default: null, agents: {}, tasks: { status: 'haiku' } },
    });
    expect(run('apply', taskApply('status'), '--dry-run').stdout).toMatch(/^effective changes \(none\):\ndry-run: nothing written/);
    // Positive control: a different stored value makes the same apply a change.
    writeOverrides({ artibot: { default: null, agents: {}, phaseRoles: {}, tasks: { status: 'sonnet' } } });
    expect(diffOf(run('apply', taskApply('status', 'artibot'), '--dry-run').stdout).lines).toEqual([
      expect.stringMatching(/^ {2}artibot \[task=status\]: sonnet → haiku for (\d+) of \1 agent\(s\) not defaulting to status$/),
    ]);
  });

  it('a task pick every agent override shadows (agent > task) is none; unshadow one agent and it shows', { timeout: TIMEOUT }, () => {
    const roster = artibotRoster();
    const pinned = (names) => Object.fromEntries(names.map((a) => [a, 'sonnet']));
    const cowork = { default: null, agents: { planner: 'sonnet', 'case-study-writer': 'sonnet' } };
    writeOverrides({ artibot: { default: null, agents: pinned(roster), phaseRoles: {} }, 'artibot-cowork': cowork });
    expect(run('apply', taskApply('status'), '--dry-run').stdout).toMatch(/^effective changes \(none\):\n/);
    writeOverrides({ artibot: { default: null, agents: pinned(roster.slice(1)), phaseRoles: {} }, 'artibot-cowork': cowork });
    const { header, lines } = diffOf(run('apply', taskApply('status'), '--dry-run').stdout);
    expect(lines).toEqual([`  artibot [task=status]: opus → haiku for 1 of ${roster.length} agent(s) not defaulting to status`]);
    expect(header).toBe('effective changes (1):');
  });

  it('adds no row for agents whose DEFAULT task is the class — the per-agent rows already show them', { timeout: TIMEOUT }, () => {
    const json = showJson('--plugin', 'artibot');
    const defaulters = json.tasks.find((t) => t.task === 'review').agents;
    expect(defaulters).toContain('artibot:code-reviewer');
    const others = json.plugins.artibot.rows.length - defaulters.length;
    const r = run('set', 'task', 'review', 'haiku', '--plugin', 'artibot', '--dry-run');
    const { header, lines } = diffOf(r.stdout);
    expect(lines.filter((l) => l.includes('[task='))).toEqual([
      `  artibot [task=review]: opus → haiku for ${others} of ${others} agent(s) not defaulting to review`,
    ]);
    for (const name of defaulters) {
      expect(lines).toContain(`  ${name}: opus → haiku`);
      expect(r.stdout).not.toContain(`${name} [task=`);
    }
    expect(lines).toHaveLength(defaulters.length + 1);
    expect(header).toBe(`effective changes (${lines.length}):`);
  });

  it('role variants that differ print per role, like the per-agent rows', { timeout: TIMEOUT }, () => {
    writeOverrides({ artibot: { default: null, agents: {}, phaseRoles: { build: 'sonnet' } } });
    const n = artibotRoster().length;
    const { header, lines } = diffOf(run('set', 'task', 'status', 'haiku', '--plugin', 'artibot', '--dry-run').stdout);
    expect(lines).toEqual([
      `  artibot [task=status role=none]: opus → haiku for ${n} of ${n} agent(s) not defaulting to status`,
      `  artibot [task=status role=build]: sonnet → haiku for ${n} of ${n} agent(s) not defaulting to status`,
      `  artibot [task=status role=review]: opus → haiku for ${n} of ${n} agent(s) not defaulting to status`,
    ]);
    expect(header).toBe('effective changes (3):');
  });
});
