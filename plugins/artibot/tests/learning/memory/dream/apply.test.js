import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  canAutoAccept,
  createApplyEngine,
  isManualOnly,
  renderReport,
} from '../../../../lib/learning/memory/dream/apply.js';
import { createMemoryMdAdapter } from '../../../../lib/learning/memory/dream/memory-md-adapter.js';

let tmpDir;
let memDir;
let staging;

async function hashAll(dir) {
  const out = {};
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile()) {
      const raw = await fs.readFile(path.join(dir, e.name), 'utf-8');
      out[e.name] = createHash('sha256').update(raw).digest('hex');
    }
  }
  return out;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-apply-'));
  memDir = path.join(tmpDir, 'memory');
  staging = path.join(memDir, '.dream-staging');
  await fs.mkdir(memDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('canAutoAccept', () => {
  const cfg = { autoAccept: { enabled: true } };
  it('is false when autoAccept disabled', () => {
    expect(canAutoAccept({ op: 'insert', confidence: 0.99, evidence: [{ externalSignal: true }] },
      { autoAccept: { enabled: false } })).toBe(false);
  });
  it('is false for non-insert ops', () => {
    expect(canAutoAccept({ op: 'merge', confidence: 0.99, evidence: [{ externalSignal: true }] }, cfg)).toBe(false);
  });
  it('is false below 0.95 confidence', () => {
    expect(canAutoAccept({ op: 'insert', confidence: 0.9, evidence: [{ externalSignal: true }] }, cfg)).toBe(false);
  });
  it('is false without external signal', () => {
    expect(canAutoAccept({ op: 'insert', confidence: 0.99, evidence: [{ externalSignal: false }] }, cfg)).toBe(false);
  });
  it('is true for insert + conf≥0.95 + external signal', () => {
    expect(canAutoAccept({ op: 'insert', confidence: 0.96, evidence: [{ externalSignal: true }] }, cfg)).toBe(true);
  });
});

describe('isManualOnly', () => {
  it('flags CLAUDE.md and rules targets', () => {
    expect(isManualOnly({ name: 'CLAUDE.md' })).toBe(true);
    expect(isManualOnly({ targets: [{ file: 'rules/x.md' }] })).toBe(true);
    expect(isManualOnly({ name: 'project_x', targets: [{ file: 'a.md' }] })).toBe(false);
  });
});

describe('renderReport', () => {
  it('notes when there are no proposals', () => {
    expect(renderReport([], {})).toContain('No proposals');
  });
  it('marks manual-only proposals as manual merge recommended', () => {
    const r = renderReport([{ op: 'insert', name: 'CLAUDE.md', evidence: [] }], {});
    expect(r).toContain('MANUAL MERGE RECOMMENDED');
  });
});

describe('createApplyEngine — dry-run (default, non-destructive)', () => {
  it('writes report.md only, never touches live MD', async () => {
    await fs.writeFile(path.join(memDir, 'a.md'), '---\nname: a\n---\n\n# A\nbody\n', 'utf-8');
    const before = await hashAll(memDir);

    const engine = createApplyEngine({ memoryDir: memDir, stagingDir: staging });
    const res = await engine.dryRun([{ op: 'insert', name: 'new', confidence: 0.9, evidence: [{ source: 'x' }] }]);

    expect(res.mode).toBe('dry-run');
    expect(res.applied).toBe(0);
    expect(await hashAll(memDir)).toEqual(before); // live MD unchanged
    const report = await fs.readFile(path.join(staging, 'report.md'), 'utf-8');
    expect(report).toContain('INSERT — new');
  });
});

describe('createApplyEngine — apply (review-gate passed)', () => {
  it('archives replaced originals (hard-delete 0) and regenerates index', async () => {
    // Two originals that a merge will replace.
    await fs.writeFile(path.join(memDir, 'dup-a.md'),
      '---\nname: dup-a\ndescription: hook a\n---\n\n# Dup A\nbody a\n', 'utf-8');
    await fs.writeFile(path.join(memDir, 'dup-b.md'),
      '---\nname: dup-b\ndescription: hook b\n---\n\n# Dup B\nbody b\n', 'utf-8');
    await fs.writeFile(path.join(memDir, 'MEMORY.md'),
      '# Project Memory\n\n- [Dup A](dup-a.md) — hook a\n- [Dup B](dup-b.md) — hook b\n', 'utf-8');
    // Staged merged proposal copy.
    await fs.mkdir(staging, { recursive: true });
    const stagedPath = path.join(staging, 'merged.proposed.md');
    await fs.writeFile(stagedPath,
      '---\nname: merged\ndescription: merged hook\n---\n\n# Merged\nmerged body\n', 'utf-8');

    const adapter = createMemoryMdAdapter({ memoryDir: memDir });
    const ledgerPath = path.join(tmpDir, 'transitions.log');
    const engine = createApplyEngine({ memoryDir: memDir, stagingDir: staging, adapter, ledgerPath });

    const res = await engine.apply([{
      op: 'merge', name: 'merged', targetFile: 'merged.md', stagedPath,
      targets: [{ file: 'dup-a.md' }, { file: 'dup-b.md' }],
    }]);

    expect(res.hardDeleted).toBe(0);
    expect(res.archived).toBe(2);
    expect(res.applied).toBe(1);
    // Originals moved into archive, not deleted.
    const archiveDir = path.join(memDir, '.dream-archive');
    const dates = await fs.readdir(archiveDir);
    const archived = await fs.readdir(path.join(archiveDir, dates[0]));
    expect(archived.sort()).toEqual(['dup-a.md', 'dup-b.md']);
    // New merged MD present in live dir.
    expect(await fs.readFile(path.join(memDir, 'merged.md'), 'utf-8')).toContain('Merged');
    // Index regenerated: only the merged row remains.
    const index = await fs.readFile(path.join(memDir, 'MEMORY.md'), 'utf-8');
    expect(index).toContain('merged.md');
    expect(index).not.toContain('dup-a.md');
    // Transition log appended.
    const log = await fs.readFile(ledgerPath, 'utf-8');
    expect(log).toContain('"kind":"apply"');
  });

  it('preserves the installer-seeded MEMORY.md prose while indexing new memories', async () => {
    // Verbatim `SEED_MEMORY` heredoc from `install.sh#render_memory_seed` with
    // the shell count vars expanded — pure prose, zero index rows. Cited by
    // symbol rather than line number, which rots as the installer is refactored.
    const seed = `# Project Memory (Seeded by Artibot)

## Artibot Quick Reference
- **Agents**: 28 specialized agents — use \`Agent()\` to delegate
- **Commands**: \`/sc\` routes to optimal command/agent/skill automatically
- **DEV Protocol**: Decompose → Execute → Verify (mandatory for all code changes)
- **Quality**: 80%+ test coverage, immutable patterns, functions < 50 lines

## Workflow Tips
- Complex features: start with \`/sc plan [feature]\` or use planner agent
- After implementation: code-reviewer agent runs automatically via rules
- Parallel work: launch multiple agents with \`Agent()\` for independent tasks
- Vibe coding: rules auto-activate on file access (no /sc needed after install)

## Key Paths
- Agents: \`~/.claude/agents/\` (28 .md files)
- Commands: \`~/.claude/commands/\` (78 .md files)
- Skills: \`~/.claude/artibot/skills/\` (113 skill directories)
- Rules: \`~/.claude/rules/artibot/\` (auto-activate on file access)
- Config: \`~/.claude/artibot/artibot.config.json\`
`;
    await fs.writeFile(path.join(memDir, 'MEMORY.md'), seed, 'utf-8');
    await fs.writeFile(path.join(memDir, 'project_existing.md'),
      '---\nname: existing\ndescription: pre-existing memory\n---\n\n# Existing Note\n', 'utf-8');
    await fs.mkdir(staging, { recursive: true });
    const stagedPath = path.join(staging, 'new.proposed.md');
    await fs.writeFile(stagedPath,
      '---\nname: newly-learned\ndescription: learned this run\n---\n\n# Newly Learned\n', 'utf-8');

    const adapter = createMemoryMdAdapter({ memoryDir: memDir });
    const engine = createApplyEngine({ memoryDir: memDir, stagingDir: staging, adapter });
    const res = await engine.apply([{
      op: 'insert', name: 'newly-learned', targetFile: 'project_newly_learned.md', stagedPath,
    }]);
    expect(res.applied).toBe(1);

    const index = await fs.readFile(path.join(memDir, 'MEMORY.md'), 'utf-8');
    // Every non-blank seed line survives the regeneration.
    for (const line of seed.split('\n').filter((l) => l.trim())) {
      expect(index).toContain(line);
    }
    // …and both memories are indexed.
    expect(index).toContain('(project_existing.md)');
    expect(index).toContain('(project_newly_learned.md)');
  });

  it('skips rules/CLAUDE.md proposals (proposal-only, acceptance #7)', async () => {
    const adapter = createMemoryMdAdapter({ memoryDir: memDir });
    const engine = createApplyEngine({ memoryDir: memDir, stagingDir: staging, adapter });
    const res = await engine.apply([{ op: 'insert', name: 'CLAUDE.md', targetFile: 'CLAUDE.md' }]);
    expect(res.skippedManual).toBe(1);
    expect(res.applied).toBe(0);
    // No CLAUDE.md written into the memory dir.
    await expect(fs.access(path.join(memDir, 'CLAUDE.md'))).rejects.toThrow();
  });
});
