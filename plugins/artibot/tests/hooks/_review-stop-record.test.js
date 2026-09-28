import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ledgerFilePath } from '../../lib/runtime/ledger.js';
import { recordReviewFromStop } from '../../scripts/hooks/_review-stop-record.js';

/**
 * CA-17 method A on the HOOK path — `recordReviewFromStop` computes the intent
 * binding synchronously and hands its status to the writer as
 * `data.intent_binding`. The binding is keyed on the VERDICT's `mission_id`;
 * the stop's own id is only a cross-check.
 *
 * LIVE REACH, STATED BEFORE ANY GREEN IS READ: `review.completed` = 0 of
 * 33,526 ledger rows (leader count, 2026-09-28 17:07 KST). 분모 0 은 PASS 가
 * 아니다 — 라이브 도달 미관측. The same count found every row's mission id in
 * the session S-form, and the SubagentStop payload is not measured to carry a
 * mission field (`subagent-handler.js:225` reads `hookData?.mission_id ??
 * hookData?.missionId`), so live stops never cross-check. Which value lands
 * live now depends on whether a reviewer's verdict names a mission folder
 * that holds an `intent.md` — UNMEASURED. `match`/`mismatch`/`error` below are
 * fixture-driven.
 *
 * WHAT IS PINNED:
 *  - each of the four statuses reaches the row, through an injected binder;
 *  - the binder is asked about `MISSIONS_DIR/<verdict mission_id>` with the
 *    verdict's `intent_revision` and that id as `expectedMissionId`;
 *  - a stop that DECLARES a different non-fallback mission reads nothing and
 *    records `input_absent`; a fallback or absent stop id does not cross-check;
 *  - through the real port: S-form and N-form folders bind, a moved revision
 *    is `mismatch`, and an intent.md naming another mission is `error`;
 *  - a throwing or shapeless binder records `error` — never "no key";
 *  - an inadmissible verdict writes no row and asks no binder;
 *  - the summary this function returns, and the hook's stdout and exit code,
 *    do not depend on the binding at all (zero rejection, zero blocking).
 *
 * WHAT GREEN HERE DOES NOT PROVE:
 *  - that a real reviewer's `intent_revision` is the revision it actually
 *    read — the verdict document asserts it and nothing checks it;
 *  - that a real reviewer's `mission_id` names the mission it reviewed — it is
 *    the reviewer's claim, checked only against the folder's own front matter;
 *  - THAT ADDING THE KEY NEVER COSTS A ROW. `,"intent_binding":"input_absent"`
 *    is 32 B, counted inside the builder's budget
 *    (`verdict-writer.js#buildReviewCompletedEvent`, `oversize:line`): a row
 *    that sat within 32 B of the 3,968 B budget before this change is now
 *    skipped instead of written. How many live rows sit there is unmeasured —
 *    there are 0 live rows to measure. No fallback retries without the key.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'scripts', 'hooks', 'subagent-handler.js');

const SID = 'sess-ca17-bind-record';
const AGENT_ID = 'agent-ca17';
const MODEL = 'claude-opus-5-5';
/** A declared, counter-form (N-form) id. */
const DECLARED = 'M-20260928-001';
/** Another declared id — a stop that disagrees with the verdict. */
const OTHER_DECLARED = 'M-20260928-002';
/**
 * An S-form id: where `intent.md` lives for a session-derived mission. Its
 * sid8 and date are deliberately NOT what the child process derives from
 * {@link SID}, so binding on the stop's own fallback cannot pass by accident.
 */
const S_MISSION = 'M-20260101-Srevwmiss';
/** A different S-form id: the stop's own session fallback. */
const STOP_FALLBACK = 'M-20260928-Sstopfall';
const STATUSES = ['match', 'mismatch', 'input_absent', 'error'];

let root;
let transcript;

/**
 * @param {object} [over] field overrides
 * @returns {object} a valid reviewOutputV2 document
 */
function v2Doc(over = {}) {
  return {
    schema_version: 2,
    verdict: 'PASS',
    findings: [],
    evidence: [{ kind: 'file', file: 'scripts/hooks/_review-stop-record.js', line: 1 }],
    recommended_action: 'proceed',
    mission_id: DECLARED,
    intent_revision: 2,
    plan_revision: 1,
    diff_ref: 'HEAD~1..HEAD',
    test_evidence: [{ kind: 'command', command: 'npx vitest run tests/hooks', output: 'ok' }],
    regression_evidence: [{ kind: 'command', command: 'npx vitest run tests/hooks', output: 'ok' }],
    verification_id: 'v-ca17',
    next_steps: [],
    ...over,
  };
}

/**
 * @param {object} [over] verdict overrides
 * @returns {string} a reviewer answer carrying the verdict as a fenced block
 */
function answer(over = {}) {
  return ['REVIEW', '', '```json', JSON.stringify(v2Doc(over), null, 2), '```', ''].join('\n');
}

/**
 * @param {string} [text] the reviewer's answer
 * @returns {object} a SubagentStop payload whose transcript names the model
 */
function hookData(text = answer()) {
  const message = { role: 'assistant', model: MODEL, content: [{ type: 'text', text }] };
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message })}\n`, 'utf-8');
  return { agent_transcript_path: transcript, last_assistant_message: text };
}

/**
 * @param {string|null} missionId the stop's resolved mission id
 * @returns {object} the ids `subagent-handler.js#handleStop` passes
 */
function ids(missionId = DECLARED) {
  return { agentId: AGENT_ID, agentType: 'code-reviewer', sessionId: SID, missionId };
}

/**
 * @param {string} folderId mission folder to write into
 * @param {number} revision `intent_revision` to write
 * @param {string} [fmMissionId] front-matter `mission_id`, the folder's by default
 * @returns {void}
 */
function writeIntent(folderId, revision, fmMissionId = folderId) {
  const dir = path.join(root, '.artibot', 'missions', folderId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'intent.md'),
    `---\nmission_id: ${fmMissionId}\nintent_revision: ${revision}\n---\n\n# intent\n`, 'utf-8');
}

/** @returns {object[]} every parsed ledger line, rejections included */
function rawLedger() {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const reviewRows = () => rawLedger().filter((l) => l.event === 'review.completed');
const rejections = () => rawLedger().filter((l) => l.event === 'ledger.rejected');
const bindingOf = () => reviewRows()[0]?.data?.intent_binding;

/**
 * A binder port that returns a fixed status and records what it was asked.
 *
 * @param {unknown} status the status to return
 * @returns {Function & {calls: object[]}} the port
 */
function binderReturning(status) {
  const calls = [];
  const port = (input) => {
    calls.push(input);
    return { status, currentRevision: 2, reviewedRevision: 2, reason: null };
  };
  port.calls = calls;
  return port;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'artibot-ca17-hook-')));
  transcript = path.join(root, 'agent.jsonl');
});

afterEach(() => {
  vi.restoreAllMocks();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('recordReviewFromStop — data.intent_binding', () => {
  it.each(STATUSES)('records %s from the binder on exactly one row', (status) => {
    const bindIntent = binderReturning(status);
    recordReviewFromStop(hookData(), ids(), root, { bindIntent });

    const rows = reviewRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].data.intent_binding).toBe(status);
    expect(rejections()).toHaveLength(0);
  });

  it('asks the binder about the verdict mission folder, revision and id', () => {
    const bindIntent = binderReturning('match');
    recordReviewFromStop(hookData(), ids(), root, { bindIntent });

    expect(bindIntent.calls).toEqual([{
      missionDir: path.join(root, '.artibot', 'missions', DECLARED),
      reviewedRevision: 2,
      expectedMissionId: DECLARED,
    }]);
  });

  it('returns the same summary and writes no stdout whatever the status', () => {
    const write = vi.spyOn(process.stdout, 'write');
    const summaries = STATUSES.map((status) => {
      rmSync(ledgerFilePath(root), { force: true });
      return recordReviewFromStop(hookData(), ids(), root, { bindIntent: binderReturning(status) });
    });
    for (const s of summaries) expect(s).toEqual(summaries[0]);
    expect(summaries[0].review).toBe('appended');
    expect(write).not.toHaveBeenCalled();
  });

  it('records mismatch as one appended row and no rejection', () => {
    const out = recordReviewFromStop(hookData(), ids(), root, {
      bindIntent: binderReturning('mismatch'),
    });
    expect(out.review).toBe('appended');
    expect(out.reviewReason).toBeNull();
    expect(reviewRows()).toHaveLength(1);
    expect(rejections()).toHaveLength(0);
  });

  it('records error, and still ends normally, when the binder throws', () => {
    const out = recordReviewFromStop(hookData(), ids(), root, {
      bindIntent: () => { throw new Error('disk on fire'); },
    });
    expect(out.review).toBe('appended');
    expect(out).not.toHaveProperty('error');
    expect(bindingOf()).toBe('error');
  });

  it.each([
    ['undefined', undefined],
    ['a status-less object', {}],
    ['a bare string', 'match'],
  ])('records error when the binder returns %s', (_label, value) => {
    recordReviewFromStop(hookData(), ids(), root, { bindIntent: () => value });
    expect(bindingOf()).toBe('error');
  });

  it('reads nothing and records input_absent when the stop declares another mission', () => {
    const bindIntent = binderReturning('match');
    recordReviewFromStop(hookData(answer({ mission_id: OTHER_DECLARED })), ids(DECLARED), root,
      { bindIntent });

    expect(bindIntent.calls).toEqual([]);
    expect(reviewRows()).toHaveLength(1);
    expect(bindingOf()).toBe('input_absent');
  });

  it.each([
    ['the session fallback id', STOP_FALLBACK],
    ['no mission id', null],
  ])('does not cross-check %s and binds on the verdict id', (_label, stopId) => {
    const bindIntent = binderReturning('match');
    recordReviewFromStop(hookData(answer({ mission_id: S_MISSION })), ids(stopId), root,
      { bindIntent });

    expect(bindIntent.calls).toEqual([{
      missionDir: path.join(root, '.artibot', 'missions', S_MISSION),
      reviewedRevision: 2,
      expectedMissionId: S_MISSION,
    }]);
    expect(bindingOf()).toBe('match');
  });

  it('writes no row and asks no binder for an inadmissible verdict', () => {
    const bindIntent = binderReturning('match');
    const out = recordReviewFromStop(hookData('APPROVE'), ids(), root, { bindIntent });

    expect(out.review).toBe('skipped');
    expect(bindIntent.calls).toEqual([]);
    expect(reviewRows()).toHaveLength(0);
  });
});

describe('recordReviewFromStop — the default binder reads intent.md', () => {
  it('records match under the verdict S-form mission id, the stop being a fallback', () => {
    writeIntent(S_MISSION, 2);
    recordReviewFromStop(hookData(answer({ mission_id: S_MISSION })), ids(STOP_FALLBACK), root);
    expect(bindingOf()).toBe('match');
  });

  it('records mismatch under the verdict S-form mission id when intent.md moved on', () => {
    writeIntent(S_MISSION, 3);
    recordReviewFromStop(hookData(answer({ mission_id: S_MISSION })), ids(STOP_FALLBACK), root);
    expect(bindingOf()).toBe('mismatch');
  });

  it('records match under an N-form verdict mission id', () => {
    writeIntent(DECLARED, 2);
    recordReviewFromStop(hookData(), ids(), root);
    expect(bindingOf()).toBe('match');
  });

  it('records error when intent.md names another mission than its folder', () => {
    writeIntent(S_MISSION, 2, DECLARED);
    recordReviewFromStop(hookData(answer({ mission_id: S_MISSION })), ids(STOP_FALLBACK), root);
    expect(bindingOf()).toBe('error');
  });

  it('records input_absent when intent.md does not exist', () => {
    recordReviewFromStop(hookData(), ids(), root);
    expect(bindingOf()).toBe('input_absent');
  });

  it('records input_absent from the real ENOENT error, not a message match', () => {
    // The folder exists, the file does not: the port must hand over the fs
    // error object itself, whose `.code` is what the binder reads.
    mkdirSync(path.join(root, '.artibot', 'missions', DECLARED), { recursive: true });
    recordReviewFromStop(hookData(), ids(), root);
    expect(bindingOf()).toBe('input_absent');
  });

  it('records error for a read error that is not ENOENT', () => {
    // A DIRECTORY at the file's path makes the read fail with another code.
    mkdirSync(path.join(root, '.artibot', 'missions', DECLARED, 'intent.md'), { recursive: true });
    recordReviewFromStop(hookData(), ids(), root);
    expect(bindingOf()).toBe('error');
  });

  it('records error when intent.md has no front matter', () => {
    const dir = path.join(root, '.artibot', 'missions', DECLARED);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'intent.md'), '# no front matter\n', 'utf-8');
    recordReviewFromStop(hookData(), ids(), root);
    expect(bindingOf()).toBe('error');
  });
});

describe('SubagentStop child process — a mismatch changes neither stdout nor exit code', () => {
  it('exits 0 with the deregistration message and one mismatch row, live-shaped', () => {
    // A repo, so the child's `resolveProjectRoot(cwd)` stops here instead of
    // climbing to a weak marker above the temp dir.
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore', windowsHide: true });
    const home = path.join(root, 'home');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeIntent(S_MISSION, 5);
    // No payload `mission_id`, as measured live: the stop resolves to its own
    // session fallback, and only the verdict's id names the folder.
    const payload = {
      ...hookData(answer({ mission_id: S_MISSION })),
      agent_id: AGENT_ID,
      agent_type: 'code-reviewer',
      cwd: root,
      hook_event_name: 'SubagentStop',
      session_id: SID,
    };
    const res = spawnSync(process.execPath, [HOOK, 'stop'], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
      windowsHide: true,
    });

    expect(res.status).toBe(0);
    expect(JSON.parse(String(res.stdout))).toEqual({
      message: `[team] Agent deregistered: ${AGENT_ID}`,
    });
    const rows = reviewRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].data.intent_binding).toBe('mismatch');
    expect(rejections()).toHaveLength(0);
  }, 60000);
});
