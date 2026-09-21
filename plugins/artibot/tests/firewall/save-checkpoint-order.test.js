/**
 * Firewall gate — the `/save` checkpoint pass runs the §31 steps IN ORDER, and
 * landing it changes no behaviour because the canary is off.
 *
 * WHY THIS GATE EXISTS. Two of the five ports are only correct in the position
 * they occupy, and a refactor that moved them would still return a well-formed
 * row, still pass every output-shaped unit test, and leave no error behind:
 *
 *   - `buildResumeReport` is asked AFTER `checkpoint` so the report can see the
 *     checkpoint that was just written. Asked before, it judges the PREVIOUS
 *     checkpoint and the row reports a verdict about a state that no longer
 *     exists — `resumable` would be a lie with the right type.
 *   - `appendEvent` is emitted LAST so the ledger line can carry that verdict.
 *     Emitted earlier, `data.resumable` is `null` forever and the scorecard
 *     numerator counts checkpoints nobody ever judged.
 *
 * Both failures are silent. The outputs still have the right keys, so the ORDER
 * itself has to be the assertion. `lib/checkpoint/save-checkpoint.js:69` exports
 * `SAVE_CHECKPOINT_PORT_ORDER` for exactly that reason, and this file refuses to
 * trust it alone: the observed call log is compared to the exported constant AND
 * to a literal written out here, so editing the constant to match a reordered
 * implementation does not buy a green.
 *
 * THE PROSE IS PART OF THE CONTRACT. `commands/save.md` is what a human and a
 * later session read to know what `/save` does; if its eight numbered steps drift
 * out of §31 order the module and the documentation disagree and only one of them
 * is executable. So the Phase A½ section is read as text and its bold step tokens
 * must occur in strictly ascending position. Two leader decisions are pinned as
 * plain substrings because they are the two the prose is most likely to lose in an
 * edit: `appendEvent: null` on the checkpoint service (ca05-2 — the ledger line is
 * the assembly module's job, not the service's) and `source:'supervisor'` beside
 * `mission.checkpointed` (ca05-1 — `save` is outside the envelope allowlist and
 * would be refused a layer earlier).
 *
 * LANDING = NO BEHAVIOUR CHANGE. `runtime.checkpoint.saveOnSave` is ABSENT from
 * `artibot.config.json` today, and `isSaveCheckpointEnabled` is strict `=== true`,
 * so the whole pass is off. This file pins the RESULT (`false` against the real
 * config file), never the key's presence — the key is the leader's to add, and a
 * gate that demanded it would go red on an untouched tree.
 *
 * SELF-VERIFICATION. Both audits are pure functions returning `{ pass, reasons }`,
 * and the real assertions and the `the audit itself` block call the same code
 * path. One `it` points the port audit at a subject that announces before it
 * judges; two more point the prose audit at shuffled and gate-sentence-less
 * markdown. If those do not go red, every green above them is vacuous.
 *
 * ── WHAT THIS GATE CANNOT SEE (rules §9) ───────────────────────────────────
 *   - THE CALLER. `buildSaveCheckpoint` is pure over its ports; NOTHING here
 *     shows that any `/save` implementation actually reads the config, builds
 *     these ports, or calls this module. Wiring is another limb's file and is
 *     UNMEASURED. A green here is compatible with the pass never running.
 *   - THE REAL PORTS. Every port below is a fake that returns a happy value.
 *     That the real checkpoint service, state store and ledger have these shapes
 *     is their own tests' claim, not this file's.
 *   - ONE MISSION, ONE HAPPY PATH. The audit runs a single mission whose
 *     checkpoint succeeds. Rejected checkpoints, throwing report ports, refusing
 *     ledgers and multi-mission sequencing are the module's unit tests' subject.
 *     The order under FAILURE is not measured here.
 *   - STEPS 1, 4 AND 8. Flush artifacts, Epoch and Snapshot Scorecard are pinned
 *     only as words in the markdown. Step 1 lives behind a different config gate,
 *     step 4 is absent by design, and step 8 is another limb entirely. This gate
 *     says nothing about whether any of them work.
 *   - THE PROSE'S TRUTH. The prose audit checks ORDER and the presence of three
 *     substrings. It does not check that the `file.js:NNN` line numbers cited in
 *     that section still point at the symbols they name.
 *   - THE CONFIG'S FUTURE. The default gate pins today's `false`. The day the
 *     leader adds the key as `true`, this file goes red ON PURPOSE — that is the
 *     canary flip, and it must be a deliberate edit here, not a silent one there.
 *
 * @module tests/firewall/save-checkpoint-order
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  buildSaveCheckpoint,
  isSaveCheckpointEnabled,
  SAVE_CHECKPOINT_CONFIG_PATH,
  SAVE_CHECKPOINT_EVENT,
  SAVE_CHECKPOINT_PORT_ORDER,
  SAVE_CHECKPOINT_SOURCE,
} from '../../lib/checkpoint/save-checkpoint.js';

const SAVE_MD = readFileSync(new URL('../../commands/save.md', import.meta.url), 'utf-8');
const CONFIG = JSON.parse(readFileSync(new URL('../../artibot.config.json', import.meta.url), 'utf-8'));

/**
 * The port order written out by hand, so that a commit which reorders the
 * implementation AND edits {@link SAVE_CHECKPOINT_PORT_ORDER} to agree with it
 * still has to come through this line.
 */
const LITERAL_PORT_ORDER = [
  'getMission',
  'getTaskGraph',
  'checkpoint',
  'buildResumeReport',
  'appendEvent',
];

const MISSION = 'm-1';
const SESSION = 's-1';
const TRIGGER = '/save';

/** Heading of the section `commands/save.md` devotes to the §31 order (:45). */
const PHASE_HEADING = '### Phase A½: 체크포인트';

/** The sentence that states the canary, verbatim from `commands/save.md:47`. */
const GATE_SENTENCE = '이 단계는 runtime.checkpoint.saveOnSave 가 true 일 때만 실행된다';

/** The eight §31 step names, in the order the prose must present them. */
const STEP_TOKENS = [
  'Flush artifacts',
  'Task Graph',
  'State',
  'Epoch',
  'Checkpoint',
  'Validate resume',
  'Ledger',
  'Snapshot Scorecard',
];

/** Leader decisions ca05-2 and ca05-1, pinned as plain substrings. */
const DECISION_SUBSTRINGS = ['appendEvent: null', "source:'supervisor'", 'mission.checkpointed'];

/**
 * The Phase A½ section only: from its heading to the next `###`, so a token that
 * happens to appear elsewhere in a 227-line command cannot satisfy the order.
 *
 * @param {string} text - Full markdown of `commands/save.md`, or a synthetic one.
 * @returns {string|null} The section body, or null when the heading is absent.
 */
function slicePhaseSection(text) {
  const start = text.indexOf(PHASE_HEADING);
  if (start === -1) return null;
  const rest = text.slice(start + PHASE_HEADING.length);
  const end = rest.indexOf('\n### ');
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Audit the prose: heading present, canary sentence verbatim, eight bold step
 * tokens present and in strictly ascending position, three decision substrings
 * present.
 *
 * @param {string} text - Markdown to audit.
 * @returns {{pass: boolean, reasons: string[], positions: object[]}} Verdict.
 */
function auditProseOrder(text) {
  const section = slicePhaseSection(text);
  if (section === null) {
    return { pass: false, reasons: [`Phase A½ heading absent: ${PHASE_HEADING}`], positions: [] };
  }

  const reasons = [];
  if (!section.includes(GATE_SENTENCE)) {
    reasons.push(`canary sentence absent: "${GATE_SENTENCE}"`);
  }

  const positions = [];
  let previous = -1;
  let previousToken = '(start of section)';
  for (const token of STEP_TOKENS) {
    const at = section.indexOf(`**${token}**`);
    positions.push({ token, at });
    if (at === -1) {
      reasons.push(`step token absent: **${token}**`);
      continue;
    }
    if (at <= previous) {
      reasons.push(`step out of §31 order: **${token}** at ${at} does not follow **${previousToken}** at ${previous}`);
    }
    previous = at;
    previousToken = token;
  }

  for (const substring of DECISION_SUBSTRINGS) {
    if (!section.includes(substring)) reasons.push(`leader decision absent from prose: ${substring}`);
  }

  return { pass: reasons.length === 0, reasons, positions };
}

/**
 * Ports that record their own names. `listActiveMissionIds` and `latestValid`
 * record too even though the happy path must not reach them — an extra entry in
 * the log is as much a failure as a missing one.
 *
 * @param {string[]} log - Call log, appended in place.
 * @param {object[]} envelopes - Ledger envelopes, appended in place.
 * @returns {object} Ports for `buildSaveCheckpoint`.
 */
function recordingPorts(log, envelopes) {
  return {
    listActiveMissionIds: async () => {
      log.push('listActiveMissionIds');
      return [MISSION];
    },
    getMission: async (missionId) => {
      log.push('getMission');
      return { mission_id: missionId, intent: { revision: 3 }, plan: { revision: 5 } };
    },
    getTaskGraph: async () => {
      log.push('getTaskGraph');
      return { tasks: [{ id: 't-1', status: 'in_progress' }, { id: 't-2', status: 'done' }] };
    },
    checkpointService: {
      checkpoint: async () => {
        log.push('checkpoint');
        return { ok: true, checkpoint_id: 'cp-1', ts: 't' };
      },
      latestValid: async () => {
        log.push('latestValid');
        return { checkpoint_id: 'cp-1', content: { mission_id: MISSION, resumable: true } };
      },
    },
    buildResumeReport: async () => {
      log.push('buildResumeReport');
      return { resumable: true, blocked_by: [] };
    },
    appendEvent: async (envelope) => {
      log.push('appendEvent');
      envelopes.push(envelope);
      return { ok: true };
    },
  };
}

/**
 * Run a subject over the recording ports and judge the call order and the ledger
 * envelope. The subject is a parameter so the self-check can feed a deliberately
 * mis-ordered one through the identical code path.
 *
 * @param {Function} subject - Something with `buildSaveCheckpoint`'s signature.
 * @returns {Promise<{pass: boolean, reasons: string[], log: string[], envelope: object|null, result: unknown}>} Verdict.
 */
async function auditPortOrder(subject) {
  const log = [];
  const envelopes = [];
  const result = await subject(recordingPorts(log, envelopes), {
    sessionId: SESSION,
    trigger: TRIGGER,
    missionIds: [MISSION],
  });

  const reasons = [];
  if (log.length === 0) reasons.push('audit did not exercise the subject: zero port calls');

  const width = Math.max(log.length, LITERAL_PORT_ORDER.length);
  for (let i = 0; i < width; i += 1) {
    if (log[i] !== LITERAL_PORT_ORDER[i]) {
      reasons.push(
        `port ${i + 1}: expected ${LITERAL_PORT_ORDER[i] ?? '(no further call)'}, saw ${log[i] ?? '(no call)'}`,
      );
    }
  }

  const at = (name) => log.indexOf(name);
  if (at('checkpoint') === -1 || at('buildResumeReport') === -1 || at('buildResumeReport') < at('checkpoint')) {
    reasons.push('step 6 buildResumeReport must run after step 5 checkpoint, so it judges the checkpoint just written');
  }
  if (at('buildResumeReport') === -1 || at('appendEvent') === -1 || at('appendEvent') < at('buildResumeReport')) {
    reasons.push('step 7 appendEvent must run after step 6 buildResumeReport, so the ledger line carries the verdict');
  }

  const envelope = envelopes[0] ?? null;
  if (envelope === null) {
    reasons.push('no ledger envelope was appended');
  } else {
    if (envelope.event !== SAVE_CHECKPOINT_EVENT) reasons.push(`ledger event: expected ${SAVE_CHECKPOINT_EVENT}, saw ${envelope.event}`);
    if (envelope.source !== SAVE_CHECKPOINT_SOURCE) reasons.push(`ledger source: expected ${SAVE_CHECKPOINT_SOURCE}, saw ${envelope.source}`);
    if (envelope.data?.trigger !== TRIGGER) reasons.push(`ledger data.trigger: expected ${TRIGGER}, saw ${envelope.data?.trigger}`);
  }

  return { pass: reasons.length === 0, reasons, log, envelope, result };
}

/** A subject that announces before it judges — steps 6 and 7 swapped. */
async function announcesBeforeJudging(ports, options) {
  const missionId = options.missionIds[0];
  await ports.getMission(missionId);
  await ports.getTaskGraph(missionId);
  await ports.checkpointService.checkpoint({}, { trigger: options.trigger });
  await ports.appendEvent({
    event: SAVE_CHECKPOINT_EVENT,
    mission_id: missionId,
    session_id: options.sessionId,
    source: SAVE_CHECKPOINT_SOURCE,
    data: { checkpoint_id: 'cp-1', trigger: options.trigger, resumable: null },
  });
  await ports.buildResumeReport({}, { missionId });
  return { skipped: null, rows: [] };
}

describe('commands/save.md states the §31 steps in order', () => {
  it('has the Phase A½ heading, the canary sentence and eight bold steps in ascending position', () => {
    const audit = auditProseOrder(SAVE_MD);
    expect(audit.reasons).toEqual([]);
    expect(audit.pass).toBe(true);
  });

  it('places every one of the eight step tokens, none of them missing', () => {
    const audit = auditProseOrder(SAVE_MD);
    expect(audit.positions).toHaveLength(8);
    expect(audit.positions.filter((p) => p.at === -1)).toEqual([]);
  });

  it('carries the canary sentence verbatim', () => {
    expect(slicePhaseSection(SAVE_MD)).toContain(GATE_SENTENCE);
  });

  it('records leader decisions ca05-2 (appendEvent: null) and ca05-1 (supervisor source)', () => {
    const section = slicePhaseSection(SAVE_MD);
    expect(section).toContain('appendEvent: null');
    expect(section).toContain("source:'supervisor'");
    expect(section).toContain('mission.checkpointed');
  });
});

describe('buildSaveCheckpoint calls its five ports in SAVE_CHECKPOINT_PORT_ORDER', () => {
  it('produces a call log equal to the exported constant AND to the literal written here', async () => {
    const audit = await auditPortOrder(buildSaveCheckpoint);
    expect(audit.reasons).toEqual([]);
    expect(audit.log).toEqual([...SAVE_CHECKPOINT_PORT_ORDER]);
    expect(audit.log).toEqual(LITERAL_PORT_ORDER);
    expect([...SAVE_CHECKPOINT_PORT_ORDER]).toEqual(LITERAL_PORT_ORDER);
  });

  it('never reaches listActiveMissionIds or latestValid on this path, so the log is exactly five calls', async () => {
    const audit = await auditPortOrder(buildSaveCheckpoint);
    expect(audit.log).toHaveLength(5);
  });

  it('announces on the ledger as supervisor / mission.checkpointed / trigger /save', async () => {
    const audit = await auditPortOrder(buildSaveCheckpoint);
    expect(audit.envelope.source).toBe('supervisor');
    expect(audit.envelope.event).toBe('mission.checkpointed');
    expect(audit.envelope.data.trigger).toBe('/save');
  });

  it('saves the mission, so the order above was measured on a real pass and not on a skip', async () => {
    const audit = await auditPortOrder(buildSaveCheckpoint);
    expect(audit.result.skipped).toBeNull();
    expect(audit.result.rows).toHaveLength(1);
    expect(audit.result.rows[0].status).toBe('saved');
  });
});

describe('the ledger line comes after the resume verdict (steps 5 -> 6 -> 7)', () => {
  it('orders checkpoint before buildResumeReport before appendEvent', async () => {
    const { log } = await auditPortOrder(buildSaveCheckpoint);
    expect(log.indexOf('checkpoint')).toBeLessThan(log.indexOf('buildResumeReport'));
    expect(log.indexOf('buildResumeReport')).toBeLessThan(log.indexOf('appendEvent'));
  });
});

describe('landing the pass changes no behaviour: the canary is off', () => {
  it('reads false against the real artibot.config.json today', () => {
    expect(isSaveCheckpointEnabled(CONFIG)).toBe(false);
  });

  it('reads true only for a literal boolean true at the canary path', () => {
    expect(isSaveCheckpointEnabled({ runtime: { checkpoint: { saveOnSave: true } } })).toBe(true);
    expect(isSaveCheckpointEnabled({ runtime: { checkpoint: { saveOnSave: 'true' } } })).toBe(false);
    expect(isSaveCheckpointEnabled({})).toBe(false);
    expect(isSaveCheckpointEnabled(undefined)).toBe(false);
  });

  it('exports the canary path the prose names, so both spell it the same way', () => {
    expect(SAVE_CHECKPOINT_CONFIG_PATH).toBe('runtime.checkpoint.saveOnSave');
    expect(slicePhaseSection(SAVE_MD)).toContain(SAVE_CHECKPOINT_CONFIG_PATH);
  });
});

describe('the audit itself', () => {
  it('goes red on a pass that announces before it judges, naming the misplaced port', async () => {
    const bad = await auditPortOrder(announcesBeforeJudging);
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' | ')).toContain('appendEvent');
    expect(bad.reasons.join(' | ')).toContain('step 7 appendEvent must run after step 6 buildResumeReport');
  });

  it('goes red on a subject that calls nothing, so the log is load-bearing', async () => {
    const inert = async () => ({ skipped: null, rows: [] });
    const bad = await auditPortOrder(inert);
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' | ')).toContain('zero port calls');
  });

  it('goes red on prose whose step tokens are shuffled', () => {
    const shuffled = [
      PHASE_HEADING,
      '',
      GATE_SENTENCE,
      '',
      '1. **Flush artifacts** — x',
      '2. **Task Graph** — x',
      '3. **State** — x',
      '4. **Epoch** — x',
      '5. **Ledger** — appendEvent: null / mission.checkpointed',
      "6. **Validate resume** — source:'supervisor'",
      '7. **Checkpoint** — x',
      '8. **Snapshot Scorecard** — x',
    ].join('\n');
    const bad = auditProseOrder(shuffled);
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' | ')).toContain('step out of §31 order');
    expect(bad.reasons.join(' | ')).toContain('**Checkpoint**');
  });

  it('goes red on prose that lost the canary sentence', () => {
    const withSentence = SAVE_MD;
    const withoutSentence = withSentence.replace(GATE_SENTENCE, '이 단계는 항상 실행된다');
    expect(auditProseOrder(withSentence).pass).toBe(true);
    const bad = auditProseOrder(withoutSentence);
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' | ')).toContain('canary sentence absent');
  });

  it('goes red on prose with no Phase A½ heading at all', () => {
    const bad = auditProseOrder('# save\n\nnothing here\n');
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' | ')).toContain('Phase A½ heading absent');
  });
});
