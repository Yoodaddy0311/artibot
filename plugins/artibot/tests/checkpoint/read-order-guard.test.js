/**
 * `scripts/checkpoint/read-order-guard.mjs` (CA-08, consumer side) — the
 * judgement and the rendering: a plan, review or outcome that is not CURRENT is
 * never handed to the model as current truth by `/resume --read-order` steps
 * 4 and 6.
 *
 * This file owns the PURE half: the switch reader, the routing through
 * `classifyStaleness`, and the text the model relays. The process-level half
 * (the CLI against a real store, the OFF-is-silent pin, the source pins) lives
 * in `read-order-guard-cli.test.js`; the doc and config pins live in
 * `tests/commands/resume-read-order-guard-doc.test.js`.
 *
 * THE VERDICTS ARE NOT RE-DERIVED HERE. Every expected state below is the one
 * `classifyStaleness` returns for the same inputs, so the guard cannot grow a
 * second definition of "stale" beside the write-side gates
 * (`lib/runtime/artifact-lifecycle-gates.js`). What IS pinned is the guard's
 * own contribution: an ALLOWLIST of `CURRENT` (anything else — an unknown
 * state, a throw, a lie about an unreadable file — is not presented), and that
 * a body is structurally absent from a non-CURRENT entry rather than merely
 * not printed.
 *
 * ── WHAT THIS FILE CANNOT SEE (rules §9) ───────────────────────────────────
 *   - WHETHER THE MODEL RUNS THE CLI AT ALL. `/resume` is prose; a model that
 *     `Read`s plan.md directly never reaches this code. Live behaviour is
 *     UNMEASURED here.
 *   - THE STORE. `live` is injected. Whether the real store yields those numbers
 *     is `read-order-guard-cli.test.js`, against a store seeded by the real
 *     writer.
 *   - A PLAN THAT LAGS ITS OWN STORE REVISION. The classifier compares each
 *     artifact's `based_on` with its UPSTREAM's live revision; it never asks
 *     whether plan.md is the newest plan. That is the classifier's scope, and
 *     this guard does not widen it (two spellings of one classification would
 *     eventually be two classifications).
 *   - STEPS 3 AND 5, AND THE HANDOFF FALLBACK. Only steps 4 and 6 are guarded.
 *
 * @module tests/checkpoint/read-order-guard
 */

import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { classifyStaleness, StaleState } from '../../lib/runtime/artifact-lifecycle.js';
import {
  buildGuardReport,
  collectInputs,
  EXCERPT_MAX_CHARS,
  parseArgs,
  READ_ORDER_STALE_GUARD_CONFIG_PATH,
  readLiveRevisions,
  readStaleGuardEnabled,
  renderGuardReport,
} from '../../scripts/checkpoint/read-order-guard.mjs';
import {
  cleanupTempDirs, MISSION, OUTCOME_MARK, outcomeText, PLAN_MARK, planText, REL, reviewText,
} from './read-order-guard-fixtures.js';

afterAll(cleanupTempDirs);

const okLive = { ok: true, intentRevision: 3, planRevision: 5 };
const present = (text) => ({ presence: 'present', text });
const absent = { presence: 'absent' };

/** What each kind's rendered body holds that no reason line ever does. */
const OWN_FRAGMENTS = {
  plan: [PLAN_MARK, '# Plan', 'Work decomposition'],
  review: ['# Review', '## Verdict'],
  outcome: [OUTCOME_MARK, '# Outcome', 'Accepted Result'],
};

describe('readStaleGuardEnabled — strict boolean at runtime.resume.staleGuard', () => {
  it('names the path the doc, the config and the reader share', () => {
    expect(READ_ORDER_STALE_GUARD_CONFIG_PATH).toBe('runtime.resume.staleGuard');
  });

  it('is true only for the literal boolean true at that path', () => {
    expect(readStaleGuardEnabled({ runtime: { resume: { staleGuard: true } } })).toBe(true);
  });

  it.each([
    ['boolean false', { runtime: { resume: { staleGuard: false } } }],
    ['string "true"', { runtime: { resume: { staleGuard: 'true' } } }],
    ['number 1', { runtime: { resume: { staleGuard: 1 } } }],
    ['string "yes"', { runtime: { resume: { staleGuard: 'yes' } } }],
    ['null', { runtime: { resume: { staleGuard: null } } }],
    ['an array holding true', { runtime: { resume: { staleGuard: [true] } } }],
    ['an object', { runtime: { resume: { staleGuard: { enabled: true } } } }],
    ['an absent key', { runtime: { resume: {} } }],
    ['an absent block', { runtime: {} }],
    ['an absent runtime', {}],
    ['a neighbouring switch set true', { runtime: { checkpoint: { saveOnSave: true }, artifactLifecycle: { enabled: true } } }],
    ['a null config', null],
    ['an undefined config', undefined],
    ['a string config', 'staleGuard'],
    ['a number config', 42],
  ])('is false for %s', (_label, cfg) => {
    expect(readStaleGuardEnabled(cfg)).toBe(false);
  });
});

describe('buildGuardReport — routes through classifyStaleness', () => {
  it('presents every artifact whose classifier state is CURRENT', () => {
    const report = buildGuardReport({
      missionId: MISSION,
      files: { plan: present(planText()), review: present(reviewText()), outcome: present(outcomeText()) },
      live: okLive,
    });
    for (const kind of ['plan', 'review', 'outcome']) {
      expect(report.entries[kind].verdict.presentable, kind).toBe(true);
      expect(typeof report.entries[kind].body, kind).toBe('string');
    }
    // Positive control for the absence claims below: these fragments really are
    // in a printable body, so their absence from a non-CURRENT entry means
    // something.
    const text = renderGuardReport(report);
    for (const fragments of Object.values(OWN_FRAGMENTS)) {
      for (const fragment of fragments) expect(text, fragment).toContain(fragment);
    }
    // The classifier agrees, so this is not a guard-private notion of CURRENT.
    expect(classifyStaleness({ kind: 'plan', basedOn: { intent_revision: 3 }, current: { intentRevision: 3 } }).state)
      .toBe(StaleState.CURRENT);
  });

  it.each([
    ['plan behind the intent', 'plan', planText({ intent: 2 }), StaleState.STALE],
    ['review behind the intent', 'review', reviewText({ intent: 2 }), StaleState.INVALID],
    ['review behind the plan', 'review', reviewText({ plan: 4 }), StaleState.INVALID],
    ['outcome behind the intent', 'outcome', outcomeText({ intent: 2 }), StaleState.NOT_ACCEPTABLE],
    ['outcome behind the plan', 'outcome', outcomeText({ plan: 4 }), StaleState.NOT_ACCEPTABLE],
    ['plan claiming an intent revision the mission never reached', 'plan', planText({ intent: 9 }), StaleState.BROKEN],
    ['review with no plan edge recorded', 'review', reviewText({ plan: null }), StaleState.BROKEN],
  ])('%s -> the classifier state, and no body', (_label, kind, text, state) => {
    const files = { plan: absent, review: absent, outcome: absent };
    // An outcome is judged against a review artifact, so it needs a CURRENT one
    // beside it; that review's own body is not what is being asserted about.
    if (kind === 'outcome') files.review = present(reviewText());
    files[kind] = present(text);
    const report = buildGuardReport({ missionId: MISSION, files, live: okLive });
    const entry = report.entries[kind];

    expect(entry.verdict.presentable).toBe(false);
    expect(entry.verdict.line.startsWith(`${state}:`), entry.verdict.line).toBe(true);
    // Structural, not cosmetic: the entry holds no body to print by mistake.
    expect(entry.body ?? null).toBeNull();
    const rendered = renderGuardReport(report);
    for (const fragment of OWN_FRAGMENTS[kind]) expect(rendered, fragment).not.toContain(fragment);
  });

  it('an unreadable frontmatter is BROKEN and names the parser error CODE, never its message', () => {
    const report = buildGuardReport({
      missionId: MISSION,
      files: { plan: present('no frontmatter here\nSECRET-BODY-TEXT\n'), review: absent, outcome: absent },
      live: okLive,
    });
    const { line } = report.entries.plan.verdict;
    expect(line.startsWith('BROKEN: plan')).toBe(true);
    expect(line).toContain('FRONTMATTER_MISSING');
    expect(renderGuardReport(report)).not.toContain('SECRET-BODY-TEXT');
  });

  it('a live revision that cannot be read makes every present artifact BROKEN, with the reason', () => {
    const report = buildGuardReport({
      missionId: MISSION,
      files: { plan: present(planText()), review: present(reviewText()), outcome: present(outcomeText()) },
      live: { ok: false, why: 'mission-row-absent' },
    });
    for (const kind of ['plan', 'review', 'outcome']) {
      const { line, presentable } = report.entries[kind].verdict;
      expect(presentable, kind).toBe(false);
      expect(line.startsWith('BROKEN:'), line).toBe(true);
      expect(line, kind).toContain('현재 미확인');
      expect(line, kind).toContain('mission-row-absent');
    }
  });

  it('judges an outcome against the REVIEW ARTIFACT\'s own revision (the store keeps none)', () => {
    const fine = buildGuardReport({
      missionId: MISSION,
      files: { plan: absent, review: present(reviewText({ revision: 2 })), outcome: present(outcomeText({ review: 2 })) },
      live: okLive,
    });
    expect(fine.entries.outcome.verdict.presentable).toBe(true);

    const behind = buildGuardReport({
      missionId: MISSION,
      files: { plan: absent, review: present(reviewText({ revision: 3 })), outcome: present(outcomeText({ review: 2 })) },
      live: okLive,
    });
    const { line, presentable } = behind.entries.outcome.verdict;
    expect(presentable).toBe(false);
    expect(line.startsWith('NOT_ACCEPTABLE:')).toBe(true);
    expect(line).toContain('review_revision(선언 2, 현재 3)');
  });

  it('an outcome with no readable review has no live review revision and fails closed', () => {
    const report = buildGuardReport({
      missionId: MISSION,
      files: { plan: absent, review: absent, outcome: present(outcomeText()) },
      live: okLive,
    });
    expect(report.entries.outcome.verdict.presentable).toBe(false);
    expect(report.entries.outcome.verdict.line.startsWith('BROKEN:')).toBe(true);
  });

  it('is an ALLOWLIST of CURRENT: a state the classifier vocabulary does not have is not presented', () => {
    const report = buildGuardReport({
      missionId: MISSION,
      files: { plan: present(planText()), review: absent, outcome: absent },
      live: okLive,
      classify: () => ({ state: 'FRESH_ENOUGH', kind: 'plan', staleMembers: [] }),
    });
    expect(report.entries.plan.verdict.presentable).toBe(false);
    expect(report.entries.plan.verdict.line.startsWith('측정 불가:')).toBe(true);
    expect(renderGuardReport(report)).not.toContain(PLAN_MARK);
  });

  it.each([
    ['undefined', () => undefined],
    ['null', () => null],
    ['a state that is not a string', () => ({ state: 3 })],
    ['no state at all', () => ({})],
    ['"current" in the wrong case', () => ({ state: 'current' })],
  ])('a classifier answer of %s is not presented', (_label, classify) => {
    const report = buildGuardReport({
      missionId: MISSION,
      files: { plan: present(planText()), review: absent, outcome: absent },
      live: okLive,
      classify,
    });
    expect(report.entries.plan.verdict.presentable).toBe(false);
    expect(renderGuardReport(report)).not.toContain(PLAN_MARK);
  });

  it('a classifier that throws fails closed to 측정 불가, with no body and no exception', () => {
    const boom = () => { throw new Error('classifier exploded PLAN-BODY-SENTINEL-7f3a91'); };
    let report;
    expect(() => {
      report = buildGuardReport({
        missionId: MISSION,
        files: { plan: present(planText()), review: absent, outcome: absent },
        live: okLive,
        classify: boom,
      });
    }).not.toThrow();
    expect(report.entries.plan.verdict.line.startsWith('측정 불가: plan')).toBe(true);
    // The thrown message quotes content; it must not reach the output.
    expect(renderGuardReport(report)).not.toContain('exploded');
  });

  it('a classifier that says CURRENT for an unreadable document is still not presented', () => {
    const report = buildGuardReport({
      missionId: MISSION,
      files: { plan: present('garbage\n'), review: absent, outcome: absent },
      live: okLive,
      classify: () => ({ state: StaleState.CURRENT, kind: 'plan', staleMembers: [] }),
    });
    expect(report.entries.plan.verdict.presentable).toBe(false);
    expect(report.entries.plan.verdict.line.startsWith('측정 불가:')).toBe(true);
  });

  it('never echoes a mission id that fails the id pattern, and builds no path from it', () => {
    const report = buildGuardReport({
      missionId: '../../etc/passwd',
      files: { plan: present(planText()), review: absent, outcome: absent },
      live: okLive,
    });
    const text = renderGuardReport(report);
    expect(text).not.toContain('etc/passwd');
    expect(text).not.toContain(PLAN_MARK);
    expect(text.match(/^측정 불가:/gm)?.length).toBe(2);
  });
});

describe('buildGuardReport — inputs it cannot trust', () => {
  const planOnly = (file) => buildGuardReport({
    missionId: MISSION, files: { plan: file, review: absent, outcome: absent }, live: okLive,
  });

  it.each([
    ['null text', null],
    ['numeric text', 42],
    ['an object with no string methods', {}],
    ['an empty file', ''],
  ])('a present file whose text is %s is BROKEN and prints no body', (_label, text) => {
    const report = planOnly({ presence: 'present', text });
    expect(report.entries.plan.verdict.presentable).toBe(false);
    expect(report.entries.plan.verdict.line.startsWith('BROKEN: plan')).toBe(true);
    expect(report.entries.plan.body ?? null).toBeNull();
  });

  it('a presence value nobody defined is treated as unreadable, not as absent and not as present', () => {
    const report = planOnly({ presence: 'weird', text: planText() });
    expect(report.entries.plan.presence).toBe('unreadable');
    expect(report.entries.plan.verdict.presentable).toBe(false);
    expect(renderGuardReport(report)).not.toContain(PLAN_MARK);
  });

  it('an unreadable file\'s reason is printed only if it looks like a code, never as free text', () => {
    const line = planOnly({ presence: 'unreadable', reason: 'EISDIR: secret path C:\\x\\y and text' })
      .entries.plan.verdict.line;
    expect(line).toBe('측정 불가: plan — 읽을 수 없음(unreadable) · 본문 미출력');
  });

  it('a non-CURRENT verdict with no member named still prints one line, and says the reason is unknown', () => {
    const report = buildGuardReport({
      missionId: MISSION,
      files: { plan: present(planText()), review: absent, outcome: absent },
      live: okLive,
      classify: () => ({ state: StaleState.STALE, kind: 'plan', staleMembers: [] }),
    });
    expect(report.entries.plan.verdict.line).toBe('STALE: plan rev 5 — 사유 미상 · 본문 미출력');
  });

  it('a member name from the classifier is printed only if it looks like a token', () => {
    const report = buildGuardReport({
      missionId: MISSION,
      files: { plan: present(planText()), review: absent, outcome: absent },
      live: okLive,
      classify: () => ({ state: StaleState.STALE, kind: 'plan', staleMembers: ['evil member!\nSECOND-LINE'] }),
    });
    const { line } = report.entries.plan.verdict;
    expect(line).not.toContain('SECOND-LINE');
    expect(line.includes('\n')).toBe(false);
    expect(line).toContain('member(선언 없음, 현재 미확인)');
  });

  it('the reason line is ONE line whatever the inputs held', () => {
    const report = buildGuardReport({
      missionId: MISSION,
      files: { plan: present(planText({ intent: 2 })), review: present(reviewText({ plan: 4 })), outcome: present(outcomeText({ intent: 1 })) },
      live: { ok: false, why: 'store-unreadable' },
    });
    for (const kind of ['plan', 'review', 'outcome']) {
      expect(report.entries[kind].verdict.line.includes('\n'), kind).toBe(false);
    }
  });
});

describe('readLiveRevisions — the store row, read without coercion', () => {
  const opener = (getMission) => () => ({ getMission });

  it('reads the intent and plan revisions off the row', () => {
    const row = { intent: { revision: 4 }, plan: { revision: 6 } };
    expect(readLiveRevisions('/p', MISSION, opener(() => row))).toEqual({ ok: true, intentRevision: 4, planRevision: 6 });
  });

  it('asks the store for the id it was given, and only that', () => {
    const asked = [];
    readLiveRevisions('/p', MISSION, opener((id) => { asked.push(id); return null; }));
    expect(asked).toEqual([MISSION]);
  });

  it.each([['null', null], ['undefined', undefined], ['a string', 'row'], ['a number', 5]])(
    'a store answer of %s is mission-row-absent',
    (_label, answer) => {
      expect(readLiveRevisions('/p', MISSION, opener(() => answer))).toEqual({ ok: false, why: 'mission-row-absent' });
    },
  );

  it.each([
    ['the string "3"', '3'], ['a negative number', -1], ['a fraction', 1.5], ['NaN', Number.NaN],
    ['null', null], ['undefined', undefined], ['true', true], ['an object', { n: 3 }],
  ])('a revision of %s is null, never coerced', (_label, revision) => {
    const out = readLiveRevisions('/p', MISSION, opener(() => ({ intent: { revision }, plan: { revision } })));
    expect(out).toEqual({ ok: true, intentRevision: null, planRevision: null });
  });

  it('zero is a revision', () => {
    const out = readLiveRevisions('/p', MISSION, opener(() => ({ intent: { revision: 0 }, plan: { revision: 0 } })));
    expect(out).toEqual({ ok: true, intentRevision: 0, planRevision: 0 });
  });

  it('a row with no plan block leaves the plan revision null (so review and outcome fail closed)', () => {
    const live = readLiveRevisions('/p', MISSION, opener(() => ({ intent: { revision: 3 } })));
    expect(live).toEqual({ ok: true, intentRevision: 3, planRevision: null });
    const report = buildGuardReport({
      missionId: MISSION, files: { plan: absent, review: present(reviewText()), outcome: absent }, live,
    });
    expect(report.entries.review.verdict.line).toContain('plan_revision(선언 5, 현재 미확인)');
    expect(report.entries.review.verdict.presentable).toBe(false);
  });

  it('a store that throws when opened, or when asked, is store-unreadable and the message is not echoed', () => {
    const openThrows = () => { throw new Error('EACCES C:\\secret\\path'); };
    const askThrows = () => ({ getMission: () => { throw new Error('torn journal'); } });
    for (const open of [openThrows, askThrows]) {
      const out = readLiveRevisions('/p', MISSION, open);
      expect(out).toEqual({ ok: false, why: 'store-unreadable' });
      expect(JSON.stringify(out)).not.toMatch(/secret|torn/);
    }
  });
});

describe('collectInputs — the id is validated before anything is read', () => {
  /** Recording ports: what was asked of the disk and of the store. */
  function recorder(files = {}) {
    const calls = [];
    return {
      calls,
      ports: {
        readText: (file) => { calls.push(['text', file]); return files[path.basename(file)] ?? absent; },
        readLive: (root, id) => { calls.push(['live', root, id]); return okLive; },
      },
    };
  }

  it.each(['..', '../x', 'M-20260929-001/../x', '', 'm-20260929-001', 'M-20260929-01', ' M-20260929-001'])(
    'a malformed id %j builds no path, reads no file and opens no store',
    (id) => {
      const { calls, ports } = recorder({ 'plan.md': present(planText()) });
      expect(collectInputs('/project', id, ports)).toEqual({ files: null, live: null });
      expect(calls).toEqual([]);
    },
  );

  it('a valid id reads exactly the three canonical paths under the mission folder, plan first', () => {
    const { calls, ports } = recorder();
    collectInputs('/project', MISSION, ports);
    const files = calls.filter(([what]) => what === 'text').map(([, file]) => path.relative('/project', file).split(path.sep).join('/'));
    expect(files).toEqual([REL('plan.md'), REL('review.md'), REL('outcome.md')]);
  });

  it('does not open the store when all three artifacts are absent (the answer is 부재 whatever it holds)', () => {
    const { calls, ports } = recorder();
    collectInputs('/project', MISSION, ports);
    expect(calls.filter(([what]) => what === 'live')).toEqual([]);
  });

  it('opens the store exactly once when at least one artifact is present', () => {
    const { calls, ports } = recorder({ 'review.md': present(reviewText()) });
    const out = collectInputs('/project', MISSION, ports);
    expect(calls.filter(([what]) => what === 'live')).toEqual([['live', '/project', MISSION]]);
    expect(out.live).toEqual(okLive);
    expect(out.files.review.presence).toBe('present');
  });
});

describe('renderGuardReport — the lines the model relays', () => {
  it('renders a CURRENT block: header, provenance line, delimited body', () => {
    const text = renderGuardReport(buildGuardReport({
      missionId: MISSION,
      files: { plan: present(planText()), review: absent, outcome: absent },
      live: okLive,
    }));
    const lines = text.split('\n');
    expect(lines[0]).toBe(`[4/6] ${REL('plan.md')}`);
    expect(lines[1]).toBe('CURRENT: plan rev 5 — intent_revision 3 = 현재 3');
    expect(lines[2]).toBe('--- 본문 (CURRENT 산출물) ---');
    expect(text).toContain(PLAN_MARK);
    expect(text).toContain('--- 본문 끝 ---');
    // The frontmatter is machine metadata, summarised in the provenance line.
    expect(text).not.toContain('schema_version');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('renders a non-CURRENT block as a header plus exactly one reason line', () => {
    const text = renderGuardReport(buildGuardReport({
      missionId: MISSION,
      files: { plan: present(planText({ intent: 2 })), review: absent, outcome: absent },
      live: okLive,
    }));
    expect(text.split('\n\n')[0].split('\n')).toEqual([
      `[4/6] ${REL('plan.md')}`,
      'STALE: plan rev 5 — intent_revision(선언 2, 현재 3) · 본문 미출력',
    ]);
  });

  it('prints the same 부재 lines the doc has always specified', () => {
    const text = renderGuardReport(buildGuardReport({
      missionId: MISSION, files: { plan: absent, review: absent, outcome: absent }, live: okLive,
    }));
    expect(text).toBe(`부재: ${REL('plan.md')}\n\n부재: review/outcome\n`);
  });

  it('prints only the step-6 artifacts that exist, and no 부재 line for the other one', () => {
    const text = renderGuardReport(buildGuardReport({
      missionId: MISSION, files: { plan: absent, review: present(reviewText()), outcome: absent }, live: okLive,
    }));
    expect(text).toContain(`[6/6] ${REL('review.md')}`);
    expect(text).not.toContain('outcome');
    expect(text).not.toContain('부재: review/outcome');
  });

  it('flags an unreadable file (a directory named plan.md) without reading it', () => {
    const text = renderGuardReport(buildGuardReport({
      missionId: MISSION,
      files: { plan: { presence: 'unreadable', reason: 'EISDIR' }, review: absent, outcome: absent },
      live: okLive,
    }));
    expect(text).toContain(`[4/6] ${REL('plan.md')}`);
    expect(text).toContain('측정 불가: plan — 읽을 수 없음(EISDIR) · 본문 미출력');
  });

  it('caps the excerpt at a line boundary and says how much was left out', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `step-${String(i).padStart(4, '0')}`);
    const text = renderGuardReport(buildGuardReport({
      missionId: MISSION, files: { plan: present(planText({ lines })), review: absent, outcome: absent }, live: okLive,
    }));
    expect(text).toContain('step-0000');
    expect(text).not.toContain('step-0999');
    expect(text).toMatch(/이하 \d+자 생략/);
    expect(text.length).toBeLessThan(EXCERPT_MAX_CHARS + 1500);
    // A cut mid-line would print half a step id.
    expect(text.match(/step-\d+/g).every((s) => s.length === 9)).toBe(true);
  });

  it('a CRLF document prints without a carriage return', () => {
    const report = buildGuardReport({
      missionId: MISSION,
      files: { plan: present(planText().replace(/\n/g, '\r\n')), review: absent, outcome: absent },
      live: okLive,
    });
    expect(report.entries.plan.verdict.presentable).toBe(true);
    const text = renderGuardReport(report);
    expect(text).toContain(PLAN_MARK);
    expect(text).not.toContain('\r');
  });
});

describe('parseArgs', () => {
  it('accepts --mission and --cwd', () => {
    expect(parseArgs(['--mission', MISSION, '--cwd', '/x'])).toEqual({ opts: { mission: MISSION, cwd: '/x' } });
  });

  it.each([
    ['no arguments', []],
    ['an unknown flag', ['--mission', MISSION, '--nope']],
    ['--mission with no value', ['--mission']],
    ['--mission followed by another flag', ['--mission', '--cwd', '/x']],
    ['an empty --mission', ['--mission', '']],
    ['a bare positional', [MISSION]],
    ['--cwd with no value', ['--mission', MISSION, '--cwd']],
  ])('rejects %s', (_label, argv) => {
    expect(typeof parseArgs(argv).error).toBe('string');
  });
});
