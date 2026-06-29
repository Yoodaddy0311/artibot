import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  distillCandidates,
  resolveDistillConfig,
  writeCandidates,
} from '../../../../lib/learning/memory/dream/distiller.js';
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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-distiller-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

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

  it('resolveDistillConfig exposes freshnessThreshold with safe defaults (F-08 D2)', () => {
    expect(resolveDistillConfig({}).freshnessThreshold).toBe(0.3);
    expect(resolveDistillConfig({ learning: { dream: { distill: { freshnessThreshold: 0.5 } } } }).freshnessThreshold).toBe(0.5);
    // out-of-range → clamp back to default
    expect(resolveDistillConfig({ learning: { dream: { distill: { freshnessThreshold: 9 } } } }).freshnessThreshold).toBe(0.3);
  });

  // --- F-08 D2: freshness protection from recent-conversation signals --------

  it('protects a stale memory whose terms appear in recent signals (freshness)', () => {
    const stale = parseMemoryDoc(doc({ name: 'topic', type: 'project', body: 'nightly trainer schedule cron registration os scheduler 2020-01-01' }), 'topic.md');
    const now = () => Date.parse('2026-05-30T00:00:00Z');
    const signals = [{
      kind: 'ledger', source: 's1.jsonl',
      text: 'how should we change the nightly trainer schedule cron registration os scheduler',
    }];
    const out = distillCandidates([stale], { now, signals });
    expect(out.archiveCandidates).toHaveLength(0);
  });

  it('still archives a stale memory unrelated to the recent signals', () => {
    const stale = parseMemoryDoc(doc({ name: 'old', type: 'project', body: 'one-off note 2020-01-01 never referenced legacy' }), 'old.md');
    const now = () => Date.parse('2026-05-30T00:00:00Z');
    const signals = [{
      kind: 'ledger', source: 's1.jsonl',
      text: 'discussing react component accessibility and responsive design today',
    }];
    const out = distillCandidates([stale], { now, signals });
    expect(out.archiveCandidates).toHaveLength(1);
    expect(out.archiveCandidates[0].kind).toBe('archive');
  });

  it('is a no-op when signals are absent (regression guard)', () => {
    const stale = parseMemoryDoc(doc({ name: 'old', type: 'project', body: 'one-off note 2020-01-01 never referenced' }), 'old.md');
    const now = () => Date.parse('2026-05-30T00:00:00Z');
    const baseline = distillCandidates([stale], { now });
    const withUndefined = distillCandidates([stale], { now, signals: undefined });
    const withEmpty = distillCandidates([stale], { now, signals: [] });
    expect(baseline.archiveCandidates).toHaveLength(1);
    expect(withUndefined.archiveCandidates).toEqual(baseline.archiveCandidates);
    expect(withEmpty.archiveCandidates).toEqual(baseline.archiveCandidates);
  });

  it('honors a custom freshnessThreshold boundary', () => {
    const stale = parseMemoryDoc(doc({ name: 'topic', type: 'project', body: 'alpha beta gamma delta epsilon 2020-01-01' }), 'topic.md');
    const now = () => Date.parse('2026-05-30T00:00:00Z');
    const signals = [{ kind: 'ledger', source: 's1.jsonl', text: 'alpha beta gamma delta epsilon' }];
    // High threshold (1.0) → partial overlap < 1.0 → NOT protected → archived
    const strict = distillCandidates([stale], {
      now, signals, config: { learning: { dream: { distill: { freshnessThreshold: 1 } } } },
    });
    // Low threshold (0.01) → any overlap protects → kept fresh
    const loose = distillCandidates([stale], {
      now, signals, config: { learning: { dream: { distill: { freshnessThreshold: 0.01 } } } },
    });
    expect(strict.archiveCandidates).toHaveLength(1);
    expect(loose.archiveCandidates).toHaveLength(0);
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
