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
 * @module tests/hooks/tool-used-record
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendLedgerEvent, ledgerFilePath, readAllEvents } from '../../lib/runtime/ledger.js';
import { buildExistenceAudit } from '../../lib/replay/existence-audit.js';
import {
  buildEnvelope, lineBytes, validateEnvelope, validateEventContract,
} from '../../lib/runtime/event-writer.js';
import {
  buildToolUsedEnvelope, record, SKILL_TOOL, TOOL_USED_EVENT,
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
    expect(audit.kinds.skills.carrier).toEqual({ event: TOOL_USED_EVENT, field: 'skill' });
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

  it.each([['Read'], ['Edit'], ['Bash'], ['Grep']])(
    'does not route %s to tool-used-record',
    async (tool) => {
      const mod = await import('../../scripts/hooks/_posttooluse-dispatcher.js');
      expect(mod.selectHooks(tool).map((h) => h.name)).not.toContain('tool-used-record');
    },
  );
});
