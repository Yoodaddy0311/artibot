/**
 * scripts/model-routing/model-routing-roster.mjs — roster discovery and `show`
 * rendering, exercised as plain functions against temp directories. The CLI
 * contract (stdout/stderr/exit codes) stays pinned by model-routing-cli.test.js.
 *
 * @module tests/scripts/model-routing-roster
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareSemver,
  findCoworkAgentsDir,
  loadRosters,
  readRoster,
  renderShowJson,
  renderShowText,
  renderTable,
  renderTaskLine,
  rowCells,
} from '../../scripts/model-routing/model-routing-roster.mjs';

const BOM = String.fromCharCode(0xfeff);

let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'artibot-model-routing-roster-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * @param {string} dir
 * @param {Record<string, string>} files - file name → contents
 * @returns {string} dir
 */
function writeAgents(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text, 'utf8');
  return dir;
}

/** @param {string} model @returns {string} */
function agent(model) {
  return `---\nname: x\ndescription: fixture\n${model === undefined ? '' : `model: ${model}\n`}---\nbody\n`;
}

describe('compareSemver', () => {
  it('compares numerically, so 3.10.0 sorts after 3.9.0', () => {
    expect(compareSemver('3.9.0', '3.10.0')).toBeLessThan(0);
    expect(compareSemver('3.10.0', '3.9.0')).toBeGreaterThan(0);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(['3.10.0', '3.9.0', '10.0.0', '3.9.1'].sort(compareSemver)).toEqual([
      '3.9.0',
      '3.9.1',
      '3.10.0',
      '10.0.0',
    ]);
  });
});

describe('findCoworkAgentsDir', () => {
  it('picks the highest semver cache directory and ignores non-semver names', () => {
    const pluginRoot = path.join(root, 'cache', 'artibot', '4.0.0');
    mkdirSync(pluginRoot, { recursive: true });
    const cacheBase = path.join(root, 'cache', 'artibot-cowork');
    writeAgents(path.join(cacheBase, '3.9.0', 'agents'), {});
    writeAgents(path.join(cacheBase, '3.10.0', 'agents'), {});
    writeAgents(path.join(cacheBase, 'latest', 'agents'), {});
    writeAgents(path.join(cacheBase, '99.0.0-beta', 'agents'), {});
    // A semver directory without agents/ is not a candidate.
    mkdirSync(path.join(cacheBase, '50.0.0'), { recursive: true });
    expect(findCoworkAgentsDir(pluginRoot, undefined)).toBe(path.resolve(cacheBase, '3.10.0', 'agents'));
  });

  it('prefers the dev tree over the plugin cache', () => {
    const pluginRoot = path.join(root, 'plugins', 'artibot');
    mkdirSync(pluginRoot, { recursive: true });
    const devTree = writeAgents(path.join(root, 'plugins', 'artibot-cowork', 'agents'), {});
    writeAgents(path.join(root, 'artibot-cowork', '9.9.9', 'agents'), {});
    expect(findCoworkAgentsDir(pluginRoot, undefined)).toBe(path.resolve(devTree));
  });

  it('treats --cowork-root as exclusive: a root without agents/ is null even with a dev tree', () => {
    const pluginRoot = path.join(root, 'plugins', 'artibot');
    mkdirSync(pluginRoot, { recursive: true });
    writeAgents(path.join(root, 'plugins', 'artibot-cowork', 'agents'), {});
    const explicit = path.join(root, 'explicit');
    mkdirSync(explicit, { recursive: true });
    expect(findCoworkAgentsDir(pluginRoot, explicit)).toBeNull();
    writeAgents(path.join(explicit, 'agents'), {});
    expect(findCoworkAgentsDir(pluginRoot, explicit)).toBe(path.join(explicit, 'agents'));
  });

  it('returns null when no roster exists anywhere', () => {
    const pluginRoot = path.join(root, 'plugins', 'artibot');
    mkdirSync(pluginRoot, { recursive: true });
    expect(findCoworkAgentsDir(pluginRoot, undefined)).toBeNull();
  });
});

describe('readRoster', () => {
  it('strips a BOM and quotes, and maps every non-tier value to null', () => {
    const dir = writeAgents(path.join(root, 'agents'), {
      'bom.md': `${BOM}${agent('opus')}`,
      'double.md': agent('"fable"'),
      'single.md': agent("'haiku'"),
      'crlf.md': agent('sonnet').replace(/\n/g, '\r\n'),
      'inherit.md': agent('inherit'),
      'typo.md': agent('opsu'),
      'missing.md': agent(undefined),
      'INDEX.md': agent('opus'),
      'README.md': agent('opus'),
      'notes.txt': agent('opus'),
    });
    expect(Object.fromEntries(readRoster(dir))).toEqual({
      bom: 'opus',
      crlf: 'sonnet',
      double: 'fable',
      inherit: null,
      missing: null,
      single: 'haiku',
      typo: null,
    });
    expect([...readRoster(dir).keys()]).toEqual(['bom', 'crlf', 'double', 'inherit', 'missing', 'single', 'typo']);
  });
});

describe('loadRosters', () => {
  it('reads both rosters and leaves a missing one null', () => {
    const pluginRoot = path.join(root, 'plugins', 'artibot');
    writeAgents(path.join(pluginRoot, 'agents'), { 'planner.md': agent('fable') });
    const none = loadRosters(pluginRoot, undefined);
    expect(Object.fromEntries(none.artibot)).toEqual({ planner: 'fable' });
    expect(none['artibot-cowork']).toBeNull();

    writeAgents(path.join(root, 'plugins', 'artibot-cowork', 'agents'), { 'writer.md': agent('haiku') });
    const both = loadRosters(pluginRoot, undefined);
    expect(Object.fromEntries(both['artibot-cowork'])).toEqual({ writer: 'haiku' });
  });

  it('is null for artibot when its agents/ directory is missing', () => {
    expect(loadRosters(path.join(root, 'nowhere'), undefined).artibot).toBeNull();
  });
});

describe('show rendering', () => {
  const rows = [
    {
      plugin: 'artibot',
      agent: 'planner',
      frontmatter: 'fable',
      shipped: 'fable',
      override: null,
      effective: 'fable',
      source: 'policy',
      reason: null,
      hostPath: 'frontmatter',
    },
    {
      plugin: 'artibot',
      agent: 'x',
      frontmatter: null,
      shipped: 'opus',
      override: 'sonnet (agent)',
      effective: 'sonnet',
      source: 'user',
      reason: null,
      hostPath: 'needs-spawn-param',
    },
  ];
  const view = {
    file: '/state/model-routing.json',
    overridesStatus: 'ok',
    role: 'build',
    plugins: {
      artibot: { status: 'ok', rows },
      'artibot-cowork': { status: 'unavailable', reason: 'roster-not-found' },
    },
    phases: [
      { phase: 'build', shipped: 'opus', override: null },
      { phase: 'review', shipped: 'fable', override: 'opus' },
    ],
  };

  it('aligns columns and trims trailing padding', () => {
    expect(renderTable(['a', 'bb'], [['ccc', 'd']])).toBe('a    bb\n---  --\nccc  d');
  });

  it('renders unknown frontmatter/effective as (unknown) and joins source/reason', () => {
    expect(rowCells(rows[1])).toEqual([
      'artibot',
      'x',
      '(unknown)',
      'opus',
      'sonnet (agent)',
      'sonnet [user]',
      'needs-spawn-param',
    ]);
    const unknown = { ...rows[0], effective: null, source: 'unknown', reason: 'no-frontmatter' };
    expect(rowCells(unknown)[4]).toBe('—');
    expect(rowCells(unknown)[5]).toBe('(unknown) [unknown/no-frontmatter]');
  });

  it('renders the text view: header, rows, unavailable note, phase line, footnote', () => {
    const lines = renderShowText(view).split('\n');
    expect(lines[0]).toBe('overrides: /state/model-routing.json (ok) · role=build');
    expect(lines[1].split(/\s{2,}/)).toEqual([
      'plugin',
      'agent',
      'frontmatter',
      'shipped',
      'override',
      'effective',
      'host path',
    ]);
    expect(lines[3].split(/\s{2,}/)).toEqual(['artibot', 'planner', 'fable', 'fable', '—', 'fable [policy]', 'frontmatter']);
    expect(lines[4].split(/\s{2,}/)).toEqual(rowCells(rows[1]));
    expect(lines[5]).toBe('artibot-cowork: unavailable:roster-not-found');
    expect(lines[6]).toBe('phase roles (artibot): build=opus · review=fable → user opus');
    expect(lines[7]).toBe(
      'needs-spawn-param = the value takes effect only if the leader spawns with Agent(model=<resolve output>).',
    );
    expect(lines[8]).toBe('');
    expect(lines).toHaveLength(9);
  });

  it('renders a tierless (inherit) cowork agent as (unknown) instead of throwing', () => {
    // The row pluginRows builds for `model: inherit`: nothing resolves, so every
    // model column is null (measured from `show --json`).
    const tierless = {
      plugin: 'artibot-cowork',
      agent: 'odd',
      frontmatter: null,
      shipped: null,
      override: null,
      effective: null,
      source: 'cowork-frontmatter-unknown',
      reason: null,
      hostPath: 'frontmatter',
    };
    const tierlessView = { ...view, plugins: { 'artibot-cowork': { status: 'ok', rows: [tierless] } } };
    expect(() => renderShowText(tierlessView)).not.toThrow();
    expect(rowCells(tierless)).toEqual([
      'artibot-cowork',
      'odd',
      '(unknown)',
      '(unknown)',
      '—',
      '(unknown) [cowork-frontmatter-unknown]',
      'frontmatter',
    ]);
    expect(renderShowText(tierlessView).split('\n')[3].split(/\s{2,}/)).toEqual(rowCells(tierless));
  });

  it('omits the role suffix when no role is selected', () => {
    expect(renderShowText({ ...view, role: null }).split('\n')[0]).toBe('overrides: /state/model-routing.json (ok)');
  });

  it('renders the JSON view in the view key order with a trailing newline', () => {
    const text = renderShowJson(view);
    expect(text.endsWith('}\n')).toBe(true);
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual(['file', 'overridesStatus', 'role', 'plugins', 'phases']);
    expect(parsed.plugins['artibot-cowork']).toEqual({ status: 'unavailable', reason: 'roster-not-found' });
    expect(text).toBe(`${JSON.stringify(view, null, 2)}\n`);
  });

  describe('task layer', () => {
    const taskRows = [{ ...rows[0], task: 'architecture' }, { ...rows[1], task: null }];
    const tasks = [
      { task: 'review', agents: [], overrides: { artibot: 'haiku', 'artibot-cowork': null } },
      { task: 'status', agents: [], overrides: { artibot: null, 'artibot-cowork': null } },
      { task: 'explore', agents: [], overrides: { artibot: 'sonnet', 'artibot-cowork': 'sonnet' } },
    ];
    const taskView = { ...view, task: 'review', plugins: { artibot: { status: 'ok', rows: taskRows } }, tasks };

    it('appends the task cell last, — for an agent without a task', () => {
      expect(rowCells(taskRows[0])).toEqual([...rowCells(rows[0]), 'architecture']);
      expect(rowCells(taskRows[1]).at(-1)).toBe('—');
      expect(rowCells(rows[0])).toHaveLength(7);
    });

    it('renders the task header, the task suffix and the task overrides line', () => {
      const lines = renderShowText(taskView).split('\n');
      expect(lines[0]).toBe('overrides: /state/model-routing.json (ok) · role=build · task=review');
      expect(lines[1].split(/\s{2,}/).at(-1)).toBe('task');
      expect(lines[3].split(/\s{2,}/)).toEqual(rowCells(taskRows[0]));
      expect(lines[6]).toBe('task overrides: review=artibot haiku · explore=artibot sonnet, artibot-cowork sonnet');
    });

    it('says (none) when no task override is stored', () => {
      expect(renderTaskLine([tasks[1]])).toBe('task overrides: (none)');
      expect(renderTaskLine([])).toBe('task overrides: (none)');
    });
  });
});
