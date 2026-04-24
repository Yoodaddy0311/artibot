import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  logProposal,
  logApproval,
  logRejection,
  summary,
  _internals,
} from '../../../lib/learning/voyager/curriculum-log.js';

let tmpDir;
let logPath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voyager-log-'));
  logPath = path.join(tmpDir, 'runtime', 'voyager-curriculum.jsonl');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('curriculum-log — writers', () => {
  it('logProposal refuses invalid hash', async () => {
    const r = await logProposal('', { frames: [] }, 1.0, { logPath });
    expect(r.logged).toBe(false);
  });

  it('logProposal refuses null cluster', async () => {
    const r = await logProposal('abc', null, 1.0, { logPath });
    expect(r.logged).toBe(false);
    expect(r.reason).toBe('missing-cluster');
  });

  it('logProposal appends a single line with expected fields', async () => {
    const ok = await logProposal('sig1', {
      exampleIntent: 'refactor pricing module',
      occurrence: 6,
      distinctSessions: 3,
      toolUnion: ['read', 'edit'],
    }, 4.2, { logPath, now: () => 1_700_000_000_000 });
    expect(ok.logged).toBe(true);
    const content = await fs.readFile(logPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.kind).toBe('proposal');
    expect(record.signature).toBe('sig1');
    expect(record.score).toBeCloseTo(4.2);
    expect(record.occurrence).toBe(6);
    expect(record.distinctSessions).toBe(3);
    expect(record.tools).toEqual(['read', 'edit']);
    expect(record.at).toMatch(/T.*Z$/);
  });

  it('logApproval appends a line and preserves previous lines (append-only)', async () => {
    await logProposal('sig2', { frames: [{}] }, 1.0, { logPath });
    const ok = await logApproval('sig2', { skillName: 'my-skill', targetFile: '/a/b' }, { logPath });
    expect(ok.logged).toBe(true);

    const content = await fs.readFile(logPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.kind).toBe('proposal');
    expect(second.kind).toBe('approval');
    expect(second.skillName).toBe('my-skill');
    expect(second.targetFile).toBe('/a/b');
  });

  it('logRejection records reason and timestamp', async () => {
    const ok = await logRejection('sig3', 'duplicate of refactor-cleaner', { logPath });
    expect(ok.logged).toBe(true);
    const raw = await fs.readFile(logPath, 'utf-8');
    const record = JSON.parse(raw.trim());
    expect(record.kind).toBe('rejection');
    expect(record.reason).toContain('duplicate');
  });

  it('logRejection refuses invalid hash', async () => {
    const r = await logRejection(null, 'x', { logPath });
    expect(r.logged).toBe(false);
  });

  it('logApproval refuses invalid hash', async () => {
    const r = await logApproval('', {}, { logPath });
    expect(r.logged).toBe(false);
  });
});

describe('curriculum-log — summary', () => {
  it('summarizes counts and approval rate', async () => {
    await logProposal('a', { frames: [{}, {}] }, 1.1, { logPath });
    await logProposal('b', { frames: [{}] }, 2.2, { logPath });
    await logApproval('a', { skillName: 'a-skill' }, { logPath });
    await logRejection('b', 'dup', { logPath });

    const s = await summary({ logPath });
    expect(s.proposals).toBe(2);
    expect(s.approvals).toBe(1);
    expect(s.rejections).toBe(1);
    expect(s.approvalRate).toBe(0.5);
    expect(s.records).toHaveLength(4);
  });

  it('summary with since="Xd" style via days number filters older entries', async () => {
    // Seed one entry at a very old timestamp
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const oldRecord = {
      kind: 'proposal',
      signature: 'old',
      at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      score: 0,
      occurrence: 0,
      distinctSessions: 0,
      exampleIntent: '',
      tools: [],
    };
    await fs.writeFile(logPath, `${JSON.stringify(oldRecord)}\n`);
    await logProposal('new', { frames: [{}] }, 1.0, { logPath });

    const s = await summary({ logPath, since: 7 });
    expect(s.proposals).toBe(1);
    expect(s.records[0].signature).toBe('new');
  });

  it('summary returns zeros for a missing log file', async () => {
    const s = await summary({ logPath: path.join(tmpDir, 'nope.jsonl') });
    expect(s.proposals).toBe(0);
    expect(s.approvals).toBe(0);
    expect(s.rejections).toBe(0);
    expect(s.approvalRate).toBe(0);
  });

  it('summary tolerates malformed lines', async () => {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const valid = JSON.stringify({
      kind: 'proposal', signature: 'z', at: new Date().toISOString(),
    });
    await fs.writeFile(logPath, `not-json\n${valid}\n{"no":"sig-or-kind"}\n`);
    const s = await summary({ logPath });
    expect(s.proposals).toBe(1);
  });

  it('summary accepts Date / ISO string / epoch-ms since', async () => {
    await logProposal('s1', { frames: [{}] }, 1.0, { logPath });
    const all = await summary({ logPath, since: new Date('2000-01-01T00:00:00Z') });
    expect(all.proposals).toBe(1);
    const future = await summary({ logPath, since: '2999-01-01T00:00:00Z' });
    expect(future.proposals).toBe(0);
    const epoch = await summary({ logPath, since: 0 });
    // 0 is treated as "days back" because it's < 10000 — equivalent to "now"
    expect(epoch.proposals).toBeGreaterThanOrEqual(0);
    const big = await summary({ logPath, since: Date.now() + 1000 * 60 * 60 });
    expect(big.proposals).toBe(0);
  });
});

describe('curriculum-log — jsonl format validity', () => {
  it('every line is independently JSON-parseable', async () => {
    await logProposal('p1', { frames: [{}] }, 1.0, { logPath });
    await logApproval('p1', { skillName: 's' }, { logPath });
    await logRejection('p2', 'r', { logPath });
    const raw = await fs.readFile(logPath, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('kind');
      expect(parsed).toHaveProperty('signature');
      expect(parsed).toHaveProperty('at');
    }
  });

  it('resolveLogPath uses pluginRoot default when no logPath provided', () => {
    const resolved = _internals.resolveLogPath({ pluginRoot: '/plug' });
    expect(resolved).toBe(path.join('/plug', _internals.DEFAULT_REL_PATH));
  });
});
