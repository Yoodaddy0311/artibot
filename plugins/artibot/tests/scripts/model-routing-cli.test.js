/**
 * N2 — scripts/model-routing/model-routing.mjs, driven as a real child process.
 *
 * Every run gets an ISOLATED environment: HOME/USERPROFILE and the
 * `ARTIBOT_STATE_DIR` + `ARTIBOT_STATE_DIR_HOME` pair point into a temp dir
 * (lib/core/config.js#resolveArtibotDir honors the override only while the
 * minted-for home matches every home variable), and both host session id
 * variables are deleted — the host env otherwise leaks into CLI children.
 *
 * The artibot-cowork roster is a temp fixture passed with `--cowork-root`, so
 * the cowork assertions do not depend on the dev tree next to this plugin.
 *
 * WHAT THIS DOES NOT SEE: whether the host honors a resolved model (only a live
 * spawn shows that), whether a leader passes `resolve` output to Agent(model=…),
 * and whether a REAL installed plugin cache matches the layout assumed here —
 * the plugin-cache branch of cowork roster discovery runs only against a temp
 * fixture (`--plugin-root` inside a fake `cache/<market>/artibot/<ver>`), which
 * pins the numeric semver pick, not the host's active cache version.
 *
 * @module tests/scripts/model-routing-cli
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(PLUGIN_ROOT, 'scripts', 'model-routing', 'model-routing.mjs');
const REAL_FILE = path.join(homedir(), '.claude', 'artibot', 'model-routing.json');
const TIMEOUT = 60_000;

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
  root = mkdtempSync(path.join(tmpdir(), 'artibot-model-routing-'));
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  mkdirSync(home, { recursive: true });
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ARTIBOT_STATE_DIR: state,
    ARTIBOT_STATE_DIR_HOME: home,
  };
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_CODE_SESSION_ID;
  stateFile = path.join(state, 'model-routing.json');
  coworkRoot = path.join(root, 'cowork');
  mkdirSync(path.join(coworkRoot, 'agents'), { recursive: true });
  writeFileSync(
    path.join(coworkRoot, 'agents', 'planner.md'),
    '---\nname: planner\ndescription: fixture\nmodel: sonnet\n---\nbody\n',
    'utf8',
  );
  writeFileSync(
    path.join(coworkRoot, 'agents', 'case-study-writer.md'),
    '---\nname: case-study-writer\ndescription: fixture\nmodel: haiku\n---\nbody\n',
    'utf8',
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Run the CLI with the isolated env and the fixture cowork roster.
 *
 * @param {string[]} args
 * @param {{ cowork?: string|null }} [opts] - `null` omits `--cowork-root`.
 * @returns {{ code: number|null, stdout: string, stderr: string }}
 */
function run(args, { cowork = coworkRoot } = {}) {
  const extra = cowork === null ? [] : ['--cowork-root', cowork];
  const r = spawnSync(process.execPath, [CLI, ...args, ...extra], {
    env,
    encoding: 'utf8',
    timeout: TIMEOUT,
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** @returns {object} parsed `show --json` */
function showJson(...args) {
  const r = run(['show', '--json', ...args]);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

/** @returns {object} the row for one agent from `show --json` */
function row(json, plugin, agent) {
  return json.plugins[plugin].rows.find((x) => x.agent === agent);
}

describe('show', () => {
  it('prints one row per agent with the host-path column', { timeout: TIMEOUT }, () => {
    const r = run(['show']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/plugin\s+agent\s+frontmatter\s+shipped\s+override\s+effective\s+host path/);
    expect(r.stdout).toMatch(/artibot\s+security-reviewer\s+opus\s+opus\s+—\s+opus \[shipped\]\s+frontmatter/);
    expect(r.stdout).toMatch(/artibot-cowork\s+planner\s+sonnet\s+sonnet\s+—\s+sonnet \[cowork-frontmatter\]/);
  });

  it('--json carries the shipped rosters: 30 artibot agents and the cowork fixture', { timeout: TIMEOUT }, () => {
    const json = showJson();
    expect(json.overridesStatus).toBe('absent');
    expect(json.file).toBe(stateFile);
    expect(json.plugins.artibot.rows).toHaveLength(30);
    for (const r of json.plugins.artibot.rows) {
      expect(r).toMatchObject({ shipped: 'opus', effective: 'opus', source: 'shipped', override: null });
    }
    expect(json.plugins['artibot-cowork'].rows.map((r) => r.agent)).toEqual(['case-study-writer', 'planner']);
  });

  it('marks the cowork rows unavailable when the roster cannot be found', { timeout: TIMEOUT }, () => {
    const missing = path.join(root, 'no-such-cowork');
    const json = JSON.parse(run(['show', '--json'], { cowork: missing }).stdout);
    expect(json.plugins['artibot-cowork']).toEqual({ status: 'unavailable', reason: 'roster-not-found' });
    expect(run(['show'], { cowork: missing }).stdout).toContain('artibot-cowork: unavailable:roster-not-found');
  });

  it('picks the highest cowork cache version numerically, not lexically', { timeout: TIMEOUT }, () => {
    // Plugin-cache layout: <cache>/<marketplace>/<plugin>/<version>/. No dev tree
    // sits next to the plugin root, so discovery must fall through to the cache.
    const market = path.join(root, 'cache', 'market');
    const pluginRoot = path.join(market, 'artibot', '9.0.0');
    mkdirSync(path.join(pluginRoot, 'agents'), { recursive: true });
    copyFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), path.join(pluginRoot, 'artibot.config.json'));
    writeFileSync(path.join(pluginRoot, 'agents', 'planner.md'), '---\nname: planner\nmodel: opus\n---\n', 'utf8');
    for (const [version, model] of [['3.9.0', 'haiku'], ['3.10.0', 'sonnet'], ['latest', 'opus']]) {
      const dir = path.join(market, 'artibot-cowork', version, 'agents');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'planner.md'), `---\nname: planner\nmodel: ${model}\n---\n`, 'utf8');
    }
    const r = run(['resolve', 'artibot-cowork:planner', '--plugin-root', pluginRoot], { cowork: null });
    expect(r).toMatchObject({ code: 0, stdout: 'sonnet\n' });
  });

  it('parses roster frontmatter strictly: BOM and quotes stripped, non-tiers unknown', { timeout: TIMEOUT }, () => {
    const agents = path.join(coworkRoot, 'agents');
    const bom = String.fromCharCode(0xfeff);
    writeFileSync(path.join(agents, 'seo-specialist.md'), `${bom}---\nname: seo-specialist\nmodel: "haiku"\n---\n`, 'utf8');
    writeFileSync(path.join(agents, 'data-analyst.md'), "---\nname: data-analyst\nmodel: 'inherit'\n---\n", 'utf8');
    expect(run(['resolve', 'artibot-cowork:seo-specialist']).stdout).toBe('haiku\n');
    const unknown = row(showJson(), 'artibot-cowork', 'data-analyst');
    expect(unknown).toMatchObject({ frontmatter: null, effective: null, source: 'cowork-frontmatter-unknown' });
    const r = run(['resolve', 'artibot-cowork:data-analyst']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
  });

  it('--plugin narrows the rows', { timeout: TIMEOUT }, () => {
    const json = showJson('--plugin', 'artibot-cowork');
    expect(Object.keys(json.plugins)).toEqual(['artibot-cowork']);
  });
});

describe('set → show → resolve → reset round trip', () => {
  it('agent scope', { timeout: TIMEOUT }, () => {
    const set = run(['set', 'agent', 'artibot:planner', 'sonnet']);
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout).toContain('artibot:planner: opus → sonnet');
    expect(existsSync(stateFile)).toBe(true);

    const shown = row(showJson(), 'artibot', 'planner');
    expect(shown).toMatchObject({
      effective: 'sonnet',
      source: 'override-agent',
      override: 'sonnet (agent)',
      hostPath: 'needs-spawn-param',
    });
    expect(run(['resolve', 'artibot:planner'])).toMatchObject({ code: 0, stdout: 'sonnet\n' });
    // Qualified keys: the cowork planner is untouched.
    expect(run(['resolve', 'artibot-cowork:planner']).stdout).toBe('sonnet\n');
    expect(run(['resolve', 'artibot:architect']).stdout).toBe('opus\n');

    const reset = run(['reset', 'agent', 'artibot:planner']);
    expect(reset.code, reset.stderr).toBe(0);
    expect(reset.stdout).toContain('artibot:planner: sonnet → opus');
    expect(run(['resolve', 'artibot:planner']).stdout).toBe('opus\n');
    expect(row(showJson(), 'artibot', 'planner')).toMatchObject({ source: 'shipped', hostPath: 'frontmatter' });
  });

  it('phase scope applies only with the matching role', { timeout: TIMEOUT }, () => {
    expect(run(['set', 'phase', 'build', 'haiku']).code).toBe(0);
    expect(run(['resolve', 'artibot:backend-developer', '--role', 'build']).stdout).toBe('haiku\n');
    expect(run(['resolve', 'artibot:backend-developer', '--role', 'review']).stdout).toBe('opus\n');
    expect(run(['resolve', 'artibot:backend-developer']).stdout).toBe('opus\n');
    const json = showJson('--role', 'build');
    expect(row(json, 'artibot', 'tdd-guide')).toMatchObject({ effective: 'haiku', source: 'override-phase' });
    expect(json.phases.find((p) => p.phase === 'build')).toEqual({ phase: 'build', shipped: 'opus', override: 'haiku' });

    expect(run(['reset', 'phase', 'build']).code).toBe(0);
    expect(run(['resolve', 'artibot:backend-developer', '--role', 'build']).stdout).toBe('opus\n');
  });

  it('plugin scope stays inside its plugin', { timeout: TIMEOUT }, () => {
    expect(run(['set', 'plugin', 'artibot-cowork', 'haiku']).code).toBe(0);
    expect(run(['resolve', 'artibot-cowork:planner']).stdout).toBe('haiku\n');
    expect(run(['resolve', 'artibot:planner']).stdout).toBe('opus\n');

    expect(run(['reset', '--all']).code).toBe(0);
    expect(run(['resolve', 'artibot-cowork:planner']).stdout).toBe('sonnet\n');
  });
});

describe('write safety', () => {
  it('--dry-run shows the diff and writes nothing', { timeout: TIMEOUT }, () => {
    const r = run(['set', 'agent', 'artibot:planner', 'sonnet', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('artibot:planner: opus → sonnet');
    expect(r.stdout).toContain('dry-run: nothing written');
    expect(existsSync(stateFile)).toBe(false);
    expect(existsSync(path.dirname(stateFile))).toBe(false);
  });

  it('backs the previous file up to .bak on the second write', { timeout: TIMEOUT }, () => {
    expect(run(['set', 'agent', 'artibot:planner', 'sonnet']).code).toBe(0);
    expect(existsSync(`${stateFile}.bak`)).toBe(false);
    const first = readFileSync(stateFile);

    expect(run(['set', 'agent', 'artibot:architect', 'haiku']).code).toBe(0);
    expect(readFileSync(`${stateFile}.bak`)).toEqual(first);
    const second = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(second.plugins.artibot.agents).toEqual({ planner: 'sonnet', architect: 'haiku' });
    // The CLI stamps every write; the core setters leave the stamp alone.
    expect(Number.isNaN(Date.parse(second.updatedAt))).toBe(false);
    expect(second.updatedAt).not.toBe(JSON.parse(first.toString('utf8')).updatedAt);
  });

  it('reset with no file writes nothing', { timeout: TIMEOUT }, () => {
    const r = run(['reset', '--all']);
    expect(r.code).toBe(0);
    expect(existsSync(stateFile)).toBe(false);
  });
});

describe('damaged overrides file (fail-closed)', () => {
  beforeEach(() => {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, '{ "schemaVersion": 1, "plugins": ', 'utf8');
  });

  it('show warns on stderr and falls back to shipped values', { timeout: TIMEOUT }, () => {
    const r = run(['show', '--json']);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/warning: .*malformed.*IGNORED/);
    const json = JSON.parse(r.stdout);
    expect(json.overridesStatus).toBe('malformed');
    expect(row(json, 'artibot', 'planner')).toMatchObject({ effective: 'opus', source: 'shipped' });
  });

  it('set and reset refuse and leave the bytes identical', { timeout: TIMEOUT }, () => {
    const before = fingerprint(stateFile);
    const set = run(['set', 'agent', 'artibot:planner', 'sonnet']);
    expect(set.code).toBe(1);
    expect(set.stderr).toContain('refusing to write');
    const reset = run(['reset', '--all']);
    expect(reset.code).toBe(1);
    expect(fingerprint(stateFile)).toBe(before);
    expect(existsSync(`${stateFile}.bak`)).toBe(false);
  });

  it('resolve prints the shipped model and warns', { timeout: TIMEOUT }, () => {
    const r = run(['resolve', 'artibot:planner']);
    expect(r).toMatchObject({ code: 0, stdout: 'opus\n' });
    expect(r.stderr).toContain('malformed');
  });
});

describe('stored fable picks while the shipped fable gate is off', () => {
  // A file written while the gate was on. It must still load: the fable picks
  // are demoted on read, every other override keeps working.
  beforeEach(() => {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    const agents = { architect: 'fable', 'security-reviewer': 'fable', planner: 'sonnet' };
    const doc = { schemaVersion: 1, plugins: { artibot: { default: null, agents, phaseRoles: {} } } };
    writeFileSync(stateFile, JSON.stringify(doc), 'utf8');
  });

  it('show loads the file without a warning and marks the demoted rows', { timeout: TIMEOUT }, () => {
    const r = run(['show', '--json']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const json = JSON.parse(r.stdout);
    expect(json.overridesStatus).toBe('ok');
    expect(row(json, 'artibot', 'architect')).toMatchObject({
      effective: 'opus',
      source: 'override-agent',
      reason: 'fable-gate',
      override: 'fable (agent)',
    });
    expect(row(json, 'artibot', 'security-reviewer')).toMatchObject({ effective: 'opus', reason: 'denylist' });
    expect(row(json, 'artibot', 'planner')).toMatchObject({ effective: 'sonnet', source: 'override-agent' });
    expect(run(['resolve', 'artibot:architect']).stdout).toBe('opus\n');
    expect(run(['resolve', 'artibot:planner']).stdout).toBe('sonnet\n');
  });

  it('validate reports the demotions as warnings and exits 0', { timeout: TIMEOUT }, () => {
    const r = run(['validate']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('WARN  artibot:architect: fable demoted to opus (fable-gate)');
    expect(r.stdout).toContain('WARN  artibot:security-reviewer: fable demoted to opus (denylist)');
    expect(r.stdout).not.toContain('ERROR');
  });

  it('set still refuses a new fable pick', { timeout: TIMEOUT }, () => {
    const before = fingerprint(stateFile);
    expect(run(['set', 'agent', 'artibot:doc-updater', 'fable']).code).toBe(2);
    expect(fingerprint(stateFile)).toBe(before);
  });

  it('reset succeeds and leaves the other stored picks in place', { timeout: TIMEOUT }, () => {
    const r = run(['reset', 'agent', 'artibot:planner']);
    expect(r.code, r.stderr).toBe(0);
    const doc = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(doc.plugins.artibot.agents).toEqual({ architect: 'fable', 'security-reviewer': 'fable' });
    expect(run(['reset', '--all']).code).toBe(0);
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).plugins.artibot.agents).toEqual({});
  });
});

describe('unreadable overrides file (fail-closed)', () => {
  beforeEach(() => {
    // A directory where the file should be: exists, cannot be read as a file.
    mkdirSync(stateFile, { recursive: true });
  });

  it('show warns and falls back to shipped values', { timeout: TIMEOUT }, () => {
    const r = run(['show', '--json']);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/warning: .*unreadable.*IGNORED/);
    expect(JSON.parse(r.stdout).overridesStatus).toBe('unreadable');
  });

  it('set refuses and changes nothing', { timeout: TIMEOUT }, () => {
    const r = run(['set', 'agent', 'artibot:planner', 'sonnet']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refusing to write');
    expect(statSync(stateFile).isDirectory()).toBe(true);
    expect(readdirSync(stateFile)).toEqual([]);
    expect(existsSync(`${stateFile}.bak`)).toBe(false);
  });
});

describe('validate', () => {
  it('exits 0 with no file and with a valid file', { timeout: TIMEOUT }, () => {
    expect(run(['validate']).code).toBe(0);
    expect(run(['set', 'agent', 'artibot:planner', 'sonnet']).code).toBe(0);
    const r = run(['validate']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('needs-spawn-param artibot:planner: effective sonnet ≠ frontmatter opus');
  });

  it('exits 1 on a malformed file', { timeout: TIMEOUT }, () => {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, 'not json', 'utf8');
    const r = run(['validate', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).status).toBe('malformed');
  });

  it('exits 1 on an agent the roster does not list', { timeout: TIMEOUT }, () => {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    const doc = {
      schemaVersion: 1,
      plugins: { artibot: { default: null, agents: { 'no-such-agent': 'sonnet' }, phaseRoles: {} } },
    };
    writeFileSync(stateFile, JSON.stringify(doc), 'utf8');
    const r = run(['validate']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('ERROR unknown agent: artibot:no-such-agent');
  });
});

describe('resolve', () => {
  it('uses the cowork frontmatter, never the core policy, for a cowork agent', { timeout: TIMEOUT }, () => {
    // The fixture planner says sonnet; the core planner resolves to opus. A
    // resolver that stripped the prefix would print opus here.
    expect(run(['resolve', 'artibot-cowork:planner'])).toMatchObject({ code: 0, stdout: 'sonnet\n' });
    expect(run(['resolve', 'artibot-cowork:case-study-writer']).stdout).toBe('haiku\n');
    expect(run(['resolve', 'artibot:planner']).stdout).toBe('opus\n');
  });

  it('prints exactly one line and nothing else', { timeout: TIMEOUT }, () => {
    const r = run(['resolve', 'artibot:doc-updater', '--role', 'review']);
    expect(r.stdout).toMatch(/^[a-z]+\n$/);
    expect(r.stderr).toBe('');
  });

  it('exits 2 on an unknown agent', { timeout: TIMEOUT }, () => {
    expect(run(['resolve', 'artibot:nobody']).code).toBe(2);
    expect(run(['resolve', 'artibot-cowork:architect']).code).toBe(2);
    // A role alias is not an agent: the core would resolve it as shipped, the CLI refuses it.
    expect(run(['resolve', 'artibot:deep-async']).code).toBe(2);
  });
});

describe('usage errors (exit 2, one stderr line, nothing written)', () => {
  /** @param {string[]} args */
  function expectUsage(args) {
    const r = run(args);
    expect(r.code, `${args.join(' ')} → ${r.stdout}${r.stderr}`).toBe(2);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(existsSync(stateFile)).toBe(false);
    return r;
  }

  it('rejects a bare name that exists in both plugins, naming both', { timeout: TIMEOUT }, () => {
    const r = expectUsage(['set', 'agent', 'planner', 'sonnet']);
    expect(r.stderr).toContain('artibot:planner');
    expect(r.stderr).toContain('artibot-cowork:planner');
  });

  it('rejects a bare name in resolve too', { timeout: TIMEOUT }, () => {
    expectUsage(['resolve', 'architect']);
  });

  it('rejects fable while the shipped fable gate is off', { timeout: TIMEOUT }, () => {
    const r = expectUsage(['set', 'agent', 'artibot:architect', 'fable']);
    expect(r.stderr).toContain('fable gate is off');
  });

  it('rejects unknown tiers, aliases, agents, flags and subcommands', { timeout: TIMEOUT }, () => {
    expectUsage(['set', 'agent', 'artibot:planner', 'deep-async']);
    expectUsage(['set', 'agent', 'artibot:nobody', 'sonnet']);
    expectUsage(['set', 'phase', 'deploy', 'sonnet']);
    expectUsage(['set', 'plugin', 'other', 'sonnet']);
    expectUsage(['set', 'agent', 'artibot:planner', 'sonnet', '--dryrun']);
    expectUsage(['show', '--role', 'ship']);
    expectUsage(['frobnicate']);
  });
});

describe('validate --live (reads the ledger, never writes it)', () => {
  // Line shapes copied from tests/replay/spawn-outcome.test.js (`bound`,
  // `receipt`): the live envelope keys, trimmed of columns this fold never reads.
  const SESSION = 'sess-live-1';
  const OPUS_ID = 'claude-opus-5-5';
  const SONNET_ID = 'claude-sonnet-5';
  let seq = 0;
  let project;
  let ledger;

  /** @returns {object} a `route.bound` line */
  function bound(agentId, agentType, ts = '2026-09-21T01:00:00.000Z') {
    seq += 1;
    return {
      v: 1, ts, event: 'route.bound', session_id: SESSION, source: 'hook', pid: 4242, seq,
      routing_epoch_id: agentId, run_id: agentId, action_id: `toolu_${agentId}`,
      data: {
        tool_use_id: `toolu_${agentId}`, agent_id: agentId, confidence: 'exact', method: 'prompt_id+name',
        ...(agentType === null ? {} : { agent_type: agentType }),
        matched_on: 'name', recommended_model: OPUS_ID, action_class: 'implement',
      },
    };
  }

  /** @returns {object} a `usage.receipt` line */
  function receipt(runId, model, ts = '2026-09-21T01:05:00.000Z') {
    seq += 1;
    return {
      v: 1, ts, event: 'usage.receipt', session_id: SESSION, source: 'hook', pid: 4242, seq,
      run_id: runId, model, idempotency_key: `usage.receipt:${SESSION}:${runId}:${model}`,
      data: {
        schema_version: 1, run_id: runId,
        model_identity: { provider: 'anthropic', family: 'claude', tier: 'high', model_id: model, version: '1', catalog_version: '5' },
        usage: { source: 'transcript', fresh_input_tokens: 1, output_tokens: 1, requests: 1 },
        outcome: { status: 'unknown', accepted: null },
        cost: { total: null, pricing_version: 'unresolved' },
      },
    };
  }

  /** The base ledger: 2 honored, 1 unhonored, 1 unmeasured, 1 unjoined bind, 1 unjoined receipt. */
  function baseLines() {
    return [
      bound('a1', 'artibot:planner'), receipt('agent-a1', OPUS_ID),
      bound('a2', 'artibot:architect'), receipt('agent-a2', SONNET_ID),
      bound('a3', 'Explore'), receipt('agent-a3', OPUS_ID),
      bound('a4', 'artibot-cowork:planner'), receipt('agent-a4', SONNET_ID),
      bound('a5', 'artibot:doc-updater'),
      receipt('agent-a9', OPUS_ID),
      receipt(SESSION, OPUS_ID), // main thread: in no denominator
    ];
  }

  /** @param {object[]} lines */
  function writeLedger(lines) {
    mkdirSync(path.dirname(ledger), { recursive: true });
    writeFileSync(ledger, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  }

  /** @returns {{ code: number|null, stdout: string, stderr: string, json?: object }} */
  function live(...args) {
    const r = run(['validate', '--live', '--cwd', project, ...args]);
    return args.includes('--json') && r.code === 0 ? { ...r, json: JSON.parse(r.stdout) } : r;
  }

  beforeEach(() => {
    seq = 0;
    // No `.git` here, so the ledger path is `<project>/.artibot/runtime/ledger.jsonl`
    // (lib/runtime/event-writer.js#ledgerFilePath, the no-common-dir branch).
    project = path.join(root, 'project');
    ledger = path.join(project, '.artibot', 'runtime', 'ledger.jsonl');
    writeLedger(baseLines());
  });

  it('--json: denominators, rates, verdicts and breakdowns from the fold', { timeout: TIMEOUT }, () => {
    const { code, json, stderr } = live('--json');
    expect(code, stderr).toBe(0);
    expect(json.inputPath).toBe(ledger);
    expect(json.since).toBeNull();
    expect(json.pluginRoot).toBe(PLUGIN_ROOT);
    expect(json.configPath).toBe(path.join(PLUGIN_ROOT, 'artibot.config.json'));
    expect(json.coworkAgentsDir).toBe(path.join(coworkRoot, 'agents'));
    expect(json.census.file).toMatchObject({ present: true, readable: true, path: ledger });
    expect(json.overridesStatus).toBe('absent');
    expect(json.denominators).toEqual({ binds: 5, joined: 4, subagent_runs: 5, measured: 3 });
    expect(json.rates).toEqual({
      join_of_binds: 0.8,
      join_of_subagent_runs: 0.8,
      measured_of_joined: 0.75,
      honored_of_measured: 2 / 3,
    });
    expect(json.verdicts).toEqual({ honored: 2, unhonored: 1, unmeasured: 1 });
    expect(json.unmeasured_by_reason['unqualified-agent-type']).toBe(1);
    expect(json.by_expected_source).toEqual({
      honored: { 'cowork-frontmatter': 1, shipped: 1 },
      unhonored: { shipped: 1 },
    });
    expect(json.unhonored_by_transition).toEqual({ 'opus->sonnet': 1 });
    expect(json.rows.map((r) => [r.agent_id, r.verdict])).toEqual([
      ['a1', 'honored'], ['a2', 'unhonored'], ['a3', 'unmeasured'], ['a4', 'honored'],
    ]);
    expect(json.caveats).toHaveLength(3);
  });

  it('text: census line, rates, verdicts, the unhonored row and both caveats', { timeout: TIMEOUT }, () => {
    const r = live();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`ledger: ${ledger} (`);
    expect(r.stdout).toContain(`judged against: plugin root ${PLUGIN_ROOT} · config ${path.join(PLUGIN_ROOT, 'artibot.config.json')}`);
    expect(r.stdout).toContain('--plugin-root');
    expect(r.stdout).toContain('denominators: binds 5 · joined 4 · subagent_runs 5 · measured 3');
    expect(r.stdout).toMatch(/honored_of_measured\s+2\/3\s+66\.7%/);
    expect(r.stdout).toContain('verdicts: honored 2 · unhonored 1 · unmeasured 1');
    expect(r.stdout).toContain('unhonored artibot:architect: expected opus [shipped] served sonnet (claude-sonnet-5)');
    expect(r.stdout.match(/^caveat: /gm)).toHaveLength(3);
    expect(run(['validate', '--live', '--cwd', project]).stdout).toBe(r.stdout);
  });

  it('never writes the ledger: sha256 and the directory listing are unchanged', { timeout: TIMEOUT }, () => {
    const before = fingerprint(ledger);
    const listing = readdirSync(path.dirname(ledger));
    expect(live('--json').code).toBe(0);
    expect(live().code).toBe(0);
    expect(fingerprint(ledger)).toBe(before);
    expect(readdirSync(path.dirname(ledger))).toEqual(listing);
  });

  it('judges against the user overrides', { timeout: TIMEOUT }, () => {
    expect(run(['set', 'agent', 'artibot:architect', 'sonnet']).code).toBe(0);
    const { json } = live('--json');
    expect(json.overridesStatus).toBe('ok');
    expect(json.verdicts).toEqual({ honored: 3, unhonored: 0, unmeasured: 1 });
    expect(json.by_expected_source.honored).toEqual({ 'cowork-frontmatter': 1, 'override-agent': 1, shipped: 1 });
  });

  it('a damaged overrides file warns and falls back to the shipped values', { timeout: TIMEOUT }, () => {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, 'not json', 'utf8');
    const r = live('--json');
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/warning: .*malformed.*IGNORED/);
    expect(r.json.verdicts).toEqual({ honored: 2, unhonored: 1, unmeasured: 1 });
  });

  it('without a cowork roster the cowork spawn is not-in-roster, never guessed', { timeout: TIMEOUT }, () => {
    const r = run(['validate', '--live', '--cwd', project, '--json'], { cowork: path.join(root, 'no-such-cowork') });
    const json = JSON.parse(r.stdout);
    expect(json.unmeasured_by_reason['agent-not-in-roster']).toBe(1);
    expect(json.verdicts).toEqual({ honored: 1, unhonored: 1, unmeasured: 2 });
  });

  it('--since windows the ledger, as ISO or as epoch milliseconds', { timeout: TIMEOUT }, () => {
    const old = '2026-09-01T00:00:00.000Z';
    writeLedger([bound('a0', 'artibot:tdd-guide', old), receipt('agent-a0', OPUS_ID, old), ...baseLines()]);
    expect(live('--json').json.denominators.binds).toBe(6);
    const iso = live('--json', '--since', '2026-09-10T00:00:00Z');
    expect(iso.json.since).toBe('2026-09-10T00:00:00.000Z');
    expect(iso.json.denominators).toEqual({ binds: 5, joined: 4, subagent_runs: 5, measured: 3 });
    expect(iso.json.census.dropped.selection.filtered_out).toBe(2);
    const ms = live('--json', '--since', String(Date.parse('2026-09-10T00:00:00Z')));
    expect(ms.json.denominators).toEqual(iso.json.denominators);
    const offset = live('--json', '--since', '2026-09-10T09:00+09:00');
    expect(offset.json.since).toBe('2026-09-10T00:00:00.000Z');
  });

  it('a missing ledger exits 0, says so, and reports null rates (not 0)', { timeout: TIMEOUT }, () => {
    rmSync(ledger);
    const text = live();
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`ledger absent: ${ledger}`);
    expect(text.stdout).toContain('null (denominator 0)');
    const { code, json } = live('--json');
    expect(code).toBe(0);
    expect(json.census.file.present).toBe(false);
    expect(json.denominators).toEqual({ binds: 0, joined: 0, subagent_runs: 0, measured: 0 });
    expect(Object.values(json.rates)).toEqual([null, null, null, null]);
    expect(existsSync(ledger)).toBe(false);
  });

  it('usage errors exit 2: bad --since, and --since/--cwd without --live', { timeout: TIMEOUT }, () => {
    // V8's Date.parse accepts every one of these; the CLI must not.
    const lenient = ['-1', '123 ', '2026-09-23T07:40', '2026-09-23', '2026-02-31T00:00:00Z', '2026-09-23T24:00:00Z'];
    for (const bad of ['yesterday', '99999999999999999999', ...lenient]) {
      const r = live('--since', bad);
      expect(r.code, bad).toBe(2);
      expect(r.stderr).toContain('unparseable --since');
    }
    expect(run(['validate', '--since', '2026-09-10']).code).toBe(2);
    const cwd = run(['validate', '--cwd', project]);
    expect(cwd.code).toBe(2);
    expect(cwd.stderr).toContain('--cwd is only valid with --live');
  });

  it("judges each spawn under its agent's DEFAULT task override", { timeout: TIMEOUT }, () => {
    // artibot:architect AND artibot:planner default to `architecture`: the a2
    // spawn (architect, served sonnet) turns honored, a1 (planner, served opus)
    // turns unhonored — both judged against the task override.
    expect(run(['set', 'task', 'architecture', 'sonnet', '--plugin', 'artibot']).code).toBe(0);
    const { json } = live('--json');
    expect(json.verdicts).toEqual({ honored: 2, unhonored: 1, unmeasured: 1 });
    const byId = Object.fromEntries(json.rows.map((r) => [r.agent_id, [r.verdict, r.expected_tier, r.expected_source]]));
    expect(byId.a1).toEqual(['unhonored', 'sonnet', 'override-task']);
    expect(byId.a2).toEqual(['honored', 'sonnet', 'override-task']);
  });
});

describe('task layer on an existing v1 file (additive, no schema bump)', () => {
  it('a file without a tasks key loads, and every row carries its default task', { timeout: TIMEOUT }, () => {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    const doc = { schemaVersion: 1, plugins: { artibot: { default: null, agents: { planner: 'sonnet' }, phaseRoles: {} } } };
    writeFileSync(stateFile, JSON.stringify(doc), 'utf8');
    const r = run(['show', '--json']);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const json = JSON.parse(r.stdout);
    expect(json.overridesStatus).toBe('ok');
    expect(row(json, 'artibot', 'planner')).toMatchObject({ task: 'architecture', effective: 'sonnet', source: 'override-agent' });
    expect(row(json, 'artibot', 'code-reviewer').task).toBe('review');
    expect(json.tasks.every((t) => t.overrides.artibot === null && t.overrides['artibot-cowork'] === null)).toBe(true);
  });
});
