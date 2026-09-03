/**
 * Action classifier — "what KIND of action is this?" (v5 routing, T-27).
 *
 * Answers exactly one question: which of the eight v5 action classes does the
 * next action belong to. It does NOT pick a model. Tier selection is
 * `adaptive-model-router.js` (T-29) working inside the allow-set that
 * `lib/core/model-policy.js#allowedTiers` (T-30) hands it. This module only
 * exports the class→tier policy table so the router has one place to read it
 * from; applying that table here would put routing in the classifier.
 *
 * DESIGN (v5-lane2-routing.md §2.2, §4.1, §4.5):
 *   1. The command→class table {@link COMMAND_ACTION_CLASS} is the FIRST source
 *      of truth, in the shape of `lib/cognitive/effort-policy.js#EFFORT_POLICY`.
 *      A slash command is an explicit, unambiguous statement of intent; text
 *      heuristics are a fallback for when there is no command.
 *   2. `lib/cognitive/router.js#classifyComplexity`'s five factors (steps,
 *      domains, uncertainty, risk, novelty) are surfaced in `factors` by PORT
 *      INJECTION, never by import: `lib/routing/` is registered at L2
 *      (eslint.config.js:172) and `lib/cognitive/` is L4, so an L2→L4 import is
 *      a layer violation the lint gate rejects.
 *   3. Output `phase` is derived from the `resolveModel` role vocabulary, so a
 *      RouteReceipt writer can fill `action.phase` without a second lookup.
 *
 * LAYER: L2 (auxiliary). The only import is `lib/core/model-policy.js` (L1),
 * which the layer rule allows (upper imports lower). That module reads config
 * lazily inside its own functions, so importing it costs no load-time I/O and
 * this module stays pure: no I/O, no config read, no module state, never
 * throws. Every exported object is frozen.
 *
 * TRAP — `complex-debug` vs `complex-debugging`: `artibot.config.json:61`
 * spells an ADVISOR trigger condition `complex-debugging`. That is a different
 * axis (when to consult an advisor model) and is NOT an action class. This
 * module never emits it and {@link isActionClass} rejects it, matching the
 * receipt schema, which also rejects it
 * (`tests/schemas/receipts.test.js:357-363`).
 *
 * @module lib/routing/action-classifier
 */

import { BUILD_ROLES, REVIEW_ROLES } from '../core/model-policy.js';

// ---------------------------------------------------------------------------
// Action class vocabulary
// ---------------------------------------------------------------------------

/**
 * The eight v5 action classes, as a CLOSED allowlist.
 *
 * Byte-identical to the `action.type` enum of
 * `schemas/route-receipt.schema.json` (T-16). A ninth class is a schema change
 * in both files, not a new string here.
 *
 * @type {readonly string[]}
 */
export const ACTION_CLASSES = Object.freeze([
  'classify',
  'status',
  'explore',
  'edit-routine',
  'implement',
  'complex-debug',
  'architecture',
  'review',
]);

/** Fast membership set for {@link isActionClass}. @type {Set<string>} */
const ACTION_CLASS_SET = new Set(ACTION_CLASSES);

/**
 * True only for one of the eight action classes. Deliberately strict: the
 * near-miss `complex-debugging` (the advisor trigger condition in
 * `artibot.config.json:61`) returns false.
 *
 * @param {*} value - Candidate class name.
 * @returns {boolean} True when `value` is one of {@link ACTION_CLASSES}.
 *
 * @example
 * isActionClass('complex-debug'); // true
 * isActionClass('complex-debugging'); // false — advisor axis, not an action class
 */
export function isActionClass(value) {
  return typeof value === 'string' && ACTION_CLASS_SET.has(value);
}

/**
 * Action class → model tier, the eight behaviour aliases of
 * v5-lane2-routing.md §2.3 step 1.
 *
 * EXPORTED FOR READING ONLY. This module does not apply it and neither does
 * anything else in Phase 0 (Observe): the router records a recommendation
 * while spawns keep using the `resolveModel` policy result. Two hard limits
 * survive this table once it IS applied — a tier outside
 * `allowedTiers(agent, {role})` is never selectable, and the
 * `security-reviewer` denylist is not overridable by any action class.
 *
 * @type {Readonly<Record<string, 'haiku'|'sonnet'|'opus'|'fable'>>}
 */
export const ACTION_CLASS_TIERS = Object.freeze({
  classify: 'haiku',
  status: 'haiku',
  explore: 'sonnet',
  'edit-routine': 'sonnet',
  implement: 'opus',
  'complex-debug': 'opus',
  architecture: 'fable',
  review: 'fable',
});

/**
 * Fallback class when nothing in the input identifies the action.
 *
 * `implement` on purpose, not a cheap class: an unknown action routed downward
 * is the failure that costs a re-run, and `implement` maps to `opus`, which is
 * already the `phaseRoles.build` default. An unrecognised action therefore
 * produces ZERO divergence from today's policy, which is what Phase 0 wants.
 *
 * @type {string}
 */
export const DEFAULT_ACTION_CLASS = 'implement';

// ---------------------------------------------------------------------------
// Primary source of truth: command → action class
// ---------------------------------------------------------------------------

/**
 * Slash command → action class. THE first source of truth (§2.2).
 *
 * Coverage is deliberately partial: 48 of the 79 commands in `commands/`
 * (measured 2026-09-02, `ls commands/*.md | wc -l` = 79). Only commands whose
 * class is unambiguous from their own description are listed. The 31 omitted
 * ones fall through to the text/agent heuristics rather than being guessed
 * here, and they split into three groups:
 *
 *   - Orchestration meta-commands (`team`, `autopilot`, `orchestrate`, `swarm`,
 *     `split`, `spawn`, `dynamic`, `assemble`, `playbook`, `autopilot-queue`,
 *     `codex`, `dreaming`, `resume`, `update`, `install`… ): one invocation
 *     drives MANY actions of different classes, so a single class would be
 *     wrong for most of them. The classifier is meant to run per action, and
 *     these commands are the thing that produces the actions.
 *   - Run-and-report commands (`build`, `test`, `verify`, `ship`,
 *     `visual-check`): they neither only read nor mainly write, and no class in
 *     the eight-value vocabulary names "execute a pipeline".
 *   - Marketing/content commands (`ad`, `analytics`, `content`, `crm`, `cro`,
 *     `email`, `excel`, `marketing`, `mkt`, `ppt`, `seo`, `social`): the eight
 *     classes describe engineering actions; mapping content production onto
 *     them would be invention, not classification.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const COMMAND_ACTION_CLASS = Object.freeze({
  // classify (1) — intent detection / routing; produces no artifact
  sc: 'classify',

  // status (9) — read-only reporting on state that already exists
  doctor: 'status', index: 'status', learning: 'status', load: 'status',
  daily: 'status', recap: 'status', scorecard: 'status',
  permissions: 'status', quickstart: 'status',

  // explore (6) — investigation with uncertain scope, read-heavy
  analyze: 'explore', explain: 'explore', blindspot: 'explore',
  repo: 'explore', 'teach-back': 'explore', watch: 'explore',

  // edit-routine (12) — mechanical, bounded writes
  document: 'edit-routine', git: 'edit-routine', squash: 'edit-routine',
  theme: 'edit-routine', setup: 'edit-routine', install: 'edit-routine',
  export: 'edit-routine', checkpoint: 'edit-routine', save: 'edit-routine',
  task: 'edit-routine', learn: 'edit-routine', sdk: 'edit-routine',

  // implement (5) — multi-file code production
  implement: 'implement', tdd: 'implement', cleanup: 'implement',
  'refactor-clean': 'implement', improve: 'implement',

  // complex-debug (2) — diagnosis before repair (both descriptions say
  // "diagnosis"/"root cause", which is what separates them from `implement`)
  troubleshoot: 'complex-debug', 'build-fix': 'complex-debug',

  // architecture (8) — design and planning decisions ahead of code
  design: 'architecture', adr: 'architecture', plan: 'architecture',
  spec: 'architecture', ultraplan: 'architecture', estimate: 'architecture',
  go: 'architecture', migrate: 'architecture',

  // review (5) — judging work that already exists
  'code-review': 'review', 'adversarial-review': 'review',
  ultrareview: 'review', review: 'review', 'audit-claude-md': 'review',
});

/**
 * Action class for a slash command name. Leading `/` optional.
 *
 * @param {string} commandName - e.g. 'implement', '/code-review'.
 * @returns {string|null} One of {@link ACTION_CLASSES}, or null when the
 *   command is unknown or intentionally unmapped (see
 *   {@link COMMAND_ACTION_CLASS}). Null means "no opinion", never "cheap".
 *
 * @example
 * getActionClassForCommand('/code-review'); // 'review'
 * getActionClassForCommand('team'); // null — orchestration meta-command
 */
export function getActionClassForCommand(commandName) {
  if (typeof commandName !== 'string') return null;
  const key = commandName.replace(/^\//, '').trim();
  return Object.prototype.hasOwnProperty.call(COMMAND_ACTION_CLASS, key)
    ? COMMAND_ACTION_CLASS[key]
    : null;
}

// ---------------------------------------------------------------------------
// Secondary source: agent type
// ---------------------------------------------------------------------------

/**
 * Agent name → action class, for spawns that carry no command.
 *
 * Derived from each agent's own "Do NOT use for" boundary in
 * `agents/<name>.md`, so it says what the agent is FOR, not which model it
 * currently runs on. Plugin prefixes (`artibot:`, `artibot-cowork:`) are
 * stripped before lookup.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const AGENT_ACTION_CLASS = Object.freeze({
  // review — judge existing work
  'code-reviewer': 'review', 'spec-reviewer': 'review',
  'quality-reviewer': 'review', 'security-reviewer': 'review',
  'database-reviewer': 'review',

  // architecture — design/plan before code
  architect: 'architecture', planner: 'architecture',
  'llm-architect': 'architecture',

  // implement — produce code
  'backend-developer': 'implement', 'frontend-developer': 'implement',
  'typescript-pro': 'implement', 'tdd-guide': 'implement',
  'mcp-developer': 'implement', 'devops-engineer': 'implement',
  'e2e-runner': 'implement',

  // complex-debug — diagnose a failure
  'build-error-resolver': 'complex-debug',
  'performance-engineer': 'complex-debug',

  // explore — survey and report
  'repo-benchmarker': 'explore',

  // edit-routine — mechanical, bounded writes
  'doc-updater': 'edit-routine', 'refactor-cleaner': 'edit-routine',
});

/**
 * Action class for an agent type. Strips a `plugin:` prefix first.
 *
 * @param {string} agentType - e.g. 'artibot:code-reviewer', 'planner'.
 * @returns {string|null} Action class, or null when unmapped.
 *
 * @example
 * getActionClassForAgent('artibot:architect'); // 'architecture'
 */
export function getActionClassForAgent(agentType) {
  if (typeof agentType !== 'string') return null;
  const bare = agentType.trim().split(':').pop();
  return Object.prototype.hasOwnProperty.call(AGENT_ACTION_CLASS, bare)
    ? AGENT_ACTION_CLASS[bare]
    : null;
}

// ---------------------------------------------------------------------------
// Phase derivation (resolveModel role vocabulary)
// ---------------------------------------------------------------------------

// The build- and review-side role vocabularies are IMPORTED from
// lib/core/model-policy.js, never re-listed here: this module and the resolver
// must agree on what counts as a review role, and two copies of the strings
// would drift apart silently. Both are plain Sets read only through `.has()`
// below — never call `.add()` on them, since Object.freeze does not stop
// Set mutation and a write here would corrupt routing for every caller.

/**
 * Lifecycle phase for a `resolveModel` role (§4.5: RouteReceipt `action.phase`
 * is derived from the role, not invented).
 *
 * @param {string} role - A `resolveModel` opts.role value.
 * @returns {'build'|'review'|null} Null for an unknown or missing role — the
 *   receipt writer must then supply `action.phase` itself rather than accept a
 *   guessed one.
 *
 * @example
 * derivePhase('crosscheck'); // 'review'
 * derivePhase('planning'); // null
 */
export function derivePhase(role) {
  if (typeof role !== 'string') return null;
  const key = role.trim().toLowerCase();
  if (BUILD_ROLES.has(key)) return 'build';
  if (REVIEW_ROLES.has(key)) return 'review';
  return null;
}

// ---------------------------------------------------------------------------
// Text / tool heuristics (fallback only)
// ---------------------------------------------------------------------------

/**
 * Keyword → action class, scanned only when command and agent give no answer.
 * Order matters: the first class whose keyword appears wins, so the specific
 * classes are checked before the general ones.
 * @type {readonly [string, readonly string[]][]}
 */
const TEXT_HINTS = Object.freeze([
  ['review', Object.freeze(['review', 'critique', 'audit', '검수', '리뷰', '감사'])],
  ['architecture', Object.freeze(['architecture', 'design', 'trade-off', 'adr', 'plan', '설계', '아키텍처', '계획'])],
  ['complex-debug', Object.freeze(['root cause', 'debug', 'stack trace', 'regression', 'reproduce', '디버그', '원인', '재현'])],
  ['explore', Object.freeze(['investigate', 'explore', 'find out', 'survey', 'where is', '조사', '탐색', '살펴'])],
  ['status', Object.freeze(['status', 'report', 'list', 'show me', 'summary', '상태', '요약', '목록'])],
  ['implement', Object.freeze(['implement', 'build', 'add feature', 'refactor', 'migrate', '구현', '리팩토링'])],
  ['edit-routine', Object.freeze(['rename', 'typo', 'format', 'bump', 'update the doc', '오타', '이름 변경'])],
]);

/**
 * First action class hinted at by free text.
 *
 * @param {string} text - Raw prompt text.
 * @returns {string|null} Action class, or null when no keyword matched.
 */
function classifyText(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const lower = text.toLowerCase();
  for (const [actionClass, keywords] of TEXT_HINTS) {
    if (keywords.some((kw) => lower.includes(kw))) return actionClass;
  }
  return null;
}

/** Tools that only read. @type {Set<string>} */
const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead']);
/** Tools that write files. @type {Set<string>} */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Action class implied by the tool/file footprint of the action.
 *
 * Read-only tools with no files touched means the action cannot be producing
 * code; a wide file footprint means it is not a routine edit. Both are weak
 * signals, which is why this runs last and reports low confidence.
 *
 * @param {readonly string[]} toolsRequested - Tool names the action asked for.
 * @param {readonly string[]} filesTouched - Paths the action expects to write.
 * @returns {string|null} Action class, or null when the footprint says nothing.
 */
function classifyFootprint(toolsRequested, filesTouched) {
  const tools = Array.isArray(toolsRequested) ? toolsRequested : [];
  const files = Array.isArray(filesTouched) ? filesTouched : [];
  const writes = tools.filter((t) => WRITE_TOOLS.has(t)).length;
  const reads = tools.filter((t) => READ_ONLY_TOOLS.has(t)).length;

  if (writes === 0 && reads > 0 && files.length === 0) return 'explore';
  if (files.length >= 3 || writes >= 2) return 'implement';
  if (files.length >= 1 && writes >= 1) return 'edit-routine';
  return null;
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/**
 * Confidence by which signal decided the class. A command is an explicit
 * statement of intent and scores highest; the default scores lowest so a
 * consumer can tell "we know" from "we fell back".
 * @type {Readonly<Record<string, number>>}
 */
export const SOURCE_CONFIDENCE = Object.freeze({
  command: 0.9,
  agent: 0.7,
  text: 0.5,
  footprint: 0.35,
  default: 0.2,
});

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Classify one action into one of the eight v5 action classes.
 *
 * Precedence: command table → agent table → text keywords → tool/file
 * footprint → {@link DEFAULT_ACTION_CLASS}. The first hit wins; later signals
 * never override an earlier one, so adding a keyword can never change what a
 * slash command classifies as.
 *
 * @param {object} input - Action description.
 * @param {string} [input.text] - Raw prompt text.
 * @param {string} [input.command] - Slash command name (leading `/` optional).
 * @param {string} [input.agentType] - Agent being spawned, e.g. 'artibot:planner'.
 * @param {readonly string[]} [input.toolsRequested] - Tool names for the action.
 * @param {readonly string[]} [input.filesTouched] - Paths the action will write.
 * @param {string} [input.role] - `resolveModel` opts.role; source of `phase`.
 * @param {string} [input.phase] - Explicit phase, overrides derivation from role.
 * @param {object} [options] - Injected ports.
 * @param {(text: string, context?: object) => {score?: number, factors?: object}} [options.classifyComplexity]
 *   PORT for `lib/cognitive/router.js#classifyComplexity`. Injected because
 *   lib/routing is L2 and lib/cognitive is L4 — importing it directly is a lint
 *   error. When supplied, its five factors and score land in `factors`; when
 *   absent, `factors.complexity` is absent and a RouteReceipt writer must
 *   supply `action.complexity` from elsewhere (the schema requires it).
 * @param {object} [options.complexityContext] - Passed through to the port.
 * @returns {{ actionClass: string, confidence: number, factors: Record<string, number|string>, phase: 'build'|'review'|null }}
 *   `factors` carries `source` (which signal decided) plus, when the port was
 *   injected, `complexity` / `steps` / `domains` / `uncertainty` / `risk` /
 *   `novelty`. RouteReceipt mapping: `action.complexity` ← `factors.complexity`,
 *   `action.uncertainty` ← `factors.uncertainty`, `action.risk` ← `factors.risk`.
 *
 * @example
 * classifyAction({ command: '/code-review', role: 'crosscheck' });
 * // { actionClass: 'review', confidence: 0.9, factors: { source: 'command' }, phase: 'review' }
 *
 * @example
 * classifyAction({ text: 'find the root cause of the flake' }, { classifyComplexity });
 * // { actionClass: 'complex-debug', confidence: 0.5, factors: { source: 'text', complexity: 0.4, ... }, phase: null }
 */
export function classifyAction(input = {}, options = {}) {
  const src = input && typeof input === 'object' ? input : {};

  const resolved =
    pick('command', getActionClassForCommand(src.command))
    ?? pick('agent', getActionClassForAgent(src.agentType))
    ?? pick('text', classifyText(src.text))
    ?? pick('footprint', classifyFootprint(src.toolsRequested, src.filesTouched))
    ?? { actionClass: DEFAULT_ACTION_CLASS, source: 'default' };

  return {
    actionClass: resolved.actionClass,
    confidence: SOURCE_CONFIDENCE[resolved.source],
    factors: buildFactors(resolved.source, src, options),
    phase: typeof src.phase === 'string' && src.phase.trim() !== ''
      ? src.phase.trim()
      : derivePhase(src.role),
  };
}

/**
 * Wrap a candidate class with the signal that produced it, dropping anything
 * outside the eight-value allowlist. This is the single choke point that keeps
 * a bad table entry (or a future `complex-debugging`) from reaching output.
 *
 * @param {string} source - Signal name, a {@link SOURCE_CONFIDENCE} key.
 * @param {string|null} actionClass - Candidate class.
 * @returns {{actionClass: string, source: string}|null} Null when unusable.
 */
function pick(source, actionClass) {
  return isActionClass(actionClass) ? { actionClass, source } : null;
}

/**
 * Assemble the `factors` object: the deciding signal plus, when the complexity
 * port was injected, its score and five factors. The port is called defensively
 * — a throwing or malformed port degrades to "no complexity factors" rather
 * than failing the classification.
 *
 * @param {string} source - Deciding signal name.
 * @param {object} input - The classifyAction input.
 * @param {object} options - The classifyAction options (may hold the port).
 * @returns {Record<string, number|string>} Frozen-shaped plain object.
 */
function buildFactors(source, input, options) {
  const factors = { source };
  const port = options && options.classifyComplexity;
  if (typeof port !== 'function' || typeof input.text !== 'string') return factors;

  let result;
  try {
    result = port(input.text, options.complexityContext);
  } catch {
    return factors;
  }
  if (!result || typeof result !== 'object') return factors;

  if (typeof result.score === 'number') factors.complexity = result.score;
  if (result.factors && typeof result.factors === 'object') {
    for (const [key, value] of Object.entries(result.factors)) {
      if (typeof value === 'number') factors[key] = value;
    }
  }
  return factors;
}
