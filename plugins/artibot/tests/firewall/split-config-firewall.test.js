/**
 * Firewall — `artibot.config.json#split` 의 형태 + cross-session 사용자 설정 무접촉 래칫.
 *
 * ── 두 가지를 지킨다 ────────────────────────────────────────────────────────
 *  A. `split` 키의 형태. 키 목록은 **allowlist** 다 — 알 수 없는 키가 생기면 RED.
 *     `maxWindows` 는 `buildFastFanoutPlan` 의 기존 4키(`maxWorktrees`·`hardMaxAgents`)
 *     로 매핑되는데, `normalizeFastProfile` 은 값을 하드캡(12/16)으로 **조용히 클램프**
 *     한다. 그래서 config 값이 정규화를 **그대로 통과하는지**를 여기서 단언한다 — 통과하지
 *     못하면 `/split plan` 이 표시하는 `limits.maxWorktrees` 는 설정값이 아니라 캡이 된다.
 *     (계획의 waves 상한에 실제 반영되는지는 `split-limits-applied.test.js` 의 몫.)
 *
 *  B. 무접촉 래칫(0). 사용자 `settings.json` 의 cross-session 수신 정책과 타 머신 격리
 *     설정은 **사용자 소유**다. 플러그인 소스·설정·문서 어디에도 그 키 이름이 등장하지
 *     않아야 한다 — 문서에 "이 값을 accept 로 두라" 가 적히는 순간 다음 편집자는 그것을
 *     훅에서 쓰게 된다(2026-08-26 설계 판정: 선언적 문서만으로는 부족하고 게이트가 필요).
 *     2026-08-26 실측 기준 플러그인 트리(테스트 제외) 0건이라 0 에서 시작하는 래칫이다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9) ───────────────────────────────────────
 *
 *  1. **다른 철자.** `'crossSession' + 'Inbound'` 처럼 조립하거나 변수로 우회하면
 *     못 본다. 스캔은 의도적으로 리터럴이다 — 명백한 회귀의 비용을 올리는 것이지
 *     작정한 우회를 막는 것이 아니다.
 *  2. **런타임 쓰기.** 어떤 코드가 `~/.claude/settings.json` 을 통째로 읽어 다른 키를
 *     쓰면서 이 키를 건드리는 경우는 문자열이 없으므로 통과한다. 그 경로는
 *     `settings.json` 쓰기 자체를 보는 별도 게이트의 대상이다(현재 없음 — 미확인).
 *  3. **`tests/` 는 스캔하지 않는다.** 이 파일 자신이 그 문자열을 담고 있기 때문이다.
 *     테스트 픽스처가 그 키를 쓰는 것은 플러그인이 쓰는 것이 아니다.
 *  4. **`docs/` 는 부분적으로만 존재한다.** `.gitignore` 가 `plugins/artibot/docs/*` 를
 *     대부분 제외하므로 CI 체크아웃과 로컬의 스캔 분모가 다르다. 분모 하한은 그 차이를
 *     흡수하도록 로컬 실측보다 낮게 잡았다 — 정확 개수가 아니라 하한이다.
 *  5. **의미.** `humanWaitReevalPct` 가 실제로 Phase 5 측정에서 소비되는지는 안 본다
 *     (2026-08-26 기준 소비자 0 — 기록용 값이다).
 *
 * @module tests/firewall/split-config-firewall
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { normalizeFastProfile } from '../../lib/autopilot/fast-profile.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const config = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'));

/** PRD Phase 2 가 정한 값. 바꾸려면 PRD 와 이 표를 함께 고쳐라. */
const EXPECTED_SPLIT = Object.freeze({
  maxWindows: 4,
  minStems: 2,
  serverEntryPaths: [],
  humanWaitReevalPct: 50,
  // recommend=split 힌트 발화 임계(sub-objective 수). `null` = 힌트 OFF(opt-in). minStems 는
  // plan 유효성 하한이지 힌트 임계가 아니다. 출하값이 null 인 이유: 기존 autopilot 힌트가
  // `tier high AND subs ≥ 6` 이라 6 이하 정수를 출하하면 다중 에이전트 autopilot 힌트가 전부
  // split 로 바뀐다(출하 config 만으로 기본 동작 변경) + 실오퍼레이터 /split 데이터 0건(2026-08-26).
  recommendMinSubtasks: null,
});

/**
 * 2026-09-02 에 additive 로 들어온 하위 객체 3종. 값은 각 소비자가 기본값으로 읽으므로
 * 여기서 형태만 allowlist 한다(의미 검증은 헤더 #5 대로 안 본다):
 *   - `supervisor`    — S0 관측 임계(`lib/supervisor/lane-monitor.js`, `scripts/split/{watch,fanout-probe}.mjs`)
 *   - `dispatch`      — `scripts/split/dispatch.mjs` 의 `{BUDGET}`·템플릿 경로
 *   - `worktreeSetup` — `scripts/split/worktree-setup.mjs` 의 junction·복사·레인 env
 * 어느 키도 행동을 켜지 않고, 사용자 settings.json 의 cross-session 키와 무관하다(아래 스캔이 지킨다).
 */
const ADDITIVE_OBJECT_KEYS = Object.freeze(['supervisor', 'dispatch', 'worktreeSetup', 'contextLifecycle']);

/** `split` 아래에 있어도 되는 키 — allowlist. `comment` 는 이 config 의 관례다. */
const ALLOWED_KEYS = new Set([...Object.keys(EXPECTED_SPLIT), ...ADDITIVE_OBJECT_KEYS, 'comment']);

/**
 * 사용자 소유 설정 키. 이 두 문자열이 플러그인 트리에 등장하면 RED.
 * 정본: code.claude.com/docs/en/settings-reference (2026-08-26 조사).
 */
export const USER_OWNED_SETTINGS = Object.freeze(['crossSessionInbound', 'isolatePeerMachines']);

/** 리터럴 탐지기 — 순수 함수. 자기검증 테스트가 같은 함수를 쓴다. */
export function findUserSettingMentions(text) {
  const out = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    for (const key of USER_OWNED_SETTINGS) {
      if (line.includes(key)) out.push({ line: i + 1, key, text: line.trim().slice(0, 120) });
    }
  });
  return out;
}

/**
 * 스캔 루트 — allowlist. `tests/` 는 의도적으로 없다(헤더 #3). 새 최상위 디렉터리가
 * 생기면 여기 추가해야 스캔된다 — 부정 목록이 아니므로 누락은 "검사 안 함" 이지
 * "통과" 가 아니다. 그 누락을 잡기 위해 아래 분모 테스트가 존재하는 디렉터리 목록을
 * 이 표와 대조한다.
 */
const SCAN_DIRS = ['lib', 'scripts', 'hooks', 'bin', 'commands', 'skills', 'agents', 'docs', 'rules', 'output-styles', '.claude-plugin'];
const SCAN_FILES = ['artibot.config.json', 'package.json', 'README.md', 'CLAUDE.md'];
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.sh', '.yml', '.yaml', '.txt']);
const SKIP_DIR = new Set(['node_modules', 'coverage', '.git']);

/** 로컬 실측 2026-08-26: 1,000+ 파일. CI 는 docs/ 대부분이 없어 더 적다 — 하한만 단언. */
const MIN_SCANNED_FILES = 400;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SCAN_EXT.has(path.extname(name))) out.push(p);
  }
  return out;
}

export function scanPluginTree(root = PLUGIN_ROOT) {
  const files = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(root, d);
    if (existsSync(abs)) walk(abs, files);
  }
  for (const f of SCAN_FILES) {
    const abs = path.join(root, f);
    if (existsSync(abs)) files.push(abs);
  }
  const offenders = [];
  for (const file of files) {
    const hits = findUserSettingMentions(readFileSync(file, 'utf-8'));
    for (const h of hits) offenders.push({ file: path.relative(root, file).replace(/\\/g, '/'), ...h });
  }
  return { scanned: files.length, offenders };
}

describe('artibot.config.json#split — 형태', () => {
  it('split 키가 있다', () => {
    expect(config.split, 'config.split 이 없다').toBeDefined();
  });

  it.each(Object.entries(EXPECTED_SPLIT))('split.%s === %j', (key, value) => {
    expect(config.split[key]).toEqual(value);
  });

  it('알 수 없는 키가 없다 (allowlist)', () => {
    const unknown = Object.keys(config.split).filter((k) => !ALLOWED_KEYS.has(k));
    expect(unknown).toEqual([]);
  });

  it('maxWindows 는 minStems 이상이고 fast-profile 하드캡을 넘지 않는다', () => {
    expect(config.split.maxWindows).toBeGreaterThanOrEqual(config.split.minStems);
    // 정규화를 그대로 통과해야 "설정값이 읽혔다" 가 성립한다. 클램프되면 표시값은 캡이다.
    const normalized = normalizeFastProfile({
      maxWorktrees: config.split.maxWindows,
      hardMaxAgents: config.split.maxWindows,
    });
    expect(normalized.maxWorktrees).toBe(config.split.maxWindows);
    expect(normalized.hardMaxAgents).toBe(config.split.maxWindows);
  });

  it('serverEntryPaths 는 문자열 배열이다', () => {
    expect(Array.isArray(config.split.serverEntryPaths)).toBe(true);
    expect(config.split.serverEntryPaths.every((p) => typeof p === 'string')).toBe(true);
  });

  it('humanWaitReevalPct 는 0~100 정수다', () => {
    const v = config.split.humanWaitReevalPct;
    expect(Number.isInteger(v) && v >= 0 && v <= 100).toBe(true);
  });
});

describe('사용자 소유 cross-session 설정 — 무접촉 래칫(0)', () => {
  it('탐지기는 리터럴이 있으면 잡는다 (자기검증)', () => {
    const sample = 'const x = settings.crossSessionInbound;\nconst y = 1;\n// isolatePeerMachines: true';
    const hits = findUserSettingMentions(sample);
    expect(hits.map((h) => h.key)).toEqual(['crossSessionInbound', 'isolatePeerMachines']);
    expect(hits.map((h) => h.line)).toEqual([1, 3]);
  });

  it('탐지기는 없는 곳에서 잡지 않는다 (자기검증)', () => {
    expect(findUserSettingMentions('cross-session inbound policy is user-owned')).toEqual([]);
  });

  it('스캔 분모가 하한을 넘는다 ("0 위반" ≠ "0개 검사")', () => {
    const { scanned } = scanPluginTree();
    expect(scanned).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
  });

  it('필수 루트가 실재한다 (allowlist 누락 = 검사 안 함 을 막는 분모)', () => {
    for (const d of ['lib', 'scripts', 'commands', 'skills', 'agents']) {
      expect(existsSync(path.join(PLUGIN_ROOT, d)), `${d}/ 가 없다`).toBe(true);
    }
  });

  it('플러그인 트리(테스트 제외)에 사용자 소유 설정 키 이름이 0건이다', () => {
    const { offenders } = scanPluginTree();
    const detail = offenders.map((o) => `${o.file}:${o.line} ${o.key} — ${o.text}`).join('\n');
    expect(detail).toBe('');
  });
});
