#!/usr/bin/env node
/**
 * The stale guard behind `/resume --read-order` steps 4 and 6 (CA-08, consumer
 * side): a plan, review or outcome that is not CURRENT is never handed to the
 * model as current truth.
 *
 * ── WHY A PROGRAM AND NOT A SENTENCE ───────────────────────────────────────
 * The write side already refuses to CREATE a stale `outcome.md`
 * (`lib/runtime/artifact-lifecycle-gates.js#blockCodeFor`, unconditional). Nothing
 * stopped a stale file that already exists from being READ back: `/resume`
 * steps 4 and 6 told the model to open `plan.md` / `review.md` / `outcome.md`
 * and summarise them, with no staleness judgement anywhere on that path. A guard
 * written as prose would be one more instruction a model can skip by opening the
 * file directly. So the output of those two steps is produced HERE: for a
 * CURRENT artifact this prints the body for the model to summarise, and for
 * anything else it prints one reason line and the body is never put in front of
 * the model at all. The entry object for a non-CURRENT artifact holds no body,
 * so a rendering slip cannot print one.
 *
 * ── THE JUDGEMENT IS THE CLASSIFIER'S ──────────────────────────────────────
 * `lib/runtime/artifact-lifecycle.js#classifyStaleness` — the function the write
 * side and `/doctor` Check 9 already use — decides. This file adds no second
 * definition of "stale". What it adds is an ALLOWLIST: only the state
 * `CURRENT` is presented. STALE, INVALID, NOT_ACCEPTABLE, BROKEN, a state the
 * classifier vocabulary does not have, a classifier that throws, a file that
 * cannot be read, and a verdict that contradicts an unparseable document are all
 * "not presented". A reader might expect three non-CURRENT states (STALE,
 * INVALID, BROKEN); the classifier has a fourth — an outcome behind its intent
 * is NOT_ACCEPTABLE — which the allowlist covers without naming it.
 *
 * The inputs are the ones the write side uses (`scripts/hooks/mission-complete-record.js`
 * builds the same shape): the artifact's own `based_on` declarations, read from
 * its frontmatter, against the LIVE revisions — intent and plan from the
 * StateStore row, and the review artifact's own revision for an outcome (the
 * store keeps no review revision). Reading both sides from the same file would
 * compare a value with itself and never report staleness.
 *
 * ── ON IS THE SHIPPED STATE, AND OFF MEANS SILENT ──────────────────────────
 * The switch is `runtime.resume.staleGuard`, strict `=== true`, shipped `true` since 2026-09-30.
 * With anything else — a string, a number, an absent key, an absent or
 * unparseable config file — this prints NOTHING and exits 0, before it parses
 * its arguments, reads a single artifact or opens the store; a malformed
 * command line is as silent as a good one. The switch is read first on purpose:
 * the command document reads every non-zero exit as `측정 불가`, so an OFF that
 * could exit 2 would not be a no-op. The document then follows steps 4 and 6
 * exactly as written, so the OFF output is byte-identical to what it was before
 * this file existed. The write-side gates are not parameterised by this key and
 * never will be: a switch that could open them would be a way to turn the gate
 * off.
 *
 * ── REPORT ONLY, AND HOW THAT IS STRUCTURAL ────────────────────────────────
 * This calls no filesystem call that creates, changes or removes anything; it
 * binds none of the store's write ports; and the store it opens has a ledger
 * port that REFUSES rather than no-ops, so a write path reached by accident
 * fails closed instead of committing. It starts no process and touches no
 * network. `tests/checkpoint/read-order-guard-cli.test.js` reads this file's
 * source and pins each of those as an absence, with a self-check that the
 * scanner goes red on a planted write. Opening the store is itself a read:
 * `createStateStore` does path arithmetic only.
 *
 * ── EXIT CODES ─────────────────────────────────────────────────────────────
 *   0  the guard is OFF (empty stdout, whatever the arguments), or a report was
 *      produced — INCLUDING when everything in it is a reason line
 *   1  an unexpected failure escaped `main` (a bug here, not a finding about
 *      the project): the message goes to stderr and NO document is printed
 *   2  usage error while the guard is ON: the command line is wrong and nothing
 *      was read (OFF never parses the command line, so it cannot report this)
 * The command document turns a non-zero exit into `측정 불가` for steps 4 and 6,
 * so a crash can never read as "the guard is off".
 *
 * ── WHAT THIS CANNOT SEE (rules §9) ────────────────────────────────────────
 *   - WHETHER THE MODEL RUNS IT. `/resume` is a prose command. A model that
 *     opens plan.md itself, or runs this and then opens the body anyway,
 *     bypasses the guard; the document forbids both and nothing enforces it.
 *     Live behaviour is unmeasured.
 *   - A PLAN THAT LAGS ITS OWN STORE REVISION. The classifier compares each
 *     artifact's `based_on` with its UPSTREAM's live revision. It never asks
 *     whether `plan.md` is the newest plan, so a plan file at revision 5 beside
 *     a store at plan revision 6 is judged on its intent edge alone (its review
 *     and outcome, which declare plan 5, do flip). Widening that is a change to
 *     the classifier, not to this guard.
 *   - THE ARTIFACT'S CONTENT. Only edges are judged. A CURRENT review can hold a
 *     verdict other than PASS and a CURRENT outcome can hold `accepted: false`
 *     (or `null`, deferred); the body is printed either way. Those two
 *     frontmatter values are not in the excerpt, so they ride on the CURRENT
 *     line (` · verdict …`, ` · accepted …`) — see {@link factsDetail}.
 *   - THE REST OF THE FRONTMATTER. It is dropped from the excerpt and shown
 *     nowhere else: ids (`verification_id`, `findings_ref`), timestamps, the
 *     actor, `evidence_refs`, `supersedes`, a reviewer's identity and a plan's
 *     `mode`. A CURRENT artifact can be read directly if one of them matters.
 *   - THE STORE THIS CHECKOUT WOULD NOT OPEN. The live revisions come from the
 *     store `createStateStore` resolves for `--cwd`. A mission folder copied
 *     between worktrees is judged against whichever store answers there.
 *   - STEPS 3 AND 5, AND THE HANDOFF FALLBACK. Only steps 4 and 6 are guarded; a
 *     handoff written earlier can quote a plan that has since gone stale.
 *   - AN UNREADABLE CONFIG. It reads OFF, silently. An operator who left the
 *     key on and then broke the config file gets no guard and no message.
 *   - LIVE REACH. Production ships the key `true` but had no
 *     `.artibot/missions/` as of 2026-09-29, so nothing here has fired outside a test.
 *
 * USAGE
 *   node scripts/checkpoint/read-order-guard.mjs --mission <M-id> [--cwd <projectRoot>]
 *
 * @module scripts/checkpoint/read-order-guard
 */

import fs from 'node:fs';
import path from 'node:path';

import { readJsonFileSync } from '../../lib/core/file.js';
import { getPluginRoot } from '../../lib/core/platform.js';
import { isMissionId } from '../../lib/mission/mission-id.js';
import { parseOutcomeMd } from '../../lib/mission/outcome-artifact.js';
import { parsePlanMd } from '../../lib/planning/plan-artifact.js';
import { resolveGitCommonDir } from '../../lib/project-state/git-common-dir.js';
import { createStateStore } from '../../lib/project-state/state-manager.js';
import { parseReviewMd } from '../../lib/review/review-artifact.js';
import {
  ARTIFACT_BASENAME,
  ArtifactKind,
  classifyStaleness,
  MISSIONS_DIR,
  StaleState,
} from '../../lib/runtime/artifact-lifecycle.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/**
 * Dotted config path of the stale-guard switch (shipped true). Exported so the
 * reader, the shipped config pin and the command-document pin share one spelling.
 *
 * @type {string}
 */
export const READ_ORDER_STALE_GUARD_CONFIG_PATH = 'runtime.resume.staleGuard';

/** Longest excerpt of a CURRENT body, in characters, before the tail is left out. */
export const EXCERPT_MAX_CHARS = 6000;

/** An artifact larger than this is not read at all (nothing real is this big). */
const MAX_ARTIFACT_BYTES = 1024 * 1024;

const VALUE_FLAGS = ['--mission', '--cwd'];
const USAGE = 'usage: read-order-guard.mjs --mission <M-id> [--cwd <projectRoot>]';

/** The three guarded kinds, in the order the command prints them. */
const KINDS = Object.freeze([ArtifactKind.PLAN, ArtifactKind.REVIEW, ArtifactKind.OUTCOME]);

/** Which read-order step prints each kind (plan is step 4; review and outcome share step 6). */
const STEP_OF = Object.freeze({
  [ArtifactKind.PLAN]: 4,
  [ArtifactKind.REVIEW]: 6,
  [ArtifactKind.OUTCOME]: 6,
});

/** `based_on` member -> the key of the live revision it is judged against. */
const LIVE_KEY_OF = Object.freeze({
  intent_revision: 'intentRevision',
  plan_revision: 'planRevision',
  review_revision: 'reviewRevision',
});

/** Every classifier state except CURRENT. A state outside this set is not presented either. */
const NON_CURRENT = new Set(Object.values(StaleState).filter((state) => state !== StaleState.CURRENT));

const BODY_OPEN = '--- 본문 (CURRENT 산출물) ---';
const BODY_CLOSE = '--- 본문 끝 ---';

const ABSENT = Object.freeze({ presence: 'absent' });

/**
 * Is the guard switched on? Strict `=== true`, so a string `'true'` or a `1`
 * reads OFF: a switch a stray string can flip is not a switch.
 *
 * @param {unknown} cfg - Parsed `artibot.config.json`, or anything at all.
 * @returns {boolean} True only for the literal boolean at the path.
 */
export function readStaleGuardEnabled(cfg) {
  return READ_ORDER_STALE_GUARD_CONFIG_PATH
    .split('.')
    .reduce((node, key) => /** @type {any} */ (node)?.[key], cfg) === true;
}

/**
 * Parse the argument list.
 *
 * @param {string[]} argv - Arguments after the script path.
 * @returns {{opts: {mission: string, cwd?: string}}|{error: string}} Parse result.
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!VALUE_FLAGS.includes(flag)) return { error: `unknown argument: ${flag}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${flag} requires a value` };
    opts[flag.slice(2)] = value;
    i += 1;
  }
  if (typeof opts.mission !== 'string' || opts.mission === '') return { error: '--mission <M-id> is required' };
  return { opts: /** @type {any} */ (opts) };
}

/**
 * A short code that is safe to print: a closed-looking token, never free text.
 *
 * @param {unknown} value - Candidate.
 * @param {string} fallback - Printed when the candidate is not such a token.
 * @returns {string} The token.
 */
function safeToken(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : fallback;
}

/**
 * A non-negative integer, or null.
 *
 * @param {unknown} value - Candidate revision.
 * @returns {number|null} The revision, or null when it is anything else.
 */
function revisionOrNull(value) {
  return Number.isInteger(value) && /** @type {number} */ (value) >= 0 ? /** @type {number} */ (value) : null;
}

/** @param {unknown} n - A revision. @param {string} none - Printed when it is not one. */
const shown = (n, none) => (Number.isInteger(n) ? String(n) : none);

// ─── reading the world (the only part that touches disk) ──────────────────

/**
 * Read one artifact as text, saying which of three things happened. Absent is
 * not the same fact as unreadable: absent means nothing was written, unreadable
 * means something is there that this process cannot turn into text.
 *
 * @param {string} file - Absolute path.
 * @returns {{presence: 'absent'}|{presence: 'unreadable', reason: string}|{presence: 'present', text: string}} Outcome.
 */
function readTextFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { presence: 'unreadable', reason: 'not-a-file' };
    if (stat.size > MAX_ARTIFACT_BYTES) return { presence: 'unreadable', reason: 'too-large' };
    return { presence: 'present', text: fs.readFileSync(file, 'utf-8') };
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    return code === 'ENOENT' ? ABSENT : { presence: 'unreadable', reason: safeToken(code, 'read-failed') };
  }
}

/**
 * The store, opened for reading only. Isomorphic to
 * `scripts/checkpoint/resume-report.mjs#openStores`: no projection file, and a
 * ledger port that REFUSES, so a write path reached by accident fails closed
 * instead of committing an unpaired write.
 *
 * @param {string} projectRoot - Absolute project root.
 * @returns {{getMission: (id: string) => any}} The store.
 */
function openReadOnlyStore(projectRoot) {
  return createStateStore({
    projectRoot,
    sessionId: 'read-order-guard',
    renderProjectionFile: false,
    resolveGitCommonDir: () => resolveGitCommonDir(projectRoot),
    appendEvent: () => ({ ok: false, reason: 'report-only: this CLI binds no ledger writer' }),
  });
}

/**
 * The mission's LIVE intent and plan revisions, from the store row. Never
 * throws: every failure is a `why`, so the caller can print it.
 *
 * A revision the row holds as anything but a non-negative integer (a string
 * `"3"`, a negative number) is `null`, never coerced: the classifier reads
 * `null` as "cannot assert freshness".
 *
 * @param {string} projectRoot - Absolute project root.
 * @param {string} missionId - A validated mission id.
 * @param {(root: string) => {getMission: (id: string) => any}} [openStore] - Store opener (tests).
 * @returns {{ok: true, intentRevision: number|null, planRevision: number|null}|{ok: false, why: string}} Live revisions.
 */
export function readLiveRevisions(projectRoot, missionId, openStore = openReadOnlyStore) {
  let row;
  try {
    row = openStore(projectRoot).getMission(missionId);
  } catch {
    return { ok: false, why: 'store-unreadable' };
  }
  if (row === null || typeof row !== 'object') return { ok: false, why: 'mission-row-absent' };
  return {
    ok: true,
    intentRevision: revisionOrNull(row.intent?.revision),
    planRevision: revisionOrNull(row.plan?.revision),
  };
}

/**
 * Read everything the judgement needs. The id is validated FIRST: an id that
 * fails the pattern builds no path, opens no file and no store.
 *
 * @param {string} projectRoot - Absolute project root.
 * @param {string} missionId - Caller-supplied mission id (untrusted).
 * @param {{readText?: Function, readLive?: Function}} [ports] - Injected reads (tests).
 * @returns {{files: Record<string, object>|null, live: object|null}} Inputs.
 */
export function collectInputs(projectRoot, missionId, ports = {}) {
  if (!isMissionId(missionId)) return { files: null, live: null };
  const read = ports.readText ?? readTextFile;
  /** @type {Record<string, any>} */
  const files = {};
  for (const kind of KINDS) {
    files[kind] = read(path.join(projectRoot, ...MISSIONS_DIR, missionId, ARTIFACT_BASENAME[kind]));
  }
  // The store is opened only when there is something to judge: with all three
  // absent the answer is "부재" whatever the store holds.
  const anyPresent = KINDS.some((kind) => files[kind].presence === 'present');
  const live = anyPresent ? (ports.readLive ?? readLiveRevisions)(projectRoot, missionId) : { ok: false, why: 'not-read' };
  return { files, live };
}

// ─── judging (pure) ────────────────────────────────────────────────────────

/**
 * @param {string[]|undefined} errors - Parser error objects' `code` values.
 * @returns {{ok: false, revision: null, basedOn: null, codes: string[]}} A failed read.
 */
function failedEdges(errors) {
  const codes = [...new Set((errors ?? []).map((e) => safeToken(/** @type {any} */ (e)?.code, '')).filter(Boolean))];
  return { ok: false, revision: null, basedOn: null, codes: codes.length > 0 ? codes : ['UNREADABLE'] };
}

/**
 * Read an artifact's own revision and its declared `based_on`, in the snake_case
 * shape `classifyStaleness` takes. The parsers return camelCase; the mapping is
 * the same one `mission-complete-record.js#buildMissionState` makes.
 *
 * `facts` carries the two frontmatter values the excerpt would otherwise lose
 * and the body does not have to repeat: a review's `verdict` and an outcome's
 * `accepted`. They are read from the PARSED document, never from the body.
 *
 * @param {string} kind - `plan`, `review` or `outcome`.
 * @param {string} text - File text.
 * @returns {{ok: boolean, revision: number|null, basedOn: object|null, facts?: object, codes?: string[]}} Edges.
 */
function parseEdges(kind, text) {
  try {
    if (kind === ArtifactKind.PLAN) {
      const r = parsePlanMd(text);
      if (!r.ok) return failedEdges(r.errors);
      return { ok: true, revision: r.plan.revision, basedOn: { intent_revision: r.plan.basedOn.intentRevision } };
    }
    if (kind === ArtifactKind.REVIEW) {
      const r = parseReviewMd(text);
      if (!r.ok) return failedEdges(r.errors);
      return {
        ok: true,
        revision: r.review.revision,
        basedOn: { intent_revision: r.review.basedOn.intentRevision, plan_revision: r.review.basedOn.planRevision },
        facts: { verdict: r.review.verdict },
      };
    }
    const r = parseOutcomeMd(text);
    if (!r.ok) return failedEdges(r.errors);
    return {
      ok: true,
      revision: null,
      basedOn: {
        intent_revision: r.outcome.basedOn.intentRevision,
        plan_revision: r.outcome.basedOn.planRevision,
        review_revision: r.outcome.basedOn.reviewRevision,
      },
      facts: { accepted: r.outcome.accepted },
    };
  } catch {
    return failedEdges([{ code: 'PARSE_THREW' }]);
  }
}

/**
 * The live revisions in the shape `classifyStaleness` compares against. An
 * unreadable value stays `undefined`/`null`, which the classifier reads as
 * "cannot assert freshness" — BROKEN — rather than as zero.
 *
 * @param {{ok: boolean, intentRevision?: number|null, planRevision?: number|null}} live - Store answer.
 * @param {{ok: boolean, revision: number|null}|null} reviewEdges - The review artifact, when present.
 * @returns {{intentRevision?: number|null, planRevision?: number|null, reviewRevision?: number|null}} Current revisions.
 */
function currentOf(live, reviewEdges) {
  return {
    intentRevision: live?.ok === true ? live.intentRevision : undefined,
    planRevision: live?.ok === true ? live.planRevision : undefined,
    reviewRevision: reviewEdges?.ok === true ? reviewEdges.revision : undefined,
  };
}

/** @param {string} kind - Kind. @param {{ok: boolean, revision: number|null}} edges - Edges. @returns {string} `plan rev 5` / `outcome`. */
function labelOf(kind, edges) {
  return edges.ok && Number.isInteger(edges.revision) ? `${kind} rev ${edges.revision}` : kind;
}

/**
 * `intent_revision 3 = 현재 3, ...` — what a CURRENT verdict rested on.
 *
 * @param {{basedOn: Record<string, number|null>}} edges - Parsed edges.
 * @param {Record<string, unknown>} current - Live revisions.
 * @returns {string} Provenance text.
 */
function currentDetail(edges, current) {
  return Object.keys(edges.basedOn)
    .map((member) => `${member} ${shown(edges.basedOn[member], '없음')} = 현재 ${shown(current[LIVE_KEY_OF[member]], '미확인')}`)
    .join(', ');
}

/**
 * What the frontmatter says that the excerpt drops and the body need not repeat:
 * a review's `verdict` and an outcome's `accepted` flag (true, false, or null for
 * a deferred outcome). A CURRENT outcome whose `accepted` is false has fresh
 * edges and a printable body, and nothing in that body says it was not
 * accepted — so this rides on the CURRENT line, where the model reads it before
 * it summarises. Printed only as tokens: a value that is not one of the expected
 * shapes reads `미상`, never itself, so document text cannot reach the line.
 * A plan has neither field.
 *
 * @param {string} kind - Artifact kind.
 * @param {{verdict?: unknown, accepted?: unknown}|null|undefined} facts - Parsed frontmatter values.
 * @returns {string} ` · verdict PASS`, ` · accepted false`, or the empty string.
 */
export function factsDetail(kind, facts) {
  if (kind === ArtifactKind.REVIEW) return ` · verdict ${safeToken(facts?.verdict, '미상')}`;
  if (kind === ArtifactKind.OUTCOME) {
    const flag = facts?.accepted;
    return ` · accepted ${flag === true || flag === false || flag === null ? String(flag) : '미상'}`;
  }
  return '';
}

/**
 * Why a non-CURRENT verdict is not CURRENT: each offending member with what the
 * artifact declared and what is live, or the parser's error codes.
 *
 * @param {{ok: boolean, basedOn: object|null, codes?: string[]}} edges - Parsed edges.
 * @param {{staleMembers?: string[]}} verdict - Classifier answer.
 * @param {Record<string, unknown>} current - Live revisions.
 * @returns {string} Reason text.
 */
function staleDetail(edges, verdict, current) {
  if (!edges.ok) return `frontmatter 판독 불가(${(edges.codes ?? ['UNREADABLE']).join(',')})`;
  const members = Array.isArray(verdict.staleMembers) ? verdict.staleMembers : [];
  if (members.length === 0) return '사유 미상';
  return members
    .map((member) => {
      const declared = /** @type {any} */ (edges.basedOn)?.[member];
      return `${safeToken(member, 'member')}(선언 ${shown(declared, '없음')}, 현재 ${shown(current[LIVE_KEY_OF[member]], '미확인')})`;
    })
    .join(', ');
}

/** @param {string} label - Artifact label. @param {string} why - Reason. @returns {object} A verdict that presents nothing. */
function unmeasured(label, why) {
  return { presentable: false, state: null, line: `측정 불가: ${label} — ${why} · 본문 미출력` };
}

/**
 * Judge one artifact. The classifier decides; this decides only what to do with
 * its answer, and the default of every branch but one is "do not present".
 *
 * @param {object} input - Judgement inputs.
 * @param {string} input.kind - Artifact kind.
 * @param {object} input.edges - Parsed edges.
 * @param {object} input.current - Live revisions.
 * @param {object} input.live - Store answer (for the note on a missing store).
 * @param {Function} input.classify - The classifier port.
 * @returns {{presentable: boolean, state: string|null, line: string}} Verdict with the one-line text.
 */
function judge({ kind, edges, current, live, classify }) {
  const label = labelOf(kind, edges);
  let verdict;
  try {
    verdict = classify({ kind, basedOn: edges.ok ? edges.basedOn : null, current });
  } catch {
    // The thrown message can quote content; it is deliberately not printed.
    return unmeasured(label, '판정기 예외');
  }
  const state = verdict?.state;
  if (state === StaleState.CURRENT) {
    // A CURRENT verdict for a document that did not parse is a contradiction.
    if (!edges.ok) return unmeasured(label, '판정과 판독이 어긋남');
    const line = `CURRENT: ${label} — ${currentDetail(edges, current)}${factsDetail(kind, edges.facts)}`;
    return { presentable: true, state, line };
  }
  if (!NON_CURRENT.has(state)) return unmeasured(label, '판정 결과를 해석할 수 없음');
  const note = live?.ok === false ? ` · 스토어: ${safeToken(live.why, 'unknown')}` : '';
  return { presentable: false, state, line: `${state}: ${label} — ${staleDetail(edges, verdict, current)}${note} · 본문 미출력` };
}

/**
 * The body of a CURRENT artifact for the model to summarise: frontmatter
 * removed, LF endings, and capped at the last line boundary inside the limit (a
 * hard cut only when the first line alone exceeds it), with the size of what was
 * left out.
 *
 * The frontmatter is NOT all carried elsewhere. The `based_on` edges, a
 * review's `verdict` and an outcome's `accepted` flag are on the CURRENT line
 * ({@link currentDetail}, {@link factsDetail}); every other key — ids,
 * timestamps, actor, evidence and finding refs, `supersedes`, a plan's `mode` —
 * is dropped here and appears nowhere in the output.
 *
 * @param {string} text - File text.
 * @returns {string} Excerpt.
 */
function excerptOf(text) {
  const lf = String(text).replace(/\r\n/g, '\n');
  const fm = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(lf);
  const body = (fm === null ? lf : lf.slice(fm[0].length)).replace(/^\n+/, '').replace(/\n+$/, '');
  if (body.length <= EXCERPT_MAX_CHARS) return body;
  const head = body.slice(0, EXCERPT_MAX_CHARS);
  const lineEnd = head.lastIndexOf('\n');
  const kept = lineEnd > 0 ? head.slice(0, lineEnd) : head;
  return `${kept}\n… (이하 ${body.length - kept.length}자 생략 — CURRENT 산출물이므로 필요하면 직접 Read 해도 된다)`;
}

/**
 * Build the report. Pure: every input arrives as an argument.
 *
 * @param {object} input - Report inputs.
 * @param {string} input.missionId - Caller-supplied mission id (untrusted).
 * @param {Record<string, any>|null} input.files - `kind` -> read outcome, from {@link collectInputs}.
 * @param {object|null} input.live - Store answer.
 * @param {Function} [input.classify] - Classifier port; defaults to `classifyStaleness`.
 * @returns {{valid: boolean, entries: Record<string, any>|null}} The report; `valid: false` for a malformed id.
 */
export function buildGuardReport({ missionId, files, live, classify = classifyStaleness }) {
  if (!isMissionId(missionId)) return { valid: false, entries: null };

  const fileOf = (kind) => files?.[kind] ?? ABSENT;
  /** @type {Record<string, any>} */
  const edges = {};
  for (const kind of KINDS) {
    edges[kind] = fileOf(kind).presence === 'present' ? parseEdges(kind, fileOf(kind).text) : null;
  }
  const current = currentOf(/** @type {any} */ (live), edges[ArtifactKind.REVIEW]);

  /** @type {Record<string, any>} */
  const entries = {};
  for (const kind of KINDS) {
    const base = {
      kind,
      step: STEP_OF[kind],
      rel: `${MISSIONS_DIR.join('/')}/${missionId}/${ARTIFACT_BASENAME[kind]}`,
    };
    entries[kind] = buildEntry(base, fileOf(kind), { edges: edges[kind], current, live, classify });
  }
  return { valid: true, entries };
}

/**
 * One kind's entry. The body exists on the entry ONLY when the verdict allows
 * it, so nothing downstream has to remember to withhold it.
 *
 * @param {{kind: string, step: number, rel: string}} base - Identity of the entry.
 * @param {{presence: string, text?: string, reason?: string}} file - What was read.
 * @param {{edges: object|null, current: object, live: object|null, classify: Function}} judgement - Judgement inputs.
 * @returns {object} The entry.
 */
function buildEntry(base, file, { edges, current, live, classify }) {
  if (file.presence === 'absent') return { ...base, presence: 'absent' };
  if (file.presence !== 'present') {
    // Anything but a read text — including a presence value nobody defined —
    // is unreadable: fail closed.
    const reason = safeToken(file.reason, 'unreadable');
    return { ...base, presence: 'unreadable', reason, verdict: unmeasured(base.kind, `읽을 수 없음(${reason})`) };
  }
  const verdict = judge({ kind: base.kind, edges, current, live, classify });
  const entry = { ...base, presence: 'present', verdict };
  return verdict.presentable ? { ...entry, body: excerptOf(String(file.text)) } : entry;
}

// ─── rendering (pure) ──────────────────────────────────────────────────────

/** @param {any} entry - A report entry. @returns {string} Its block of text. */
function renderEntry(entry) {
  if (entry.presence === 'absent') return `부재: ${entry.rel}`;
  const head = `[${entry.step}/6] ${entry.rel}\n${entry.verdict.line}`;
  return entry.verdict.presentable ? `${head}\n${BODY_OPEN}\n${entry.body}\n${BODY_CLOSE}` : head;
}

/**
 * Render the report as the text the model relays as steps 4 and 6.
 *
 * @param {{valid: boolean, entries: Record<string, any>|null}} report - From {@link buildGuardReport}.
 * @returns {string} Text ending in one newline.
 */
export function renderGuardReport(report) {
  if (!report.valid || report.entries === null) {
    // The malformed id is not echoed, and no path was built from it.
    return [
      '측정 불가: 미션 id 형식 위반 — 4단계 plan.md 를 열지 않는다',
      '측정 불가: 미션 id 형식 위반 — 6단계 review.md·outcome.md 를 열지 않는다',
    ].join('\n\n') + '\n';
  }
  const { plan, review, outcome } = report.entries;
  const step6 = [review, outcome].filter((entry) => entry.presence !== 'absent');
  const blocks = [renderEntry(plan)];
  if (step6.length === 0) blocks.push('부재: review/outcome');
  else blocks.push(...step6.map(renderEntry));
  return `${blocks.join('\n\n')}\n`;
}

// ─── entry point ───────────────────────────────────────────────────────────

/**
 * The plugin's own config, raw, under `getPluginRoot()`. Null when unreadable,
 * which reads OFF.
 *
 * @returns {object|null} Parsed config.
 */
function readPluginConfig() {
  return readJsonFileSync(path.join(getPluginRoot(), 'artibot.config.json'), null);
}

/**
 * Run the guard.
 *
 * @param {string[]} argv - Arguments after the script path.
 * @returns {number} Process exit code.
 */
export function main(argv) {
  // The switch is read FIRST, before the arguments are even parsed. OFF must be
  // a pure no-op for ANY argv: were a malformed command line reported as a usage
  // error (exit 2) while OFF, `commands/resume.md` — which reads every non-zero
  // exit as 측정 불가 for steps 4 and 6 — would break the very path the switch
  // exists to leave alone. So OFF returns 0 with zero bytes, and touches no
  // argument, no artifact and no store.
  if (!readStaleGuardEnabled(readPluginConfig())) return 0;

  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    process.stderr.write(`read-order-guard: ${parsed.error} | ${USAGE}\n`);
    return 2;
  }

  const { mission, cwd } = parsed.opts;
  const projectRoot = path.resolve(typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd());
  const { files, live } = collectInputs(projectRoot, mission);
  process.stdout.write(renderGuardReport(buildGuardReport({ missionId: mission, files, live })));
  return 0;
}

if (isMainEntry(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`read-order-guard: unexpected failure: ${/** @type {any} */ (err)?.message ?? err}\n`);
    process.exitCode = 1;
  }
}
