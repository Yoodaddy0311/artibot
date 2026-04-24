/**
 * Voyager Iterative Prompter — local, stateless, LLM-free.
 *
 * MVP design: this module produces SKILL.md drafts and applies user-supplied
 * refinement feedback *deterministically* (string transforms only). No LLM
 * calls happen here — drafting is a template scaffold, refinement merges
 * feedback blocks into the draft text. Any actual language-model rewriting
 * is expected to happen downstream via a user-triggered command (e.g. a
 * `/team` run driven by the `llm-architect` agent).
 *
 * This separation keeps the curation loop compliant with the Artibot DATA
 * POLICY HARD RULE — no external AI API, no external DB — while still giving
 * users a useful prompt scaffold per cluster.
 *
 * The original Voyager paper's "self-verification" step is intentionally
 * omitted from MVP; see v3.4 candidates in the curation guide.
 *
 * @module lib/learning/voyager/iterative-prompter
 */

const TEMPLATE_SECTIONS = Object.freeze([
  'trigger',
  'when-applies',
  'process',
  'anti-patterns',
  'output-format',
]);

// ---------------------------------------------------------------------------
// Helpers — pure, no I/O
// ---------------------------------------------------------------------------

function coerceSlug(raw) {
  const base = String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base.slice(0, 48) || 'voyager-skill';
}

function describeCluster(cluster) {
  if (!cluster || typeof cluster !== 'object') return 'cluster-missing';
  const example = String(cluster.exampleIntent || '').slice(0, 160) || 'intent-unknown';
  const tools = Array.isArray(cluster.toolUnion) ? cluster.toolUnion : [];
  const frames = Array.isArray(cluster.frames) ? cluster.frames : [];
  return {
    example,
    tools,
    frameCount: frames.length,
    firstFrameIntent: frames[0]?.intent?.slice(0, 160) || example,
    signature: cluster.signature,
  };
}

function buildTriggerBlock(tools, intentTokens) {
  const merged = [...new Set([...(tools || []), ...(intentTokens || [])])]
    .filter(Boolean)
    .slice(0, 8);
  if (merged.length === 0) return '  - ""';
  return merged.map((t) => `  - "${String(t).replace(/"/g, '')}"`).join('\n');
}

function buildWhenAppliesBlock(info) {
  return [
    `- The user intent matches: _"${info.example}"_`,
    `- The task involves tools: ${info.tools.length > 0 ? info.tools.map((t) => `\`${t}\``).join(', ') : '_(none recorded)_'}`,
    `- Observed in ${info.frameCount} episodes (automatically clustered).`,
  ].join('\n');
}

function buildProcessBlock() {
  return [
    '1. Confirm the user intent matches the pattern (reject if drift detected).',
    '2. Load the relevant tool/context subset listed in the trigger.',
    '3. Execute the canonical procedure (user fills this in).',
    '4. Verify outcome against the episodic success signal captured at proposal time.',
  ].join('\n');
}

function buildAntiPatternsBlock() {
  return [
    '- Do not promote this draft without user review.',
    '- Do not invoke external APIs beyond the declared tool set.',
    '- Do not mutate global state — keep the procedure idempotent.',
  ].join('\n');
}

function buildOutputFormatBlock() {
  return [
    '- Structured summary table (GFM pipe syntax).',
    '- Evidence block with `file:line` references where applicable.',
    '- Explicit completion signal for the orchestrator.',
  ].join('\n');
}

function composeBody(info, intentTokens) {
  const slug = coerceSlug(info.example);
  const triggerBlock = buildTriggerBlock(info.tools, intentTokens);
  return [
    '---',
    `name: ${slug}`,
    'context: proposal',
    'user-invocable: false',
    'description: |',
    `  Iterative-prompter draft for signature ${info.signature}.`,
    '  Populated from episodic cluster; requires user refinement before promotion.',
    'platforms: [claude-code]',
    'level: 2',
    'triggers:',
    triggerBlock,
    `source_signature: ${info.signature}`,
    '---',
    '',
    `# ${slug}`,
    '',
    '## When This Skill Applies',
    '',
    buildWhenAppliesBlock(info),
    '',
    '## Process',
    '',
    buildProcessBlock(),
    '',
    '## Anti-Patterns',
    '',
    buildAntiPatternsBlock(),
    '',
    '## Output Format',
    '',
    buildOutputFormatBlock(),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate an initial SKILL.md draft for a cluster. Deterministic — the same
 * cluster + existingSkills list always yields byte-equal output.
 *
 * @param {object} cluster
 * @param {string[]} existingSkills
 * @returns {string}
 */
export function generateSkillDraft(cluster, existingSkills = []) {
  const info = describeCluster(cluster);
  if (typeof info === 'string') return `# (invalid cluster: ${info})\n`;
  const intentTokens = String(info.example).split(/\s+/).filter((t) => t && t.length >= 3).slice(0, 6);
  let body = composeBody(info, intentTokens);
  if (Array.isArray(existingSkills) && existingSkills.length > 0) {
    const similar = existingSkills
      .filter((s) => typeof s === 'string' && info.tools.some((t) => s.includes(t)))
      .slice(0, 5);
    if (similar.length > 0) {
      body += [
        '',
        '## Similar Existing Skills',
        '',
        similar.map((s) => `- \`${s}\``).join('\n'),
        '',
      ].join('\n');
    }
  }
  return body;
}

/**
 * Merge a feedback object into an existing draft without re-generating. The
 * merge is purely textual — each feedback key maps to a canonical heading;
 * if the heading exists, its body is replaced between the heading and the
 * next `## ` marker; otherwise the block is appended.
 *
 * No LLM involved — this is a diff-and-splice transform that lets the user
 * (or a downstream agent) iterate on a draft without re-running the curator.
 *
 * @param {string} draft
 * @param {Record<string,string>} feedback - e.g. { process: "Updated process..." }
 * @returns {string}
 */
export function refineDraft(draft, feedback) {
  if (typeof draft !== 'string') return '';
  if (!feedback || typeof feedback !== 'object') return draft;
  let output = draft;
  for (const key of Object.keys(feedback)) {
    if (!TEMPLATE_SECTIONS.includes(key)) continue;
    const body = String(feedback[key] || '').trim();
    if (!body) continue;
    const heading = sectionHeading(key);
    output = upsertSection(output, heading, body);
  }
  return output;
}

function sectionHeading(key) {
  switch (key) {
    case 'trigger': return '## Triggers';
    case 'when-applies': return '## When This Skill Applies';
    case 'process': return '## Process';
    case 'anti-patterns': return '## Anti-Patterns';
    case 'output-format': return '## Output Format';
    default: return `## ${key}`;
  }
}

function upsertSection(text, heading, body) {
  const safeHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)${safeHeading}\\n[\\s\\S]*?(?=\\n## |\\n?$)`, 'm');
  const replacement = `\n${heading}\n\n${body}\n`;
  if (re.test(text)) {
    return text.replace(re, replacement);
  }
  if (text.endsWith('\n')) return `${text}${replacement.trimStart()}\n`;
  return `${text}\n${replacement.trimStart()}\n`;
}

/**
 * Expose canonical template section keys for downstream callers that want to
 * validate feedback payloads before passing them into `refineDraft`.
 * @returns {readonly string[]}
 */
export function listTemplateSections() {
  return TEMPLATE_SECTIONS;
}

export const _internals = Object.freeze({
  describeCluster,
  buildTriggerBlock,
  buildWhenAppliesBlock,
  buildProcessBlock,
  coerceSlug,
  sectionHeading,
});
