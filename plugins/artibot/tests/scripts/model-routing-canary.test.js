/**
 * CA-02 — the shipped canary, driven through `scripts/model-routing/model-routing.mjs`
 * as a real child process (the CLI a leader runs right before a spawn).
 *
 * `routing.canary` ships `{ actionClasses: ['classify','status'], tier: 'sonnet' }`, so
 * `resolve <plugin:name> --task classify|status` prints the low tier instead of opus,
 * and the leader's `Agent(model=<that word>)` is what makes it real (D1: the
 * `/model-routing` task layer is the CA-02 actuator; there is no enforcing hook).
 *
 * Pins, all against the REAL shipped `artibot.config.json`:
 *   A. positive control — the two classes resolve to sonnet for agents that build or
 *      run routine work, in both plugins; and (SHOULD-1) design and review stay on
 *      opus: a `--role review` spawn, and any agent whose OWN default task is
 *      review or architecture, whatever role or task the leader names;
 *   B. negative control — every other class, and a call without `--task`, is
 *      byte-identical to a plugin root whose canary is switched OFF; under classify
 *      and status only the agents the guard lets through differ, and a review role
 *      sees no canary at all;
 *   C. every user setting (agent / task / phase / plugin default) beats it — the
 *      guard limits the canary, never the user — and clearing the pick brings it back;
 *   D. `show` labels the answer (`canary-task`), it is not a user override, and it
 *      needs the spawn parameter; held rows keep the shipped answer;
 *   E. the `set`/`reset` effective-changes diff starts from the canary value, role
 *      by role (a review role never had it);
 *   F. a damaged overrides file still answers the SHIPPED values, canary included.
 *
 * Isolation: HOME/USERPROFILE and the `ARTIBOT_STATE_DIR` + `ARTIBOT_STATE_DIR_HOME`
 * pair point into a temp dir, both host session id variables are deleted, and the
 * suite fingerprints the user's REAL overrides file before and after — it must never
 * read or write it. The cowork roster is a temp fixture (`--cowork-root`).
 *
 * WHAT THIS DOES NOT SEE: whether a leader passes `--task classify|status` (no agent
 * DEFAULTS to those classes, so an unlabelled spawn is never lowered), whether it
 * passes the printed word to `Agent(model=…)`, and whether the host serves it — only
 * `usage.receipt` (served model) shows the last one. It also cannot see a caller of
 * `resolveEffectiveModel` other than this CLI: the class guard needs the agent's
 * default task, which only the CLI supplies (`tests/core/model-overrides-canary.test.js`
 * pins what core does without it — role guard and the protected-agent floor only).
 *
 * @module tests/scripts/model-routing-canary
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACTION_CLASSES } from '../../lib/routing/action-classifier.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'model-routing', 'model-routing.mjs');
const REAL_FILE = path.join(homedir(), '.claude', 'artibot', 'model-routing.json');
const SHIPPED = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf8'));
const TIMEOUT = 60_000;
const CANARY = Object.freeze(['classify', 'status']);
const PLAIN = Object.freeze(ACTION_CLASSES.filter((c) => !CANARY.includes(c)));
/** The one artibot agent on the canary's own protected list — and, as a `review` agent, held by its class too. */
const DENYLISTED = 'security-reviewer';
/** Default tasks whose agents the canary never lowers: the owner's "design and review = opus" (2026-09-29). */
const HELD_TASKS = Object.freeze(['review', 'architecture']);

/** @param {string} file @returns {string|null} sha256 of the bytes, or null when absent */
function fingerprint(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
}

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
  root = mkdtempSync(path.join(tmpdir(), 'artibot-model-routing-canary-'));
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  mkdirSync(home, { recursive: true });
  env = { ...process.env, HOME: home, USERPROFILE: home, ARTIBOT_STATE_DIR: state, ARTIBOT_STATE_DIR_HOME: home };
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_CODE_SESSION_ID;
  stateFile = path.join(state, 'model-routing.json');
  coworkRoot = path.join(root, 'cowork');
  mkdirSync(path.join(coworkRoot, 'agents'), { recursive: true });
  // content-marketer (an `implement` agent) and planner (an `architecture` agent): both dearer than the canary
  // tier, but only the first may be lowered; case-study-writer: CHEAPER than it; doc-updater: equal to it.
  for (const [name, model] of [['planner', 'opus'], ['content-marketer', 'opus'], ['case-study-writer', 'haiku'], ['doc-updater', 'sonnet']]) {
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

/** @returns {string} the resolved word (stdout of `resolve`, exit 0 and a quiet stderr asserted) */
function resolved(...args) {
  const r = run('resolve', ...args);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stderr).toBe('');
  return r.stdout;
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

/**
 * The agents' OWN default tasks, read from a plain `show --json` (no `--task`, so each row's
 * `task` is the agent's default, `null` for an agent with none).
 *
 * @returns {Map<string, string|null>} `<plugin>:<agent>` → default task
 */
function defaultTasks() {
  const json = showJson();
  return new Map(Object.entries(json.plugins).flatMap(([plugin, p]) => (p.rows ?? []).map((r) => [`${plugin}:${r.agent}`, r.task])));
}

/** @returns {boolean} true when the canary never lowers this agent — its own default task is review or architecture */
const isHeld = (defaults, plugin, agent) => HELD_TASKS.includes(defaults.get(`${plugin}:${agent}`));

/** @returns {{ n: number, held: number, lowered: number }} the artibot roster, split the way the guard splits it */
function artibotSplit() {
  const defaults = defaultTasks();
  const agents = [...defaults.keys()].filter((k) => k.startsWith('artibot:')).map((k) => k.slice('artibot:'.length));
  const held = agents.filter((a) => isHeld(defaults, 'artibot', a)).length;
  return { n: agents.length, held, lowered: agents.length - held };
}

/** @param {object} plugins @returns {void} writes a v1 overrides document */
function writeOverrides(plugins) {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, plugins }), 'utf8');
}

/**
 * A plugin root identical to the real one except `routing.canary.actionClasses: []`
 * (the pre-CA-02 value): `agents/` copied, the config rewritten. `--plugin-root` makes
 * the CLI read it, so the two roots differ in nothing but the canary.
 *
 * @returns {string} the fixture root
 */
function canaryOffRoot() {
  const dir = path.join(root, 'off-plugin');
  mkdirSync(path.join(dir, 'agents'), { recursive: true });
  for (const f of readdirSync(path.join(PLUGIN_ROOT, 'agents'))) copyFileSync(path.join(PLUGIN_ROOT, 'agents', f), path.join(dir, 'agents', f));
  const config = structuredClone(SHIPPED);
  config.routing.canary.actionClasses = [];
  writeFileSync(path.join(dir, 'artibot.config.json'), JSON.stringify(config, null, 2), 'utf8');
  return dir;
}

describe('the premise: the shipped file arms the canary', () => {
  it('routing.canary is classify + status onto sonnet', () => {
    expect(SHIPPED.routing.canary).toEqual({ actionClasses: [...CANARY], tier: 'sonnet' });
    expect(PLAIN).toHaveLength(6);
  });
});

describe('A. resolve --task classify|status prints the low tier', () => {
  it.each(CANARY)('agents that build or run routine work resolve to sonnet under --task %s (with no role and with --role build)', { timeout: TIMEOUT }, (task) => {
    for (const agent of ['doc-updater', 'backend-developer', 'tdd-guide']) {
      expect(resolved(`artibot:${agent}`, '--task', task), `${agent} ${task}`).toBe('sonnet\n');
      expect(resolved(`artibot:${agent}`, '--role', 'build', '--task', task), `${agent} build ${task}`).toBe('sonnet\n');
    }
  });

  it.each(CANARY)('SHOULD-1: design and review stay on opus under --task %s — a review role, and agents whose own default task is review or architecture', { timeout: TIMEOUT }, (task) => {
    // The owner's rule is design and review = opus, implementation = sonnet. Before the guard,
    // `code-reviewer --role review --task status` printed sonnet (this suite used to pin exactly that).
    expect(resolved('artibot:code-reviewer', '--role', 'review', '--task', task)).toBe('opus\n');
    // A builder spawned AS a reviewer is a review spawn: the role alone holds it.
    expect(resolved('artibot:doc-updater', '--role', 'review', '--task', task)).toBe('opus\n');
    expect(resolved('artibot:backend-developer', '--role', 'review', '--task', task)).toBe('opus\n');
    // A reviewer or designer is held by its own default task under EVERY role, or none.
    for (const agent of ['code-reviewer', 'architect', 'planner']) {
      expect(resolved(`artibot:${agent}`, '--task', task), `${agent} ${task}`).toBe('opus\n');
      expect(resolved(`artibot:${agent}`, '--role', 'build', '--task', task), `${agent} build ${task}`).toBe('opus\n');
    }
  });

  it('an artibot-cowork agent is lowered only when it costs more than the canary tier and is not a design or review agent', { timeout: TIMEOUT }, () => {
    for (const task of CANARY) {
      expect(resolved('artibot-cowork:content-marketer', '--task', task)).toBe('sonnet\n'); // opus → sonnet
      expect(resolved('artibot-cowork:planner', '--task', task)).toBe('opus\n'); // architecture: held
      expect(resolved('artibot-cowork:content-marketer', '--role', 'review', '--task', task)).toBe('opus\n'); // review role: held
      expect(resolved('artibot-cowork:case-study-writer', '--task', task)).toBe('haiku\n'); // never raised
      expect(resolved('artibot-cowork:doc-updater', '--task', task)).toBe('sonnet\n'); // already there
    }
  });

  it('security-reviewer keeps its shipped tier under the canary — held by its protected-list entry AND by its default task', { timeout: TIMEOUT }, () => {
    for (const task of CANARY) expect(resolved(`artibot:${DENYLISTED}`, '--task', task)).toBe('opus\n');
    // Positive control: the very same call for a build agent IS lowered.
    expect(resolved('artibot:tdd-guide', '--task', 'classify')).toBe('sonnet\n');
  });
});

describe('B. nothing else moves', () => {
  it('the six other classes, no --task, and a role alone print the shipped tier', { timeout: TIMEOUT }, () => {
    for (const task of PLAIN) expect(resolved('artibot:doc-updater', '--task', task), task).toBe('opus\n');
    expect(resolved('artibot:doc-updater')).toBe('opus\n');
    expect(resolved('artibot:doc-updater', '--role', 'review')).toBe('opus\n');
    expect(resolved('artibot:doc-updater', '--role', 'build')).toBe('opus\n');
    expect(resolved('artibot-cowork:planner')).toBe('opus\n');
  });

  it('every action class × every agent row equals a canary-OFF plugin root — except classify and status, and there only the agents the guard lets through', { timeout: TIMEOUT * 2 }, () => {
    const off = canaryOffRoot();
    const defaults = defaultTasks();
    let lowered = 0;
    let held = 0;
    for (const task of ACTION_CLASSES) {
      const on = showJson('--task', task);
      const base = showJson('--task', task, '--plugin-root', off);
      if (PLAIN.includes(task)) {
        // Byte-identical: the canary layer is not consulted at all.
        expect(JSON.stringify(on), task).toBe(JSON.stringify(base));
        continue;
      }
      expect(on.plugins.artibot.rows).toHaveLength(base.plugins.artibot.rows.length);
      for (const [i, r] of on.plugins.artibot.rows.entries()) {
        const before = base.plugins.artibot.rows[i];
        if (isHeld(defaults, 'artibot', r.agent)) {
          // A reviewer or designer (security-reviewer among them): the whole row is the canary-OFF row.
          expect(r, `${r.agent} ${task}`).toEqual(before);
          held += 1;
          continue;
        }
        // Only the four answer fields may differ.
        const { effective, source, hostPath, shipped, ...rest } = r;
        const { effective: e0, source: s0, hostPath: _h0, shipped: p0, ...rest0 } = before;
        expect(rest, `${r.agent} ${task}`).toEqual(rest0);
        expect([e0, s0, p0]).toEqual(['opus', 'shipped', 'opus']);
        expect({ effective, source, hostPath, shipped }, r.agent).toEqual({ effective: 'sonnet', source: 'canary-task', hostPath: 'needs-spawn-param', shipped: 'sonnet' });
        lowered += 1;
      }
    }
    // Both sides are populated in both classes, so neither branch above is a vacuous pass.
    const n = showJson().plugins.artibot.rows.length;
    expect(held + lowered).toBe(n * CANARY.length);
    expect(held).toBeGreaterThan(0);
    expect(lowered).toBeGreaterThan(0);
  });

  it('a review role sees no canary at all: show --role review --task classify|status equals the canary-OFF root, byte for byte', { timeout: TIMEOUT }, () => {
    const off = canaryOffRoot();
    for (const task of CANARY) {
      expect(JSON.stringify(showJson('--role', 'review', '--task', task)), task)
        .toBe(JSON.stringify(showJson('--role', 'review', '--task', task, '--plugin-root', off)));
    }
  });

  it('a build role is read like no role: the same rows, so what holds a spawn is a review role, not the mere presence of a role', { timeout: TIMEOUT }, () => {
    for (const task of CANARY) {
      expect(JSON.stringify(showJson('--role', 'build', '--task', task).plugins), task).toBe(JSON.stringify(showJson('--task', task).plugins));
    }
  });

  it('a call without --task lists the same rows as the canary-OFF root, byte for byte', { timeout: TIMEOUT }, () => {
    const off = canaryOffRoot();
    expect(JSON.stringify(showJson())).toBe(JSON.stringify(showJson('--plugin-root', off)));
    expect(JSON.stringify(showJson('--role', 'review'))).toBe(JSON.stringify(showJson('--role', 'review', '--plugin-root', off)));
  });
});

describe('C. the user always wins', () => {
  it('a user TASK pick beats it, for the class it names only, and reset brings the canary back', { timeout: TIMEOUT }, () => {
    expect(run('set', 'task', 'classify', 'opus').code).toBe(0);
    expect(resolved('artibot:doc-updater', '--task', 'classify')).toBe('opus\n');
    expect(resolved('artibot:doc-updater', '--task', 'status')).toBe('sonnet\n');
    expect(run('reset', 'task', 'classify').code).toBe(0);
    expect(resolved('artibot:doc-updater', '--task', 'classify')).toBe('sonnet\n');
  });

  it('a user task pick BELOW the canary is honoured (the user may go cheaper than the default)', { timeout: TIMEOUT }, () => {
    expect(run('set', 'task', 'status', 'haiku').code).toBe(0);
    expect(resolved('artibot:doc-updater', '--task', 'status')).toBe('haiku\n');
    expect(resolved('artibot-cowork:planner', '--task', 'status')).toBe('haiku\n');
  });

  it('a user AGENT pick, a user PLUGIN default and a user PHASE pick each beat it', { timeout: TIMEOUT }, () => {
    expect(run('set', 'agent', 'artibot:doc-updater', 'haiku').code).toBe(0);
    expect(resolved('artibot:doc-updater', '--task', 'classify')).toBe('haiku\n');
    expect(resolved('artibot:tdd-guide', '--task', 'classify')).toBe('sonnet\n'); // other agents still canary
    expect(run('reset', 'agent', 'artibot:doc-updater').code).toBe(0);

    expect(run('set', 'plugin', 'artibot', 'opus').code).toBe(0);
    expect(resolved('artibot:doc-updater', '--task', 'classify')).toBe('opus\n');
    expect(resolved('artibot-cowork:content-marketer', '--task', 'classify')).toBe('sonnet\n'); // the other plugin is untouched
    expect(run('reset', 'plugin', 'artibot').code).toBe(0);

    expect(run('set', 'phase', 'build', 'opus').code).toBe(0);
    expect(resolved('artibot:doc-updater', '--role', 'build', '--task', 'classify')).toBe('opus\n');
    // No build pick applies to the review role, and the review guard keeps the canary off it: the shipped opus.
    expect(resolved('artibot:doc-updater', '--role', 'review', '--task', 'classify')).toBe('opus\n');
    expect(resolved('artibot:doc-updater', '--task', 'classify')).toBe('sonnet\n');
  });

  it('the guard limits the CANARY, not the user: an explicit pick still reaches design and review spawns', { timeout: TIMEOUT }, () => {
    expect(run('set', 'task', 'status', 'sonnet').code).toBe(0);
    expect(resolved('artibot:code-reviewer', '--role', 'review', '--task', 'status')).toBe('sonnet\n');
    expect(resolved('artibot:planner', '--task', 'status')).toBe('sonnet\n');
    // The pick names `status` only; the sibling class is still guarded.
    expect(resolved('artibot:planner', '--task', 'classify')).toBe('opus\n');
    expect(run('reset', 'task', 'status').code).toBe(0);
    expect(resolved('artibot:planner', '--task', 'status')).toBe('opus\n');
  });

  it('the owner\'s 2026-09-29 task picks (architecture/review opus, implement/edit-routine sonnet) leave the canary alone', { timeout: TIMEOUT }, () => {
    const tasks = { architecture: 'opus', review: 'opus', implement: 'sonnet', 'edit-routine': 'sonnet' };
    writeOverrides({ artibot: { default: null, agents: {}, phaseRoles: {}, tasks }, 'artibot-cowork': { default: null, agents: {}, tasks } });
    expect(resolved('artibot:doc-updater', '--task', 'implement')).toBe('sonnet\n');
    expect(resolved('artibot:doc-updater', '--task', 'review')).toBe('opus\n');
    expect(resolved('artibot:doc-updater', '--task', 'classify')).toBe('sonnet\n');
    expect(resolved('artibot:doc-updater', '--task', 'status')).toBe('sonnet\n');
    expect(resolved('artibot:doc-updater', '--task', 'explore')).toBe('opus\n');
    expect(resolved('artibot:doc-updater', '--task', 'complex-debug')).toBe('opus\n');
  });
});

describe('D. show labels the canary answer', () => {
  it.each(CANARY)('show --task %s: every row the guard lets through is `canary-task`, not a user override, and needs the spawn parameter; held rows keep the shipped answer', { timeout: TIMEOUT }, (task) => {
    const json = showJson('--task', task);
    const defaults = defaultTasks();
    expect(json.task).toBe(task);
    const rows = json.plugins.artibot.rows;
    expect(rows.length).toBeGreaterThanOrEqual(30);
    const held = rows.filter((x) => isHeld(defaults, 'artibot', x.agent));
    const lowered = rows.filter((x) => !isHeld(defaults, 'artibot', x.agent));
    // Neither side is empty, so neither loop below is a vacuous pass.
    expect(held.length).toBeGreaterThan(0);
    expect(lowered.length).toBeGreaterThan(0);
    for (const r of lowered) {
      expect(r, r.agent).toMatchObject({ effective: 'sonnet', shipped: 'sonnet', source: 'canary-task', override: null, hostPath: 'needs-spawn-param', reason: null });
    }
    for (const r of held) {
      expect(r, r.agent).toMatchObject({ effective: 'opus', shipped: 'opus', source: 'shipped', override: null, hostPath: 'frontmatter', reason: null });
    }
    expect(row(json, 'artibot', DENYLISTED)).toMatchObject({ effective: 'opus', source: 'shipped', hostPath: 'frontmatter' });
    // Written out, so the split above is not only the CLI agreeing with itself.
    for (const agent of ['code-reviewer', 'spec-reviewer', 'auditor', 'architect', 'planner', 'orchestrator']) {
      expect(row(json, 'artibot', agent), agent).toMatchObject({ effective: 'opus', source: 'shipped' });
    }
    for (const agent of ['doc-updater', 'backend-developer', 'tdd-guide', 'investigator', 'build-error-resolver']) {
      expect(row(json, 'artibot', agent), agent).toMatchObject({ effective: 'sonnet', source: 'canary-task' });
    }
    expect(row(json, 'artibot-cowork', 'case-study-writer')).toMatchObject({ effective: 'haiku', source: 'cowork-frontmatter' });
    expect(row(json, 'artibot-cowork', 'planner')).toMatchObject({ effective: 'opus', source: 'cowork-frontmatter', override: null });
    expect(row(json, 'artibot-cowork', 'content-marketer')).toMatchObject({ effective: 'sonnet', source: 'canary-task', override: null });
  });

  it('show --task X row.effective equals resolve <name> --task X (the table and the CLI cannot disagree)', { timeout: TIMEOUT }, () => {
    for (const task of CANARY) {
      const json = showJson('--task', task);
      for (const name of [`artibot:${DENYLISTED}`, 'artibot:doc-updater', 'artibot:planner', 'artibot-cowork:planner', 'artibot-cowork:content-marketer', 'artibot-cowork:case-study-writer']) {
        const [plugin, agent] = name.split(':');
        expect(resolved(name, '--task', task), `${name} ${task}`).toBe(`${row(json, plugin, agent).effective}\n`);
      }
    }
  });

  it('show without --task is unchanged: default tasks only, the shipped answer, frontmatter path', { timeout: TIMEOUT }, () => {
    const json = showJson();
    expect(row(json, 'artibot', 'doc-updater')).toMatchObject({ task: 'edit-routine', effective: 'opus', source: 'shipped', hostPath: 'frontmatter' });
    expect(json.plugins.artibot.rows.every((r) => r.source === 'shipped')).toBe(true);
  });

  it('the text table names the source', { timeout: TIMEOUT }, () => {
    expect(run('show', '--plugin', 'artibot', '--task', 'status').stdout).toMatch(/artibot\s+doc-updater\s+opus\s+sonnet\s+—\s+sonnet \[canary-task\]\s+needs-spawn-param/);
  });
});

describe('E. the effective-changes diff starts from the canary value, role by role', () => {
  // A review role never had the canary (SHOULD-1), so a change that touches the canary classes reads
  // `role=none` and `role=build` rows (sonnet → …) and, when the new value applies to a review role too,
  // a `role=review` row that starts from opus. A held agent (default task review/architecture) is opus under
  // every role, so it prints as one uniform row.
  /** @param {string} stdout @returns {string[]} the indented rows */
  const rows = (stdout) => stdout.split('\n').filter((l) => l.startsWith('  '));
  const sorted = (lines) => [...lines].sort();

  it('set task <canary class> reads sonnet → … for the lowered agents under none/build, opus → … under review and for the held agents', { timeout: TIMEOUT }, () => {
    const { n, held, lowered } = artibotSplit();
    const tail = `agent(s) not defaulting to classify`;
    const lines = rows(run('set', 'task', 'classify', 'haiku', '--plugin', 'artibot', '--dry-run').stdout);
    expect(sorted(lines)).toEqual(sorted([
      `  artibot [task=classify role=none]: sonnet → haiku for ${lowered} of ${n} ${tail}`,
      `  artibot [task=classify role=build]: sonnet → haiku for ${lowered} of ${n} ${tail}`,
      `  artibot [task=classify role=review]: opus → haiku for ${lowered} of ${n} ${tail}`,
      `  artibot [task=classify]: opus → haiku for ${held} of ${n} ${tail}`,
    ]));
    expect(held).toBeGreaterThan(0);
    expect(lowered).toBeGreaterThan(0);
  });

  it('reset task goes BACK to the canary value, not to opus — except under a review role, which never had it', { timeout: TIMEOUT }, () => {
    expect(run('set', 'task', 'status', 'haiku', '--plugin', 'artibot').code).toBe(0);
    const { n, held, lowered } = artibotSplit();
    const tail = `agent(s) not defaulting to status`;
    const lines = rows(run('reset', 'task', 'status', '--plugin', 'artibot', '--dry-run').stdout);
    expect(sorted(lines)).toEqual(sorted([
      `  artibot [task=status role=none]: haiku → sonnet for ${lowered} of ${n} ${tail}`,
      `  artibot [task=status role=build]: haiku → sonnet for ${lowered} of ${n} ${tail}`,
      `  artibot [task=status role=review]: haiku → opus for ${lowered} of ${n} ${tail}`,
      `  artibot [task=status]: haiku → opus for ${held} of ${n} ${tail}`,
    ]));
  });

  it('pinning the canary value explicitly moves only what the canary did not already give: the review role and the held agents', { timeout: TIMEOUT }, () => {
    const { n, held, lowered } = artibotSplit();
    const tail = `agent(s) not defaulting to classify`;
    const r = run('set', 'task', 'classify', 'sonnet', '--plugin', 'artibot', '--dry-run');
    // The lowered agents already resolve to sonnet under none and build; they move only under review (opus → sonnet).
    expect(sorted(rows(r.stdout))).toEqual(sorted([
      `  artibot [task=classify role=review]: opus → sonnet for ${lowered} of ${n} ${tail}`,
      `  artibot [task=classify]: opus → sonnet for ${held} of ${n} ${tail}`,
    ]));
  });

  it('a wider setting that only matters to the canary classes is not "none": set plugin artibot opus shows classify and status', { timeout: TIMEOUT }, () => {
    // The default-task rows do not move (opus → opus), but `resolve --task classify|status` goes
    // sonnet → opus for every agent the canary was lowering — under none and build; a review role was
    // opus already. A preview that said "none" would end the /model-routing menu without writing the
    // setting the user just asked for.
    const { n, lowered } = artibotSplit();
    const r = run('set', 'plugin', 'artibot', 'opus', '--dry-run');
    expect(r.code, r.stderr).toBe(0);
    const expected = (from, to) => CANARY.flatMap((task) => ['none', 'build'].map(
      (role) => `  artibot [task=${task} role=${role}]: ${from} → ${to} for ${lowered} of ${n} agent(s) not defaulting to ${task}`,
    ));
    expect(sorted(rows(r.stdout))).toEqual(sorted(expected('sonnet', 'opus')));
    expect(r.stdout.split('\n')[0]).toBe('effective changes (4):');
    // ...and reset walks back the same way.
    expect(run('set', 'plugin', 'artibot', 'opus').code).toBe(0);
    expect(sorted(rows(run('reset', 'plugin', 'artibot', '--dry-run').stdout))).toEqual(sorted(expected('opus', 'sonnet')));
  });

  it('an agent pick that only matters to the canary classes shows them too, for that agent alone', { timeout: TIMEOUT }, () => {
    const { n } = artibotSplit();
    const r = run('set', 'agent', 'artibot:doc-updater', 'opus', '--dry-run');
    expect(sorted(rows(r.stdout))).toEqual(sorted(CANARY.flatMap((task) => ['none', 'build'].map(
      (role) => `  artibot [task=${task} role=${role}]: sonnet → opus for 1 of ${n} agent(s) not defaulting to ${task}`,
    ))));
  });

  it('negative control: a setting the canary classes never see adds no [task=classify|status] row', { timeout: TIMEOUT }, () => {
    for (const args of [
      ['set', 'task', 'explore', 'haiku', '--plugin', 'artibot'],
      ['set', 'task', 'review', 'sonnet', '--plugin', 'artibot'],
      // The canary already leaves the denylisted agent on opus, so pinning opus changes nothing for it.
      ['set', 'agent', 'artibot:security-reviewer', 'opus'],
    ]) {
      const r = run(...args, '--dry-run');
      expect(r.code, `${args.join(' ')}: ${r.stderr}`).toBe(0);
      expect(r.stdout, args.join(' ')).not.toMatch(/\[task=(classify|status)/);
    }
  });

  it('with the canary switched OFF the same setting is "none" again (the rows come from the canary, nothing else)', { timeout: TIMEOUT }, () => {
    const off = canaryOffRoot();
    const r = run('set', 'plugin', 'artibot', 'opus', '--dry-run', '--plugin-root', off);
    expect(r.stdout).toMatch(/^effective changes \(none\):\n/);
  });

  it('a task pick for a class OUTSIDE the canary still diffs against the shipped opus', { timeout: TIMEOUT }, () => {
    const n = showJson('--plugin', 'artibot').plugins.artibot.rows.length;
    const lines = rows(run('set', 'task', 'explore', 'haiku', '--plugin', 'artibot', '--dry-run').stdout);
    const summary = lines.filter((l) => l.includes('[task=explore]'));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatch(/^ {2}artibot \[task=explore\]: opus → haiku for \d+ of \d+ agent\(s\) not defaulting to explore$/);
    expect(n).toBeGreaterThanOrEqual(30);
  });
});

describe('F. a damaged overrides file still answers the shipped values — canary included', () => {
  it('resolve warns on stderr and prints the canary tier for classify, opus for the rest', { timeout: TIMEOUT }, () => {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, 'not json', 'utf8');
    const lowered = run('resolve', 'artibot:doc-updater', '--task', 'classify');
    expect(lowered.code, lowered.stderr).toBe(0);
    expect(lowered.stdout).toBe('sonnet\n');
    expect(lowered.stderr).toContain('IGNORED, shipped values shown');
    const plain = run('resolve', 'artibot:doc-updater', '--task', 'implement');
    expect(plain.stdout).toBe('opus\n');
    expect(plain.stderr).toContain('IGNORED, shipped values shown');
  });

  it('validate on a clean state says the shipped policy is in force and exits 0 (no warning about the canary)', { timeout: TIMEOUT }, () => {
    const r = run('validate');
    expect(r.code, r.stderr).toBe(0);
    // Line 1 is `overrides: <path> (absent)`; nothing but the two fixed lines may follow.
    expect(r.stdout.trim().split('\n').slice(1)).toEqual(['no overrides file — the shipped policy is in force', 'valid']);
  });
});
