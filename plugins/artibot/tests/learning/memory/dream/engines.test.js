import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createCollector } from '../../../../lib/learning/memory/dream/collector.js';
import {
  distillCandidates,
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

// Collector unit tests → collector.test.js · Distiller unit tests →
// distiller.test.js (split per-module so the stop-review-gate's filename-stem
// test detection finds them). This file keeps the cross-module integration
// tests (promote-md gating + the non-destructive full engine run).

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
