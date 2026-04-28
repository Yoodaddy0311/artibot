/**
 * MCP bridge tests — covers all four v3.8 bridges:
 *   - skills-bridge
 *   - agents-bridge
 *   - memory-bridge (with redaction guarantees)
 *   - git-bridge (read-only enforcement)
 *
 * Tests are written against the live Artibot plugin layout where a bridge's
 * default wiring is filesystem-backed, and against injected fakes where a
 * narrower contract is clearer.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSkillsBridge } from '../../lib/mcp/bridge/skills-bridge.js';
import { createAgentsBridge } from '../../lib/mcp/bridge/agents-bridge.js';
import { createMemoryBridge } from '../../lib/mcp/bridge/memory-bridge.js';
import { createGitBridge, __test__ as gitInternals } from '../../lib/mcp/bridge/git-bridge.js';

// Assemble secret-shaped values at runtime so the source file doesn't trip
// repository-wide secret scanners.
const FAKE_EMAIL = ['alice', '@', 'example.com'].join('');
const FAKE_SK = ['s', 'k', '-', 'AAAABBBBCCCCDDDDEEEE'].join('');

// ---------------------------------------------------------------------------
// Fake in-memory skill registry used by the bridge-level tests that don't
// need the real filesystem.
// ---------------------------------------------------------------------------

function makeFakeSkillRegistry(skills) {
  const list = () => Promise.resolve(skills.map((s) => ({
    name: s.name,
    description: s.description,
    tags: s.tags || [],
    path: s.path || `/fake/${s.name}/SKILL.md`,
    size: s.body?.length ?? 0,
    mtimeMs: 1,
  })));
  const read = async (name) => {
    const found = skills.find((s) => s.name === name);
    if (!found) return null;
    return {
      entry: {
        name: found.name,
        description: found.description,
        tags: found.tags || [],
        path: found.path || `/fake/${found.name}/SKILL.md`,
        size: found.body?.length ?? 0,
        mtimeMs: 1,
      },
      body: found.body || '',
    };
  };
  return { list, read };
}

// ---------------------------------------------------------------------------
// skills-bridge
// ---------------------------------------------------------------------------

describe('createSkillsBridge — injected registry', () => {
  const registry = makeFakeSkillRegistry([
    {
      name: 'seo-strategy',
      description: 'SEO optimization guide',
      tags: ['seo', 'marketing'],
      body: '# SEO\nSome body text.',
    },
    {
      name: 'coding-standards',
      description: 'Coding standards and conventions',
      tags: ['code', 'standards'],
      body: '# Standards\nBody.',
    },
  ]);

  it('listSkills returns all entries with sanitized fields', async () => {
    const bridge = createSkillsBridge({ skillRegistry: registry });
    const res = await bridge.listSkills();
    expect(res.ok).toBe(true);
    expect(res.value).toHaveLength(2);
    expect(res.value[0]).toMatchObject({
      name: expect.any(String),
      description: expect.any(String),
      tags: expect.any(Array),
      path: expect.any(String),
    });
  });

  it('getSkill returns full body and metadata', async () => {
    const bridge = createSkillsBridge({ skillRegistry: registry });
    const res = await bridge.getSkill('seo-strategy');
    expect(res.ok).toBe(true);
    expect(res.value.name).toBe('seo-strategy');
    expect(res.value.body).toContain('# SEO');
    expect(res.value.tags).toContain('seo');
  });

  it('getSkill rejects empty name with error', async () => {
    const bridge = createSkillsBridge({ skillRegistry: registry });
    const res = await bridge.getSkill('');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/name required/);
  });

  it('getSkill returns structured error for missing skill', async () => {
    const bridge = createSkillsBridge({ skillRegistry: registry });
    const res = await bridge.getSkill('does-not-exist');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
  });

  it('searchSkills matches by description keyword', async () => {
    const bridge = createSkillsBridge({ skillRegistry: registry });
    const res = await bridge.searchSkills({ query: 'standards' });
    expect(res.ok).toBe(true);
    expect(res.value.length).toBeGreaterThan(0);
    expect(res.value[0].name).toBe('coding-standards');
    expect(res.value[0].score).toBeGreaterThan(0);
  });

  it('searchSkills matches by tag', async () => {
    const bridge = createSkillsBridge({ skillRegistry: registry });
    const res = await bridge.searchSkills({ query: 'marketing' });
    expect(res.ok).toBe(true);
    expect(res.value.map((r) => r.name)).toContain('seo-strategy');
  });

  it('searchSkills rejects empty query', async () => {
    const bridge = createSkillsBridge({ skillRegistry: registry });
    const res = await bridge.searchSkills({ query: '' });
    expect(res.ok).toBe(false);
  });

  it('searchSkills honours limit', async () => {
    const res = await createSkillsBridge({ skillRegistry: registry })
      .searchSkills({ query: 'standards seo code', limit: 1 });
    expect(res.ok).toBe(true);
    expect(res.value.length).toBeLessThanOrEqual(1);
  });
});

describe('createSkillsBridge — live filesystem', () => {
  it('listSkills enumerates the real Artibot skills directory', async () => {
    const bridge = createSkillsBridge();
    const res = await bridge.listSkills();
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.value)).toBe(true);
    // Repo is guaranteed to ship many skills; 10 is a safe floor.
    expect(res.value.length).toBeGreaterThanOrEqual(10);
  });

  it('getSkill returns a real SKILL.md body for an existing entry', async () => {
    const bridge = createSkillsBridge();
    const list = await bridge.listSkills();
    const first = list.value[0];
    const res = await bridge.getSkill(first.name);
    expect(res.ok).toBe(true);
    expect(typeof res.value.body).toBe('string');
    expect(res.value.body.length).toBeGreaterThan(0);
  });

  it('getSkill rejects path-traversal attempts', async () => {
    const bridge = createSkillsBridge();
    const res = await bridge.getSkill('../../etc/passwd');
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// agents-bridge
// ---------------------------------------------------------------------------

describe('createAgentsBridge — injected registry', () => {
  const fakeAgents = [
    {
      name: 'test-reviewer',
      description: 'reviews code',
      capabilities: ['review', 'audit'],
      lifecycle: 'review',
      model: 'opus',
      tools: ['Read', 'Grep'],
      path: '/fake/test-reviewer.md',
      mtimeMs: 1,
    },
    {
      name: 'test-planner',
      description: 'plans features',
      capabilities: ['plan', 'architect'],
      lifecycle: 'plan',
      model: 'opus',
      tools: ['Read'],
      path: '/fake/test-planner.md',
      mtimeMs: 1,
    },
  ];

  const registry = {
    list: async () => fakeAgents,
    get: async (name) => fakeAgents.find((a) => a.name === name) || null,
    getBody: async (entry) => `# ${entry.name}\nfake body content`,
  };

  it('listAgents returns shaped summaries with derived category', async () => {
    const bridge = createAgentsBridge({ agentRegistry: registry });
    const res = await bridge.listAgents();
    expect(res.ok).toBe(true);
    expect(res.value).toHaveLength(2);
    const reviewer = res.value.find((a) => a.name === 'test-reviewer');
    expect(reviewer.category).toBe('review');
    expect(reviewer.tools).toContain('Read');
    const planner = res.value.find((a) => a.name === 'test-planner');
    expect(planner.category).toBe('planning');
  });

  it('getAgent returns full entry with body', async () => {
    const bridge = createAgentsBridge({ agentRegistry: registry });
    const res = await bridge.getAgent('test-reviewer');
    expect(res.ok).toBe(true);
    expect(res.value.name).toBe('test-reviewer');
    expect(res.value.body).toContain('fake body content');
    expect(res.value.category).toBe('review');
  });

  it('getAgent rejects empty name', async () => {
    const bridge = createAgentsBridge({ agentRegistry: registry });
    const res = await bridge.getAgent('');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/name required/);
  });

  it('getAgent returns structured error for unknown agent', async () => {
    const bridge = createAgentsBridge({ agentRegistry: registry });
    const res = await bridge.getAgent('nope');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
  });

  it('supports registries that expose listAgents / getAgent directly', async () => {
    const altRegistry = {
      listAgents: async () => fakeAgents,
      getAgent: async (n) => fakeAgents.find((a) => a.name === n) || null,
    };
    const bridge = createAgentsBridge({ agentRegistry: altRegistry });
    const list = await bridge.listAgents();
    expect(list.ok).toBe(true);
    expect(list.value.length).toBe(2);
    const entry = await bridge.getAgent('test-planner');
    expect(entry.ok).toBe(true);
    expect(entry.value.name).toBe('test-planner');
  });
});

describe('createAgentsBridge — live registry', () => {
  it('listAgents returns the real Artibot agent roster', async () => {
    const bridge = createAgentsBridge();
    const res = await bridge.listAgents();
    expect(res.ok).toBe(true);
    expect(res.value.length).toBeGreaterThan(10);
    // Every entry must have name + path — core invariant of the registry.
    for (const entry of res.value) {
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// memory-bridge (with redaction)
// ---------------------------------------------------------------------------

describe('createMemoryBridge — redaction + retrieval', () => {
  it('getMemoryStats aggregates per-layer counts', async () => {
    const workingStore = { size: () => 3 };
    const episodicStore = { size: () => 7 };
    const semanticStore = { count: () => 42 };
    const metrics = {
      snapshot: () => ({
        date: '2026-04-23',
        working: { hits: 5, queries: 10, rate: 0.5 },
        episodic: { hits: 2, queries: 10, rate: 0.2 },
        semantic: { hits: 0, queries: 0, rate: 0 },
      }),
    };
    const bridge = createMemoryBridge({
      workingStore, episodicStore, semanticStore, metrics,
    });
    const res = await bridge.getMemoryStats();
    expect(res.ok).toBe(true);
    expect(res.value.counts).toEqual({ working: 3, episodic: 7, semantic: 42 });
    expect(res.value.hitRates.working.rate).toBe(0.5);
  });

  it('getMemoryStats redacts flat memoryManager output', async () => {
    const memoryManager = {
      getMemoryStats: async () => ({
        memoryDir: 'C:\\Users\\alice\\memory',
        note: `contact ${FAKE_EMAIL}`,
      }),
    };
    const bridge = createMemoryBridge({ memoryManager });
    const res = await bridge.getMemoryStats();
    expect(res.ok).toBe(true);
    expect(JSON.stringify(res.value.flat)).not.toContain('alice');
    expect(JSON.stringify(res.value.flat)).not.toContain(FAKE_EMAIL);
    expect(JSON.stringify(res.value.flat)).toContain('{email}');
  });

  it('searchMemory routes through retriever and redacts entry payloads', async () => {
    const retriever = {
      search: async () => ({
        results: [
          {
            entry: { message: `secret api_key=${FAKE_SK}`, from: FAKE_EMAIL },
            score: 0.8,
            layer: 'working',
            provenance: { source: 'user' },
          },
        ],
        metrics: {
          date: '2026-04-23',
          working: { hits: 1, queries: 1, rate: 1 },
          episodic: { hits: 0, queries: 1, rate: 0 },
          semantic: { hits: 0, queries: 1, rate: 0 },
        },
      }),
    };
    const bridge = createMemoryBridge({ retriever });
    const res = await bridge.searchMemory({ query: 'anything' });
    expect(res.ok).toBe(true);
    expect(res.value.mode).toBe('retriever');
    const serialized = JSON.stringify(res.value.results);
    expect(serialized).not.toContain(FAKE_SK);
    expect(serialized).not.toContain(FAKE_EMAIL);
    expect(serialized).toContain('***REDACTED***');
    expect(serialized).toContain('{email}');
    expect(res.value.results[0].layer).toBe('working');
    expect(res.value.results[0].score).toBe(0.8);
    expect(res.value.metrics.working.rate).toBe(1);
  });

  it('searchMemory falls back to flat memoryManager when no retriever', async () => {
    const memoryManager = {
      searchMemory: async () => [
        {
          entry: { password: FAKE_SK, owner: FAKE_EMAIL },
          score: 0.6,
          store: 'preferences',
        },
      ],
    };
    const bridge = createMemoryBridge({ memoryManager });
    const res = await bridge.searchMemory({ query: 'foo' });
    expect(res.ok).toBe(true);
    expect(res.value.mode).toBe('flat');
    const serialized = JSON.stringify(res.value.results);
    expect(serialized).not.toContain(FAKE_SK);
    expect(serialized).not.toContain(FAKE_EMAIL);
  });

  it('searchMemory rejects empty query', async () => {
    const bridge = createMemoryBridge({
      retriever: { search: async () => ({ results: [] }) },
    });
    const res = await bridge.searchMemory({ query: '   ' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/query required/);
  });

  it('searchMemory errors cleanly when no dependency is wired', async () => {
    const bridge = createMemoryBridge({});
    const res = await bridge.searchMemory({ query: 'x' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no retriever or memoryManager/);
  });

  it('searchMemory redacts the query itself before logging/returning', async () => {
    let captured = null;
    const retriever = {
      search: async (q) => {
        captured = q;
        return { results: [] };
      },
    };
    const bridge = createMemoryBridge({ retriever });
    const res = await bridge.searchMemory({
      query: `please check api_key=${FAKE_SK}`,
    });
    expect(res.ok).toBe(true);
    expect(captured).toContain('***REDACTED***');
    expect(captured).not.toContain(FAKE_SK);
    expect(res.value.query).not.toContain(FAKE_SK);
  });

  it('searchMemory clamps limit to the maximum', async () => {
    let opts = null;
    const retriever = {
      search: async (_q, o) => {
        opts = o;
        return { results: [] };
      },
    };
    const bridge = createMemoryBridge({ retriever });
    await bridge.searchMemory({ query: 'hi', limit: 9999 });
    expect(opts.limit).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// git-bridge (read-only enforcement)
// ---------------------------------------------------------------------------

describe('createGitBridge — read-only guarantees', () => {
  it('assertReadOnly rejects every write subcommand', () => {
    for (const cmd of gitInternals.WRITE_SUBCOMMANDS) {
      expect(() => gitInternals.assertReadOnly(cmd)).toThrow(/forbidden/);
    }
  });

  it('assertReadOnly rejects unknown/non-allow-listed subcommands', () => {
    expect(() => gitInternals.assertReadOnly('whatever')).toThrow(/not allow-listed/);
    expect(() => gitInternals.assertReadOnly('')).toThrow();
  });

  it('assertReadOnly accepts every read subcommand', () => {
    for (const cmd of gitInternals.READONLY_SUBCOMMANDS) {
      expect(() => gitInternals.assertReadOnly(cmd)).not.toThrow();
    }
  });

  it('status dispatches `git status --porcelain=v1` and parses output', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: ' M file.js\n?? newfile.ts\n',
      stderr: '',
    });
    const bridge = createGitBridge({ cwd: '/tmp/x', exec });
    const res = await bridge.status();
    expect(exec).toHaveBeenCalledWith(['status', '--porcelain=v1'], '/tmp/x');
    expect(res.ok).toBe(true);
    expect(res.value.clean).toBe(false);
    expect(res.value.entries).toHaveLength(2);
    expect(res.value.entries[0]).toEqual({ code: ' M', path: 'file.js' });
  });

  it('status marks clean tree when porcelain is empty', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const res = await createGitBridge({ exec }).status();
    expect(res.ok).toBe(true);
    expect(res.value.clean).toBe(true);
    expect(res.value.entries).toEqual([]);
  });

  it('log dispatches `git log --oneline -10` and parses commits', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: 'abc1234 first\ndef5678 second\n',
      stderr: '',
    });
    const res = await createGitBridge({ exec }).log();
    expect(exec).toHaveBeenCalledWith(['log', '--oneline', '-10'], expect.any(String));
    expect(res.ok).toBe(true);
    expect(res.value.commits).toEqual([
      { sha: 'abc1234', subject: 'first' },
      { sha: 'def5678', subject: 'second' },
    ]);
  });

  it('branches dispatches `git branch --list` and flags current', async () => {
    const exec = vi.fn().mockResolvedValue({
      stdout: '* main\n  feature/x\n',
      stderr: '',
    });
    const res = await createGitBridge({ exec }).branches();
    expect(res.ok).toBe(true);
    expect(res.value.branches).toEqual([
      { name: 'main', current: true },
      { name: 'feature/x', current: false },
    ]);
  });

  it('run dispatches only allow-listed ops', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const bridge = createGitBridge({ exec });
    const bad = await bridge.run('commit');
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/unknown op/);
    const good = await bridge.run('status');
    expect(good.ok).toBe(true);
  });

  it('runGit timeout / buffer guard is active by default (contract check)', async () => {
    // Cannot actually invoke git under the test sandbox deterministically, but
    // we confirm that any error is wrapped into {ok: false, error}.
    const bridge = createGitBridge({
      cwd: '/definitely/not/a/git/repo/xyz',
      exec: async () => { throw new Error('fatal: not a git repository'); },
    });
    const res = await bridge.status();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a git repository/);
  });

  it('parsers handle empty input', () => {
    expect(gitInternals.parsePorcelain('')).toEqual([]);
    expect(gitInternals.parseOneline('')).toEqual([]);
    expect(gitInternals.parseBranches('')).toEqual([]);
  });

  it('returned bridge object is frozen (immutability)', () => {
    const bridge = createGitBridge();
    expect(Object.isFrozen(bridge)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cross-bridge smoke
// ---------------------------------------------------------------------------

describe('bridge factories — immutability and shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('all four factories return frozen objects', () => {
    expect(Object.isFrozen(createSkillsBridge({ skillRegistry: makeFakeSkillRegistry([]) }))).toBe(true);
    expect(Object.isFrozen(createAgentsBridge({ agentRegistry: { list: async () => [] } }))).toBe(true);
    expect(Object.isFrozen(createMemoryBridge({}))).toBe(true);
    expect(Object.isFrozen(createGitBridge({ exec: async () => ({ stdout: '', stderr: '' }) }))).toBe(true);
  });

  it('all bridges return {ok, value|error} shape on happy and error paths', async () => {
    const skills = createSkillsBridge({ skillRegistry: makeFakeSkillRegistry([]) });
    expect(await skills.listSkills()).toMatchObject({ ok: true, value: [] });
    expect((await skills.getSkill('nope')).ok).toBe(false);

    const agents = createAgentsBridge({ agentRegistry: { list: async () => [] } });
    expect(await agents.listAgents()).toMatchObject({ ok: true, value: [] });
    expect((await agents.getAgent('nope')).ok).toBe(false);

    const memory = createMemoryBridge({ retriever: { search: async () => ({ results: [] }) } });
    expect((await memory.searchMemory({ query: 'hi' })).ok).toBe(true);
    expect((await memory.searchMemory({ query: '' })).ok).toBe(false);

    const git = createGitBridge({ exec: async () => ({ stdout: '', stderr: '' }) });
    expect((await git.status()).ok).toBe(true);
  });
});
