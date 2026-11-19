/**
 * `scripts/orca/mark.mjs` — wall-clock windows of one `/orca` run (DESIGN §11.1 E1).
 *
 * WHAT THIS PROVES: the script writes `wall-clock-start` / `wall-clock-end`
 * lines through the reused `/split` telemetry store under an ORCA-shaped run id
 * (`run_<hex>`), that the summary hands `null` back as `null` (an unmeasured
 * window is never a zero), and that a real direct invocation fires the entry
 * guard and reaches the same store.
 *
 * WHAT IT CANNOT PROVE: that the leader actually wraps the approval prompt —
 * that is `commands/orca.md` prose, not code. The fixtures are single-run and
 * a handful of events; nothing here says how the store behaves at the size a
 * long-lived run reaches.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closedConfirmLaunchPairs,
  CONFIRM_LAUNCH_SEGMENT,
  main,
  parseArgs,
  runMark,
} from '../../scripts/orca/mark.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', '..', 'scripts', 'orca', 'mark.mjs');
/** The id shape Orca really issued in the P0 run (`run-create` receipt). */
const ORCA_RUN_ID = 'run_3c01547fc37f';

let storeDir = '';
let clock = 0;
/** Fixed, strictly increasing clock: each call advances `step` ms from a base instant. */
const BASE = Date.parse('2026-11-19T04:00:00.000Z');
const tick = (stepMs) => () => {
  clock += stepMs;
  return new Date(BASE + clock);
};

const capture = () => {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) } };
};

/** Run `main` with the injected store and clock; returns exit code and captured text. */
const run = (argv, now = tick(1000)) => {
  const c = capture();
  const code = main(argv, { storeDir, now, ...c.io });
  return { code, out: c.out.join(''), err: c.err.join('') };
};

const eventsFile = (runId) => path.join(storeDir, `${runId}.events.ndjson`);
const readEvents = (runId) => fs.readFileSync(eventsFile(runId), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));

beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-mark-'));
  clock = 0;
});

afterEach(() => {
  fs.rmSync(storeDir, { recursive: true, force: true });
});

describe('parseArgs — 검증은 fail-closed', () => {
  it('start / end / summary 의 올바른 형태를 읽는다', () => {
    const a = parseArgs(['start', CONFIRM_LAUNCH_SEGMENT, '--run-id', ORCA_RUN_ID, '--human-wait', '--json']);
    expect(a).toMatchObject({ ok: true, cmd: 'start', segment: 'confirm-launch', runId: ORCA_RUN_ID, humanWait: true, json: true });
    expect(parseArgs(['end', 'run', '--run-id', ORCA_RUN_ID])).toMatchObject({ ok: true, cmd: 'end', segment: 'run', humanWait: false, json: false });
    expect(parseArgs(['summary', '--run-id', ORCA_RUN_ID])).toMatchObject({ ok: true, cmd: 'summary', segment: null });
  });

  it.each([
    [[], 'unknown or missing command'],
    [['begin', 'x', '--run-id', ORCA_RUN_ID], 'unknown or missing command'],
    [['start', 'x'], '--run-id'],
    [['start', '--run-id', ORCA_RUN_ID], 'exactly one <segment>'],
    [['start', 'a', 'b', '--run-id', ORCA_RUN_ID], 'exactly one <segment>'],
    [['summary', 'run', '--run-id', ORCA_RUN_ID], 'summary takes no segment'],
    [['end', 'run', '--run-id', ORCA_RUN_ID, '--human-wait'], '--human-wait is only meaningful with start'],
    [['start', 'run', '--run-id', ORCA_RUN_ID, '--frobnicate'], 'unknown option'],
    [['start', 'run', '--run-id'], '--run-id requires a value'],
    [['start', 'run', '--run-id', '--json'], '--run-id requires a value'],
  ])('거부: %j', (argv, fragment) => {
    const r = parseArgs(argv);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(fragment);
  });

  it.each([
    '../escape', 'a/b', 'a\\b', '', ' ', '.hidden', 'run id', `run_${'x'.repeat(80)}`, 'run_é',
  ])('runId %j 는 경로 안전 문자만 통과한다', (runId) => {
    expect(parseArgs(['summary', '--run-id', runId]).ok).toBe(false);
  });

  it.each(['../x', 'a/b', '', '-lead', 'two words'])('segment %j 는 거부', (segment) => {
    expect(parseArgs(['start', segment, '--run-id', ORCA_RUN_ID]).ok).toBe(false);
  });
});

describe('start / end — Orca 형식 runId 로 기록된다', () => {
  it('start 는 wall-clock-start 한 줄을 <runId>.events.ndjson 에 쓴다 (humanWait 표시 포함)', () => {
    const r = run(['start', CONFIRM_LAUNCH_SEGMENT, '--run-id', ORCA_RUN_ID, '--human-wait']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(eventsFile(ORCA_RUN_ID))).toBe(true);
    const [ev] = readEvents(ORCA_RUN_ID);
    expect(ev).toMatchObject({ type: 'wall-clock-start', sessionId: ORCA_RUN_ID, data: { segment: 'confirm-launch', humanWait: true } });
    expect(ev.ts).toBe('2026-11-19T04:00:01.000Z');
  });

  it('end 는 wall-clock-end 를 쓴다 — humanWait 키는 end 에 없다', () => {
    run(['start', 'run', '--run-id', ORCA_RUN_ID]);
    const r = run(['end', 'run', '--run-id', ORCA_RUN_ID]);
    expect(r.code).toBe(0);
    const events = readEvents(ORCA_RUN_ID);
    expect(events.map((e) => e.type)).toEqual(['wall-clock-start', 'wall-clock-end']);
    expect(events[1].data).toEqual({ segment: 'run' });
  });

  it('열린 start 가 있는 구간을 다시 start 하면 경고하고 그래도 기록한다', () => {
    run(['start', 'run', '--run-id', ORCA_RUN_ID]);
    const r = run(['start', 'run', '--run-id', ORCA_RUN_ID, '--json']);
    const doc = JSON.parse(r.out);
    expect(doc.ok).toBe(true);
    expect(doc.warnings[0]).toContain('already open');
    expect(readEvents(ORCA_RUN_ID)).toHaveLength(2);
  });

  it('start 없는 end 는 쌍 없는 end 로 기록하고 경고한다 (거부하지 않는다)', () => {
    const r = run(['end', 'run', '--run-id', ORCA_RUN_ID, '--json']);
    const doc = JSON.parse(r.out);
    expect(doc).toMatchObject({ ok: true, command: 'end' });
    expect(doc.warnings[0]).toContain('unpaired end');
    expect(readEvents(ORCA_RUN_ID)).toHaveLength(1);
  });
});

describe('summary — 측정되지 않은 값은 null 그대로', () => {
  it('닫힌 confirm-launch 30s 와 run 120s → 사람 대기 비율 25 (분모는 run 구간)', () => {
    // run start @+1s, confirm start @+2s ... clock advances 1s per call, so use explicit steps.
    const now = (() => { const t = [0, 10_000, 40_000, 120_000]; let i = 0; return () => new Date(BASE + t[i++]); })();
    run(['start', 'run', '--run-id', ORCA_RUN_ID], now);
    run(['start', CONFIRM_LAUNCH_SEGMENT, '--run-id', ORCA_RUN_ID, '--human-wait'], now);
    run(['end', CONFIRM_LAUNCH_SEGMENT, '--run-id', ORCA_RUN_ID], now);
    run(['end', 'run', '--run-id', ORCA_RUN_ID], now);
    const doc = JSON.parse(run(['summary', '--run-id', ORCA_RUN_ID, '--json']).out);
    expect(doc).toMatchObject({ ok: true, runId: ORCA_RUN_ID, eventCount: 4, totalMs: 120_000, humanWaitMs: 30_000, humanWaitPct: 25, confirmLaunchClosedPairs: 1 });
    expect(doc.unpaired).toEqual([]);
  });

  it('end 가 없는 구간은 durationMs null · 비율 null — 0 으로 바뀌지 않는다', () => {
    run(['start', 'run', '--run-id', ORCA_RUN_ID]);
    run(['start', CONFIRM_LAUNCH_SEGMENT, '--run-id', ORCA_RUN_ID, '--human-wait']);
    const doc = JSON.parse(run(['summary', '--run-id', ORCA_RUN_ID, '--json']).out);
    expect(doc.segments.map((s) => s.durationMs)).toEqual([null, null]);
    expect(doc.totalMs).toBeNull();
    expect(doc.humanWaitMs).toBeNull();
    expect(doc.humanWaitPct).toBeNull();
    expect(doc.confirmLaunchClosedPairs).toBe(0);
    expect(doc.unpaired.map((u) => `${u.segment}:${u.side}`)).toEqual(['run:start', 'confirm-launch:start']);
    // The serialised text really carries the literal null for the percentage.
    expect(run(['summary', '--run-id', ORCA_RUN_ID, '--json']).out).toMatch(/"humanWaitPct": null/);
  });

  it('길이 0 의 쌍(오너 사전 위임)은 0 으로 남고 null 과 구분된다', () => {
    const now = (() => { const t = [0, 5_000, 5_000, 65_000]; let i = 0; return () => new Date(BASE + t[i++]); })();
    run(['start', 'run', '--run-id', ORCA_RUN_ID], now);
    run(['start', CONFIRM_LAUNCH_SEGMENT, '--run-id', ORCA_RUN_ID, '--human-wait'], now);
    run(['end', CONFIRM_LAUNCH_SEGMENT, '--run-id', ORCA_RUN_ID], now);
    run(['end', 'run', '--run-id', ORCA_RUN_ID], now);
    const doc = JSON.parse(run(['summary', '--run-id', ORCA_RUN_ID, '--json']).out);
    expect(doc.humanWaitMs).toBe(0);
    expect(doc.humanWaitPct).toBe(0);
    expect(doc.confirmLaunchClosedPairs).toBe(1);
  });

  it('기록이 없는 run 은 빈 요약 — 전부 null, 오류 아님', () => {
    const doc = JSON.parse(run(['summary', '--run-id', 'run_000000000000', '--json']).out);
    expect(doc).toMatchObject({ ok: true, eventCount: 0, segments: [], unpaired: [], totalMs: null, humanWaitMs: null, humanWaitPct: null });
  });

  it('사람이 읽는 표는 null 의 이유를 말로 덧붙이되 숫자는 건드리지 않는다', () => {
    run(['start', CONFIRM_LAUNCH_SEGMENT, '--run-id', ORCA_RUN_ID, '--human-wait']);
    run(['end', CONFIRM_LAUNCH_SEGMENT, '--run-id', ORCA_RUN_ID]);
    const text = run(['summary', '--run-id', ORCA_RUN_ID]).out;
    expect(text).toContain('humanWaitPct: null');
    expect(text).toContain('no closed "run" window');
    expect(text).toContain('confirm-launch closed pairs: 1');
  });
});

describe('closedConfirmLaunchPairs — status.mjs 가 읽는 닫힌 쌍', () => {
  it('confirm-launch 구간 중 durationMs 가 있는 것만 센다', () => {
    const summary = {
      segments: [
        { segment: 'confirm-launch', humanWait: true, durationMs: 1200 },
        { segment: 'confirm-launch', humanWait: true, durationMs: null },
        { segment: 'run', humanWait: false, durationMs: 9999 },
        { segment: 'confirm-integrate', humanWait: true, durationMs: 5 },
      ],
    };
    expect(closedConfirmLaunchPairs(summary)).toHaveLength(1);
    expect(closedConfirmLaunchPairs(null)).toEqual([]);
    expect(closedConfirmLaunchPairs({})).toEqual([]);
  });
});

describe('출력 계약 — --json 은 문서 1개, 실패는 { ok:false, error } + exit 1', () => {
  it('JSON 모드의 성공 출력은 통째로 parse 된다', () => {
    const r = run(['start', 'run', '--run-id', ORCA_RUN_ID, '--json']);
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.out)).not.toThrow();
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, command: 'start', segment: 'run', humanWait: false });
  });

  it('JSON 모드의 파싱 실패도 stdout 에 { ok:false, error } 이고 exit 1, 아무것도 쓰지 않는다', () => {
    const r = run(['start', '../x', '--run-id', ORCA_RUN_ID, '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false });
    expect(r.err).toBe('');
    expect(fs.readdirSync(storeDir)).toEqual([]);
  });

  it('텍스트 모드의 실패는 stderr 에 사유 + 사용법, stdout 은 비어 있다', () => {
    const r = run(['bogus']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('unknown or missing command');
    expect(r.err).toContain('usage:');
  });

  it('--help 는 exit 0 이고 사용법만 낸다', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('usage:');
  });

  it('저장소를 쓸 수 없으면 ok:false 로 닫고 던지지 않는다', () => {
    const blocker = path.join(storeDir, 'not-a-dir');
    fs.writeFileSync(blocker, 'file');
    const args = parseArgs(['start', 'run', '--run-id', ORCA_RUN_ID]);
    const result = runMark(args, { storeDir: path.join(blocker, 'child'), now: tick(1) });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('start failed');
  });
});

describe('실제 직접 실행 — 진입 가드가 발화하고 같은 저장소에 쓴다', () => {
  it('node mark.mjs --help 는 사용법을 낸다 (가드가 false 면 아무것도 안 내고 exit 0)', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf-8', windowsHide: true });
    expect(out).toContain('usage:');
  });

  it('CLAUDE_PLUGIN_ROOT 를 임시 폴더로 돌린 start → summary 왕복 (실제 런타임 저장소는 건드리지 않는다)', () => {
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: storeDir };
    const exec = (args) => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8', windowsHide: true, env });
    exec(['start', CONFIRM_LAUNCH_SEGMENT, '--run-id', ORCA_RUN_ID, '--human-wait']);
    exec(['end', CONFIRM_LAUNCH_SEGMENT, '--run-id', ORCA_RUN_ID]);
    const doc = JSON.parse(exec(['summary', '--run-id', ORCA_RUN_ID, '--json']));
    expect(doc).toMatchObject({ ok: true, eventCount: 2, confirmLaunchClosedPairs: 1 });
    expect(fs.existsSync(path.join(storeDir, 'runtime', 'split', `${ORCA_RUN_ID}.events.ndjson`))).toBe(true);
  });

  it('잘못된 인자는 exit 1 (종료코드가 호출자에게 전달된다)', () => {
    expect(() => execFileSync(process.execPath, [SCRIPT, 'start', 'x'], { stdio: 'pipe', windowsHide: true })).toThrow();
  });
});
