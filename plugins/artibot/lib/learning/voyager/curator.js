/**
 * Voyager-style Skill Curator — MVP, LOCAL ONLY.
 *
 * Mines recent Episodic memory (see `lib/learning/memory/episodic.js`) for
 * recurring task frames, clusters them, scores candidates, and writes SKILL.md
 * drafts into a staging directory for user review. No automatic approval.
 *
 * Patterned after Voyager (MineDojo / NVIDIA 2023) — automatic curriculum +
 * iterative prompting + ever-growing skill library — but intentionally ported
 * with three HARD constraints that differ from the paper:
 *   1. All state stays on disk under `~/.claude/artibot/` or the project
 *      plugin directory. No network calls, no external DB, no external AI API.
 *   2. No automatic promotion. Every candidate requires explicit user action
 *      via `approveProposal()`. Rejection opens a 30-day cooldown on the same
 *      cluster signature (configurable).
 *   3. Voyager's executable-code skills are replaced by Artibot's declarative
 *      SKILL.md format (frontmatter + trigger words + process). No code
 *      execution sandbox — the skill body is guidance text for agents.
 *
 * Zero runtime deps. ESM only. Immutable-first (all returned records frozen).
 *
 * @module lib/learning/voyager/curator
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { atomicWriteJson, ensureDir, readJsonFile } from '../../core/file.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MIN_OCCURRENCES = 5;
const DEFAULT_SINCE_DAYS = 14;
const DEFAULT_COOLDOWN_DAYS = 30;
const DEFAULT_MAX_PROPOSALS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const PROPOSAL_FILE_PREFIX = 'voyager-proposal-';
const REJECTION_LEDGER_FILE = 'voyager-rejections.json';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function hashSignature(input) {
  return createHash('sha256').update(String(input || '')).digest('hex').slice(0, 12);
}

function normIntent(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTopTokens(text, limit = 8) {
  const freq = new Map();
  for (const tok of normIntent(text).split(' ')) {
    if (!tok || tok.length < 3) continue;
    freq.set(tok, (freq.get(tok) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([t]) => t);
}

function toToolSet(record) {
  const raw = record?.tools ?? record?.toolsUsed ?? record?.keywords ?? [];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((t) => String(t).toLowerCase()).filter(Boolean))].sort();
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/**
 * Extract a task frame from a raw episode record. Frames are the atomic unit
 * of clustering — an episode yields zero or one frame (no frame = skip).
 *
 * @param {object} episode
 * @returns {{intent: string, tokens: string[], tools: string[], success: boolean, sessionId: string, timestamp: number}|null}
 */
export function extractFrame(episode) {
  if (!episode || typeof episode !== 'object') return null;
  const summary = String(episode.summary ?? episode.title ?? '').trim();
  if (!summary) return null;
  const intent = normIntent(summary).slice(0, 240);
  if (intent.length < 6) return null;
  const tokens = extractTopTokens(summary);
  const tools = toToolSet(episode);
  const outcome = episode.outcome ?? episode.result ?? null;
  const success = outcome
    ? outcome === 'success' || outcome === true || outcome === 'pass'
    : episode.importanceScore === undefined
      ? true
      : Number(episode.importanceScore) >= 0;
  return Object.freeze({
    intent,
    tokens,
    tools,
    success,
    sessionId: String(episode.sessionId || 'unknown'),
    timestamp: Number(episode.timestamp) || 0,
  });
}

/**
 * Jaccard-based agglomerative clustering on (tokens ∪ tools). O(n^2) but
 * bounded because episodes are already pre-filtered by time window.
 *
 * @param {Array<object>} frames
 * @param {{similarityThreshold?: number}} [opts]
 * @returns {Array<{signature: string, frames: object[], toolUnion: string[], exampleIntent: string}>}
 */
export function groupByPattern(frames, opts = {}) {
  const threshold = typeof opts.similarityThreshold === 'number'
    ? opts.similarityThreshold
    : 0.45;
  const clusters = [];
  for (const frame of frames) {
    const featureBag = [...frame.tokens, ...frame.tools];
    let placed = false;
    for (const c of clusters) {
      const sim = jaccard(featureBag, c._feat);
      if (sim >= threshold) {
        c.frames.push(frame);
        for (const t of frame.tools) c._toolSet.add(t);
        c._feat = [...new Set([...c._feat, ...featureBag])];
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push({
        _feat: featureBag,
        _toolSet: new Set(frame.tools),
        frames: [frame],
        exampleIntent: frame.intent,
      });
    }
  }
  return clusters
    .filter((c) => c.frames.length > 0)
    .map((c) => {
      const toolUnion = [...c._toolSet].sort();
      const sig = hashSignature(`${c.exampleIntent}|${toolUnion.join(',')}`);
      return Object.freeze({
        signature: sig,
        frames: Object.freeze(c.frames.slice()),
        toolUnion: Object.freeze(toolUnion),
        exampleIntent: c.exampleIntent,
      });
    });
}

/**
 * Score clusters and rank. Score formula:
 *   occurrence * distinctSessionFactor * successRate * recencyBoost
 * All factors in [0, 1] except occurrence which is clipped to [0, 20].
 *
 * @param {Array<object>} clusters
 * @param {{now?: number, minOccurrences?: number}} [opts]
 * @returns {Array<object>}
 */
export function scoreCandidates(clusters, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const min = typeof opts.minOccurrences === 'number'
    ? opts.minOccurrences
    : DEFAULT_MIN_OCCURRENCES;
  const scored = clusters.map((c) => {
    const occ = Math.min(c.frames.length, 20);
    const sessions = new Set(c.frames.map((f) => f.sessionId));
    const distinctFactor = Math.min(sessions.size / 3, 1);
    const successRate = c.frames.length === 0
      ? 0
      : c.frames.filter((f) => f.success).length / c.frames.length;
    const latest = Math.max(...c.frames.map((f) => f.timestamp));
    const ageDays = latest > 0 ? (now - latest) / DAY_MS : 999;
    const recencyBoost = Math.max(0, 1 - ageDays / 30);
    const score = occ * distinctFactor * Math.max(successRate, 0.3) * Math.max(recencyBoost, 0.2);
    return Object.freeze({
      ...c,
      occurrence: occ,
      distinctSessions: sessions.size,
      successRate: Number(successRate.toFixed(3)),
      recencyBoost: Number(recencyBoost.toFixed(3)),
      score: Number(score.toFixed(3)),
      meetsMin: c.frames.length >= min,
    });
  });
  return scored
    .filter((s) => s.meetsMin)
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function loadRejections(ledgerPath) {
  const raw = await readJsonFile(ledgerPath);
  if (!raw || !Array.isArray(raw.rejections)) return [];
  return raw.rejections.filter((r) => r && typeof r === 'object');
}

async function saveRejections(ledgerPath, rejections) {
  await atomicWriteJson(ledgerPath, { rejections, updatedAt: new Date().toISOString() });
}

function inCooldown(rejections, signature, now, cooldownDays) {
  const windowMs = cooldownDays * DAY_MS;
  return rejections.some((r) =>
    r?.signature === signature
    && r?.rejectedAt
    && (now - Date.parse(r.rejectedAt)) <= windowMs,
  );
}

function stagingFileName(signature) {
  return `${PROPOSAL_FILE_PREFIX}${signature}.md`;
}

async function listStagingFiles(stagingDir) {
  try {
    const names = await fs.readdir(stagingDir);
    return names.filter((n) => n.startsWith(PROPOSAL_FILE_PREFIX) && n.endsWith('.md'));
  } catch {
    return [];
  }
}

function proposalSkillSlug(cluster) {
  const base = extractTopTokens(cluster.exampleIntent, 3).join('-');
  const safe = (base || `voyager-${cluster.signature}`).replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  return safe.slice(0, 48) || `voyager-${cluster.signature}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CuratorOptions
 * @property {object} episodicStore - Object with `listEpisodes()` returning array.
 * @property {string} skillRegistryPath - Absolute path to plugin skills/ dir.
 * @property {string} stagingDir - Absolute path to staging dir for drafts.
 * @property {string} [rejectionLedgerPath] - Defaults to `<stagingDir>/voyager-rejections.json`.
 * @property {number} [minOccurrences=5]
 * @property {number} [cooldownDays=30]
 * @property {number} [maxProposals=5]
 * @property {(cluster: object, existingSkills: string[]) => string} [draftGenerator]
 * @property {() => number} [now]
 *
 * @param {CuratorOptions} options
 */
export function createCurator(options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createCurator requires options');
  }
  const {
    episodicStore,
    skillRegistryPath,
    stagingDir,
    rejectionLedgerPath,
    draftGenerator,
  } = options;
  if (!episodicStore || typeof episodicStore.listEpisodes !== 'function') {
    throw new TypeError('options.episodicStore must expose listEpisodes()');
  }
  if (!skillRegistryPath) throw new TypeError('options.skillRegistryPath is required');
  if (!stagingDir) throw new TypeError('options.stagingDir is required');

  const minOccurrences = Number.isInteger(options.minOccurrences) && options.minOccurrences >= 1
    ? options.minOccurrences
    : DEFAULT_MIN_OCCURRENCES;
  const cooldownDays = Number.isFinite(options.cooldownDays) && options.cooldownDays >= 0
    ? options.cooldownDays
    : DEFAULT_COOLDOWN_DAYS;
  const maxProposals = Number.isInteger(options.maxProposals) && options.maxProposals >= 1
    ? options.maxProposals
    : DEFAULT_MAX_PROPOSALS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const ledgerPath = rejectionLedgerPath || path.join(stagingDir, REJECTION_LEDGER_FILE);

  async function analyzeEpisodes(filters = {}) {
    const episodes = await episodicStore.listEpisodes();
    if (!Array.isArray(episodes) || episodes.length === 0) return [];
    const sinceTs = typeof filters.since === 'number'
      ? filters.since
      : now() - (filters.sinceDays ?? DEFAULT_SINCE_DAYS) * DAY_MS;
    const untilTs = typeof filters.until === 'number' ? filters.until : now();
    const windowed = episodes.filter((e) =>
      (e?.timestamp ?? 0) >= sinceTs && (e?.timestamp ?? 0) <= untilTs,
    );
    return windowed.map(extractFrame).filter(Boolean);
  }

  async function listExistingSkills() {
    try {
      const dirents = await fs.readdir(skillRegistryPath, { withFileTypes: true });
      return dirents.filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch {
      return [];
    }
  }

  function renderDraft(cluster, existingSkills) {
    if (typeof draftGenerator === 'function') {
      return draftGenerator(cluster, existingSkills);
    }
    const slug = proposalSkillSlug(cluster);
    const triggers = cluster.toolUnion.concat(extractTopTokens(cluster.exampleIntent, 4))
      .slice(0, 8);
    const triggersYaml = triggers.map((t) => `  - "${t}"`).join('\n');
    const frames = cluster.frames.slice(0, 3).map((f, i) =>
      `${i + 1}. _(session ${f.sessionId})_ ${f.intent.slice(0, 160)}`,
    ).join('\n');
    const similar = existingSkills
      .filter((s) => triggers.some((t) => s.includes(t)))
      .slice(0, 5);
    const similarBlock = similar.length > 0
      ? similar.map((s) => `- \`${s}\``).join('\n')
      : '- (no close match — candidate appears novel)';
    return [
      '---',
      `name: ${slug}`,
      'context: proposal',
      'user-invocable: false',
      `description: |`,
      `  Voyager-proposed skill — draft generated ${new Date(now()).toISOString()} from `,
      `  ${cluster.frames.length} recent episodes across ${new Set(cluster.frames.map((f) => f.sessionId)).size} sessions.`,
      '  Requires user review before promotion into skills/.',
      'platforms: [claude-code]',
      'level: 2',
      'triggers:',
      triggersYaml || '  - ""',
      'tokens: "~2K"',
      'category: "voyager-proposal"',
      `source_signature: ${cluster.signature}`,
      '---',
      '',
      `# ${slug}`,
      '',
      '## When This Skill Applies',
      '',
      `- Recurring intent detected in episodic memory: _"${cluster.exampleIntent}"_`,
      `- Shared tool set: ${cluster.toolUnion.length > 0 ? cluster.toolUnion.map((t) => `\`${t}\``).join(', ') : '_(none recorded)_'}`,
      '- Detected in 3+ distinct sessions (auto-confirmed repeating pattern).',
      '',
      '## Example Episodes (redacted summaries)',
      '',
      frames || '(no frames — empty cluster)',
      '',
      '## Candidate Process (user to refine)',
      '',
      '1. Identify the repeating user intent from the pattern above.',
      '2. Confirm the shared tool chain and whether it generalises.',
      '3. Replace this scaffold with your canonical procedure.',
      '4. Add explicit triggers and anti-patterns.',
      '',
      '## Similar Existing Skills',
      '',
      similarBlock,
      '',
      '## Anti-Patterns',
      '',
      '- Do not promote this proposal without human review.',
      '- Do not copy Voyager source prompts verbatim — pattern only.',
      '- Do not register until drift against existing skills is resolved.',
      '',
      '## Voyager Metadata (do not edit — used for audit)',
      '',
      '```json',
      JSON.stringify({
        signature: cluster.signature,
        occurrence: cluster.occurrence,
        distinctSessions: cluster.distinctSessions,
        successRate: cluster.successRate,
        recencyBoost: cluster.recencyBoost,
        score: cluster.score,
        generatedAt: new Date(now()).toISOString(),
      }, null, 2),
      '```',
      '',
    ].join('\n');
  }

  async function proposeSkill(cluster) {
    await ensureDir(stagingDir);
    const rejections = await loadRejections(ledgerPath);
    if (inCooldown(rejections, cluster.signature, now(), cooldownDays)) {
      return { proposed: false, reason: 'cooldown', signature: cluster.signature };
    }
    const existing = await listExistingSkills();
    const body = renderDraft(cluster, existing);
    const filePath = path.join(stagingDir, stagingFileName(cluster.signature));
    await fs.writeFile(filePath, body, 'utf-8');
    return Object.freeze({
      proposed: true,
      signature: cluster.signature,
      filePath,
      score: cluster.score,
      occurrence: cluster.occurrence,
    });
  }

  async function proposeFromClusters(scored) {
    const limited = scored.slice(0, maxProposals);
    const results = [];
    for (const cluster of limited) {
      const r = await proposeSkill(cluster);
      results.push(r);
    }
    return results;
  }

  async function listProposals() {
    const files = await listStagingFiles(stagingDir);
    const proposals = [];
    for (const file of files) {
      const full = path.join(stagingDir, file);
      let content = '';
      try { content = await fs.readFile(full, 'utf-8'); } catch { continue; }
      const signature = file.replace(PROPOSAL_FILE_PREFIX, '').replace(/\.md$/, '');
      const nameMatch = /^name:\s*(.+)$/m.exec(content);
      const skillName = nameMatch ? nameMatch[1].trim() : `voyager-${signature}`;
      proposals.push(Object.freeze({
        signature,
        filePath: full,
        skillName,
        size: content.length,
      }));
    }
    return proposals;
  }

  async function approveProposal(signature) {
    if (!signature || typeof signature !== 'string') {
      return { approved: false, reason: 'invalid-signature' };
    }
    const stagingFile = path.join(stagingDir, stagingFileName(signature));
    let body;
    try {
      body = await fs.readFile(stagingFile, 'utf-8');
    } catch {
      return { approved: false, reason: 'proposal-not-found' };
    }
    const nameMatch = /^name:\s*(.+)$/m.exec(body);
    const skillName = nameMatch
      ? nameMatch[1].trim().replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
      : `voyager-${signature}`;
    const targetDir = path.join(skillRegistryPath, skillName);
    const targetFile = path.join(targetDir, 'SKILL.md');
    try {
      await fs.access(targetFile);
      return { approved: false, reason: 'skill-already-exists', skillName };
    } catch { /* ok — does not exist */ }
    await ensureDir(targetDir);
    // Rewrite frontmatter context from 'proposal' to 'fork' (matches registered skills).
    const promoted = body.replace(/^context:\s*proposal$/m, 'context: fork');
    await fs.writeFile(targetFile, promoted, 'utf-8');
    try { await fs.unlink(stagingFile); } catch { /* best-effort */ }
    return Object.freeze({ approved: true, skillName, targetFile, signature });
  }

  async function rejectProposal(signature, reason = '') {
    if (!signature || typeof signature !== 'string') {
      return { rejected: false, reason: 'invalid-signature' };
    }
    const stagingFile = path.join(stagingDir, stagingFileName(signature));
    try { await fs.unlink(stagingFile); } catch { /* may not exist */ }
    const rejections = await loadRejections(ledgerPath);
    const next = [
      ...rejections.filter((r) => r.signature !== signature),
      {
        signature,
        reason: String(reason).slice(0, 240),
        rejectedAt: new Date(now()).toISOString(),
      },
    ];
    await saveRejections(ledgerPath, next);
    return Object.freeze({ rejected: true, signature, cooldownDays });
  }

  return Object.freeze({
    analyzeEpisodes,
    groupByPattern,
    scoreCandidates,
    proposeSkill,
    proposeFromClusters,
    listProposals,
    approveProposal,
    rejectProposal,
    _internals: Object.freeze({
      ledgerPath,
      stagingDir,
      skillRegistryPath,
      minOccurrences,
      cooldownDays,
      maxProposals,
    }),
  });
}

export const _testing = Object.freeze({
  hashSignature,
  normIntent,
  extractTopTokens,
  jaccard,
  proposalSkillSlug,
  PROPOSAL_FILE_PREFIX,
});
