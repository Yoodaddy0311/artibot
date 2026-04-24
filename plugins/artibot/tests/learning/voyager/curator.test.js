import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  _testing,
  createCurator,
  extractFrame,
  groupByPattern,
  scoreCandidates,
} from '../../../lib/learning/voyager/curator.js';
import {
  generateSkillDraft,
  listTemplateSections,
  refineDraft,
} from '../../../lib/learning/voyager/iterative-prompter.js';
import { VERDICTS } from '../../../lib/learning/voyager/self-verifier.js';

// ---------------------------------------------------------------------------
// Mock episodic store — in-memory list with the public `listEpisodes` shape.
// ---------------------------------------------------------------------------

function mockEpisodicStore(episodes) {
  return Object.freeze({
    listEpisodes: async () => episodes.slice(),
  });
}

function makeEpisode(overrides = {}) {
  return {
    id: `ep-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: overrides.sessionId || 's1',
    timestamp: overrides.timestamp || Date.now(),
    title: overrides.title || 'refactor module split',
    summary: overrides.summary || 'refactor the pricing module split into smaller files',
    keywords: overrides.keywords || ['refactor', 'module', 'pricing'],
    tools: overrides.tools || ['Read', 'Edit', 'Bash'],
    outcome: overrides.outcome || 'success',
    importanceScore: overrides.importanceScore ?? 0.5,
    ...overrides,
  };
}

async function makeTmpDirs() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voyager-curator-'));
  const skillsDir = path.join(root, 'skills');
  const stagingDir = path.join(root, 'runtime', 'voyager-staging');
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.mkdir(stagingDir, { recursive: true });
  return { root, skillsDir, stagingDir };
}

// ---------------------------------------------------------------------------

describe('voyager curator — pure helpers', () => {
  it('extractFrame returns null on non-object input', () => {
    expect(extractFrame(null)).toBeNull();
    expect(extractFrame(undefined)).toBeNull();
    expect(extractFrame('not-an-object')).toBeNull();
  });

  it('extractFrame derives intent tokens and tools', () => {
    const frame = extractFrame(makeEpisode({
      summary: 'refactor pricing module split smaller files',
      tools: ['Read', 'Edit'],
    }));
    expect(frame).not.toBeNull();
    expect(frame.tokens.length).toBeGreaterThan(0);
    expect(frame.tools).toContain('read');
    expect(frame.tools).toContain('edit');
    expect(frame.intent).toContain('refactor');
  });

  it('hashSignature is deterministic', () => {
    const a = _testing.hashSignature('intent|read,edit');
    const b = _testing.hashSignature('intent|read,edit');
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });

  it('jaccard returns 0 for disjoint sets and 1 for identical sets', () => {
    expect(_testing.jaccard([], [])).toBe(0);
    expect(_testing.jaccard(['a', 'b'], ['c', 'd'])).toBe(0);
    expect(_testing.jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    const partial = _testing.jaccard(['a', 'b'], ['a', 'c']);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
  });
});

describe('groupByPattern', () => {
  it('clusters frames that share tool/intent features', () => {
    const frames = [1, 2, 3, 4].map((i) =>
      extractFrame(makeEpisode({
        sessionId: `s${i}`,
        summary: 'refactor pricing module split smaller files',
        tools: ['Read', 'Edit', 'Bash'],
      })),
    ).filter(Boolean);
    const clusters = groupByPattern(frames);
    expect(clusters.length).toBe(1);
    expect(clusters[0].frames.length).toBe(4);
    expect(clusters[0].signature).toHaveLength(12);
  });

  it('keeps unrelated frames in separate clusters', () => {
    const frames = [
      extractFrame(makeEpisode({ summary: 'refactor pricing module split files', tools: ['Read', 'Edit'] })),
      extractFrame(makeEpisode({ summary: 'run full test suite coverage check', tools: ['Bash', 'Grep'] })),
    ].filter(Boolean);
    const clusters = groupByPattern(frames, { similarityThreshold: 0.6 });
    expect(clusters.length).toBe(2);
  });

  it('is deterministic across invocations', () => {
    const frames = [1, 2, 3].map((i) =>
      extractFrame(makeEpisode({ sessionId: `s${i}`, summary: 'deploy staging run tests' })),
    ).filter(Boolean);
    const a = groupByPattern(frames).map((c) => c.signature);
    const b = groupByPattern(frames).map((c) => c.signature);
    expect(a).toEqual(b);
  });
});

describe('scoreCandidates', () => {
  it('filters clusters below minOccurrences', () => {
    const frames = [extractFrame(makeEpisode())].filter(Boolean);
    const clusters = groupByPattern(frames);
    const scored = scoreCandidates(clusters, { minOccurrences: 5 });
    expect(scored).toHaveLength(0);
  });

  it('sorts surviving clusters by descending score', () => {
    const now = Date.now();
    const high = [1, 2, 3, 4, 5, 6].map((i) =>
      extractFrame(makeEpisode({
        sessionId: `a${i}`,
        timestamp: now - i * 1000,
        summary: 'deploy staging tests pass',
        tools: ['Bash', 'Read'],
      })),
    ).filter(Boolean);
    const low = [1, 2, 3, 4, 5].map(() =>
      extractFrame(makeEpisode({
        sessionId: 'same-session',
        timestamp: now - 29 * 24 * 60 * 60 * 1000,
        summary: 'lint cleanup sometimes maybe',
        tools: ['Grep'],
      })),
    ).filter(Boolean);

    const clusters = groupByPattern([...high, ...low]);
    const scored = scoreCandidates(clusters, { now, minOccurrences: 5 });
    expect(scored.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < scored.length; i += 1) {
      expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
    }
  });
});

describe('createCurator — end-to-end flow', () => {
  let root;
  let skillsDir;
  let stagingDir;

  beforeEach(async () => {
    ({ root, skillsDir, stagingDir } = await makeTmpDirs());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function buildCurator({ now, episodes } = {}) {
    const store = mockEpisodicStore(episodes || []);
    return createCurator({
      episodicStore: store,
      skillRegistryPath: skillsDir,
      stagingDir,
      minOccurrences: 3,
      cooldownDays: 30,
      maxProposals: 3,
      now: now ? () => now : undefined,
    });
  }

  it('throws when required options are missing', () => {
    expect(() => createCurator()).toThrow(/requires options/);
    expect(() => createCurator({})).toThrow(/episodicStore/);
    expect(() => createCurator({ episodicStore: {} })).toThrow(/listEpisodes/);
    expect(() => createCurator({ episodicStore: mockEpisodicStore([]) })).toThrow(/skillRegistryPath/);
    expect(() => createCurator({
      episodicStore: mockEpisodicStore([]),
      skillRegistryPath: skillsDir,
    })).toThrow(/stagingDir/);
  });

  it('analyzeEpisodes filters by the time window', async () => {
    const now = Date.UTC(2026, 3, 20);
    const recent = makeEpisode({ timestamp: now - 1000 });
    const old = makeEpisode({ timestamp: now - 60 * 24 * 60 * 60 * 1000 });
    const curator = buildCurator({ now, episodes: [recent, old] });
    const frames = await curator.analyzeEpisodes({ sinceDays: 14 });
    expect(frames).toHaveLength(1);
  });

  it('proposeSkill writes a staging draft with frontmatter + metadata block', async () => {
    const now = Date.UTC(2026, 3, 20);
    const eps = [1, 2, 3, 4].map((i) => makeEpisode({
      sessionId: `s${i}`,
      timestamp: now - i * 1000,
      summary: 'refactor pricing module split files',
      tools: ['Read', 'Edit', 'Bash'],
    }));
    const curator = buildCurator({ now, episodes: eps });
    const frames = await curator.analyzeEpisodes({ sinceDays: 14 });
    const clusters = curator.groupByPattern(frames);
    const scored = curator.scoreCandidates(clusters, { now, minOccurrences: 3 });
    expect(scored.length).toBe(1);

    const result = await curator.proposeSkill(scored[0]);
    expect(result.proposed).toBe(true);
    const body = await fs.readFile(result.filePath, 'utf-8');
    expect(body).toContain('---');
    expect(body).toContain('context: proposal');
    expect(body).toContain('Voyager Metadata');
    expect(body).toContain(scored[0].signature);
  });

  it('proposeFromClusters respects maxProposals', async () => {
    const now = Date.UTC(2026, 3, 20);
    const clusterOne = [1, 2, 3, 4].map((i) => makeEpisode({
      sessionId: `a${i}`,
      timestamp: now - i * 1000,
      summary: 'refactor pricing module split files',
      tools: ['Read', 'Edit'],
    }));
    const clusterTwo = [1, 2, 3, 4].map((i) => makeEpisode({
      sessionId: `b${i}`,
      timestamp: now - i * 1500,
      summary: 'deploy staging tests pass green',
      tools: ['Bash'],
    }));
    const clusterThree = [1, 2, 3, 4].map((i) => makeEpisode({
      sessionId: `c${i}`,
      timestamp: now - i * 2000,
      summary: 'document api reference jsdoc examples',
      tools: ['Read', 'Grep'],
    }));
    const clusterFour = [1, 2, 3, 4].map((i) => makeEpisode({
      sessionId: `d${i}`,
      timestamp: now - i * 2500,
      summary: 'lint fix unused imports remove',
      tools: ['Grep', 'Edit'],
    }));

    const curator = buildCurator({
      now,
      episodes: [...clusterOne, ...clusterTwo, ...clusterThree, ...clusterFour],
    });
    const frames = await curator.analyzeEpisodes({ sinceDays: 14 });
    const clusters = curator.groupByPattern(frames);
    const scored = curator.scoreCandidates(clusters, { now, minOccurrences: 3 });
    const results = await curator.proposeFromClusters(scored);
    expect(results.length).toBeLessThanOrEqual(3);
    for (const r of results) {
      expect(r.proposed).toBe(true);
    }
  });

  it('listProposals reads staged drafts back', async () => {
    const now = Date.UTC(2026, 3, 20);
    const eps = [1, 2, 3, 4].map((i) => makeEpisode({
      sessionId: `s${i}`,
      timestamp: now - i * 1000,
      summary: 'refactor payments module split',
      tools: ['Read', 'Edit'],
    }));
    const curator = buildCurator({ now, episodes: eps });
    const frames = await curator.analyzeEpisodes({ sinceDays: 14 });
    const clusters = curator.groupByPattern(frames);
    const scored = curator.scoreCandidates(clusters, { now, minOccurrences: 3 });
    await curator.proposeFromClusters(scored);

    const proposals = await curator.listProposals();
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    expect(proposals[0]).toHaveProperty('signature');
    expect(proposals[0]).toHaveProperty('filePath');
    expect(proposals[0]).toHaveProperty('skillName');
  });

  it('approveProposal promotes into skills/ and removes staging file', async () => {
    const now = Date.UTC(2026, 3, 20);
    const eps = [1, 2, 3, 4].map((i) => makeEpisode({
      sessionId: `s${i}`,
      timestamp: now - i * 1000,
      summary: 'automate release tagging semver bump',
      tools: ['Bash', 'Edit'],
    }));
    const curator = buildCurator({ now, episodes: eps });
    const frames = await curator.analyzeEpisodes({ sinceDays: 14 });
    const clusters = curator.groupByPattern(frames);
    const scored = curator.scoreCandidates(clusters, { now, minOccurrences: 3 });
    const [proposed] = await curator.proposeFromClusters(scored);
    expect(proposed.proposed).toBe(true);

    const approval = await curator.approveProposal(proposed.signature);
    expect(approval.approved).toBe(true);

    const target = await fs.readFile(approval.targetFile, 'utf-8');
    expect(target).toContain('context: fork');
    // Staging file should be gone.
    await expect(fs.access(proposed.filePath)).rejects.toBeTruthy();
  });

  it('approveProposal returns invalid-signature for empty input', async () => {
    const curator = buildCurator({});
    expect((await curator.approveProposal()).approved).toBe(false);
    expect((await curator.approveProposal('')).approved).toBe(false);
  });

  it('approveProposal refuses duplicate skill names', async () => {
    const now = Date.UTC(2026, 3, 20);
    const eps = [1, 2, 3, 4].map((i) => makeEpisode({
      sessionId: `s${i}`,
      timestamp: now - i * 1000,
      summary: 'dedupe skill name conflict test',
      tools: ['Bash'],
    }));
    const curator = buildCurator({ now, episodes: eps });
    const frames = await curator.analyzeEpisodes({ sinceDays: 14 });
    const clusters = curator.groupByPattern(frames);
    const scored = curator.scoreCandidates(clusters, { now, minOccurrences: 3 });
    const [proposed] = await curator.proposeFromClusters(scored);
    const first = await curator.approveProposal(proposed.signature);
    expect(first.approved).toBe(true);

    // Re-create a fresh draft at the same signature.
    await fs.mkdir(stagingDir, { recursive: true });
    await fs.writeFile(
      path.join(stagingDir, `voyager-proposal-${proposed.signature}.md`),
      `---\nname: ${first.skillName}\n---\n# body`,
      'utf-8',
    );
    const second = await curator.approveProposal(proposed.signature);
    expect(second.approved).toBe(false);
    expect(second.reason).toBe('skill-already-exists');
  });

  it('rejectProposal deletes staging and records cooldown', async () => {
    const now = Date.UTC(2026, 3, 20);
    const eps = [1, 2, 3, 4].map((i) => makeEpisode({
      sessionId: `s${i}`,
      timestamp: now - i * 1000,
      summary: 'cooldown behaviour test reject flow',
      tools: ['Bash'],
    }));
    const curator = buildCurator({ now, episodes: eps });
    const frames = await curator.analyzeEpisodes({ sinceDays: 14 });
    const clusters = curator.groupByPattern(frames);
    const scored = curator.scoreCandidates(clusters, { now, minOccurrences: 3 });
    const [proposed] = await curator.proposeFromClusters(scored);

    const res = await curator.rejectProposal(proposed.signature, 'dup');
    expect(res.rejected).toBe(true);
    await expect(fs.access(proposed.filePath)).rejects.toBeTruthy();

    // Re-running proposal for the same cluster should be blocked by cooldown.
    const retry = await curator.proposeSkill(scored[0]);
    expect(retry.proposed).toBe(false);
    expect(retry.reason).toBe('cooldown');
  });

  it('rejectProposal returns invalid-signature for empty input', async () => {
    const curator = buildCurator({});
    const r = await curator.rejectProposal('');
    expect(r.rejected).toBe(false);
  });
});

describe('iterative-prompter', () => {
  it('generateSkillDraft produces deterministic output', () => {
    const cluster = {
      signature: 'abc123456789',
      exampleIntent: 'refactor pricing module',
      toolUnion: ['read', 'edit'],
      frames: [
        { intent: 'refactor pricing module', sessionId: 's1', timestamp: 1000, tools: ['read'], tokens: [], success: true },
      ],
    };
    const a = generateSkillDraft(cluster, ['refactor-cleaner', 'unrelated']);
    const b = generateSkillDraft(cluster, ['refactor-cleaner', 'unrelated']);
    expect(a).toBe(b);
    expect(a).toContain('## When This Skill Applies');
    expect(a).toContain('## Process');
    expect(a).toContain('## Anti-Patterns');
    expect(a).toContain('## Output Format');
  });

  it('generateSkillDraft handles missing cluster gracefully', () => {
    const out = generateSkillDraft(null);
    expect(out).toContain('invalid cluster');
  });

  it('refineDraft merges feedback into named sections', () => {
    const cluster = {
      signature: 'sig000000000',
      exampleIntent: 'test intent here',
      toolUnion: ['read'],
      frames: [{ intent: 'test intent here', sessionId: 's', timestamp: 1, tools: ['read'], tokens: [], success: true }],
    };
    const draft = generateSkillDraft(cluster, []);
    const refined = refineDraft(draft, { process: 'Step A\nStep B' });
    expect(refined).toContain('Step A');
    expect(refined).toContain('Step B');
  });

  it('refineDraft ignores unknown keys and empty values', () => {
    const draft = '# title\n\n## Process\n\nold\n';
    const sameA = refineDraft(draft, { unknown: 'x' });
    const sameB = refineDraft(draft, { process: '' });
    expect(sameA).toBe(draft);
    expect(sameB).toBe(draft);
  });

  it('listTemplateSections returns the frozen template key list', () => {
    const keys = listTemplateSections();
    expect(keys).toContain('process');
    expect(keys).toContain('anti-patterns');
  });
});

// ---------------------------------------------------------------------------
// Self-verification pre-flight (v3.4.0+)
// ---------------------------------------------------------------------------

describe('createCurator — self-verification pre-flight', () => {
  let root;
  let skillsDir;
  let stagingDir;
  let curriculumLogPath;

  beforeEach(async () => {
    ({ root, skillsDir, stagingDir } = await makeTmpDirs());
    curriculumLogPath = path.join(root, 'runtime', 'voyager-curriculum.jsonl');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function buildCurator({ now, episodes, selfVerifier, config } = {}) {
    const store = mockEpisodicStore(episodes || []);
    return createCurator({
      episodicStore: store,
      skillRegistryPath: skillsDir,
      stagingDir,
      minOccurrences: 3,
      cooldownDays: 30,
      maxProposals: 3,
      now: now ? () => now : undefined,
      selfVerifier,
      config,
      curriculumLogPath,
    });
  }

  it('accepts a proposal when the verifier returns accept', async () => {
    const now = Date.UTC(2026, 3, 20);
    const eps = [1, 2, 3, 4].map((i) => makeEpisode({
      sessionId: `s${i}`,
      timestamp: now - i * 1000,
      summary: 'refactor pricing module split files',
      tools: ['Read', 'Edit', 'Bash'],
    }));
    const verifier = {
      enabled: true,
      verifyProposal: async () => ({
        verdict: VERDICTS.ACCEPT,
        score: 0.9,
        reasons: ['pass-ratio 1.00 >= 0.7'],
      }),
    };
    const curator = buildCurator({ now, episodes: eps, selfVerifier: verifier });
    const frames = await curator.analyzeEpisodes({ sinceDays: 14 });
    const clusters = curator.groupByPattern(frames);
    const scored = curator.scoreCandidates(clusters, { now, minOccurrences: 3 });
    const [result] = await curator.proposeFromClusters(scored);
    expect(result.proposed).toBe(true);
    expect(result.preflightVerdict).toBe(VERDICTS.ACCEPT);
    expect(result.preflightScore).toBeCloseTo(0.9, 5);
  });

  it('auto-rejects the proposal when the verifier returns reject', async () => {
    const now = Date.UTC(2026, 3, 20);
    const eps = [1, 2, 3, 4].map((i) => makeEpisode({
      sessionId: `s${i}`,
      timestamp: now - i * 1000,
      summary: 'totally unrelated noise tokens',
      tools: ['Bash'],
    }));
    const verifier = {
      enabled: true,
      verifyProposal: async () => ({
        verdict: VERDICTS.REJECT,
        score: 0.2,
        reasons: ['fail-ratio 0.80 >= 0.5', 'worst-episode-score 0.100'],
      }),
    };
    const curator = buildCurator({ now, episodes: eps, selfVerifier: verifier });
    const frames = await curator.analyzeEpisodes({ sinceDays: 14 });
    const clusters = curator.groupByPattern(frames);
    const scored = curator.scoreCandidates(clusters, { now, minOccurrences: 3 });
    const [result] = await curator.proposeFromClusters(scored);
    expect(result.proposed).toBe(false);
    expect(result.reason).toBe('self-verify-fail');
    expect(result.preflightVerdict).toBe(VERDICTS.REJECT);

    // Staging file must NOT exist.
    const expectedPath = path.join(
      stagingDir,
      `voyager-proposal-${result.signature}.md`,
    );
    await expect(fs.access(expectedPath)).rejects.toBeTruthy();

    // Curriculum log must contain an auto-reject line with self-verify-fail reason.
    const raw = await fs.readFile(curriculumLogPath, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const record = JSON.parse(lines[lines.length - 1]);
    expect(record.kind).toBe('rejection');
    expect(record.reason).toContain('self-verify-fail');
  });

  it('annotates review verdicts in the staged metadata block', async () => {
    const now = Date.UTC(2026, 3, 20);
    const eps = [1, 2, 3, 4].map((i) => makeEpisode({
      sessionId: `s${i}`,
      timestamp: now - i * 1000,
      summary: 'refactor pricing module split files borderline',
      tools: ['Read', 'Edit'],
    }));
    const verifier = {
      enabled: true,
      verifyProposal: async () => ({
        verdict: VERDICTS.REVIEW,
        score: 0.55,
        reasons: ['pass-ratio 0.50 between 0.5 and 0.7'],
      }),
    };
    const curator = buildCurator({ now, episodes: eps, selfVerifier: verifier });
    const frames = await curator.analyzeEpisodes({ sinceDays: 14 });
    const clusters = curator.groupByPattern(frames);
    const scored = curator.scoreCandidates(clusters, { now, minOccurrences: 3 });
    const [result] = await curator.proposeFromClusters(scored);
    expect(result.proposed).toBe(true);
    expect(result.preflightVerdict).toBe(VERDICTS.REVIEW);

    const body = await fs.readFile(result.filePath, 'utf-8');
    expect(body).toContain('"preflightVerdict": "review"');
    expect(body).toContain('"preflightScore": 0.55');
  });

  it('falls back to review if the verifier throws', async () => {
    const now = Date.UTC(2026, 3, 20);
    const eps = [1, 2, 3, 4].map((i) => makeEpisode({
      sessionId: `s${i}`,
      timestamp: now - i * 1000,
      summary: 'refactor pricing module split files again',
      tools: ['Read', 'Edit'],
    }));
    const verifier = {
      enabled: true,
      verifyProposal: async () => { throw new Error('boom'); },
    };
    const curator = buildCurator({ now, episodes: eps, selfVerifier: verifier });
    const frames = await curator.analyzeEpisodes({ sinceDays: 14 });
    const clusters = curator.groupByPattern(frames);
    const scored = curator.scoreCandidates(clusters, { now, minOccurrences: 3 });
    const [result] = await curator.proposeFromClusters(scored);
    expect(result.proposed).toBe(true); // review → still proposes
    expect(result.preflightVerdict).toBe(VERDICTS.REVIEW);

    const body = await fs.readFile(result.filePath, 'utf-8');
    expect(body).toContain('verifier-error');
  });

  it('bypasses self-verification when config.learning.voyager.selfVerify is false', async () => {
    const now = Date.UTC(2026, 3, 20);
    const eps = [1, 2, 3, 4].map((i) => makeEpisode({
      sessionId: `s${i}`,
      timestamp: now - i * 1000,
      summary: 'opt-out path test data',
      tools: ['Bash'],
    }));
    const curator = buildCurator({
      now,
      episodes: eps,
      config: { learning: { voyager: { selfVerify: false } } },
    });
    expect(curator._internals.selfVerifyEnabled).toBe(false);
    const frames = await curator.analyzeEpisodes({ sinceDays: 14 });
    const clusters = curator.groupByPattern(frames);
    const scored = curator.scoreCandidates(clusters, { now, minOccurrences: 3 });
    const [result] = await curator.proposeFromClusters(scored);
    expect(result.proposed).toBe(true);
    expect(result.preflightVerdict).toBe(null);
  });

  it('defaults selfVerify to true when config is omitted', async () => {
    const curator = buildCurator({});
    expect(curator._internals.selfVerifyEnabled).toBe(true);
  });
});
