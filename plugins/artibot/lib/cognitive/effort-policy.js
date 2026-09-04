/**
 * Static Effort Level Policy (cognitive layer, pure L4 leaf — no imports).
 *
 * Maps slash-command names to Claude Opus 4.8 native effort levels. Extracted
 * verbatim from router.js so the static mapping can be imported without pulling
 * in the System 1/2 routing graph (breaks the router↔effort-resolver cycle and
 * keeps router.js under the <800-line quality gate). Logic is byte-identical to
 * the previous in-router definition.
 *
 * @module lib/cognitive/effort-policy
 */

// ---------------------------------------------------------------------------
// Effort Level Policy (native effort level vocabulary)
// ---------------------------------------------------------------------------
// Official guide: https://platform.claude.com/docs/ko/build-with-claude/effort
// Native levels: max | xhigh | high | medium | low. Default is 'high' on every
// surface; no beta header is required.
//
// HOW THIS MAPPING ACTUALLY REACHES THE MODEL (measured 2026-09-02 — the
// plugin has NO Messages API caller and sets NO output_config.effort; grep
// `output_config` in lib/ and scripts/ finds only comments):
//   1. scripts/hooks/runtime-prompt.js resolves EFFORT_POLICY (via
//      effort-resolver.js) on UserPromptSubmit, persists it to
//      runtime/current-effort.json, and emits the prose directive
//      `[artibot:effort level=X command=Y]` as
//      hookSpecificOutput.additionalContext. The host delivers that as a
//      separate meta message ("UserPromptSubmit hook additional context: …")
//      NEXT TO the user’s prompt — a hook cannot rewrite or prefix the prompt
//      itself (measured 2026-09-03 on 2.1.259; see
//      .artibot/guides/v5-design/PROBE-effort-directive-delivery.md).
//      Teammates get the directive only because the orchestrator writes it
//      into each Agent() prompt (commands/team.md "Auto-Effort Pre-injection").
//   2. The host's own effort setting is READ, never written: when
//      runtime.effort.nativeApi is true, runtime-prompt.js consults
//      lib/cognitive/native-effort.js (host env var / hook stdin band) and lets
//      that band override the heuristic one before persisting.
//   3. lib/runtime/middleware/tasks.js copies the persisted band into
//      task.meta.effort / task.meta.taskBudget so /team can prefix each
//      teammate prompt with the same directive.
// The directive is advisory text; the model's real effort is whatever the host
// (Claude Code /effort, --effort, settings) applies. 'xhigh' is the recommended
// floor for agentic coding; 'max' is reserved for the deepest multi-agent
// orchestration (ultracode: xhigh + always-on team workflows).

/** @type {Readonly<Record<string, 'max'|'xhigh'|'high'|'medium'|'low'>>} */
export const EFFORT_POLICY = Object.freeze({
  // max — deepest multi-agent orchestration / long-horizon autonomy (ultracode-class)
  orchestrate: 'max', swarm: 'max', autopilot: 'max',
  // xhigh — agentic coding / multi-file implementation (official coding recommendation)
  implement: 'xhigh', team: 'xhigh', tdd: 'xhigh',
  'build-fix': 'xhigh', cleanup: 'xhigh', 'refactor-clean': 'xhigh',
  spawn: 'xhigh',
  // high — focused reasoning / review / design
  'code-review': 'high', 'adversarial-review': 'high', review: 'high',
  plan: 'high', troubleshoot: 'high', analyze: 'high', design: 'high',
  estimate: 'high', spec: 'high', verify: 'high', improve: 'high', repo: 'high',
  // medium — balanced content / domain work
  daily: 'medium', load: 'medium', index: 'medium',
  explain: 'medium', document: 'medium', checkpoint: 'medium', learn: 'medium',
  git: 'medium', playbook: 'medium', build: 'medium', ship: 'medium',
  test: 'medium', 'visual-check': 'medium',
  ad: 'medium', analytics: 'medium', content: 'medium',
  crm: 'medium', cro: 'medium', email: 'medium', excel: 'medium',
  marketing: 'medium', mkt: 'medium', ppt: 'medium',
  seo: 'medium', social: 'medium',
  // low — cost-saving / lookup / config
  permissions: 'low', update: 'low', quickstart: 'low',
  sc: 'low', sdk: 'low', setup: 'low', task: 'low',
  assemble: 'low', codex: 'low',
});

/**
 * Resolve effort level for a slash command name.
 * @param {string} commandName - e.g. 'implement', 'code-review' (leading '/' optional)
 * @returns {'max'|'xhigh'|'high'|'medium'|'low'} Defaults to 'medium' for unknown commands.
 */
export function getEffortForCommand(commandName) {
  const key = String(commandName || '').replace(/^\//, '').trim();
  return EFFORT_POLICY[key] ?? 'medium';
}
