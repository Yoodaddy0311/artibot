/**
 * CA-01 — Canary auto-activation of LOW-RISK commands (decision half, L4).
 *
 * WHAT IT DECIDES. For one prompt: should the UserPromptSubmit hook tell the
 * model "run /<command> now, without asking"? Nothing else. It executes no
 * command, spawns nothing and writes nothing; the caller renders the answer.
 *
 * WHAT "AUTO-ACTIVATE" ACTUALLY IS. A hook cannot run a slash command — its
 * only lever is the text the model reads. So this changes ONE instruction: from
 * the confirm-first shape of `[artibot:hint recommend=X]` (`CLAUDE.md`
 * "Recommend-hint surfacing rule": surface a sentence, wait for confirmation) to
 * `[artibot:auto-activate command=X]` (run it, say so in one sentence). Whether
 * the model follows that line is UNMEASURED — nothing in this repo observes the
 * model's reaction, and the record this feature writes says a directive was
 * SHOWN, not that a command RAN.
 *
 * WHY SHIPPING IT ON IS DEFENSIBLE — an argument from the code's structure, not
 * a measurement, and where it stops. It is not the gate screen below that keeps
 * this safe: the screen is a text match on natural language. What limits the
 * blast radius is that the directive only removes a QUESTION; every tool call
 * the command then makes still passes the PreToolUse hooks and the host
 * permission system, so no human gate is bypassed. The allowlist keeps the
 * removed question cheap: by their own command docs each activatable command is
 * a read-and-report flow (`allowed-tools` has no Write/Edit), and
 * `/scorecard`'s default path also appends a snapshot to
 * `.artibot/scorecard.json`. "Read-only" is documented intent, not enforcement:
 * their `allowed-tools` do include Bash, and `/analyze` and `/explain` may spawn
 * Agents.
 *
 * DESIGN SOURCE (v5 design, ARTIBOT-5.0-DESIGN.md; quoted fragments, line numbers
 * as of 2026-09-30):
 *  - :257 Canary row — "저위험 커맨드 자동 활성(allowlist A2)", behaviour change
 *    "있음, config 1키로 되돌림".
 *  - :272 A2 — proposal "제안 `/analyze /explain /blindspot /scorecard /why` +
 *    autopilot 무확인 진입 조건"; recommendation "위 5종 + autopilot 은 게이트 히트
 *    0 ∧ allowlist".
 *  - :273 A3 — "Shadow 원장 1릴리스 후". WAIVED for this feature by the owner's
 *    2026-09-30 instruction (relayed by the leader; not verified against the
 *    owner's own message) — the Shadow-ledger precondition is NOT met and this
 *    file does not pretend otherwise.
 *  - :202 — Canary keeps `autoFire: ['solo','team']`; "autopilot 은 게이트 히트 0
 *    + allowlist 일 때만". The autopilot half of that rule is NOT implemented:
 *    `docs/ORCHESTRATION-ROUTING.md` "Harness Constraint" says orchestrate and
 *    autopilot must never auto-fire, and CA-06 (owner decision) is what would
 *    relax it. Only the CONDITION shape (gate hits 0 ∧ allowlist) is reused.
 *  - :564 — "게이트 판정 정본 = 훅 계층 `human-gates.js#classify`; 라우터 hit 는
 *    advisory, 결정에 사용 금지". Hence this module screens with `classify` and
 *    NOT with `topology-router.js#humanGateHits` (which the live hook never
 *    feeds a matrix or planned actions, so it is always `[]` /
 *    `human-gates:unavailable` — a vacuous "0").
 *  - :230 — "`/why` `/cost` `/status`(D17, 전부 미존재)"; :275 and :519 — A5
 *    settled on extending `/doctor` and `/scorecard` instead of creating them.
 *
 * THE ALLOWLIST HAS FIVE NAMES AND FOUR SURFACES. `why` is in the list because
 * the design names it; it has no command file and no trigger, so it can never
 * fire. `tests/firewall/auto-activate-contract.test.js` fails the day a
 * `commands/why.md` appears, so that day is a decision, not an accident.
 *
 * WHAT "GATE HIT" MEANS HERE. A hit is any of:
 *  1. `human-gates.js#classify({command: <prompt>})` returns a row whose
 *     `default` is `policy` or `human` (HG-06 … HG-13). The `auto` rows
 *     (HG-01 … HG-05) are classification rows, not gates — counting them would
 *     make "run the tests and analyze the result" a gate hit.
 *  2. `autopilot/safety.js#classifyRisk(<prompt>)` is not `safe` (destructive
 *     fs/git/SQL, secrets, curl/wget to a host, publish — `caution` counts).
 * Both catalogs were written for tool-call payloads. Run over prose they
 * over-match (measured 2026-09-30: a prompt whose last token is a path such as
 * `.claude/settings.json` trips HG-12) — and that error is the SAFE direction:
 * a hit only withholds the convenience, it never blocks and never grants
 * anything.
 *
 * WHAT THIS CANNOT SEE (stated beside the code so the tests cannot become the
 * next false assurance):
 *  - Precision of the trigger table on real prompts. It was written from each
 *    command's own frontmatter (trigger list or example hint) and pinned on
 *    synthetic prompts; live false-positive and false-negative rates are
 *    unmeasured.
 *  - Natural-language risk with no command in it ("delete production and then
 *    analyze the code") passes the screen. The command that would do harm is
 *    not the allowlisted one, and it stays behind the PreToolUse gates.
 *  - Whether the model complies, and whether the user found it helpful.
 *
 * PURE apart from two lazy `import()`s of the gate catalogs, taken only after a
 * trigger has matched (a cold import of both costs ~20 ms, measured 2026-09-30,
 * and most prompts match nothing). No fs, no clock, no randomness.
 *
 * @module lib/cognitive/auto-activate
 */

/**
 * Dot path of the ONE kill switch. Shipped `true` (the 2026-09-30 owner
 * instruction, as relayed in the CA-01 lane brief); the reader is strict
 * `=== true`, so a missing key, a string `"true"` or an unparsable config all
 * read as OFF — the byte-identical path.
 */
export const AUTO_ACTIVATE_CONFIG_PATH = 'automation.autoActivate.commands';

/**
 * The design's A2 list, in the design's order (ARTIBOT-5.0-DESIGN.md:272).
 * A closed ALLOWLIST: nothing outside it can be activated, and adding a name is
 * an owner-visible decision — `tests/firewall/auto-activate-contract.test.js`
 * pins this exact array.
 * @type {readonly string[]}
 */
export const AUTO_ACTIVATE_ALLOWLIST = Object.freeze([
  'analyze', 'explain', 'blindspot', 'scorecard', 'why',
]);

/**
 * A code/system object — what makes `/analyze` fit. The command describes
 * itself as "Multi-dimensional code and system analysis" (`commands/analyze.md`
 * description), so a bare "분석해줘" ("analyze this data / market / sentiment")
 * is NOT enough: the verb rule below must be joined by one of these.
 * `리포`/`레포` refuse a following `트` so "리포트" (report) is not "repo".
 * Every quantifier is bounded: an open `+`/`*` before a literal is quadratic on
 * a long single run, and the prompt is user-sized.
 */
const CODE_OBJECT = new RegExp([
  '코드|소스|모듈|함수|클래스|저장소|아키텍처|의존성|취약점',
  '리포지토리|레포지토리|리포(?!트)|레포(?!트)',
  '\\bcode(?:base)?\\b|\\bsource\\b|\\bmodules?\\b|\\bfunctions?\\b|\\bclass(?:es)?\\b',
  '\\brepo(?:sitory)?\\b|\\barchitecture\\b|\\bdependenc(?:y|ies)\\b|\\bvulnerabilit(?:y|ies)\\b',
  '(?:^|\\s)@[\\w./-]{1,128}',
  '\\b[\\w-]{1,64}\\.(?:js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|rb|sh)\\b',
].join('|'), 'i');

/**
 * @param {string} id stable rule id (charset `[a-z0-9-]`)
 * @param {string} command the allowlisted command this rule selects
 * @param {RegExp[]} all EVERY regex must match. No `g`/`y` flag: `.test` must be
 *   stateless across calls.
 */
function rule(id, command, all) {
  return Object.freeze({ id, command, all: Object.freeze(all) });
}

/**
 * The trigger table — ALLOWLIST-SHAPED like the topology router's NL patterns
 * (a deny list fails open on every phrase nobody thought of). Provenance differs
 * by command: `blindspot` and `scorecard` rows come from the trigger lists in
 * their own frontmatter `description`, deliberately NARROWER than them (the
 * generic ones — "점검해줘", "얼마나 남았" — are left out, because a false
 * positive here removes a confirmation). `analyze` and `explain` document no
 * trigger list, only an `argument-hint` example ("보안 취약점 분석해줘",
 * "이벤트 루프 동작 원리"), so their rows are the verb (+ object) shape of such a
 * request. There is no row for `why`: it has no command.
 * @type {readonly Readonly<{id: string, command: string, all: readonly RegExp[]}>[]}
 */
const TRIGGER_RULES = Object.freeze([
  rule('analyze-code', 'analyze', [/분석|analy[sz]e|analysis/i, CODE_OBJECT]),
  rule('explain-ko', 'explain', [
    /설명\s{0,4}(?:해\s{0,2}(?:줘|주세요|주라|봐|볼래|줄래|주실|주십)|좀|부탁)/,
  ]),
  rule('explain-en', 'explain', [
    /\bexplain\s{1,4}(?:this|that|these|those|the|it|me|how|why|what|to)\b/i,
  ]),
  rule('explain-walkthrough', 'explain', [/\bwalk\s{1,4}me\s{1,4}through\b/i]),
  rule('blindspot-term', 'blindspot', [/사각지대|blind\s{0,2}-?\s{0,2}spot/i]),
  // The command's own triggers are "빠뜨린 거" / "놓친 거", but on their own those
  // fire on "메일 놓친 거 같아". Requiring the CHECK verb after them keeps the
  // "did I miss anything?" reading and drops the statement reading.
  rule('blindspot-missed', 'blindspot', [
    /(?:빠뜨린|빠트린|놓친|빠진)\s{0,3}(?:거|것|게|부분|점)\s{0,3}(?:없|있|점검|확인|찾)/,
  ]),
  rule('scorecard-term', 'scorecard', [/스코어\s{0,2}카드|score\s{0,2}card/i]),
  rule('scorecard-completeness', 'scorecard', [
    /기능\s{0,3}완성도|완성도\s{0,3}(?:평가|점수|채점)|기능별\s{0,3}점수|작업\s{0,3}전후\s{0,3}(?:비교|점수)/,
  ]),
]);

/**
 * The trigger rows, exposed for the contract tests (frozen; the table itself is
 * not an extension point — a new row is a code change with its own tests).
 */
export const AUTO_ACTIVATE_TRIGGER_RULES = TRIGGER_RULES;

/**
 * Allowlisted names that CAN fire: the allowlist ∩ the names the trigger table
 * selects. Today that is the allowlist minus `why`.
 * @type {readonly string[]}
 */
export const AUTO_ACTIVATE_ACTIVATABLE = Object.freeze(
  AUTO_ACTIVATE_ALLOWLIST.filter((name) => TRIGGER_RULES.some((r) => r.command === name)),
);

/**
 * Is the kill switch on? Strict `=== true` on the dot path, the same reading
 * shape as `workflow-mode.js#readFollowWorkflowPlan` and
 * `question-gate.js#readQuestionGateEnforce`.
 *
 * @param {object|null|undefined} config artibot.config.json contents
 * @returns {boolean}
 */
export function readAutoActivateEnabled(config) {
  return AUTO_ACTIVATE_CONFIG_PATH
    .split('.')
    .reduce((node, key) => node?.[key], config) === true;
}

/**
 * Which ONE allowlisted command does this prompt select?
 *
 * Exactly one distinct command → that command. Two or more distinct commands
 * ("analyze the code and give me a scorecard") is ambiguous and selects
 * NOTHING: two rules of the SAME command agree and count once, but a prompt
 * that fits two commands is exactly where asking is cheaper than guessing.
 *
 * `table` exists so a test can prove the allowlist is enforced HERE and not
 * only by how the shipped table happens to be written: a synthetic row for a
 * command outside the allowlist must never be returned.
 *
 * @param {unknown} text the prompt
 * @param {readonly {id: string, command: string, all: readonly RegExp[]}[]} [table]
 * @returns {{command: string|null, rules: string[], ambiguous: boolean}}
 */
export function matchAutoActivateCommand(text, table = TRIGGER_RULES) {
  const probe = typeof text === 'string' ? text : '';
  const commands = new Set();
  const rules = [];
  for (const row of table) {
    if (!AUTO_ACTIVATE_ALLOWLIST.includes(row.command)) continue;
    if (row.all.every((re) => re.test(probe))) {
      commands.add(row.command);
      rules.push(row.id);
    }
  }
  if (commands.size === 1) return { command: [...commands][0], rules, ambiguous: false };
  return { command: null, rules, ambiguous: commands.size > 1 };
}

/**
 * Screen a prompt against the two gate catalogs (see the header for what a
 * "gate hit" is). Async only because the catalogs are imported lazily.
 *
 * @param {unknown} text the prompt
 * @returns {Promise<string[]>} hit ids — `HG-nn` and `risk:<rule id>`; empty = zero hits
 */
export async function screenGateHits(text) {
  const probe = typeof text === 'string' ? text : '';
  const [gates, safety] = await Promise.all([
    import('../security/human-gates.js'),
    import('../autopilot/safety.js'),
  ]);
  const hits = [];
  for (const { id } of gates.classify({ command: probe }).hits) {
    const row = gates.getGateRow(id);
    // An unknown row id is a hit: the direction of doubt is "withhold".
    if (row === null || row.default !== 'auto') hits.push(id);
  }
  const risk = safety.classifyRisk(probe);
  if (risk.level !== 'safe') hits.push(`risk:${risk.matchedId ?? risk.level}`);
  return hits;
}

/**
 * The full decision. Every condition must hold; any false one returns
 * `activate: false` with a `reason`, and the caller then emits nothing — which
 * is today's behaviour byte for byte. Cheap conditions first: the gate screen
 * (two lazy imports) only runs for a prompt that already selected a command.
 *
 * `reason`: `switch-off` · `no-text` · `slash-command` · `no-trigger` ·
 * `ambiguous-trigger` · `intent-unavailable` · `intent-ambiguous` · `gate-hit` ·
 * `gate-screen-failed` · `allowlist-match`.
 *
 * @param {object} [params]
 * @param {unknown} [params.text] the prompt the user typed
 * @param {object} [params.config] artibot.config.json contents (the kill switch)
 * @param {string|null} [params.slashCommand] `detectSlashCommand(text)`. A typed
 *   slash command is already an explicit choice; nothing to activate.
 * @param {{ambiguous?: boolean}|null} [params.intent] the router's intent for
 *   this prompt (`state.context.intent`). Absent = the runtime pipeline did not
 *   run (fallback envelope) and the decision fails closed.
 * @param {(text: string) => Promise<string[]>} [params.screen] gate screen port
 * @returns {Promise<Readonly<{activate: boolean, command: string|null,
 *   reason: string, rules: readonly string[], gates: readonly string[]}>>}
 */
export async function decideAutoActivation({
  text, config, slashCommand = null, intent = null, screen = screenGateHits,
} = {}) {
  const result = (activate, command, reason, rules = [], gates = []) => Object.freeze({
    activate, command, reason, rules: Object.freeze([...rules]), gates: Object.freeze([...gates]),
  });
  if (!readAutoActivateEnabled(config)) return result(false, null, 'switch-off');
  if (typeof text !== 'string' || text.trim() === '') return result(false, null, 'no-text');
  if (typeof slashCommand === 'string' && slashCommand !== '') {
    return result(false, null, 'slash-command');
  }
  const match = matchAutoActivateCommand(text);
  if (match.command === null) {
    return result(false, null, match.ambiguous ? 'ambiguous-trigger' : 'no-trigger', match.rules);
  }
  if (intent === null || typeof intent !== 'object') {
    return result(false, null, 'intent-unavailable', match.rules);
  }
  if (intent.ambiguous === true) return result(false, null, 'intent-ambiguous', match.rules);
  let gates;
  try {
    gates = await screen(text);
  } catch {
    return result(false, null, 'gate-screen-failed', match.rules);
  }
  if (!Array.isArray(gates)) return result(false, null, 'gate-screen-failed', match.rules);
  if (gates.length > 0) return result(false, null, 'gate-hit', match.rules, gates);
  return result(true, match.command, 'allowlist-match', match.rules);
}

/**
 * Render the directive for one activatable command, or '' for anything else.
 * The closed-set check is repeated HERE (not only in the matcher) so a caller
 * that hands in a name of its own reaches the prompt as nothing.
 *
 * One line, no newline: the hook joins directives into one head line and the
 * caller-side shape gate (`runtime-prompt.js#acceptAutoActivation`) refuses
 * anything that is not `[artibot:auto-activate command=<name>] <one line>`.
 * The final clause is an escape hatch on purpose — the triggers are heuristics,
 * and a model that can see the request does not fit should be free to say so.
 *
 * @param {unknown} command
 * @returns {string}
 */
export function renderAutoActivateDirective(command) {
  if (typeof command !== 'string' || !AUTO_ACTIVATE_ACTIVATABLE.includes(command)) return '';
  return `[artibot:auto-activate command=${command}] `
    + `Low-risk allowlisted command: run /${command} for this request now without asking for confirmation, `
    + 'and say so in one short Korean sentence first. '
    + 'If the request clearly does not fit it, ignore this line. '
    + 'Human gates and tool permissions still apply.';
}
