/**
 * Firewall gate — the Resume Contract controller REPORTS, and the report costs
 * no state transition.
 *
 * WHY THIS GATE EXISTS. Design §7.3 puts v5 Shadow at "compare/recover infra,
 * transitions unchanged", and Scorecard §51 lists the ten Resume Contract
 * steps whose names are all verbs — "Restore Task Graph", "Find expired worker
 * leases", "Reconcile Ledger". Every one of those names is one keystroke away
 * from the write that Shadow forbids: `getLease` sits beside `claimTask` on the
 * same store object (`lib/project-state/state-manager.js:430` and `:432`,
 * measured 2026-09-14), and
 * `reconcile` repairs the snapshot the moment it is handed `apply: true`
 * (`lib/project-state/reconcile.js:51`, the `if (drifted && opts.apply === true)`
 * branch). A controller that took one of those turns would still return a
 * perfectly well-formed report, all unit tests would stay green, and the only
 * trace would be a rewritten snapshot nobody asked for. There is no error and
 * no log line on that path, so a gate is the only detector.
 *
 * TWO ARMS, BECAUSE EITHER ALONE IS CHEAP TO FOOL.
 *   - STATIC. The module must import NOTHING. Not "must not import the store" —
 *     nothing at all, asserted by the absence of any `import` / `require` form
 *     in the source. That is a stronger and much less forgeable claim than a
 *     name-by-name denylist, and it is the claim the port design actually
 *     makes. A denylist was tried first and rejected: the module legitimately
 *     contains the words `ledger` and `reconcile` (they are step names and
 *     block reasons), so a bare substring scan for them would have to be
 *     weakened until it stopped meaning anything.
 *   - DYNAMIC. Static text cannot see a write reached through an injected port,
 *     which is the only way this module could write at all. So the controller
 *     is run across a fixture matrix with every port recording, and the five
 *     write ports must show zero calls while `reconcile` must never see
 *     `apply: true` — even though the caller passes `apply: true` in the
 *     options, which is the forwarding mistake the run reproduces on purpose.
 *
 * THE DENOMINATOR IS IN THE TEST NAME. "Zero writes" is trivially true of a
 * controller that calls nothing, so the count of writes is reported against N,
 * the total number of port calls the matrix provoked. A floor on N is asserted
 * as well, so an empty or short-circuited matrix cannot pass by doing nothing.
 *
 * SELF-VERIFICATION. The audit is a function, and one `it` points it at a fake
 * controller that claims a task and calls `reconcile({ apply: true })`. If the
 * audit does not go red on that, every green above it is meaningless.
 *
 * ── WHAT THIS GATE CANNOT SEE (rules §9) ───────────────────────────────────
 *   - TEAMMATE B'S MODULE. Only `lib/checkpoint/resume-controller.js` is
 *     scanned. `lib/supervisor/lane-reconcile.js` and `commands/resume.md` are
 *     another limb's files and are UNMEASURED here.
 *   - STEP 10. "Resume" is out of scope for the controller, so nothing here
 *     says anything about whether the eventual resume performs its transitions
 *     correctly. This gate pins the REPORT, not the resume.
 *   - THE REAL PORTS. Every port below is a fake. That the real
 *     `state-manager.js` bindings have the shapes assumed here is checked by
 *     their own tests, not by this file. If `getLease` were to acquire a write
 *     side effect upstream, this gate would stay green.
 *   - INDIRECT WRITES. A port that is read-only by name but writes internally
 *     (say a `reconcile` implementation that ignored `apply`) is invisible
 *     here; the gate measures what the CONTROLLER asks for, not what a port
 *     does with the request.
 *   - CONCURRENCY. Single-threaded and sequential. Two resumes reporting on
 *     one mission at the same time is not measured.
 *
 * @module tests/firewall/resume-contract-report-only
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { buildResumeReport } from '../../lib/checkpoint/resume-controller.js';

const SOURCE_URL = new URL('../../lib/checkpoint/resume-controller.js', import.meta.url);
const SOURCE = readFileSync(SOURCE_URL, 'utf-8');

const MISSION = 'm-1';
const NOW_MS = Date.parse('2026-09-14T12:00:00.000Z');

/**
 * The five state-changing bindings on the StateStore, measured 2026-09-14 at
 * `lib/project-state/state-manager.js:431-435` (`buildStoreApi`) — every write
 * the store exposes, and none of them may be called. They sit immediately
 * below the three read bindings this controller does use (`:428-430`), which
 * is the whole reason the gate exists.
 */
const WRITE_PORTS = Object.freeze(['updateMission', 'claimTask', 'releaseTask', 'heartbeatWorker', 'appendEvent']);

/** Tokens that would mean the module reached for I/O or a clock of its own. */
const FORBIDDEN_TOKENS = Object.freeze([
  'node:fs', 'node:child_process', 'child_process', 'node:path',
  'process.argv', 'process.env', 'Date.now(', 'Math.random(',
]);

const CHECKPOINT = Object.freeze({
  mission_id: MISSION,
  session_id: 's-1',
  intent_revision: 1,
  plan_revision: 1,
  active_tasks: [],
  completed_action_results: [],
  current_model: 'opus',
  resumable: true,
});

const MISSION_RECORD = Object.freeze({
  intent: { path: 'intent.md', revision: 1 },
  plan: { path: 'plan.md', revision: 1 },
});

const RECONCILE_CLEAN = Object.freeze({
  ok: true, drifted: false, applied: false, gaps: [],
  missingInStore: [], extraInStore: [], warnings: [],
  storeVersion: 17, snapshotVersion: 17,
});

/**
 * @param {object} checkpoint - Checkpoint body to hand back.
 * @returns {Function} A `latestValid` fake that returns it.
 */
function validCheckpoint(checkpoint) {
  return async () => ({ ok: true, record: { checkpoint_id: 'cp-1', ts: 't', checkpoint }, errors: [] });
}

/**
 * The fixture matrix. Each entry overrides the read ports so that a different
 * branch of the controller runs — a gate that only ever exercises the happy
 * path would miss a write hidden in a recovery branch.
 * @type {ReadonlyArray<{name: string, ports: object}>}
 */
const FIXTURES = Object.freeze([
  { name: 'valid checkpoint', ports: {} },
  { name: 'no checkpoint stored', ports: { latestValid: async () => ({ ok: false, record: null, errors: [] }) } },
  {
    name: 'invalid checkpoint',
    ports: { latestValid: async () => ({ ok: false, record: null, errors: ['plan_revision: must be an integer >= 0'] }) },
  },
  { name: 'revision mismatch', ports: { getMission: () => ({ intent: { revision: 7 }, plan: { revision: 9 } }) } },
  {
    name: 'task graph drift',
    ports: {
      latestValid: validCheckpoint({ ...CHECKPOINT, active_tasks: ['T-9'] }),
      getTaskGraph: () => ({ schema_version: 1, mission_id: MISSION, tasks: [{ id: 'T-1' }] }),
    },
  },
  {
    name: 'expired lease',
    ports: {
      getTaskGraph: () => ({ schema_version: 1, mission_id: MISSION, tasks: [{ id: 'T-1' }, { id: 'T-2' }] }),
      getLease: () => ({ owner: 'w-1', expires_at: '2026-09-14T10:00:00.000Z' }),
      isLeaseExpired: () => true,
    },
  },
  { name: 'ledger drift', ports: { reconcile: () => ({ ...RECONCILE_CLEAN, ok: false, drifted: true, gaps: [3], extraInStore: [5] }) } },
  {
    name: 'missing read ports',
    ports: { getMission: null, getTaskGraph: null, getLease: null, isLeaseExpired: null, resolveModel: null, now: null },
  },
]);

/**
 * Build a fully recording port object: every read port logs, every write port
 * logs and would be a violation, and `reconcile` additionally records the
 * `apply` flag it was handed.
 *
 * @param {object} over - Per-fixture overrides; `null` removes a read port.
 * @param {Array<{port: string, args: unknown[]}>} calls - Shared call log.
 * @returns {object} The ports.
 */
function recordingPorts(over, calls) {
  const reads = {
    latestValid: validCheckpoint(CHECKPOINT),
    getMission: () => MISSION_RECORD,
    getTaskGraph: () => ({ schema_version: 1, mission_id: MISSION, tasks: [] }),
    getLease: () => null,
    isLeaseExpired: () => false,
    reconcile: () => RECONCILE_CLEAN,
    resolveModel: (previous) => previous,
    now: () => NOW_MS,
  };
  const ports = {};
  const bind = (name, fn) => { ports[name] = (...args) => { calls.push({ port: name, args }); return fn(...args); }; };
  for (const [name, fn] of Object.entries({ ...reads, ...over })) {
    if (fn === null) continue;
    bind(name, fn);
  }
  for (const name of WRITE_PORTS) bind(name, () => ({ ok: true }));
  return ports;
}

/**
 * Run a controller across the whole matrix and count what it asked the ports
 * to do. Written as a function so it can be pointed at a controller that FAILS
 * it — see the self-verification block.
 *
 * `apply: true` is deliberately passed in the options of every run: forwarding
 * a caller's flag into `reconcile` is the exact mistake this gate exists to
 * catch, so the matrix supplies the flag rather than assuming nobody will.
 *
 * @param {Function} build - A `(ports, options) => Promise<object>` controller.
 * @returns {Promise<{total: number, writes: Array<string>, applyTrue: number, fixtures: number}>} Audit.
 */
async function auditPortUse(build) {
  const calls = [];
  let applyTrue = 0;
  for (const fixture of FIXTURES) {
    const over = { ...fixture.ports };
    const inner = over.reconcile ?? (() => RECONCILE_CLEAN);
    over.reconcile = (opts) => { if (opts?.apply === true) applyTrue += 1; return inner(opts); };
    // A controller that throws still must not have written, so the throw is
    // swallowed here and judged by the counts below rather than by rejection.
    await build(recordingPorts(over, calls), { missionId: MISSION, apply: true }).catch(() => null);
  }
  return {
    total: calls.length,
    writes: calls.filter((c) => WRITE_PORTS.includes(c.port)).map((c) => c.port),
    applyTrue,
    fixtures: FIXTURES.length,
  };
}

/**
 * The verdict, separated from the assertions so the same judgement can be
 * applied to a deliberately bad controller.
 *
 * @param {{total: number, writes: string[], applyTrue: number}} audit - Audit result.
 * @returns {{pass: boolean, reasons: string[]}} Verdict.
 */
function verdict(audit) {
  const reasons = [];
  if (audit.writes.length > 0) reasons.push(`write ports called: ${audit.writes.join(', ')}`);
  if (audit.applyTrue > 0) reasons.push(`reconcile called with apply:true ${audit.applyTrue} time(s)`);
  if (audit.total < 20) reasons.push(`only ${audit.total} port calls — the matrix did not exercise the controller`);
  return { pass: reasons.length === 0, reasons };
}

const AUDIT = await auditPortUse(buildResumeReport);

describe('resume controller performs no transition', () => {
  it(`write ports called 0/${AUDIT.total} times (N = total port calls across ${AUDIT.fixtures} fixtures)`, () => {
    expect(AUDIT.writes).toEqual([]);
    expect(AUDIT.total).toBeGreaterThanOrEqual(20);
    expect(AUDIT.fixtures).toBe(FIXTURES.length);
  });

  it(`reconcile saw apply:true 0/${AUDIT.fixtures} times, though every caller passed it`, () => {
    expect(AUDIT.applyTrue).toBe(0);
  });

  it('passes the whole verdict, not just its first clause', () => {
    expect(verdict(AUDIT)).toEqual({ pass: true, reasons: [] });
  });

  for (const port of WRITE_PORTS) {
    it(`never calls ${port}`, () => {
      expect(AUDIT.writes).not.toContain(port);
    });
  }
});

describe('the module reaches for nothing of its own', () => {
  it('contains no import or require of any kind', () => {
    const withoutComments = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(withoutComments).not.toMatch(/^\s*import[\s{*]/m);
    expect(withoutComments).not.toMatch(/\bimport\s*\(/);
    expect(withoutComments).not.toMatch(/\brequire\s*\(/);
    expect(withoutComments).not.toMatch(/\bfrom\s+['"]/);
  });

  for (const token of FORBIDDEN_TOKENS) {
    it(`source contains no ${token}`, () => {
      expect(SOURCE).not.toContain(token);
    });
  }

  it('the comment-stripper does not hide a real import behind a comment', () => {
    // Self-check on the stripper itself: the scan above would be vacuous if the
    // regex ate live code, and useless if it left comment text behind.
    const probe = '/* import x from "y" */\nimport real from "z";\n// import c from "d"\n';
    const stripped = probe.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(stripped).toMatch(/^\s*import[\s{*]/m);
    expect(stripped).not.toContain('from "y"');
    expect(stripped).not.toContain('from "d"');
  });
});

/**
 * A controller that does exactly what this gate forbids: it claims a task and
 * repairs the snapshot. It is otherwise a plausible resume implementation,
 * which is the point — the writes are the only difference.
 *
 * @param {object} ports - The same ports the real controller receives.
 * @param {object} options - The same options.
 * @returns {Promise<object>} A report-shaped object.
 */
async function writingController(ports, options) {
  await ports.latestValid?.(options.missionId);
  await ports.claimTask?.({ missionId: options.missionId, taskId: 'T-1', owner: 'w-1' });
  ports.reconcile?.({ apply: options.apply === true });
  await ports.appendEvent?.({ event: 'mission.resumed', mission_id: options.missionId });
  return { mission_id: options.missionId, steps: [], blocked_by: [], resumable: true, evidence: {} };
}

describe('the audit itself', () => {
  it('goes red on a controller that claims a task, so a green above is not vacuous', async () => {
    const bad = verdict(await auditPortUse(writingController));
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' ')).toContain('claimTask');
  });

  it('goes red on a controller that forwards apply:true into reconcile', async () => {
    const bad = verdict(await auditPortUse(writingController));
    expect(bad.reasons.join(' ')).toContain('apply:true');
  });

  it('goes red on a controller that calls nothing at all, so the denominator is load-bearing', async () => {
    const inert = async () => ({ steps: [] });
    const bad = verdict(await auditPortUse(inert));
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' ')).toContain('did not exercise the controller');
  });

  it('records the write ports it saw, not merely that it saw some', async () => {
    const audit = await auditPortUse(writingController);
    expect(audit.writes).toContain('claimTask');
    expect(audit.writes).toContain('appendEvent');
    expect(audit.applyTrue).toBe(FIXTURES.length);
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * CA-05 b — `/resume --read-order` pins the ARTIBOT.md read order.
 *
 * WHY. Design §159 says `/resume` executes "the ARTIBOT.md read order", and the
 * canonical order lives in ONE place: the repo-root `ARTIBOT.md` `## Read Order`
 * list. `commands/resume.md` now carries a COPY of that order so the command
 * body can be followed without opening another file. Two copies of an ordered
 * list is exactly the shape that rots silently: someone reorders ARTIBOT.md,
 * the command keeps reciting the old order, and nothing is red. So the expected
 * values here are PARSED from ARTIBOT.md on every run — never hardcoded — and
 * the command's steps are compared position by position.
 *
 * The comparison is by DISTINCTIVE TOKEN. Each ARTIBOT item contributes the
 * tokens that appear in no other item (`project.md`, `state.yaml`, `intent.md`,
 * `plan.md`, `adr`, `review`/`outcome`), and the command's step at the same
 * index must use at least one of them. A token shared across items (`artibot`,
 * `mission`, `landed`) is worth nothing here, which is what makes a swapped
 * pair go red rather than match by accident.
 *
 * ── WHAT THIS GATE CANNOT SEE (rules §9) ───────────────────────────────────
 *   - WHETHER THE PROSE IS OBEYED. This pins the text of a command document.
 *     Whether the model actually reads those six paths in that order at run
 *     time is a LIVE observation and is UNMEASURED here. Document ≠ behavior.
 *   - WHETHER THE PATHS EXIST. `state.yaml` and the mission artifacts are
 *     marked `not yet landed` in ARTIBOT.md. Their existence is the business of
 *     `artibot-entry-parity.test.js`, not this file.
 *   - WHETHER THE ORDER IS RIGHT. Only that the two copies agree. If ARTIBOT.md
 *     itself is wrong, this gate is green.
 *   - THE DEFAULT MODE'S OUTPUT. The "unchanged without the flag" assertion
 *     below checks that the document SAYS so. Nothing here runs the command.
 * ─────────────────────────────────────────────────────────────────────────── */

const ARTIBOT_MD = readFileSync(new URL('../../../../ARTIBOT.md', import.meta.url), 'utf-8');
const RESUME_MD = readFileSync(new URL('../../commands/resume.md', import.meta.url), 'utf-8');

/**
 * The body of the first section whose heading line matches, up to the next
 * heading of the same or shallower level.
 *
 * @param {string} text - Whole markdown document.
 * @param {RegExp} headingRe - Matches the heading LINE.
 * @returns {string|null} Section body, or null when the heading is absent.
 */
function sectionBody(text, headingRe) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^#+\s/.test(line) && headingRe.test(line));
  if (start === -1) return null;
  const level = lines[start].match(/^#+/)[0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#+\s/.test(line) && line.match(/^#+/)[0].length <= level);
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * Top-level numbered list items of a section body, in document order.
 *
 * @param {string} body - Section body.
 * @returns {Array<{n: number, text: string}>} Items.
 */
function numberedItems(body) {
  const items = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^(\d+)\.\s+(\S.*)$/);
    if (m) items.push({ n: Number(m[1]), text: m[2].trim() });
  }
  return items;
}

/** Lowercase, and drop one trailing plural `s` so `ADRs` and `ADR` agree. */
const stem = (word) => {
  const lower = word.toLowerCase();
  return lower.length > 3 && lower.endsWith('s') ? lower.slice(0, -1) : lower;
};

/**
 * Latin word / filename tokens of a line, stemmed and deduped. Korean prose is
 * deliberately ignored: the identifying part of every step is a path or an
 * English noun, and matching on Korean particles would match everything.
 *
 * @param {string} text - Line text.
 * @returns {string[]} Tokens.
 */
function tokensOf(text) {
  const raw = text.match(/[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*/g) ?? [];
  return [...new Set(raw.map(stem))];
}

/**
 * Compare a candidate step list against the canonical one, position by
 * position. Returns reasons rather than throwing so the SAME comparator can be
 * pointed at a deliberately wrong fixture.
 *
 * @param {Array<{n: number, text: string}>} canon - Parsed from ARTIBOT.md.
 * @param {Array<{n: number, text: string}>} candidate - Parsed from resume.md.
 * @returns {{pass: boolean, reasons: string[], checked: number}} Verdict.
 */
function compareReadOrder(canon, candidate) {
  const reasons = [];
  if (canon.length === 0) reasons.push('canonical read order parsed as 0 steps');
  if (candidate.length !== canon.length) {
    reasons.push(`step count ${candidate.length} != canonical ${canon.length}`);
  }
  const seen = new Map();
  for (const item of canon) {
    for (const token of tokensOf(item.text)) seen.set(token, (seen.get(token) ?? 0) + 1);
  }
  let checked = 0;
  for (let i = 0; i < canon.length; i += 1) {
    const distinctive = tokensOf(canon[i].text).filter((t) => seen.get(t) === 1);
    if (distinctive.length === 0) {
      reasons.push(`canonical step ${i + 1} has no distinctive token — comparison would be vacuous`);
      continue;
    }
    const got = candidate[i];
    if (!got) {
      reasons.push(`step ${i + 1} missing from candidate`);
      continue;
    }
    checked += 1;
    const mine = new Set(tokensOf(got.text));
    if (!distinctive.some((t) => mine.has(t))) {
      reasons.push(`step ${i + 1} matches none of [${distinctive.join(', ')}]`);
    }
  }
  return { pass: reasons.length === 0, reasons, checked };
}

const CANON_BODY = sectionBody(ARTIBOT_MD, /Read Order/);
const CANON_STEPS = CANON_BODY === null ? [] : numberedItems(CANON_BODY);
const READ_ORDER_BODY = sectionBody(RESUME_MD, /--read-order/);
const READ_ORDER_STEPS = READ_ORDER_BODY === null ? [] : numberedItems(READ_ORDER_BODY);

describe('/resume --read-order mirrors the canonical ARTIBOT read order', () => {
  it('parses a non-empty canonical order out of ARTIBOT.md, 6 steps as measured 2026-09-21', () => {
    expect(CANON_BODY).not.toBeNull();
    expect(CANON_STEPS.length).toBeGreaterThan(0);
    expect(CANON_STEPS.length).toBe(6);
    expect(CANON_STEPS.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('resume.md carries a --read-order section with the same step count', () => {
    expect(READ_ORDER_BODY).not.toBeNull();
    expect(READ_ORDER_STEPS.length).toBe(CANON_STEPS.length);
    expect(READ_ORDER_STEPS.map((s) => s.n)).toEqual(CANON_STEPS.map((s) => s.n));
  });

  it(`each of the ${CANON_STEPS.length} steps matches its canonical position`, () => {
    const result = compareReadOrder(CANON_STEPS, READ_ORDER_STEPS);
    expect(result.reasons).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.checked).toBe(CANON_STEPS.length);
  });

  it('names ARTIBOT.md as the single source of the order, so the copy is marked as one', () => {
    expect(READ_ORDER_BODY).toContain('ARTIBOT.md');
  });
});

describe('the read-order comparator itself', () => {
  it('goes red on a shuffled copy, so a green above is not vacuous', () => {
    const shuffled = numberedItems([
      '1. `.artibot/state.yaml`',
      '2. `.artibot/project.md`',
      '3. 활성 미션 `plan.md`',
      '4. 활성 미션 `intent.md`',
      '5. Review / Outcome',
      '6. 관련 ADR — `.artibot/adr/`',
    ].join('\n'));
    const bad = compareReadOrder(CANON_STEPS, shuffled);
    expect(bad.pass).toBe(false);
    expect(bad.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it('goes red on an empty candidate, so the denominator is load-bearing', () => {
    const bad = compareReadOrder(CANON_STEPS, []);
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' ')).toContain('step count 0');
  });

  it('every canonical step really has a distinctive token — the loop is not empty', () => {
    const seen = new Map();
    for (const item of CANON_STEPS) {
      for (const token of tokensOf(item.text)) seen.set(token, (seen.get(token) ?? 0) + 1);
    }
    for (const [i, item] of CANON_STEPS.entries()) {
      const distinctive = tokensOf(item.text).filter((t) => seen.get(t) === 1);
      expect({ step: i + 1, distinctive: distinctive.length > 0 }).toEqual({ step: i + 1, distinctive: true });
    }
  });

  it('the section slicer stops at the next heading of equal or shallower level', () => {
    const probe = '## A\n1. one\n### A2\n2. two\n## B\n3. three\n';
    expect(numberedItems(sectionBody(probe, /A2/))).toEqual([{ n: 2, text: 'two' }]);
    expect(numberedItems(sectionBody(probe, /^## B/)).length).toBe(1);
    expect(sectionBody(probe, /nope/)).toBeNull();
  });
});

describe('--read-order is a fallback-shaped, report-only, opt-in mode', () => {
  it('HANDOFF appears only outside the numbered steps, as the fallback', () => {
    for (const step of READ_ORDER_STEPS) {
      expect({ n: step.n, handoff: step.text.includes('HANDOFF') }).toEqual({ n: step.n, handoff: false });
    }
    const prose = READ_ORDER_BODY.split(/\r?\n/).filter((l) => !/^\d+\.\s/.test(l)).join('\n');
    expect(prose).toContain('HANDOFF.md');
    expect(prose).toContain('폴백');
  });

  it('the section states it writes nothing and transitions nothing', () => {
    expect(READ_ORDER_BODY).toContain('읽기 전용');
    expect(READ_ORDER_BODY).toContain('전이시키지 않는다');
  });

  it('frontmatter allowed-tools grants no write tool', () => {
    const frontmatter = RESUME_MD.split(/\r?\n/).slice(1, 20).join('\n').split(/^---\s*$/m)[0];
    expect(frontmatter).toContain('allowed-tools');
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      expect({ tool, granted: /allowed-tools:.*$/m.exec(frontmatter)?.[0].includes(tool) }).toEqual({ tool, granted: false });
    }
  });

  it('the argument list promises an unchanged default output for --read-order', () => {
    const args = sectionBody(RESUME_MD, /^##\s+Arguments/);
    const line = args.split(/\r?\n/).find((l) => l.includes('--read-order'));
    expect(line).toBeDefined();
    expect(line).toContain('플래그가 없으면 출력은 종전과 완전히 동일');
  });

  it('the anti-pattern list forbids a --read-order write', () => {
    const anti = sectionBody(RESUME_MD, /^##\s+Anti-Patterns/);
    expect(anti.split(/\r?\n/).some((l) => l.includes('--read-order'))).toBe(true);
  });
});
