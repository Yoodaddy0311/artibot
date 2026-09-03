/**
 * Mission compiler — raw request → Mission Contract.
 *
 *   Raw User Request → Intent Interpreter → Problem Boundary → Mission Contract
 *
 * PURITY (design §1-8, L2): no clock, no filesystem, no randomness, no I/O.
 * `nowMs`, the config, the intent analysis and every port arrive as inputs. The
 * same input must produce the same contract, because Shadow-stage comparison
 * (compiled activation vs the user's actual command) only means anything if the
 * compile step is deterministic.
 *
 * COMPILE HAPPENS FOR EVERY PROMPT. The existing `buildWorkflowPlan` call is
 * gated on `mode === 'agentTeam'`, which excludes every system1 prompt; design
 * §3.5 forbids inheriting that condition, because a compiler that skips system1
 * has no Observe denominator. System1 gets the REDUCED contract instead
 * (`{goal, explicit_requests, intent_confidence}`), which is why
 * `validateMissionContract` carries a `reduced` mode.
 *
 * EXPLICIT REQUESTS ARE COPIED, NEVER SUMMARIZED. Each entry is a verbatim
 * substring of the prompt plus the character span it came from. Summarizing
 * would destroy the only thing that makes the Intent Fidelity rule mechanical:
 * `verifyExplicitRequestSpans` can re-derive the text from the original at any
 * later point and catch a substitution.
 *
 * WHAT THIS COMPILER CANNOT SEE
 * -----------------------------
 *  - It does not interpret. `goal` is taken from the caller; with no caller
 *    goal it falls back to the first explicit request VERBATIM and says so in
 *    `meta.goalSource`. Real interpretation is `lib/intent/interpreter.js`
 *    (T-24), which has not landed.
 *  - It does not produce `intent_confidence`. That is `lib/intent/confidence.js`
 *    (T-24); this module passes through whatever the caller supplies.
 *  - Request extraction is a surface-pattern matcher over two documented
 *    allowlists: Korean request endings and one-sentence connectives. A request
 *    phrased as a statement produces no entry and the whole-prompt fallback
 *    fires - never silence, but also never comprehension.
 *  - Connective splitting is textual, not grammatical. It reads the characters
 *    around a connective, not the sentence's structure, so two limits stand.
 *    A connective spelled in a form the allowlist does not carry is simply not
 *    a boundary. And a sentence that buries an auxiliary in front of a real
 *    request ("...하고 싶어서 ...해줘") satisfies the guard and splits at the
 *    auxiliary, giving a fragment shorter than the user's thought. Both cases
 *    are wrong in the SAFE direction - a missed split loses a signal, it never
 *    invents a request the user did not make - but neither is comprehension.
 *  - Target derivation is textual. It yields the words the user used, not repo
 *    paths; a caller that wants paths injects a `resolveTarget` port.
 *  - `execution_profile` is passed through unvalidated (its schema is T-18's
 *    and is resolved by nobody here).
 *
 * @module lib/mission/compiler
 */

import {
  checkIntentFidelity,
  validateMissionContract,
  verifyExplicitRequestSpans,
} from './contract.js';
import { buildScope } from './problem-boundary.js';
import { scanBlindspots } from './blindspot-scanner.js';
import { detectSlashCommand, judgeSubstantive } from './mission-id.js';

/**
 * Korean request endings stripped from the tail of a clause, longest first.
 *
 * Longest-first matters: `해주세요` must win over `주세요`, otherwise the strip
 * leaves a dangling `해`. A bare `해` and `하자` are deliberately absent — `해`
 * would truncate ordinary nouns (`이해` → `이`), and a wrong cut breaks the
 * verbatim guarantee, which is worse than leaving a polite ending attached.
 */
const KO_REQUEST_ENDINGS = Object.freeze([
  '해 주시겠어요', '해주시겠어요', '해 주시겠습니까', '해주시겠습니까',
  '해 주십시오', '해주십시오', '해 주세요', '해주세요',
  '해주실래요', '해줄래요', '해줄래', '해주라', '해주렴',
  '해줘요', '해줘', '해봐요', '해봐',
  '하십시오', '하세요', '해요', '해라',
  '부탁드립니다', '부탁드려요', '부탁해요', '부탁해',
  '바랍니다', '바래요',
  '주시겠어요', '주십시오', '주세요', '줄래요', '줄래', '줘요', '줘',
]);

/**
 * Imperative verbs that open an English request.
 *
 * An allowlist: an unlisted verb yields no entry and the whole-prompt fallback
 * catches it, whereas a deny list would classify arbitrary text as a request.
 */
const EN_IMPERATIVE_VERBS = Object.freeze([
  'add', 'analyze', 'audit', 'build', 'change', 'check', 'clean', 'cleanup',
  'configure', 'create', 'delete', 'deploy', 'document', 'explain', 'extract',
  'fix', 'generate', 'implement', 'improve', 'install', 'investigate', 'make',
  'merge', 'migrate', 'modify', 'move', 'optimize', 'port', 'refactor',
  'remove', 'rename', 'replace', 'research', 'restore', 'review', 'revert',
  'rewrite', 'run', 'setup', 'split', 'test', 'update', 'upgrade', 'verify',
  'write',
]);

const EN_IMPERATIVE_SET = new Set(EN_IMPERATIVE_VERBS);

/** Clause terminators used to segment a prompt. */
const CLAUSE_TERMINATORS = /[.!?\n;]+/g;

/**
 * Connectives that join two requests inside ONE sentence - a documented
 * allowlist, never a "split on anything else" rule.
 *
 * Korean coordinates requests without a sentence terminator: "A을 추가하고 B를
 * 갱신해줘" is two requests, and only the FINAL conjunct carries the request
 * ending. Splitting on 그리고 alone therefore extracted ONE request where the same
 * sentence written with a period extracted two, which made substantive signal
 * S3 (two or more explicit requests) structurally unreachable for this phrasing.
 *
 * Two flags per form, because the two families behave differently:
 *
 *  - `leftInherits` - a VERB connective IS the verb ending of its own conjunct,
 *    so the fragment to its left is already a request and needs no ending of its
 *    own. A standalone conjunction (그리고) joins two clauses that each carry
 *    their own ending, so neither side inherits anything.
 *  - `guarded` - a verb connective splits ONLY when the text after it is itself
 *    request-shaped. That is what separates "테스트를 추가하고 README 를
 *    갱신해줘" (right side carries a request ending -> split) from
 *    "테스트하고 싶어" (right side is an auxiliary, not a request -> no split).
 *    The guard reads the SAME {@link KO_REQUEST_ENDINGS} allowlist used
 *    everywhere else, so it grows with that list instead of becoming a second,
 *    divergent rule.
 *
 * Ordered longest-first: 그리고 나서 must win over 고 나서, which would
 * otherwise cut inside the word.
 */
const CLAUSE_CONNECTIVES = Object.freeze([
  { value: '그리고 나서', leftInherits: false, guarded: false },
  { value: '그리고', leftInherits: false, guarded: false },
  { value: '하고 나서', leftInherits: true, guarded: true },
  { value: '고 나서', leftInherits: true, guarded: true },
  { value: '한 다음에', leftInherits: true, guarded: true },
  { value: '한 다음', leftInherits: true, guarded: true },
  { value: '한 뒤에', leftInherits: true, guarded: true },
  { value: '한 뒤', leftInherits: true, guarded: true },
  { value: '한 후에', leftInherits: true, guarded: true },
  { value: '한 후', leftInherits: true, guarded: true },
  { value: '하고', leftInherits: true, guarded: true },
]);

function trimSpan(text, start, end) {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s])) s += 1;
  while (e > s && /\s/.test(text[e - 1])) e -= 1;
  return { start: s, end: e };
}

function splitOn(text, segments, pattern) {
  const out = [];
  for (const seg of segments) {
    const sub = text.slice(seg.start, seg.end);
    const re = new RegExp(pattern.source, pattern.flags);
    let cursor = 0;
    let m;
    while ((m = re.exec(sub)) !== null) {
      if (m.index > cursor) out.push({ start: seg.start + cursor, end: seg.start + m.index });
      cursor = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex += 1;
    }
    if (cursor < sub.length) out.push({ start: seg.start + cursor, end: seg.end });
  }
  return out;
}

function isRequestShapedTail(text, start, end) {
  const seg = trimSpan(text, start, end);
  if (seg.end <= seg.start) return false;
  const body = text.slice(seg.start, seg.end);
  if (KO_REQUEST_ENDINGS.some((ending) => body.endsWith(ending) && body.length > ending.length)) {
    return true;
  }
  const word = firstWord(body);
  return Boolean(word && EN_IMPERATIVE_SET.has(word));
}

function matchConnectiveAt(text, index, limit) {
  for (const form of CLAUSE_CONNECTIVES) {
    const stop = index + form.value.length;
    if (stop > limit) continue;
    if (text.slice(index, stop) !== form.value) continue;
    // A connective only marks a boundary when something follows it on the same
    // clause; whitespace is what separates it from the next conjunct.
    if (stop >= limit || !/\s/.test(text[stop])) continue;
    return { form, stop };
  }
  return null;
}

function splitConnectives(text, segments) {
  const out = [];
  for (const seg of segments) {
    let cursor = seg.start;
    let i = seg.start;
    while (i < seg.end) {
      const hit = matchConnectiveAt(text, i, seg.end);
      if (hit && (!hit.form.guarded || isRequestShapedTail(text, hit.stop, seg.end))) {
        out.push({ start: cursor, end: i, requestShaped: hit.form.leftInherits });
        cursor = hit.stop;
        i = hit.stop;
        continue;
      }
      i += 1;
    }
    out.push({ start: cursor, end: seg.end, requestShaped: false });
  }
  return out;
}

function segmentClauses(prompt) {
  const whole = [{ start: 0, end: prompt.length }];
  const bySentence = splitOn(prompt, whole, CLAUSE_TERMINATORS);
  return splitConnectives(prompt, bySentence)
    .map((seg) => ({ ...trimSpan(prompt, seg.start, seg.end), requestShaped: seg.requestShaped }))
    .filter((seg) => seg.end > seg.start);
}


function stripKoreanEnding(prompt, seg) {
  const text = prompt.slice(seg.start, seg.end);
  for (const ending of KO_REQUEST_ENDINGS) {
    if (text.endsWith(ending) && text.length > ending.length) {
      const trimmed = trimSpan(prompt, seg.start, seg.end - ending.length);
      if (trimmed.end > trimmed.start) return trimmed;
    }
  }
  return null;
}

function firstWord(text) {
  const m = text.replace(/^please\s+/i, '').match(/^[A-Za-z][A-Za-z0-9_-]*/);
  return m ? m[0].toLowerCase() : null;
}

function englishImperativeSpan(prompt, seg) {
  const text = prompt.slice(seg.start, seg.end);
  const politeOffset = /^please\s+/i.test(text) ? text.match(/^please\s+/i)[0].length : 0;
  const word = firstWord(text);
  if (!word || !EN_IMPERATIVE_SET.has(word)) return null;
  return trimSpan(prompt, seg.start + politeOffset, seg.end);
}

/**
 * Extract the protected `explicit_requests` list from a raw prompt.
 *
 * Every returned `text` is `prompt.slice(span.start, span.end)` exactly — the
 * function asserts that before returning, so a future edit that starts
 * normalizing text fails here rather than silently breaking fidelity.
 *
 * When nothing matches, the WHOLE trimmed prompt becomes one entry. Losing the
 * user's words is the failure this list exists to prevent, so an unparsed
 * prompt is preserved rather than dropped, and `meta.extraction` records that
 * the fallback fired.
 *
 * @param {string} prompt
 * @returns {{requests: {text: string, span: {start: number, end: number}}[],
 *   extraction: 'matched'|'fallback-whole-prompt'|'empty'}}
 */
export function extractExplicitRequests(prompt) {
  const source = String(prompt ?? '');
  const requests = [];
  const seen = new Set();

  for (const seg of segmentClauses(source)) {
    // A fragment left of a verb connective carries no ending of its own -- the
    // connective WAS its ending -- so it is already request-shaped and is taken
    // verbatim. Everything else must still prove itself.
    const span = stripKoreanEnding(source, seg)
      ?? englishImperativeSpan(source, seg)
      ?? (seg.requestShaped ? { start: seg.start, end: seg.end } : null);
    if (!span) continue;
    const text = source.slice(span.start, span.end);
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    requests.push({ text, span: { start: span.start, end: span.end } });
  }

  let extraction = 'matched';
  if (requests.length === 0) {
    const whole = trimSpan(source, 0, source.length);
    if (whole.end > whole.start) {
      requests.push({
        text: source.slice(whole.start, whole.end),
        span: { start: whole.start, end: whole.end },
      });
      extraction = 'fallback-whole-prompt';
    } else {
      extraction = 'empty';
    }
  }

  for (const entry of requests) {
    if (source.slice(entry.span.start, entry.span.end) !== entry.text) {
      throw new Error(
        'extractExplicitRequests: span/text mismatch — extraction must stay verbatim',
      );
    }
  }

  return { requests, extraction };
}

const PATH_LIKE = /[0-9A-Za-z_.@-]*[/\\][0-9A-Za-z_./\\@-]+/g;
const FILE_LIKE = /\b[0-9A-Za-z_-]+\.[A-Za-z]{1,5}\b/g;
const KO_OBJECT_PARTICLE = /([0-9A-Za-z가-힣_./\\-]+)\s*(?:을|를)(?=\s|$)/g;
const ASCII_WORD = /\b[A-Za-z][A-Za-z0-9_-]*\b/g;

function collect(text, re) {
  const out = [];
  const rx = new RegExp(re.source, re.flags);
  let m;
  while ((m = rx.exec(text)) !== null) out.push(m[1] ?? m[0]);
  return out;
}

/**
 * Derive `scope.requested_target` subjects from the explicit requests.
 *
 * Three passes, in priority order: path-like tokens, the noun in front of a
 * Korean object particle (을/를), then remaining ASCII words with the leading
 * imperative verb dropped. Dropping the verb only in FIRST position matters:
 * `split` is both an imperative and a real target, and an unconditional verb
 * filter would erase the target in "split 을 업그레이드해줘".
 *
 * @param {{text: string}[]} explicitRequests
 * @param {object} [options]
 * @param {(subject: string) => string[]} [options.resolveTarget] - Port that maps
 *   a spoken subject onto repo paths. Default is identity: this module has no
 *   filesystem and must not pretend to know paths.
 * @returns {string[]}
 */
export function deriveRequestedTargets(explicitRequests, options = {}) {
  const resolveTarget = typeof options.resolveTarget === 'function'
    ? options.resolveTarget
    : (subject) => [subject];

  const subjects = [];
  const push = (value) => {
    const v = String(value || '').trim();
    if (v.length > 0 && !subjects.includes(v)) subjects.push(v);
  };

  for (const entry of Array.isArray(explicitRequests) ? explicitRequests : []) {
    const text = typeof entry?.text === 'string' ? entry.text : '';
    if (text.length === 0) continue;

    collect(text, PATH_LIKE).forEach(push);
    collect(text, FILE_LIKE).forEach(push);
    collect(text, KO_OBJECT_PARTICLE).forEach(push);

    const words = collect(text, ASCII_WORD);
    words.forEach((word, index) => {
      if (index === 0 && EN_IMPERATIVE_SET.has(word.toLowerCase())) return;
      push(word);
    });
  }

  const resolved = [];
  for (const subject of subjects) {
    const mapped = resolveTarget(subject);
    const list = Array.isArray(mapped) ? mapped : [mapped];
    for (const item of list) {
      const v = String(item || '').trim();
      if (v.length > 0 && !resolved.includes(v)) resolved.push(v);
    }
  }
  return resolved;
}

/**
 * Project `command_activation` from the execution decisions already made.
 *
 * The schema is explicit that this field is NOT first-class: natural language
 * compiles to an execution profile, and this projection exists only so the
 * Shadow metric "activation vs the slash command the user actually typed" stays
 * measurable. It is never an input, and nothing round-trips through it.
 *
 * Returns `undefined` when there is nothing to project — an all-false object
 * would be indistinguishable from a real decision that everything is off.
 *
 * @param {object} [input]
 * @param {{mode?: string}} [input.planning]
 * @param {{mode?: string}} [input.topology]
 * @param {{required?: boolean}} [input.review]
 * @param {string[]} [input.skills]
 * @returns {object|undefined}
 */
export function projectCommandActivation(input = {}) {
  const { planning, topology, review, skills } = input;
  const activation = {};

  if (planning && typeof planning.mode === 'string') {
    activation.plan = planning.mode === 'plan';
    activation.ultraplan = planning.mode === 'ultraplan';
  }
  if (topology && typeof topology.mode === 'string') {
    activation.autopilot = topology.mode === 'autopilot' || topology.mode === 'autopilot_fast';
    activation.autopilot_fast = topology.mode === 'autopilot_fast';
    activation.split = topology.mode === 'split';
  }
  if (review && typeof review.required === 'boolean') {
    activation.review = review.required;
  }
  if (Array.isArray(skills)) {
    activation.skills = skills.filter((s) => typeof s === 'string');
  }

  return Object.keys(activation).length > 0 ? activation : undefined;
}

function buildSuccess(input) {
  const provided = input.success;
  const success = {};
  for (const key of ['functional', 'behavioral', 'regression', 'evidence']) {
    const list = provided?.[key];
    success[key] = Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
  }
  return success;
}

function buildReducedContract({ goal, requests, confidence, missionId, schemaVersion }) {
  const contract = { goal, explicit_requests: requests };
  if (confidence !== undefined) contract.intent_confidence = confidence;
  if (missionId !== undefined) contract.mission_id = missionId;
  if (schemaVersion !== undefined) contract.schema_version = schemaVersion;
  return contract;
}

/**
 * Copy the caller-supplied optional fields onto a full contract.
 *
 * Every field is pass-through: this compiler decides none of them. Omission is
 * meaningful — an absent key means "nobody decided", which a default value
 * would erase.
 *
 * @param {object} contract - Mutated in place; freshly built by the caller.
 * @param {object} input - `compileMission` input.
 * @returns {void}
 */
function assignOptionalFields(contract, input) {
  const direct = [
    ['schemaVersion', 'schema_version'],
    ['missionId', 'mission_id'],
    ['intentRevision', 'intent_revision'],
    ['status', 'status'],
    ['autonomy', 'autonomy'],
    ['performance', 'performance'],
    ['planning', 'planning'],
    ['completion', 'completion'],
    ['intentConfidence', 'intent_confidence'],
    ['topology', 'topology'],
    ['review', 'review'],
    ['executionProfile', 'execution_profile'],
  ];
  for (const [from, to] of direct) {
    if (input[from] !== undefined) contract[to] = input[from];
  }

  const lists = [
    ['inferredOutcomes', 'inferred_outcomes'],
    ['constraints', 'constraints'],
  ];
  for (const [from, to] of lists) {
    if (Array.isArray(input[from])) {
      contract[to] = input[from].filter((s) => typeof s === 'string');
    }
  }

  if (Array.isArray(input.userDecisions)) contract.user_decisions = input.userDecisions;

  const activation = projectCommandActivation({
    planning: input.planning,
    topology: input.topology,
    review: input.review,
    skills: input.skills,
  });
  if (activation !== undefined) contract.command_activation = activation;
}

/**
 * Compile a prompt into a Mission Contract.
 *
 * @param {object} input
 * @param {string} input.prompt - The raw request. Preserved verbatim in
 *   `meta.originalRequest`; spans index into it.
 * @param {object} [input.intent] - `detectIntent()` output. Recorded, not trusted.
 * @param {object} [input.classification] - Complexity classification.
 * @param {object} [input.config] - Resolved Artibot config.
 * @param {number} [input.nowMs] - Epoch ms. Accepted so callers stay uniform;
 *   this function derives nothing from it (ids are the caller's, per T-24/§3.3).
 * @param {'system1'|'system2'} [input.system='system2'] - system1 → reduced contract.
 * @param {string} [input.goal] - Interpreted goal from T-24. Falls back verbatim.
 * @param {object} [input.intentConfidence] - From `lib/intent/confidence.js` (T-24).
 * @param {object} [input.completion] - `{expected_actions: string[]}`.
 * @param {object[]} [input.candidates] - Boundary candidates for `buildScope`.
 * @param {object[]} [input.blindspotCandidates] - Candidates for the scanner.
 * @param {object} [input.planning] `{mode}` · {object} [input.topology] `{mode}`
 * @param {object} [input.review] `{required, model, status}`
 * @param {object} [input.executionProfile] - T-18's profile, passed through.
 * @param {object} [input.autonomy] · {object} [input.performance]
 * @param {string[]} [input.constraints] · {string[]} [input.inferredOutcomes]
 * @param {string} [input.missionId] · {number} [input.intentRevision]
 * @param {string} [input.status] · {number} [input.schemaVersion]
 * @param {string|null} [input.slashCommand] - Pre-detected; else derived here.
 * @param {object|null} [input.activeMission] · {boolean} [input.followUp]
 * @param {'prompt'|'execution'} [input.stage='prompt'] - Substantive stage.
 * @param {(subject: string) => string[]} [input.resolveTarget] - Target port.
 * @param {Function} [input.validate] - Schema validator port.
 * @returns {{
 *   contract: object,
 *   mode: 'full'|'reduced',
 *   validation: object,
 *   substantive: boolean,
 *   signals: string[],
 *   deferred: boolean,
 *   fidelity: object,
 *   spans: object,
 *   meta: object
 * }}
 */
export function compileMission(input = {}) {
  const prompt = String(input.prompt ?? '');
  const system = input.system === 'system1' ? 'system1' : 'system2';
  const mode = system === 'system1' ? 'reduced' : 'full';

  const { requests, extraction } = extractExplicitRequests(prompt);

  const goalSource = typeof input.goal === 'string' && input.goal.length > 0
    ? 'input'
    : 'derived-from-explicit-request';
  const goal = goalSource === 'input' ? input.goal : (requests[0]?.text ?? '');

  const slashCommand = input.slashCommand !== undefined
    ? input.slashCommand
    : detectSlashCommand(prompt);

  const substantive = judgeSubstantive({
    stage: input.stage ?? 'prompt',
    explicitRequests: requests,
    intentConfidence: input.intentConfidence,
    completion: input.completion,
    slashCommand,
    activeMission: input.activeMission,
    followUp: input.followUp,
  });

  let contract;
  let blindspots = null;
  let boundary = null;

  if (mode === 'reduced') {
    contract = buildReducedContract({
      goal,
      requests,
      confidence: input.intentConfidence,
      missionId: input.missionId,
      schemaVersion: input.schemaVersion,
    });
  } else {
    const requestedTarget = deriveRequestedTargets(requests, {
      resolveTarget: input.resolveTarget,
    });
    boundary = buildScope({ requestedTarget, candidates: input.candidates });
    blindspots = scanBlindspots({
      candidates: input.blindspotCandidates,
      contract: null,
    });

    contract = {
      goal,
      explicit_requests: requests,
      success: buildSuccess(input),
      scope: {
        ...boundary.scope,
        bounded_blindspots: blindspots.findings.bounded_blindspots,
      },
      findings: blindspots.findings,
    };

    assignOptionalFields(contract, input);
  }

  const validation = validateMissionContract(contract, {
    mode,
    validate: input.validate,
  });

  return {
    contract,
    mode,
    validation,
    substantive: substantive.substantive,
    signals: substantive.signals,
    deferred: substantive.deferred,
    fidelity: mode === 'full' ? checkIntentFidelity(contract) : null,
    spans: verifyExplicitRequestSpans(contract, prompt),
    meta: {
      originalRequest: prompt,
      system,
      extraction,
      goalSource,
      slashCommand,
      substantiveJudgment: substantive,
      boundary,
      blindspots,
      // design §3.5 rule 1: an explicit slash command wins, so activation is
      // computed but NOT applied. The contract schema has no field for this
      // (additionalProperties: false), so the marker lives here in meta.
      activation_suppressed_by: slashCommand ? 'explicit-command' : null,
      ledgerEvent: substantive.substantive ? 'mission.created' : 'mission-candidate-deferred',
    },
  };
}
