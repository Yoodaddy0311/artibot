/**
 * `scripts/hooks/tool-used-record.js` — the `tool.used` WRITER.
 *
 * WHY THIS SUITE EXISTS. `tool.used` was a registered event with no emitter:
 * `grep -rn "tool\.used" lib scripts` returned readers and comments only, and
 * the live ledger held 0 `tool.used` rows out of 1,052 lines (measured
 * 2026-09-15 ~10:5x KST). `lib/replay/existence-audit.js#CARRIERS.skills`
 * therefore answered `unmeasured` for every skill. This suite pins the writer
 * that closes that gap, at three levels:
 *
 *   1. `buildToolUsedEnvelope` IN PROCESS — the omit/null decision and the
 *      routing guard live in the return value and nowhere else (the hook is
 *      mute by design and cannot report them).
 *   2. `appendLedgerEvent` ROUND TRIP against a `mkdtemp` + `git init` sandbox
 *      — proves the envelope survives BOTH validation layers, because a
 *      rejected line is still a written line (`ledger.rejected`) and a suite
 *      that only counted lines would read a rejection as a success.
 *   3. ONE SPAWN of the real hook as a CHILD PROCESS — the only place the exit
 *      status and the stdout byte count are observable. PostToolUse stdout is
 *      merged by the dispatcher, so "prints nothing" is a contract, not tidiness.
 *
 * EVERY CASE RUNS IN A `mkdtemp` SANDBOX WITH ITS OWN `.git`. After ADR-011 the
 * ledger lives inside the git common dir, so a sandbox without one resolves to
 * an ancestor — which is how a test writes into the real store it is supposed
 * to be measuring.
 *
 * WHAT THIS FILE DOES NOT PROVE (rules §9 — write it next to the gate):
 *   - THAT THE HOST PUTS THE SKILL NAME IN `tool_input.skill`. Every payload
 *     below is SYNTHETIC. The key name itself is measured elsewhere —
 *     `tests/hooks/fixtures/host-payloads/PostToolUse.Skill.json`, host
 *     2.1.272, `skill` present on 4/4 Skill rows — and this file does not
 *     re-derive it. A host that renames the key goes green here and silent in
 *     production; the fixture diff is the detector, not these cases.
 *   - THE DISPATCHER ROUND TRIP. That measurement needs a dispatcher spawn,
 *     which `tests/firewall/dispatcher-cwd-sandbox-required.test.js` admits
 *     only from files on its `KNOWN_DISPATCHER_SPAWNERS` ratchet. It lives in
 *     `tests/dispatcher/posttooluse-dispatcher.test.js`, which is already on
 *     that list.
 *   - ANY LIVE FIRING RATE. Nothing here says how often a Skill call happens.
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
 * @module tests/hooks/tool-used-record
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

describe('buildToolUsedEnvelope', () => {
  it('records the skill name for a Skill tool call', () => {
    const env = buildToolUsedEnvelope(payload());
    expect(env).not.toBeNull();
    expect(env.event).toBe(TOOL_USED_EVENT);
    expect(env.source).toBe('hook');
    expect(env.session_id).toBe(SESSION_ID);
    expect(env.action_id).toBe(TOOL_USE_ID);
    expect(env.data).toEqual({
      tool: 'Skill', ok: true, duration_ms: null, skill: SKILL_NAME,
    });
  });

  it('trims surrounding whitespace off the skill name', () => {
    const env = buildToolUsedEnvelope(payload({ tool_input: { skill: `  ${SKILL_NAME}\n` } }));
    expect(env.data.skill).toBe(SKILL_NAME);
  });

  it('reads the tool name from the `tool` alias when `tool_name` is absent', () => {
    const env = buildToolUsedEnvelope(payload({ tool_name: undefined, tool: SKILL_TOOL }));
    expect(env).not.toBeNull();
    expect(env.data.tool).toBe('Skill');
  });

  // The whole point of the omit decision: `fields.skill.type` is `string`
  // (schemas/ledger-events.allowlist.json, event `tool.used`) and
  // lib/runtime/ledger-schema.js#matchesType rejects null for it. A null or an
  // empty string would make the row a `type-violation:skill` REJECTION, so the
  // key is left out entirely and the row still counts as a Skill firing.
  it.each([
    ['absent', {}],
    ['empty string', { skill: '' }],
    ['whitespace only', { skill: '   ' }],
    ['non-string (number)', { skill: 42 }],
    ['non-string (null)', { skill: null }],
    ['non-string (object)', { skill: { name: SKILL_NAME } }],
  ])('omits data.skill entirely when the skill is %s', (_label, toolInput) => {
    const env = buildToolUsedEnvelope(payload({ tool_input: toolInput }));
    expect(env).not.toBeNull();
    expect('skill' in env.data).toBe(false);
    expect(env.data).toEqual({ tool: 'Skill', ok: true, duration_ms: null });
  });

  // MEASURED, and it overturned the brief this hook was written from. The
  // limb brief specified a fixed `duration_ms: null` because "the host gives
  // no duration". The live probe fixture
  // (`tests/hooks/fixtures/host-payloads/PostToolUse.Skill.json`, host 2.1.272,
  // captured 2026-09-15 11:05-11:10 KST) records `duration_ms` as a TOP-LEVEL
  // PostToolUse key of JSON type number on 2/2 rows. So the real number is
  // recorded when it is there, and null keeps its meaning: NOT MEASURED, as
  // distinct from a fabricated 0.
  it('records the host duration_ms when the payload carries one', () => {
    const env = buildToolUsedEnvelope(payload({ duration_ms: 1234 }));
    expect(env.data.duration_ms).toBe(1234);
  });

  it('records duration_ms 0 as 0, not as null', () => {
    expect(buildToolUsedEnvelope(payload({ duration_ms: 0 })).data.duration_ms).toBe(0);
  });

  it.each([
    ['absent', undefined],
    ['a string', '1234'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['negative', -5],
  ])('falls back to null duration_ms when the host value is %s', (_label, value) => {
    const env = buildToolUsedEnvelope(payload({ duration_ms: value }));
    // The key must EXIST either way — the allowlist lists it in `required`.
    expect('duration_ms' in env.data).toBe(true);
    expect(env.data.duration_ms).toBeNull();
  });

  // `ok` IS THE HOST'S BOOLEAN WHENEVER THERE IS ONE.
  //
  // The live fixture records `tool_response` for Skill as
  // {allowedTools, commandName, success} with `success` a boolean on 2/2 rows,
  // so the KEY is measured even though its `false` VALUE is not. A hardcoded
  // true would therefore write a falsely successful row the day a failure
  // arrives. Absent or non-boolean still defaults to true: whether a FAILING
  // Skill call reaches this slot at all — or diverts to PostToolUseFailure —
  // is unmeasured, and "nothing says this failed" must not be spelled like
  // "this failed".
  it('records ok:false when the host reports tool_response.success false', () => {
    const env = buildToolUsedEnvelope(payload({ tool_response: { success: false } }));
    expect(env.data.ok).toBe(false);
  });

  it.each([
    ['success true', { success: true }],
    ['tool_response absent', undefined],
    ['tool_response empty', {}],
    ['success non-boolean ("false" string)', { success: 'false' }],
    ['success null', { success: null }],
    ['tool_response a string', 'ok'],
  ])('records ok:true when the host sends %s', (_label, toolResponse) => {
    const env = buildToolUsedEnvelope(payload({ tool_response: toolResponse }));
    expect(env.data.ok).toBe(true);
  });

  it('omits data.skill when tool_input is missing altogether', () => {
    const env = buildToolUsedEnvelope(payload({ tool_input: undefined }));
    expect(env).not.toBeNull();
    expect('skill' in env.data).toBe(false);
  });

  it.each([
    ['Bash'], ['Edit'], ['skill'], ['SkillTool'],
  ])('returns null for tool %s (exact-match guard, not a prefix)', (tool) => {
    expect(buildToolUsedEnvelope(payload({ tool_name: tool }))).toBeNull();
  });

  it.each([
    ['null payload', null],
    ['undefined payload', undefined],
    ['non-object payload', 'not-json'],
    ['empty object', {}],
  ])('returns null for %s', (_label, bad) => {
    expect(buildToolUsedEnvelope(bad)).toBeNull();
  });

  it('returns null without a session_id (the envelope layer would reject it)', () => {
    expect(buildToolUsedEnvelope(payload({ session_id: undefined }))).toBeNull();
  });

  it('accepts a declared mission_id over the session fallback', () => {
    const declared = 'M-20260915-Ssesstool';
    const env = buildToolUsedEnvelope(payload({ mission_id: declared }));
    expect(env.mission_id).toBe(declared);
  });

  it('falls back to the session mission id when none is declared', () => {
    const env = buildToolUsedEnvelope(payload());
    expect(env.mission_id).toMatch(/^M-\d{8}-Ssesstool$/);
  });

  it('omits action_id rather than writing an empty one when tool_use_id is absent', () => {
    // `validateOptionalEnvelope` rejects an empty-string action_id, so an
    // absent id must become an ABSENT key — the row is still a Skill firing.
    const env = buildToolUsedEnvelope(payload({ tool_use_id: undefined }));
    expect(env).not.toBeNull();
    expect('action_id' in env).toBe(false);
  });
});

describe('ledger round trip', () => {
  it('writes exactly one accepted tool.used row carrying the skill name', () => {
    const env = buildToolUsedEnvelope(payload());
    const result = appendLedgerEvent(repo, env);
    expect(result.ok).toBe(true);

    const lines = readLedger(repo);
    const used = lines.filter((l) => l.event === TOOL_USED_EVENT);
    expect(used).toHaveLength(1);
    expect(used[0].data.skill).toBe(SKILL_NAME);
    expect(used[0].data.duration_ms).toBeNull();
    expect(used[0].source).toBe('hook');

    // A rejection is also a written line. Counting rows alone would read one
    // as a success, so the rejection stream is asserted EMPTY separately.
    expect(lines.filter((l) => l.event === 'ledger.rejected')).toEqual([]);

    // And the two validators are asked directly, on the line as stored.
    expect(validateEnvelope(used[0])).toBeNull();
    expect(validateEventContract(used[0])).toBeNull();
  });

  it('writes an accepted row when the skill name is unknown (key omitted)', () => {
    const env = buildToolUsedEnvelope(payload({ tool_input: {} }));
    expect(appendLedgerEvent(repo, env).ok).toBe(true);
    const lines = readLedger(repo);
    expect(lines.filter((l) => l.event === 'ledger.rejected')).toEqual([]);
    const used = lines.filter((l) => l.event === TOOL_USED_EVENT);
    expect(used).toHaveLength(1);
    expect('skill' in used[0].data).toBe(false);
  });

  // MEASURED 2026-09-15: 303 B for skill `artibot:split` with this file's
  // (deliberately long) session id and tool_use_id, against the 4,096 B cap
  // from `artibot.config.json#/ledger/maxLineBytes` — 7.4% of it. A 200-char
  // skill name measures 498 B. The bound below is loose on purpose: it exists
  // to catch a shape change that multiplies the line, not to pin 303.
  it('stays far below the 4096-byte line cap for a realistic skill name', () => {
    const bytes = lineBytes(buildEnvelope(buildToolUsedEnvelope(payload())));
    expect(bytes).toBeLessThan(1024);
  });

  it('record() returns not-recordable and writes nothing without a cwd', () => {
    const result = record(payload({ cwd: undefined }));
    expect(result.ok).toBe(false);
    expect(readLedger(repo)).toEqual([]);
  });

  /**
   * THE WHOLE POINT OF SH-29, IN ONE FLOW: write → read → audit.
   *
   * Before this writer, `lib/replay/existence-audit.js` answered
   * `measured: false, fired: null` for every skill, because no registered
   * event carried a skill name — its own `CARRIER_NOTES.skills` said so. The
   * two halves are asserted TOGETHER here because either alone is
   * uninformative: a `fired: 1` with `measured: false` would be a number
   * nobody may act on, and `measured: true` with a null count would be a
   * measurement of nothing.
   *
   * SYNTHETIC, AND THAT BOUNDS IT. One row this same test wrote. It proves the
   * carrier is wired end to end; it says nothing about how often any skill
   * fires in production, and `denominator: 1` is this fixture's, not a live
   * population.
   */
  it('makes the skill countable: existence-audit reports fired 1, measured true', () => {
    expect(record(payload()).ok).toBe(true);

    const events = readAllEvents(repo);
    const audit = buildExistenceAudit(events, { inventory: { skills: [SKILL_NAME] } });
    const entry = audit.kinds.skills.entries[0];

    expect(entry.name).toBe(SKILL_NAME);
    expect(entry.fired).toBe(1);
    expect(entry.measured).toBe(true);
    expect(entry.reason).toBeNull();
    // Scoped to Skill rows since R1 / OB-24 (2026-09-29), see the interplay block below.
    expect(audit.kinds.skills.carrier).toEqual({ event: TOOL_USED_EVENT, field: 'skill', where: { tool: SKILL_TOOL } });
    expect(audit.kinds.skills.denominator).toBe(1);
  });

  it('record() writes through the resolved project root', () => {
    const result = record(payload());
    expect(result.ok).toBe(true);
    expect(readLedger(repo).filter((l) => l.event === TOOL_USED_EVENT)).toHaveLength(1);
  });
});

describe('hook process contract', () => {
  it('exits 0 with an empty stdout and writes the row', () => {
    const { status, stdoutBytes } = runHook(JSON.stringify(payload()));
    expect(status).toBe(0);
    expect(stdoutBytes).toBe(0);
    const used = readLedger(repo).filter((l) => l.event === TOOL_USED_EVENT);
    expect(used).toHaveLength(1);
    expect(used[0].data.skill).toBe(SKILL_NAME);
  });

  it.each([
    ['empty stdin', ''],
    ['malformed JSON', '{not json'],
    ['a JSON array', '[]'],
    ['a non-Skill payload', JSON.stringify({ tool_name: 'Bash', session_id: SESSION_ID })],
  ])('exits 0 with empty stdout for %s, and writes nothing', (_label, raw) => {
    const { status, stdoutBytes } = runHook(raw);
    expect(status).toBe(0);
    expect(stdoutBytes).toBe(0);
    expect(readLedger(repo)).toEqual([]);
  });
});

/**
 * The one link between this writer and a MEASURED host, rather than a
 * synthetic payload this file wrote for itself.
 *
 * Every other case here builds its own input, so all of them would stay green
 * against a host that renamed the key. These read the frozen live-probe
 * fixture instead: if it is ever regenerated on a newer host with a different
 * key set, the writer's two payload reads go red HERE rather than going quiet
 * in production.
 */
describe('host payload contract (frozen live-probe fixture)', () => {
  const FIXTURE = JSON.parse(readFileSync(
    path.join(PLUGIN_ROOT, 'tests', 'hooks', 'fixtures', 'host-payloads', 'PostToolUse.Skill.json'),
    'utf-8',
  ));

  it('the host names the skill in tool_input.skill on every row', () => {
    expect(FIXTURE.PostToolUse.tool_input_keys_always).toContain('skill');
    expect(FIXTURE.PostToolUse.tool_input_key_types.skill).toBe('string');
  });

  it('the host reports duration_ms as a top-level number, not inside tool_response', () => {
    expect(FIXTURE.PostToolUse.top_level_keys).toContain('duration_ms');
    expect(FIXTURE.PostToolUse.top_level_key_types.duration_ms).toBe('number');
    expect(FIXTURE.PostToolUse.tool_response_keys).not.toContain('duration_ms');
  });

  it('the host reports the verdict as tool_response.success, a boolean', () => {
    expect(FIXTURE.PostToolUse.tool_response_keys).toContain('success');
    expect(FIXTURE.PostToolUse.tool_response_key_types.success).toBe('boolean');
    // And the failing call is still unmeasured, which is why `ok` defaults to
    // true rather than to the field's absence.
    expect(FIXTURE.not_measured.join(' ')).toContain('success=false');
  });

  it('the host reports tool_name and cwd, the two other keys this writer reads', () => {
    expect(FIXTURE.PostToolUse.tool_name).toBe(SKILL_TOOL);
    expect(FIXTURE.PostToolUse.top_level_keys).toEqual(
      expect.arrayContaining(['cwd', 'session_id', 'tool_use_id', 'tool_input']),
    );
  });
});

describe('dispatcher routing', () => {
  it('routes the Skill tool to tool-used-record', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    expect(mod.selectHooks('Skill').map((h) => h.name)).toContain('tool-used-record');
  });

  it('routes the AskUserQuestion tool to tool-used-record (SH-09)', async () => {
    const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
    expect(mod.selectHooks(ASK_TOOL).map((h) => h.name)).toContain('tool-used-record');
  });

  it.each([['Read'], ['Edit'], ['Bash'], ['Grep']])(
    'does not route %s to tool-used-record',
    async (tool) => {
      const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
      expect(mod.selectHooks(tool).map((h) => h.name)).not.toContain('tool-used-record');
    },
  );
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
