/**
 * `lib/security/human-gate-enforce.js` · `lib/security/human-gate-curl.js` 성능 게이트 —
 * 긴 단일 런 스윕(human-gate-enforce.test.js 에서 800줄 한도로 분리, 2026-09-28).
 *
 * 여기서 보는 것:
 *  - ENFORCE_PATTERNS 정규식마다 구조 스캔(findUnboundedRuns)과 근접-미스 성장비.
 *  - decideHumanGate 전체 경로·경로 술어의 성장비(세그먼트 최대화 필러 포함).
 *  - human-gate-curl.js 의 문자열 상태기계(shellWords·curlProvenLoopbackOnly) — 정규식이 아니라
 *    ReDoS 카탈로그가 못 보므로 **이 파일의 성장비 스윕이 유일한 성능 증거**다. 필러는 따옴표
 *    전이·값 옵션 건너뛰기·플래그 묶음·긴 단일 단어 등 상태 전이를 최대화하는 형이다.
 *  - 게이트 자기검증: 일부러 2차식으로 만든 단어 분해기에 같은 성장비 게이트를 대면 RED 가 난다.
 *
 * 이 파일이 못 보는 것: 절대 ms 는 이 머신 부하에 달렸다(게이트는 6배 구간 성장비 + 느슨한
 * 상한). 실트래픽 명령 길이 분포(코퍼스 없음). safety.test.js 의 카탈로그 스캔과는 별개다.
 */

import { describe, expect, it } from 'vitest';
import {
  decideHumanGate,
  ENFORCE_DECISIONS,
  ENFORCE_PATTERNS,
  isClaudeConfigPath,
} from '../../lib/security/human-gate-enforce.js';
import { curlProvenLoopbackOnly, shellWords } from '../../lib/security/human-gate-curl.js';
import { findUnboundedRuns } from '../helpers/regex-scan.js';

// Windows 경로는 조각으로 조립한다(land 인용 게이트가 드라이브+사용자 폴더 리터럴을 거부).
const CACHE_ROOT = ['C:', 'Users', 'HeechangLee', '.claude', 'plugins', 'cache', 'artibot', 'artibot', '4.67.0'].join('\\');

const ENFORCE_ALL = {
  permissions: {
    humanGates: {
      enforce: { enabled: true, mode: 'enforce', gates: ['HG-07', 'HG-12', 'HG-13'], askHonoredModes: ['default'] },
    },
  },
};

/** 강제 켠 합성 config · 권한 모드 default · pluginRoot = 설치 캐시. */
const decide = (input) => decideHumanGate({
  permissionMode: 'default',
  pluginRoot: CACHE_ROOT,
  config: ENFORCE_ALL,
  ...input,
});

// ── ReDoS: 긴 단일 런 스윕 ─────────────────────────────────────────────────
// 정규식마다 근접-미스 payload(매치하지 않는 형)를 20,480·40,960·122,880B 로 키운다. 핵심
// 단언은 구조(스캐너 0건)와 종료·결과(false)이고, 벽시계는 6배 구간 성장비(바닥값 4ms)와
// 느슨한 절대 상한만 둔다. 헬퍼는 tests/security/human-gates.test.js 와 **형식만** 같은
// 자급형 복사본이다(테스트 파일끼리 import 하지 않는다).

/** 반복 단위로 정확히 bytes 길이의 payload. @param {string} unit @param {number} bytes */
function fill(unit, bytes) {
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

/** fn 을 runs 회 돌린 경과 시간의 중앙값(ms). @param {() => void} fn @param {number} runs */
function medianMs(fn, runs) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(runs / 2)];
}

/** 성장 게이트의 바닥값(ms). 빠르고 선형인 규칙에서 생 비율이 튀는 것을 막는다. */
const RATIO_FLOOR_MS = 4;

/** 6배 구간 성장 비율. @param {number} numerator @param {number} denominator */
function growth(numerator, denominator) {
  return (numerator + RATIO_FLOOR_MS) / (denominator + RATIO_FLOOR_MS);
}

/**
 * 길이를 그대로 둔 채 회차 표식을 **꼬리에** 박는다(V8 의 같은 (regex, string) 결과 캐시 회피).
 * human-gates.test.js 는 머리에 박지만, 여기서는 머리 단어(`bypassPreCommitHooks`)와 `^` 앵커
 * 시작 위치를 보존해야 2차식 형이 살아 있으므로 꼬리다. 표식은 슬래시·별표 형이 아니라 `#i#` —
 * 슬래시 표식이 `a:/` 필러 꼬리와 붙어 `://` 를 만들어 당시 카탈로그의 URL_AUTHORITY 를
 * 매치시켰다(2026-09-28 이 스윕의 RED 로 관측; URL_AUTHORITY 는 review2 수리 라운드 1 에서 제거).
 * @param {(n: number) => string} build @param {number} n @param {number} i
 */
function tagged(build, n, i) {
  const tag = `#${i}#`;
  return build(n).slice(0, n - tag.length) + tag;
}

/**
 * 머리 표식 — 보호 basename 이 꼬리에 있어야 하는 경로 payload 용(꼬리 표식은 basename 을 깬다).
 * @param {(n: number) => string} build @param {number} n @param {number} i
 */
function headTagged(build, n, i) {
  const tag = `#${i}#`;
  return tag + build(n).slice(tag.length);
}

/** build 를 회차마다 다른 payload 로 3회 돌린 median(ms). payload 는 측정 밖에서 만든다. */
function medianOverTagged(run, build, n) {
  const payloads = [0, 1, 2].map((i) => tagged(build, n, i));
  let cursor = 0;
  return medianMs(() => {
    run(payloads[cursor]);
    cursor += 1;
  }, payloads.length);
}

const SIZES = [20_480, 40_960, 122_880];

/** 패턴 id → 근접-미스 payload 빌더들. */
const NEAR_MISS_BUILDERS = Object.freeze({
  BASH_HG12_PATH: [(n) => fill('.claude/', n)],
  BASH_HG13_PATH: [(n) => fill('.claude/', n), (n) => fill('.claude/artibot.config.jso ', n)],
  SKIP_PERMISSIONS_FLAG: [(n) => fill('--dangerously-skip-permission ', n)],
  NO_VERIFY_FLAG: [(n) => fill('--no-verif ', n)],
  BYPASS_HOOKS_TRUE: [
    (n) => fill('bypassPrePushHooks: tru ', n),
    (n) => `bypassPreCommitHooks${' '.repeat(n - 21)}x`,
  ],
  SHELL_CHAIN_META: [(n) => fill('ab ', n)],
  TOKEN_SEPARATOR: [(n) => fill('ab', n)],
  WHITESPACE: [(n) => fill('ab', n)],
});

/** decideHumanGate 전체 경로 payload — HG-13[2] 원본 2차식 형(regex-scan.js 카탈로그 (vi))을 포함한다. */
const END_TO_END_BUILDERS = Object.freeze({
  'HG-13[2] 원본 2차식 형: bypassPreCommitHooks + 공백×n': (n) => `bypassPreCommitHooks${' '.repeat(n - 21)}x`,
  '.claude/ 반복': (n) => fill('.claude/', n),
  'curl -X POST 반복': (n) => fill('curl -X POST ', n),
  '--no-verif 반복': (n) => fill('--no-verif ', n),
  'loopback URL 반복': (n) => fill('http://127.0.0.1 ', n),
  '도메인 모양 토큰 반복': (n) => fill('a.b ', n),
  '.claude/worktrees/ 반복': (n) => fill('.claude/worktrees/x', n),
  // 세그먼트 수 최대화 필러 — 2026-09-28 toPathSegments reduce+spread 2차식의 재현 형
  // (redos 팀원 실측 isClaudeConfigPath fill('a://') 122,880B 4,570.7ms).
  'a:// 단일 토큰': (n) => fill('a://', n),
  'curl -X POST + a:// 단일 토큰': (n) => `curl -X POST ${fill('a://', n - 13)}`,
  '../ 단일 토큰': (n) => fill('../', n),
  'a/ 단일 토큰': (n) => fill('a/', n),
});

/** 보호 basename 을 꼬리에 둔 경로 payload(머리 표식) — 술어가 끝까지 도는 형. */
const PATH_BUILDERS = Object.freeze({
  'a:// + settings.json': (n) => `${fill('a://', n - 13)}settings.json`,
  '../ + .claude/settings.json': (n) => `${fill('../', n - 21)}.claude/settings.json`,
  'a/ + artibot.config.json': (n) => `${fill('a/', n - 19)}artibot.config.json`,
  '.claude/worktrees/x/ + hooks.json': (n) => `${fill('.claude/worktrees/x/', n - 10)}hooks.json`,
  '백슬래시 a\\ + dispatch-table.json': (n) => `${fill('a\\', n - 19)}dispatch-table.json`,
});

describe('ReDoS — 새 정규식 구조 스캔과 긴 단일 런 스윕', () => {
  const patternIds = ENFORCE_PATTERNS.map((entry) => entry.id);
  const patternOf = (id) => ENFORCE_PATTERNS.find((entry) => entry.id === id).pattern;

  it('ENFORCE_PATTERNS 는 동결 배열이고 항목마다 고정 id + RegExp 다', () => {
    expect(Object.isFrozen(ENFORCE_PATTERNS)).toBe(true);
    expect(new Set(patternIds).size).toBe(patternIds.length);
    for (const entry of ENFORCE_PATTERNS) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.keys(entry)).toEqual(['id', 'pattern']);
      expect(entry.pattern).toBeInstanceOf(RegExp);
    }
  });

  it('모든 패턴에 근접-미스 빌더가 등록돼 있다 (새 패턴이 스윕을 빠져나가지 못한다)', () => {
    expect(Object.keys(NEAR_MISS_BUILDERS).sort()).toEqual([...patternIds].sort());
  });

  it('빌더는 주장한 바이트 수를 정확히 만들고 회차 표식이 payload 를 바꾼다', () => {
    for (const build of [...Object.values(NEAR_MISS_BUILDERS).flat(), ...Object.values(END_TO_END_BUILDERS)]) {
      expect(build(20_480)).toHaveLength(20_480);
      expect(tagged(build, 20_480, 0)).toHaveLength(20_480);
      expect(tagged(build, 20_480, 0)).not.toBe(tagged(build, 20_480, 1));
    }
  });

  it.each(patternIds)('%s — 창 192 초과 무제한 런 0건 (findUnboundedRuns), g·y 플래그 없음', (id) => {
    const re = patternOf(id);
    expect(re.global).toBe(false);
    expect(re.sticky).toBe(false);
    expect(findUnboundedRuns(re.source, re.flags)).toEqual([]);
  });

  it.each(patternIds)('%s — 20KB/40KB/120KB 근접-미스에서 종료·불일치, 6배 성장비 < 18', (id) => {
    const re = patternOf(id);
    for (const build of NEAR_MISS_BUILDERS[id]) {
      for (const n of SIZES) expect(re.test(tagged(build, n, 9))).toBe(false);
      const [t20480, , t122880] = SIZES.map((n) => medianOverTagged((s) => re.test(s), build, n));
      expect(t122880).toBeLessThan(1500);
      expect(growth(t122880, t20480)).toBeLessThan(18);
    }
  });

  it.each(Object.keys(END_TO_END_BUILDERS))('decideHumanGate 전체 경로 — %s: 종료, 어휘 안 결정, 6배 성장비 < 18', (label) => {
    const build = END_TO_END_BUILDERS[label];
    const run = (command) => decide({ tool: 'Bash', command });
    expect(ENFORCE_DECISIONS).toContain(run(tagged(build, 122_880, 9)).decision);
    const [t20480, , t122880] = SIZES.map((n) => medianOverTagged(run, build, n));
    expect(t122880).toBeLessThan(3000);
    expect(growth(t122880, t20480)).toBeLessThan(18);
  });

  /** 머리 표식 payload 로 3회 median(ms). */
  const medianOverHeadTagged = (run, build, n) => {
    const payloads = [0, 1, 2].map((i) => headTagged(build, n, i));
    let cursor = 0;
    return medianMs(() => {
      run(payloads[cursor]);
      cursor += 1;
    }, payloads.length);
  };

  it.each(Object.keys(PATH_BUILDERS))('경로 술어·Write/Edit 경로 — %s: 선형(6배 성장비 < 18)', (label) => {
    const build = PATH_BUILDERS[label];
    expect(build(20_480)).toHaveLength(20_480);
    const runs = [
      (p) => isClaudeConfigPath(p, { pluginRoot: CACHE_ROOT }),
      (p) => decide({ tool: 'Write', path: p }),
      (p) => decide({ tool: 'Bash', command: `cp x ${p}` }),
    ];
    for (const run of runs) {
      const [t20480, , t122880] = SIZES.map((n) => medianOverHeadTagged(run, build, n));
      expect(t122880).toBeLessThan(3000);
      expect(growth(t122880, t20480)).toBeLessThan(18);
    }
  });
});

// ── human-gate-curl.js 문자열 상태기계 — ReDoS 카탈로그 밖의 유일한 성능 증거 ─────────
// 필러는 끝까지 읽혀야 한다(첫 단어에서 거짓으로 빠지면 스윕이 아무것도 재지 않는다):
// 플래그·값 옵션·따옴표 전이·loopback 대상 반복은 전부 끝까지 증명을 시도하는 형이다.

/** 상태 전이 최대화 필러 — [라벨, 빌더, 끝까지 읽었을 때의 기대 결과]. */
const CURL_STATE_BUILDERS = Object.freeze([
  ['무인자 짧은 플래그 반복 `-s `', (n) => `curl ${fill('-s ', n - 5)}`, false],
  ['플래그 묶음 반복 `-sSvkifgN46 `', (n) => `curl ${fill('-sSvkifgN46 ', n - 5)}`, false],
  ['긴 플래그 반복 `--silent `', (n) => `curl ${fill('--silent ', n - 5)}`, false],
  ['값 옵션 반복 `-X POST `', (n) => `curl ${fill('-X POST ', n - 5)}`, false],
  ["작은따옴표 전이 반복 `-d 'a@b\\c' `", (n) => `curl ${fill("-d 'a@b\\c' ", n - 5)}`, false],
  ['큰따옴표 전이 반복 `-H "a b" `', (n) => `curl ${fill('-H "a b" ', n - 5)}`, false],
  ['loopback 대상 반복', (n) => `curl ${fill('http://127.0.0.1 ', n - 5)}`, true],
  ['긴 단일 작은따옴표 단어', (n) => `curl -d '${fill('a', n - 12)}' x`, false],
  ['긴 단일 짧은 플래그 단어', (n) => `curl -${fill('s', n - 6)}`, false],
  ['긴 loopback 경로', (n) => `curl http://127.0.0.1/${fill('a', n - 22)}`, true],
  ['닫히지 않는 큰따옴표', (n) => `curl "${fill('a ', n - 6)}`, false],
]);

/** 게이트 자기검증용 — 단어마다 배열을 통째로 복사하는 2차식 분해기(일부러 틀린 구현). */
function quadraticWords(command) {
  let words = [];
  let current = '';
  for (const ch of command) {
    if (ch === ' ') {
      words = [...words, current];
      current = '';
    } else {
      current += ch;
    }
  }
  return [...words, current];
}

describe('human-gate-curl — 상태기계 긴 단일 런 스윕', () => {
  it('빌더는 주장한 바이트 수를 정확히 만든다', () => {
    for (const [, build] of CURL_STATE_BUILDERS) expect(build(20_480)).toHaveLength(20_480);
  });

  it.each(CURL_STATE_BUILDERS)('%s — 120KB 결과 고정, 6배 성장비 < 18 (증명·단어 분해·전체 경로)', (_label, build, expected) => {
    expect(curlProvenLoopbackOnly(build(122_880))).toBe(expected);
    const runs = [
      (s) => curlProvenLoopbackOnly(s),
      (s) => shellWords(s),
      (s) => decide({ tool: 'Bash', command: s }),
    ];
    // 꼬리 표식 — 머리 표식은 첫 단어 `curl` 을 깨서 증명을 첫 글자에서 끝낸다.
    for (const run of runs) {
      const [t20480, , t122880] = SIZES.map((n) => medianOverTagged(run, build, n));
      expect(t122880).toBeLessThan(3000);
      expect(growth(t122880, t20480)).toBeLessThan(18);
    }
  });

  it('게이트 자기검증 — 같은 성장비 게이트가 2차식 분해기는 잡는다(양성 대조)', () => {
    // 2026-09-28 실측(scratch, 3회 중앙값): 8,192/49,152B 에서 2차식 6.6/465.0ms growth 44.1,
    // 실제 shellWords 0.3/0.8ms growth 1.1. 122,880B 는 2차식이 5s 를 넘어 이 쌍으로 잰다.
    const build = (n) => `curl ${fill('-s ', n - 5)}`;
    const [tq8, tq48] = [8_192, 49_152].map((n) => medianOverTagged(quadraticWords, build, n));
    const [tr8, tr48] = [8_192, 49_152].map((n) => medianOverTagged(shellWords, build, n));
    expect(growth(tq48, tq8)).toBeGreaterThan(18);
    expect(growth(tr48, tr8)).toBeLessThan(18);
  });
});
