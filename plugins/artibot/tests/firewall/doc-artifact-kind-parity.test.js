/**
 * 검사 목적: 커맨드 문서가 예제에 쓰는 `kind: '…'` 값이 `lib/planning/artifacts.js`
 * 가 **실제로 아는 키**인가.
 *
 * ── 왜 필요했나 — 이 결함은 **해소됐다**. 과거형으로 읽어라 (2026-08-16) ──────
 * `artifacts.js#KIND_DIRS` 는 **소문자 키**만 알았고, 지금도 그렇다:
 *
 *     lib/planning/artifacts.js:24   const KIND_DIRS = { prd: 'PRD', adr: 'adr' };
 *
 * 그런데 `commands/plan.md` 가 `kind: 'PRD'` **대문자**를 6곳에서 썼다. 그게
 * 왜 조용했냐면 — **폴백 두 개가 서로 반대 방향이었다**(당시 `:186` 과 `:561`):
 *
 *     const sub  = KIND_DIRS[kind] || KIND_DIRS.prd;      // 디렉터리
 *     const head = `# ${KIND_DIRS[kind] || kind} Index`;  // 제목
 *
 * `kind:'PRD'` 는 `undefined` → 디렉터리 폴백이 `KIND_DIRS.prd`=`'PRD'` 라
 * **우연히 맞았다.** 그래서 아무도 눈치채지 못했다. 반면 `kind:'ADR'` 이었다면
 * 디렉터리는 폴백 `'PRD'`, 제목은 `|| kind` 로 `'ADR'` → **ADR 인덱스가 PRD
 * 디렉터리를 덮어쓰는데** 던지지도 로그를 남기지도 않았을 것이다.
 *
 * **해소 (2026-08-16, `prd-hygiene` 유닛)**: `artifacts.js` 에
 * `normalizeKind()`(`:189`, 소문자화 + 미지 kind 는 `null`)와
 * `KIND_LABELS`(`:27`, `{prd:'PRD', adr:'ADR'}`)가 생겨 **두 경로가 같은 정규화를
 * 거친다**. 나아가 `kindDir()`(`:209`)는 **fail-closed** 가 됐다 — 미지 kind 는
 * 조용히 PRD 로 가지 않고 `TypeError` 를 던진다. `:619` 제목도
 * `KIND_LABELS[normalizeKind(kind)] || kind` 로 같은 정규화를 쓴다.
 *
 * ── 그런데 왜 이 게이트를 남기는가 (역할이 바뀌었다 — 지우기 전에 읽어라) ────
 * **"코드가 정규화하니 이 게이트는 이제 불필요하다"는 정확히 틀린 추론이다.**
 * `normalizeKind` 가 대소문자를 **흡수**하기 때문에, 문서가 `kind:'PRD'` 를 다시
 * 쓰기 시작해도 **아무 일도 일어나지 않는다 — 조용히 통과한다.** 즉 코드가
 * 관대해진 만큼 문서가 느슨해질 여지가 **커졌고**, 그것을 되돌려 잡을 신호는
 * 이 게이트뿐이다.
 *
 * 역할 전환을 한 줄로:
 *   전 — "틀린 값이 우연히 맞고 있는 잠복 상태"를 드러낸다
 *   후 — **"코드의 관용에 기대어 문서가 규약에서 이탈하는 것"** 을 막는다
 *
 * 문서의 `kind` 는 사람이 복사하는 **규약 표기**다. `artifacts.js` 가 받아준다는
 * 것과 문서가 정본 표기를 지킨다는 것은 다른 진술이고, 후자를 지키는 것이
 * 이 파일의 일이다.
 *
 * ── 형태 (rules §10) ────────────────────────────────────────────────────────
 * `tests/firewall/` vitest. 파일이 없으면 red = fail-closed.
 * 허용 키를 **손으로 들고 있지 않고 `artifacts.js` 소스에서 읽는다** — 손 목록은
 * 다음 리팩터에 낡고, 그러면 게이트가 코드와 사이좋게 같이 틀린다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9) ───────────────────────────────────────
 *
 *  1. **`kind:` 라는 표기만 본다.** 변수를 거쳐 넘기는 예제(`kind: kindVar`)나
 *     위치 인자는 못 본다. 측정 시각 기준 문서 전건이 리터럴이라 충돌 없다.
 *  2. **`artifacts.js` 의 `KIND_DIRS` 한 상수만 정본으로 삼는다.** 다른 모듈이
 *     자기 `kind` 어휘를 갖게 되면 이 게이트는 그걸 모른다.
 *  3. **대소문자만이 아니라 오탈자 전반을 잡지만, "그 kind 가 의미상 맞는가"는
 *     못 본다.** `kind:'prd'` 를 써야 할 자리에 `kind:'adr'` 을 쓰면 통과한다.
 *  4. **코드의 런타임 거동은 보지 않는다.** 이 게이트는 문서 문자열만 읽는다.
 *     `normalizeKind`/`kindDir` 가 실제로 fail-closed 인지는 여기서 검증하지
 *     않는다 — 그건 `artifacts.js` 자체의 유닛 테스트 몫이다. 여기 green 을
 *     "코드가 미지 kind 를 막는다"의 근거로 쓰지 마라.
 *  5. **`commands/` 밖(`skills/`·`docs/`·`agents/`)은 스코프 밖이다.**
 *
 * @module tests/firewall/doc-artifact-kind-parity
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const ARTIFACTS_JS = join(PLUGIN_ROOT, 'lib', 'planning', 'artifacts.js');
const COMMANDS_DIR = join(PLUGIN_ROOT, 'commands');

/** 분모 하한. 0건을 훑고 통과하는 상태를 RED 로 만든다. */
const MIN_KIND_LITERALS = 6;

/**
 * `artifacts.js` 소스에서 `KIND_DIRS` 의 **키**를 읽는다. 이것이 정본이다.
 *
 * @param {string} [source]
 * @returns {Set<string>}
 */
export function readKindKeys(source = readFileSync(ARTIFACTS_JS, 'utf-8')) {
  const m = source.match(/const KIND_DIRS = \{([^}]*)\}/);
  if (!m) throw new Error('KIND_DIRS 를 찾지 못했다 — 상수 이름이나 형태가 바뀌었다');
  const keys = new Set();
  for (const km of m[1].matchAll(/(\w+)\s*:/g)) keys.add(km[1]);
  return keys;
}

/**
 * 문서에서 `kind: '<literal>'` 을 (파일 기준 줄번호와 함께) 뽑는다.
 * 산문/코드블록을 가리지 않는다 — 산문의 예제도 사람이 그대로 복사하고,
 * `kind:` 표기는 도구명과 달리 오탐 여지가 거의 없다.
 *
 * @param {string} text
 * @returns {Array<{ line: number, value: string }>}
 */
export function findKindLiterals(text) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    for (const m of raw.matchAll(/kind:\s*['"]([A-Za-z]+)['"]/g)) {
      out.push({ line: i + 1, value: m[1] });
    }
  });
  return out;
}

function commandFiles() {
  return readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md')).sort();
}

/**
 * @param {Set<string>} [keys] 뮤테이션 주입점.
 */
export function scanKinds(keys = readKindKeys()) {
  const violations = [];
  let literals = 0;
  let scanned = 0;
  for (const f of commandFiles()) {
    scanned += 1;
    for (const hit of findKindLiterals(readFileSync(join(COMMANDS_DIR, f), 'utf-8'))) {
      literals += 1;
      if (!keys.has(hit.value)) violations.push({ file: `commands/${f}`, ...hit });
    }
  }
  return { violations, literals, scanned };
}

describe('문서 kind 리터럴 ↔ artifacts.js 정합 — 분모', () => {
  it('KIND_DIRS 키를 소스에서 읽는다', () => {
    const keys = readKindKeys();
    expect([...keys].sort()).toEqual(['adr', 'prd']);
  });

  it('문서에서 kind 리터럴을 충분히 찾는다 (0건이면 아래 단언이 공허하다)', () => {
    const { literals } = scanKinds();
    expect(literals).toBeGreaterThanOrEqual(MIN_KIND_LITERALS);
  });

  it('커맨드 전체를 훑는다', () => {
    const { scanned } = scanKinds();
    expect(scanned).toBe(commandFiles().length);
    expect(scanned).toBeGreaterThan(70);
  });
});

describe('문서 kind 리터럴 ↔ artifacts.js 정합 — 본 검사', () => {
  it('문서의 모든 kind 값이 KIND_DIRS 의 실제 키다', () => {
    const { violations } = scanKinds();
    const detail = violations
      .map(
        (v) =>
          `  ${v.file}:${v.line}  kind: '${v.value}'  → KIND_DIRS 에 없는 키다.\n` +
          "      정본 표기는 소문자다 ('prd' | 'adr').\n" +
          '      artifacts.js#normalizeKind 가 대소문자를 흡수하므로 지금은 동작이\n' +
          '      깨지지 않는다 — 그래서 더더욱 문서에서 잡아야 한다. 코드의 관용에\n' +
          '      기대면 규약이 조용히 무너진다.',
      )
      .join('\n');
    expect(violations.map((v) => `${v.file}:${v.line} ${v.value}`), `잘못된 kind:\n${detail}`).toEqual([]);
  });
});

describe('스캐너 자기검증', () => {
  it('대문자 kind 를 잡는다', () => {
    expect(findKindLiterals("await indexArtifacts({ kind: 'PRD' });")).toEqual([
      { line: 1, value: 'PRD' },
    ]);
  });

  it('쌍따옴표와 공백 변형도 잡는다', () => {
    expect(findKindLiterals('kind:"adr"').map((h) => h.value)).toEqual(['adr']);
    expect(findKindLiterals("kind:   'prd'").map((h) => h.value)).toEqual(['prd']);
  });

  it('한 줄에 두 개가 있으면 둘 다 잡는다', () => {
    // plan.md:241 산문이 실제로 이 형태였다 (같은 줄에 'PRD' 와 'adr' 혼재).
    expect(findKindLiterals("kind: 'PRD' … kind: 'adr'").map((h) => h.value)).toEqual(['PRD', 'adr']);
  });

  it('리터럴이 아니면 잡지 않는다 (못 보는 것 #1 의 경계)', () => {
    expect(findKindLiterals('kind: kindVar')).toEqual([]);
    expect(findKindLiterals('kind: 42')).toEqual([]);
  });

  it('KIND_DIRS 파싱이 실패하면 조용히 통과하지 않고 throw 한다', () => {
    expect(() => readKindKeys('const OTHER = { prd: 1 };')).toThrow(/KIND_DIRS/);
  });

  // ── 음성 대조 (rules §10.5(e)) ───────────────────────────────────────────
  // 허용 키를 좁혀 실제로 RED 가 나는지 본다. 워킹트리를 뮤테이션하지 않는다.
  it('허용 키에서 prd 를 빼면 그만큼 위반이 늘어난다', () => {
    const baseline = scanKinds().violations.length;
    const shrunk = new Set(readKindKeys());
    expect(shrunk.delete('prd'), '전제가 틀렸다 — prd 키가 없다').toBe(true);
    const after = scanKinds(shrunk).violations;
    const added = after.filter((v) => v.value === 'prd');
    expect(added.length).toBeGreaterThan(0);
    expect(after.length).toBe(baseline + added.length);
  });

  it('허용 키를 전부 비우면 모든 리터럴이 위반이다 (양성 대조 — 스캐너가 돌았다)', () => {
    const { violations, literals } = scanKinds(new Set());
    expect(literals).toBeGreaterThanOrEqual(MIN_KIND_LITERALS);
    expect(violations.length).toBe(literals);
  });

  it('2026-08-16 에 고친 plan.md 형태를 실제로 검출한다', () => {
    // 픽스처가 결함 지점을 실제로 통과해야 의미가 있다(rules §9).
    const pre = [
      "  kind: 'PRD',",
      "  const result = await archiveStale({ projectRoot: process.cwd(), kind: 'PRD',",
      "  await indexArtifacts({ projectRoot: process.cwd(), kind: 'PRD', now: new Date() });",
    ].join('\n');
    const keys = readKindKeys();
    const bad = findKindLiterals(pre).filter((h) => !keys.has(h.value));
    expect(bad.length).toBe(3);
  });
});
