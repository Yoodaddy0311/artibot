import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createCollector } from '../../../../lib/learning/memory/dream/collector.js';
import {
  distillCandidates,
  resolveDistillConfig,
  writeCandidates,
} from '../../../../lib/learning/memory/dream/distiller.js';
import {
  createPromoteMd,
  evaluateProposal,
  resolvePromoteConfig,
} from '../../../../lib/learning/memory/dream/promote-md.js';
import { parseMemoryDoc } from '../../../../lib/learning/memory/dream/memory-md-adapter.js';

let tmpDir;

function doc({ name, type, body, desc = 'hook', session = 's1', extraLink = '' }) {
  return `---
name: ${name}
description: ${desc}
metadata:
  node_type: memory
  type: ${type}
  originSessionId: ${session}
---

# ${name}

${body}
${extraLink}
`;
}

async function writeMemory(dir, file, content) {
  await fs.writeFile(path.join(dir, file), content, 'utf-8');
}

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-engine-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

describe('createCollector', () => {
  it('requires memoryDir', () => {
    expect(() => createCollector({})).toThrow();
  });

  it('collects memories + index rows + external signals read-only', async () => {
    const memDir = path.join(tmpDir, 'memory');
    const projDir = path.join(tmpDir, 'proj');
    await fs.mkdir(memDir, { recursive: true });
    await fs.mkdir(path.join(projDir, '.artibot', 'handoffs'), { recursive: true });
    await writeMemory(memDir, 'a.md', doc({ name: 'a', type: 'project', body: 'release ci ship' }));
    await fs.writeFile(path.join(memDir, 'MEMORY.md'),
      '# Project Memory\n\n- [A](a.md) — hook\n', 'utf-8');
    await fs.writeFile(path.join(projDir, '.artibot', 'handoffs', 'h1.md'), '# handoff', 'utf-8');
    await fs.writeFile(path.join(projDir, '.artibot', 'SESSION-NOTES.md'), 'notes', 'utf-8');

    const before = await hashAll(memDir);
    const collector = createCollector({ memoryDir: memDir, projectDir: projDir });
    const result = await collector.collect();

    expect(result.memories).toHaveLength(1);
    expect(result.indexRows).toHaveLength(1);
    const kinds = result.signals.map((s) => s.kind).sort();
    expect(kinds).toEqual(['handoff', 'session-notes']);
    expect(result.signals.every((s) => s.externalSignal === true)).toBe(true);
    // Read-only proof
    expect(await hashAll(memDir)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Distiller (Phase-1 code-Distill)
// ---------------------------------------------------------------------------

describe('distillCandidates', () => {
  it('finds dedup-merge candidates for near-duplicate same-type memories', () => {
    const a = parseMemoryDoc(doc({ name: 'dup-a', type: 'project', body: 'nightly trainer schedule cron registration os scheduler' }), 'dup-a.md');
    const b = parseMemoryDoc(doc({ name: 'dup-b', type: 'project', body: 'nightly trainer schedule cron registration os scheduler' }), 'dup-b.md');
    const out = distillCandidates([a, b]);
    expect(out.mergeCandidates).toHaveLength(1);
    expect(out.mergeCandidates[0].kind).toBe('dedup-merge');
    expect(out.mergeCandidates[0].similarity).toBeGreaterThanOrEqual(0.82);
  });

  it('does NOT merge across different types even when similar', () => {
    const a = parseMemoryDoc(doc({ name: 'x', type: 'project', body: 'identical token efficiency body content here' }), 'x.md');
    const b = parseMemoryDoc(doc({ name: 'y', type: 'feedback', body: 'identical token efficiency body content here' }), 'y.md');
    const out = distillCandidates([a, b]);
    expect(out.mergeCandidates).toHaveLength(0);
  });

  it('flags contradiction pairs as hypotheses (never auto-merge)', () => {
    const a = parseMemoryDoc(doc({ name: 'c-a', type: 'project', body: 'use playwright mcp for visual testing always' }), 'c-a.md');
    const b = parseMemoryDoc(doc({ name: 'c-b', type: 'project', body: 'playwright mcp is deprecated, replaced for visual testing' }), 'c-b.md');
    const out = distillCandidates([a, b]);
    expect(out.contradictCandidates.length).toBeGreaterThanOrEqual(1);
    expect(out.contradictCandidates[0].kind).toBe('contradict');
  });

  it('marks stale unreferenced singletons as archive candidates', () => {
    const old = parseMemoryDoc(doc({ name: 'old', type: 'project', body: 'one-off note 2020-01-01 never referenced' }), 'old.md');
    const now = () => Date.parse('2026-05-30T00:00:00Z');
    const out = distillCandidates([old], { now });
    expect(out.archiveCandidates).toHaveLength(1);
    expect(out.archiveCandidates[0].kind).toBe('archive');
  });

  it('does NOT archive a referenced memory', () => {
    const target = parseMemoryDoc(doc({ name: 'kept', type: 'project', body: 'old note 2020-01-01' }), 'kept.md');
    const referrer = parseMemoryDoc(doc({ name: 'ref', type: 'feedback', body: 'see [[kept]] for context', extraLink: '' }), 'ref.md');
    const now = () => Date.parse('2026-05-30T00:00:00Z');
    const out = distillCandidates([target, referrer], { now });
    expect(out.archiveCandidates).toHaveLength(0);
  });

  it('resolveDistillConfig applies safe defaults', () => {
    expect(resolveDistillConfig({}).mergeThreshold).toBe(0.82);
    expect(resolveDistillConfig({ learning: { dream: { distill: { mergeThreshold: 0.9 } } } }).mergeThreshold).toBe(0.9);
    expect(resolveDistillConfig({ learning: { dream: { distill: { mergeThreshold: 5 } } } }).mergeThreshold).toBe(0.82);
  });

  it('writeCandidates writes only to staging dir', async () => {
    const staging = path.join(tmpDir, '.dream-staging');
    const out = distillCandidates([]);
    const written = await writeCandidates(staging, out);
    expect(written).toBe(path.join(staging, 'candidates.json'));
    const parsed = JSON.parse(await fs.readFile(written, 'utf-8'));
    expect(parsed).toHaveProperty('mergeCandidates');
  });
});

// ---------------------------------------------------------------------------
// Promote-MD gating
// ---------------------------------------------------------------------------

describe('evaluateProposal', () => {
  const cfg = resolvePromoteConfig({});

  it('discards proposals without evidence (acceptance #3)', () => {
    const r = evaluateProposal({ op: 'insert', evidence: [], confidence: 0.99 }, cfg);
    expect(r.passes).toBe(false);
    expect(r.reason).toBe('no-evidence');
  });

  it('rejects below confidence floor', () => {
    const r = evaluateProposal({
      op: 'merge', confidence: 0.5,
      evidence: [{ source: 'a.md', originSessionId: 's1' }, { source: 'b.md', originSessionId: 's2' }],
    }, cfg);
    expect(r.passes).toBe(false);
    expect(r.reason).toBe('below-confidence');
  });

  it('passes when evidence, occurrences, sessions and confidence all clear', () => {
    const r = evaluateProposal({
      op: 'merge', confidence: 0.9,
      evidence: [
        { source: 'a.md', originSessionId: 's1', quote: 'x' },
        { source: 'b.md', originSessionId: 's2', quote: 'y' },
      ],
    }, cfg);
    expect(r.passes).toBe(true);
    expect(r.occurrences).toBe(2);
    expect(r.distinctSessions).toBe(2);
  });
});

describe('createPromoteMd', () => {
  it('requires stagingDir and rejectionsPath', () => {
    expect(() => createPromoteMd({})).toThrow();
    expect(() => createPromoteMd({ stagingDir: tmpDir })).toThrow();
  });

  it('stages passing proposals as <slug>.proposed.md with evidence frontmatter', async () => {
    const staging = path.join(tmpDir, '.dream-staging');
    const engine = createPromoteMd({
      stagingDir: staging,
      rejectionsPath: path.join(tmpDir, 'rej.json'),
      ledgerPath: path.join(tmpDir, 'ledger.log'),
      now: () => 1000,
    });
    const { staged, skipped } = await engine.promote([{
      op: 'insert', name: 'new-insight', type: 'project', scope: 'release-flow',
      confidence: 0.9, body: 'Always sync README on release.',
      evidence: [
        { source: 'a.md', originSessionId: 's1', quote: 'readme drift' },
        { source: 'b.md', originSessionId: 's2', quote: 'readme drift again' },
      ],
    }]);
    expect(staged).toHaveLength(1);
    expect(skipped).toHaveLength(0);
    const text = await fs.readFile(path.join(staging, 'new-insight.proposed.md'), 'utf-8');
    const rec = parseMemoryDoc(text, 'new-insight.proposed.md');
    expect(rec.metadata.scope).toBe('release-flow');
    expect(rec.metadata.confidence).toBe('0.9');
    expect(rec.body).toContain('Dream evidence');
  });

  it('does not re-stage a rejected proposal within window', async () => {
    const staging = path.join(tmpDir, '.dream-staging');
    const opts = {
      stagingDir: staging,
      rejectionsPath: path.join(tmpDir, 'rej2.json'),
      now: () => Date.parse('2026-05-01T00:00:00Z'),
    };
    const proposal = {
      op: 'merge', name: 'merged', type: 'project', confidence: 0.9,
      body: 'merged body',
      evidence: [
        { source: 'a.md', originSessionId: 's1' },
        { source: 'b.md', originSessionId: 's2' },
      ],
    };
    const e1 = createPromoteMd(opts);
    await e1.registerRejection(proposal, 'user-declined');
    const e2 = createPromoteMd(opts);
    const { staged, skipped } = await e2.promote([proposal]);
    expect(staged).toHaveLength(0);
    expect(skipped[0].reason).toBe('recent-rejection');
  });
});

// ---------------------------------------------------------------------------
// NON-DESTRUCTIVE FULL RUN (acceptance #1, #10): collector + distiller +
// promote-md over a fixture memoryDir → input file hashes unchanged.
// ---------------------------------------------------------------------------

describe('non-destructive full engine run', () => {
  it('leaves every input memory file byte-identical', async () => {
    const memDir = path.join(tmpDir, 'memory');
    await fs.mkdir(memDir, { recursive: true });
    await writeMemory(memDir, 'dup-a.md', doc({ name: 'dup-a', type: 'project', body: 'nightly trainer schedule cron registration', session: 's1' }));
    await writeMemory(memDir, 'dup-b.md', doc({ name: 'dup-b', type: 'project', body: 'nightly trainer schedule cron registration', session: 's2' }));
    await fs.writeFile(path.join(memDir, 'MEMORY.md'),
      '# Project Memory\n\n- [dup-a](dup-a.md) — hook\n- [dup-b](dup-b.md) — hook\n', 'utf-8');

    const before = await hashAll(memDir);

    const collector = createCollector({ memoryDir: memDir });
    const { memories } = await collector.collect();
    const candidates = distillCandidates(memories);
    const staging = path.join(memDir, '.dream-staging');
    await writeCandidates(staging, candidates);

    const engine = createPromoteMd({
      stagingDir: staging,
      rejectionsPath: path.join(memDir, '.dream-staging', 'rej.json'),
      now: () => 1000,
    });
    await engine.promote([{
      op: 'merge', name: 'merged-nightly', type: 'project', confidence: 0.9,
      body: 'merged', targets: candidates.mergeCandidates[0]?.targets,
      evidence: [
        { source: 'dup-a.md', originSessionId: 's1', quote: 'cron' },
        { source: 'dup-b.md', originSessionId: 's2', quote: 'cron' },
      ],
    }]);

    const after = await hashAll(memDir);
    // The source .md files must be byte-identical; only .dream-staging is new.
    expect(after['dup-a.md']).toBe(before['dup-a.md']);
    expect(after['dup-b.md']).toBe(before['dup-b.md']);
    expect(after['MEMORY.md']).toBe(before['MEMORY.md']);
    const top = await fs.readdir(memDir);
    expect(top.filter((f) => f.endsWith('.md')).sort())
      .toEqual(['MEMORY.md', 'dup-a.md', 'dup-b.md']);
  });
});
