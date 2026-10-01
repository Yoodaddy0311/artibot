/**
 * `scripts/hooks/tool-used-record.js` — the `AskUserQuestion` carrier (SH-09).
 *
 * This suite was split out of `tool-used-record.test.js`, the Skill writer
 * suite, so that neither file passes the 800-line standard. The five describe
 * blocks below moved unchanged. The sandbox helpers (`readLedger`, `payload`,
 * `runHook`), the `ASK_TOOL` constant and the `beforeEach` / `afterEach` pair
 * are repeated from that file with their comments, so the "see the header" in
 * the comment on `payload` means that file's header. The helpers that only
 * these cases use (the fixture loader, the privacy scan, `recordAskRows`,
 * `makeBlockedRepo`) moved with them.
 *
 * EVERY CASE RUNS IN A `mkdtemp` SANDBOX WITH ITS OWN `.git`, for the same
 * reason as in that file: after ADR-011 the ledger lives inside the git common
 * dir, so a sandbox without one resolves to an ancestor and a test would write
 * into the real store it is supposed to be measuring. The levels the cases run
 * at (the envelope in process, an `appendLedgerEvent` round trip, a spawn of
 * the real hook) are described in that file's header.
 *
 * SH-09 (2026-09-29, limb sh09-askuser-carrier) ADDS A SECOND RECORDED TOOL,
 * `AskUserQuestion`, so question frequency is live-measurable from the ledger.
 * V5-BACKLOG SH-09's purpose is the question-frequency EFFECT of the
 * constitution stage B change, and that effect had no live carrier. Its cases
 * sit in the `AskUserQuestion carrier (SH-09)` describe blocks and share ONE
 * fixture, `tests/hooks/fixtures/askuser/PostToolUse.AskUserQuestion.json`,
 * which is DOCUMENT-BASED and NOT LIVE-CAPTURED (문서 기반, 라이브 미캡처):
 * PostToolUse(AskUserQuestion) fires only after a human answers, so no
 * unattended probe can freeze it. What that costs these cases:
 *   - A HOST THAT SENDS ANOTHER AskUserQuestion SHAPE STAYS GREEN HERE. Only a
 *     real capture can catch it, which is why the writer reads nothing but keys
 *     the Skill probe measured on the PostToolUse envelope plus an optional
 *     boolean `tool_response.success`.
 *   - WHETHER A DECLINED OR INTERRUPTED QUESTION REACHES PostToolUse AT ALL is
 *     unmeasured. It may divert to PostToolUseFailure, which this writer is not
 *     wired to, so the rows are ANSWERED calls at best and are not comparable
 *     one-to-one with a transcript census of `tool_use` blocks.
 *   - THE UNIT IS ONE ROW PER TOOL CALL, and one call can carry several
 *     questions. The number of questions is deliberately not recorded.
 *
 * @module tests/hooks/tool-used-record-askuser
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendLedgerEvent, ledgerFilePath, readAllEvents } from '../../lib/runtime/ledger.js';
import { buildExistenceAudit, CARRIERS, foldFiredCounts } from '../../lib/replay/existence-audit.js';
import {
  buildEnvelope, lineBytes, validateEnvelope, validateEventContract,
} from '../../lib/runtime/event-writer.js';
import {
  buildToolUsedEnvelope, record, RECORDED_TOOLS, SKILL_TOOL, TOOL_USED_EVENT,
} from '../../scripts/hooks/tool-used-record.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'tool-used-record.js');

/** A session id with >= 8 alphanumerics, so the session fallback mission id is
 *  issuable rather than a throw. Deliberately NOT the host's 32-hex shape: the
 *  quality-gate secret scanner reads a bare 32-hex literal as a credential. */
const SESSION_ID = 'sess-tool-used-record-fixture-0001';
const TOOL_USE_ID = 'toolu_01ToolUsedRecordFixture';
/** A real skill name with the `artibot:` namespace and a colon in it. */
const SKILL_NAME = 'artibot:split';

let tmp;
let home;
let repo;

/** Parsed ledger lines for a sandbox root, `[]` when the file was never made. */
function readLedger(root) {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** A synthetic PostToolUse(`Skill`) payload. INFERRED shape — see the header. */
function payload(over = {}) {
  return {
    hook_event_name: 'PostToolUse',
    session_id: SESSION_ID,
    cwd: repo,
    tool_name: SKILL_TOOL,
    tool_use_id: TOOL_USE_ID,
    tool_input: { skill: SKILL_NAME },
    ...over,
  };
}

/** Run the REAL hook the way the dispatcher does: fresh process, JSON on stdin. */
function runHook(raw) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: raw,
    cwd: repo,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
  });
  const stdout = res.stdout ?? Buffer.alloc(0);
  return { status: res.status, stdoutBytes: stdout.length, stderr: String(res.stderr ?? '') };
}

/** The second recorded tool (SH-09). Spelled here, not imported, so a missing export cannot masquerade as a value. */
const ASK_TOOL = 'AskUserQuestion';

/** DOCUMENT-BASED, NOT LIVE-CAPTURED (문서 기반, 라이브 미캡처). See the header. */
const ASK_FIXTURE = JSON.parse(readFileSync(
  path.join(PLUGIN_ROOT, 'tests', 'hooks', 'fixtures', 'askuser', 'PostToolUse.AskUserQuestion.json'),
  'utf-8',
));

/**
 * A declared mission id, so two envelopes built milliseconds (or a midnight)
 * apart still compare equal instead of differing in the session fallback date.
 */
const ASK_MISSION_ID = 'M-20260929-Ssessaske';

/** The fixture payload aimed at this case's sandbox repo. `cwd` is ALWAYS overwritten: the fixture's is a placeholder. */
function askPayload(over = {}) {
  return { ...structuredClone(ASK_FIXTURE.payload), cwd: repo, ...over };
}

/** Every string inside `value`, object keys included: the text a leak would have to contain. */
function stringLeaves(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      stringLeaves(item, out);
    }
  }
  return out;
}

/**
 * The strings a content leak from `asked` would have to contain: every string in
 * its tool_input and tool_response that carries the SYNTHETIC- marker. A text
 * value WITHOUT the marker is invisible to the scan built on this.
 */
function contentMarkers(asked) {
  return stringLeaves([asked.tool_input, asked.tool_response]).filter((s) => s.includes('SYNTHETIC-'));
}

/** The content markers found anywhere in the serialised envelope. Empty means the row leaks nothing the scan can see. */
function leakedMarkers(env, asked) {
  const serialised = JSON.stringify(env);
  return contentMarkers(asked).filter((marker) => serialised.includes(marker));
}

/** Write `n` AskUserQuestion rows through the real `record()`, each with its own tool_use_id. */
function recordAskRows(n) {
  for (let i = 1; i <= n; i += 1) {
    const result = record(askPayload({ tool_use_id: `toolu_askuser_row_${i}` }));
    expect(result.ok, `AskUserQuestion row ${i} must be written`).toBe(true);
  }
}

/** A second sandbox repo whose ledger directory is blocked by a plain file, so any append fails. */
function makeBlockedRepo() {
  const blocked = path.join(tmp, 'blocked');
  mkdirSync(blocked, { recursive: true });
  // `git init` FIRST: after ADR-011 the ledger parent lives inside the git
  // common dir, so it can only be named once the repository exists.
  execFileSync('git', ['init'], { cwd: blocked, stdio: 'ignore', windowsHide: true });
  writeFileSync(path.dirname(ledgerFilePath(blocked)), 'not a dir', 'utf-8');
  return blocked;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-tool-used-')));
  home = path.join(tmp, 'home');
  repo = path.join(tmp, 'repo');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', windowsHide: true });
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SH-09: the AskUserQuestion carrier. ONE `tool.used` row per question call,
// fitted to the EXISTING vocabulary (required tool / ok / duration_ms; the
// allowlist is not changed). The payload is DOCUMENT-BASED, NOT LIVE-CAPTURED.
// ---------------------------------------------------------------------------

describe('AskUserQuestion carrier (SH-09): envelope', () => {
  it('records tool=AskUserQuestion with the host duration_ms and no other data key', () => {
    const env = buildToolUsedEnvelope(askPayload());
    expect(env).not.toBeNull();
    expect(env.event).toBe(TOOL_USED_EVENT);
    expect(env.source).toBe('hook');
    expect(env.session_id).toBe(ASK_FIXTURE.payload.session_id);
    expect(env.action_id).toBe(ASK_FIXTURE.payload.tool_use_id);
    expect(env.data).toEqual({ tool: ASK_TOOL, ok: true, duration_ms: 15234 });
  });

  it('writes only the three required allowlist keys: no skill, no question count, no text', () => {
    const env = buildToolUsedEnvelope(askPayload());
    expect(env).not.toBeNull();
    expect(Object.keys(env.data).sort()).toEqual(['duration_ms', 'ok', 'tool']);
  });

  // PRIVACY. A question and its answer are the user's own words. The frequency
  // is the measurement; the content is not needed and must not reach a ledger
  // that other tools read and copy.
  it('never carries question, option, header or answer text from the payload', () => {
    const asked = askPayload();
    // Scanner self-check: a fixture that lost its markers would make the scan below vacuous.
    expect(contentMarkers(asked).length).toBeGreaterThanOrEqual(20);
    const env = buildToolUsedEnvelope(asked);
    expect(env).not.toBeNull();
    expect(leakedMarkers(env, asked)).toEqual([]);
  });

  // THE SCAN SEES ONLY MARKED TEXT, so an unmarked value is a blind spot. The
  // header was one ("Format"/"Checks"): a mutant that leaked it into the row
  // passed the scan above and was caught only by the three-key pins.
  it('marks every text value in the fixture, so the privacy scan can see all of it', () => {
    const unmarked = [];
    const visit = (value, where) => {
      if (typeof value === 'string') {
        if (!value.includes('SYNTHETIC-')) unmarked.push(`${where} = ${JSON.stringify(value)}`);
      } else if (Array.isArray(value)) {
        value.forEach((item, i) => visit(item, `${where}[${i}]`));
      } else if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) visit(item, `${where}.${key}`);
      }
    };
    const { tool_input: input, tool_response: response } = ASK_FIXTURE.payload;
    visit(input, 'tool_input');
    visit(response, 'tool_response');
    // `answers` is keyed by the question text itself, so its KEYS are user text too.
    for (const key of Object.keys(response.answers)) {
      if (!key.includes('SYNTHETIC-')) unmarked.push(`tool_response.answers key ${JSON.stringify(key)}`);
    }
    expect(unmarked).toEqual([]);
  });

  // NEGATIVE CONTROL for the scan itself: each text category is planted into a
  // copy of a real row and must be flagged, and the untouched row must be clean.
  it.each([
    ['question text', (asked) => asked.tool_input.questions[0].question],
    ['header', (asked) => asked.tool_input.questions[0].header],
    ['option label', (asked) => asked.tool_input.questions[0].options[0].label],
    ['option description', (asked) => asked.tool_input.questions[0].options[0].description],
    ['answer', (asked) => Object.values(asked.tool_response.answers)[0]],
  ])('the privacy scan flags a leaked %s', (_label, pick) => {
    const asked = askPayload();
    const env = buildToolUsedEnvelope(asked);
    expect(env).not.toBeNull();
    expect(leakedMarkers(env, asked)).toEqual([]);
    const leaked = { ...env, data: { ...env.data, leak: pick(asked) } };
    expect(leakedMarkers(leaked, asked)).toContain(pick(asked));
  });

  it('omits skill even when a crafted tool_input names one', () => {
    const env = buildToolUsedEnvelope(askPayload({
      tool_input: { skill: 'artibot:split', questions: [] },
    }));
    expect(env).not.toBeNull();
    expect('skill' in env.data).toBe(false);
  });

  it.each([
    ['absent', undefined],
    ['a string', '15234'],
    ['negative', -1],
  ])('falls back to null duration_ms when the host value is %s', (_label, value) => {
    const env = buildToolUsedEnvelope(askPayload({ duration_ms: value }));
    expect(env).not.toBeNull();
    // The key must EXIST either way: the allowlist lists it in `required`.
    expect('duration_ms' in env.data).toBe(true);
    expect(env.data.duration_ms).toBeNull();
  });

  // The documented AskUserQuestion response carries NO `success` key, so the
  // writer's default (PostToolUse is the success slot) is what a normal call
  // records. `ok:true` here means "PostToolUse fired and the host said nothing
  // about failure". It does NOT mean "the user picked an option".
  it('records ok:true for the documented response and follows an explicit host success:false', () => {
    const normal = buildToolUsedEnvelope(askPayload());
    expect(normal).not.toBeNull();
    expect(normal.data.ok).toBe(true);
    const failed = buildToolUsedEnvelope(askPayload({
      tool_response: { ...ASK_FIXTURE.payload.tool_response, success: false },
    }));
    expect(failed).not.toBeNull();
    expect(failed.data.ok).toBe(false);
  });

  it('reads the tool name from the `tool` alias when `tool_name` is absent', () => {
    const env = buildToolUsedEnvelope(askPayload({ tool_name: undefined, tool: ASK_TOOL }));
    expect(env).not.toBeNull();
    expect(env.data.tool).toBe(ASK_TOOL);
  });

  it.each([
    ['askuserquestion'], ['ASKUSERQUESTION'], ['AskUserQuestionTool'], ['AskUserQuestion '],
    ['ask_user_question'], ['mcp__host__AskUserQuestion'],
  ])('returns null for tool %j (exact match: no case fold, prefix or suffix)', (tool) => {
    expect(buildToolUsedEnvelope(askPayload({ tool_name: tool }))).toBeNull();
  });

  it('returns null without a session_id (the envelope layer would reject it)', () => {
    expect(buildToolUsedEnvelope(askPayload({ session_id: undefined }))).toBeNull();
  });

  it('pins the recorded-tool allowlist to exactly Skill and AskUserQuestion', () => {
    expect(RECORDED_TOOLS).toEqual([SKILL_TOOL, ASK_TOOL]);
    expect(Object.isFrozen(RECORDED_TOOLS)).toBe(true);
  });
});

describe('AskUserQuestion carrier (SH-09): ledger round trip', () => {
  it('writes exactly one accepted tool.used row for an AskUserQuestion call', () => {
    const env = buildToolUsedEnvelope(askPayload());
    expect(env).not.toBeNull();
    expect(appendLedgerEvent(repo, env).ok).toBe(true);

    const lines = readLedger(repo);
    // A rejection is also a written line, so the rejection stream is asserted
    // empty on its own instead of being inferred from the row count.
    expect(lines.filter((l) => l.event === 'ledger.rejected')).toEqual([]);
    const used = lines.filter((l) => l.event === TOOL_USED_EVENT);
    expect(used).toHaveLength(1);
    expect(used[0].data).toEqual({ tool: ASK_TOOL, ok: true, duration_ms: 15234 });
    expect(used[0].source).toBe('hook');
    expect(validateEnvelope(used[0])).toBeNull();
    expect(validateEventContract(used[0])).toBeNull();
  });

  // THE CONSTRAINT ON THIS LIMB: schemas/ledger-events.allowlist.json is not
  // changed. Asserted as "the row fits", not as "the allowlist equals X", so an
  // unrelated optional field added to tool.used later cannot fail this.
  it('fits the existing tool.used vocabulary: every data key is allowlisted, every required key is present', () => {
    const allowlist = JSON.parse(readFileSync(
      path.join(PLUGIN_ROOT, 'schemas', 'ledger-events.allowlist.json'), 'utf-8',
    ));
    const spec = allowlist.events[TOOL_USED_EVENT];
    expect(spec.sources).toContain('hook');
    const env = buildToolUsedEnvelope(askPayload());
    expect(env).not.toBeNull();
    const allowed = new Set([...spec.required, ...Object.keys(spec.fields ?? {})]);
    for (const key of Object.keys(env.data)) {
      expect(allowed.has(key), `data.${key} is not in the tool.used allowlist`).toBe(true);
    }
    for (const key of spec.required) {
      expect(key in env.data, `required key ${key} is missing from the row`).toBe(true);
    }
  });

  // CONTENT-FREE, THEREFORE SIZE-FREE. However long the question is, the
  // envelope is the same object, so the writer's byte-cap fold (which keeps only
  // the required keys) can never be what shortens a question row.
  it('is independent of question length: a 50 KB question yields the identical envelope', () => {
    const small = buildToolUsedEnvelope(askPayload({ mission_id: ASK_MISSION_ID }));
    const big = askPayload({ mission_id: ASK_MISSION_ID });
    const huge = 'q'.repeat(50 * 1024);
    big.tool_input.questions[0].question = huge;
    big.tool_response.answers = { [huge]: huge };
    const large = buildToolUsedEnvelope(big);
    expect(small).not.toBeNull();
    expect(large).toEqual(small);
    expect(lineBytes(buildEnvelope(large))).toBeLessThan(1024);
  });

  it('record() fails closed with no-cwd rather than aiming at another repository', () => {
    const result = record(askPayload({ cwd: undefined }));
    expect(result).toEqual({ ok: false, reason: 'no-cwd' });
    expect(readLedger(repo)).toEqual([]);
  });

  it('record() reports an append failure, and does not throw, when the ledger cannot be written', () => {
    const blocked = makeBlockedRepo();
    let result;
    expect(() => { result = record(askPayload({ cwd: blocked })); }).not.toThrow();
    expect(result.ok).toBe(false);
    // Not "not-recordable": the row WAS built and the append WAS attempted.
    expect(result.reason).not.toBe('not-recordable');
    expect(existsSync(ledgerFilePath(blocked))).toBe(false);
  });
});

describe('AskUserQuestion carrier (SH-09): hook process contract', () => {
  it('exits 0 with an empty stdout and writes the row for the fixture payload', () => {
    const { status, stdoutBytes } = runHook(JSON.stringify(askPayload()));
    expect(status).toBe(0);
    expect(stdoutBytes).toBe(0);
    const used = readLedger(repo).filter((l) => l.event === TOOL_USED_EVENT);
    expect(used).toHaveLength(1);
    expect(used[0].data).toEqual({ tool: ASK_TOOL, ok: true, duration_ms: 15234 });
  });

  // FAIL OPEN. A recording failure must never surface: PostToolUse cannot
  // cancel a finished tool call, but a non-zero exit is reported to the model
  // and stdout is merged into the hook output the host acts on.
  it('fails open when the ledger cannot be written: exit 0, empty stdout, no row', () => {
    const blocked = makeBlockedRepo();
    const { status, stdoutBytes } = runHook(JSON.stringify(askPayload({ cwd: blocked })));
    expect(status).toBe(0);
    expect(stdoutBytes).toBe(0);
    expect(existsSync(ledgerFilePath(blocked))).toBe(false);
  });

  it.each([
    ['no session_id', () => JSON.stringify(askPayload({ session_id: undefined }))],
    ['no cwd', () => JSON.stringify(askPayload({ cwd: undefined }))],
    ['a truncated JSON body', () => JSON.stringify(askPayload()).slice(0, 60)],
    ['a bare tool name', () => JSON.stringify({ tool_name: ASK_TOOL })],
  ])('exits 0 with empty stdout for %s, and writes nothing', (_label, raw) => {
    const { status, stdoutBytes } = runHook(raw());
    expect(status).toBe(0);
    expect(stdoutBytes).toBe(0);
    expect(readLedger(repo)).toEqual([]);
  });
});

describe('AskUserQuestion carrier (SH-09): fixture provenance', () => {
  it('declares itself document-based and not live-captured', () => {
    expect(ASK_FIXTURE.label_ko).toBe('문서 기반, 라이브 미캡처');
    expect(ASK_FIXTURE.provenance).toBe('document-based-not-live-captured');
    expect(ASK_FIXTURE.live_captured).toBe(false);
    expect(ASK_FIXTURE._note).toContain('문서 기반, 라이브 미캡처');
  });

  it('keeps every envelope key inside the PostToolUse key set measured live on the Skill tool', () => {
    const live = JSON.parse(readFileSync(
      path.join(PLUGIN_ROOT, 'tests', 'hooks', 'fixtures', 'host-payloads', 'PostToolUse.Skill.json'),
      'utf-8',
    ));
    const measured = new Set(live.PostToolUse.top_level_keys);
    for (const key of Object.keys(ASK_FIXTURE.payload)) {
      expect(measured.has(key), `${key} was never measured on a live PostToolUse payload`).toBe(true);
    }
    expect(ASK_FIXTURE.payload.tool_name).toBe(ASK_TOOL);
    // The fixture's own cwd stays a placeholder: a real path here could aim a
    // test at a real repository.
    expect(path.isAbsolute(ASK_FIXTURE.payload.cwd)).toBe(false);
  });
});

describe('AskUserQuestion carrier (SH-09): interplay with the existence audit (scoped by R1 / OB-24)', () => {
  // SH-09 made `tool.used` carry AskUserQuestion beside Skill. Until R1 / OB-24
  // (2026-09-29) `CARRIERS.skills` filtered on the EVENT ONLY, so every question
  // row landed in the skills fold's `absent` bucket and its denominator (absent 2,
  // denominator 3 on this fixture), and a ledger holding only question rows read
  // every skill as `measured: true, fired: 0`. The two cases below were the
  // "KNOWN INTERPLAY" pins that recorded that; they were flipped, not loosened,
  // when the carrier gained `where: { tool: 'Skill' }`. The first case pins what
  // the scope never changed.
  const SCOPE_NOTE = 'CARRIERS.skills must be scoped to tool==="Skill": a question row names no '
    + 'skill, so it is not a row of the skills carrier (absent 0, denominator 1, and a '
    + 'questions-only ledger is unmeasured). If this fails, the scope was widened or dropped.';

  /** One Skill row plus two question rows, read back the way the audit reads them. */
  function seedMixed() {
    expect(record(payload()).ok).toBe(true);
    recordAskRows(2);
    const events = readAllEvents(repo);
    return {
      events,
      fold: foldFiredCounts(events, CARRIERS.skills),
      audit: buildExistenceAudit(events, { inventory: { skills: [SKILL_NAME, 'artibot:other'] } }),
    };
  }

  it('never credits a skill for a question row: per-skill fired counts are unchanged', () => {
    const { events, fold, audit } = seedMixed();
    expect(events.filter((e) => e.event === TOOL_USED_EVENT && e.data?.tool === ASK_TOOL)).toHaveLength(2);
    expect(fold.counts).toEqual({ [SKILL_NAME]: 1 });
    const fired = Object.fromEntries(audit.kinds.skills.entries.map((e) => [e.name, e.fired]));
    expect(fired).toEqual({ [SKILL_NAME]: 1, 'artibot:other': 0 });
  });

  it('FLIPPED (was KNOWN INTERPLAY): question rows are not rows of the skills fold: absent 0, denominator 1', () => {
    const { fold, audit } = seedMixed();
    expect(fold.absent, SCOPE_NOTE).toBe(0);
    expect(fold.denominator, SCOPE_NOTE).toBe(1);
    expect(audit.kinds.skills.denominator, SCOPE_NOTE).toBe(1);
  });

  it('FLIPPED (was KNOWN INTERPLAY): a ledger holding only question rows reads every skill as UNMEASURED', () => {
    // Control, the pre-carrier state of the same kind: no tool.used row at all is UNMEASURED.
    const before = buildExistenceAudit([], { inventory: { skills: [SKILL_NAME] } }).kinds.skills.entries[0];
    expect(before.measured).toBe(false);
    expect(before.fired).toBeNull();
    expect(before.reason).toBe('unmeasured:carrier-event-absent-from-ledger');

    recordAskRows(1);
    const after = buildExistenceAudit(readAllEvents(repo), { inventory: { skills: [SKILL_NAME] } })
      .kinds.skills.entries[0];
    // The row really is in the ledger, so this is not the empty-ledger case in disguise.
    expect(readAllEvents(repo).filter((e) => e.event === TOOL_USED_EVENT && e.data?.tool === ASK_TOOL)).toHaveLength(1);
    expect(after.measured, SCOPE_NOTE).toBe(false);
    expect(after.fired, SCOPE_NOTE).toBeNull();
    expect(after.reason, SCOPE_NOTE).toBe('unmeasured:carrier-event-absent-from-ledger');
  });
});
