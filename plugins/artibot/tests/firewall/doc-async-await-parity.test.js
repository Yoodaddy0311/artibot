/**
 * 검사 목적: 커맨드 문서의 **실행 가능한 예제 코드**가 `lib/` 의 `async` 함수를
 * 호출할 때 `await` 를 붙였는가.
 *
 * ── 왜 필요했나 (2026-08-16 실측) ────────────────────────────────────────────
 * `lib/planning/artifacts.js` 의 `writePRD`·`ensureADR`·`syncTodo`·`listArtifacts`·
 * `archiveStale`·`supersede`·`indexArtifacts` 는 **전부 `export async function`**
 * 인데, `commands/plan.md` 의 예제 8곳이 `await` 없이 호출하고 구조분해하고 있었다:
 *
 *     const { ok, prdPath } = writePRD({ … });   // ← Promise 를 구조분해
 *
 * **이 실수는 throw 하지 않는다.** Promise 객체에는 `ok` 도 `prdPath` 도 없으므로
 * 전 필드가 조용히 `undefined` 가 된다. 그대로 따라 쓰면 "성공했는데 경로가
 * 없다" 는 형태로 나타나고, 원인이 문서에 있다는 걸 알아내기까지가 멀다.
 *
 * 문서는 실행되지 않으므로 tsc·vitest·lint 어느 것도 이걸 보지 못한다. 그런데
 * async 여부는 **`lib/` 소스에서 기계적으로 읽을 수 있다** — 그래서 게이트가 된다.
 * 측정 시각 기준 `lib/` 전역 `export async function` 은 267개다.
 *
 * ── 오탐을 어떻게 눌렀나 (rules §10.5(c) 과대탐지 통제) ──────────────────────
 * 순진하게 `Name(` 을 전부 잡으면 산문·시그니처 표·주석이 전부 걸린다. 세 겹으로
 * 좁혔고, **좁힌 근거를 각각 남긴다**(근거 없는 좁히기는 기본값 거부다):
 *
 *  1. **` ```js `/` ```javascript ` 펜스 안만** 본다. 그 밖은 실행 예제가 아니다.
 *     실측 근거: `commands/plan.md` 의 시그니처 표(`writePRD({ … }) → { ok }`)는
 *     언어 태그 없는 맨 펜스에 있고, 실행 코드가 아니라 타입 문서다.
 *  2. **`//` 로 시작하는 줄은 건너뛴다.** 실측 근거: `commands/go.md#호출-방법`
 *     의 `// writePRD 시그니처: writePRD({ … })` 는 주석이고, 바로 위 실호출은
 *     이미 `await` 가 붙어 있다. 주석을 잡으면 고칠 것이 없는 RED 가 된다.
 *  3. **`await` · `function` 직후는 건너뛴다.** 각각 이미 올바른 호출, 그리고
 *     정의부다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9) ───────────────────────────────────────
 *
 *  1. **`.then()` 체인·`Promise.all` 로 감싼 형태는 판정하지 않는다.** `await` 가
 *     없으면 위반으로 본다. 리포의 문서 예제는 전부 `await` 스타일이라 현재
 *     충돌이 없지만, `.then()` 예제를 새로 쓰면 오탐이 난다 — 그때는 이 문단과
 *     함께 규칙을 고쳐라.
 *  2. **이름만 본다. 실제로 그 모듈에서 온 심볼인지는 모른다.** 문서가 `lib/` 의
 *     async 함수와 **동명의 로컬 sync 헬퍼**를 정의해 쓰면 오탐이다. 측정 시각
 *     기준 그런 사례는 0건이다.
 *  3. **`export const f = async () =>` 형태는 안 잡는다.** `export async function`
 *     선언만 센다. 화살표 async 를 문서 예제가 쓰기 시작하면 구멍이다.
 *  4. **`agents/*.md`·`skills/**`·`docs/**` 는 스코프 밖이다.** `commands/` 만 본다.
 *  5. **문서가 옳아도 코드가 틀릴 수 있다.** 이건 문서→코드 방향의 정합만 본다.
 *  6. **await 를 붙였다고 예제가 옳은 것은 아니다.** 인자 이름·반환 필드가 실제
 *     시그니처와 맞는지는 보지 않는다.
 *
 * @module tests/firewall/doc-async-await-parity
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const LIB_DIR = join(PLUGIN_ROOT, 'lib');
const COMMANDS_DIR = join(PLUGIN_ROOT, 'commands');

/** 분모 하한. "0 위반"과 "0개 검사"를 구분한다. */
const MIN_ASYNC_EXPORTS = 200;
const MIN_COMMANDS_SCANNED = 70;

function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkJs(p, out);
    else if (entry.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * `lib/` 전역에서 `export async function NAME` 을 모은다. **이것이 정본이다** —
 * 게이트가 async 목록을 손으로 들고 있으면 다음 리팩터에 낡는다.
 *
 * @returns {Map<string, string[]>} 함수명 → 선언 파일(리포 상대경로)
 */
export function collectAsyncExports(libDir = LIB_DIR) {
  const names = new Map();
  for (const file of walkJs(libDir)) {
    const rel = file.replace(/\\/g, '/').split('/plugins/artibot/')[1] ?? file;
    for (const m of readFileSync(file, 'utf-8').matchAll(/^export async function (\w+)/gm)) {
      if (!names.has(m[1])) names.set(m[1], []);
      names.get(m[1]).push(rel);
    }
  }
  return names;
}

/**
 * 마크다운에서 ` ```js ` 펜스 안의 줄만 (파일 기준 줄번호와 함께) 뽑는다.
 *
 * @param {string} text
 * @returns {Array<{ line: number, text: string }>}
 */
export function jsCodeBlockLines(text) {
  const out = [];
  let inBlock = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (!inBlock) {
      if (/^```(js|javascript)$/.test(t)) inBlock = true;
      return;
    }
    if (t === '```') {
      inBlock = false;
      return;
    }
    out.push({ line: i + 1, text: raw });
  });
  return out;
}

/**
 * 한 문서에서 `await` 없는 async 호출을 찾는다.
 *
 * @param {string} text 문서 전문
 * @param {Iterable<string>} asyncNames
 * @returns {Array<{ line: number, name: string, source: string }>}
 */
export function findMissingAwait(text, asyncNames) {
  const found = [];
  for (const { line, text: raw } of jsCodeBlockLines(text)) {
    if (raw.trimStart().startsWith('//')) continue; // 주석 줄 (오탐 통제 #2)
    for (const name of asyncNames) {
      const re = new RegExp(`(?<![\\w.$])${name}\\s*\\(`, 'g');
      let m;
      while ((m = re.exec(raw)) !== null) {
        const before = raw.slice(0, m.index).trimEnd();
        if (/\bawait$/.test(before) || /\bfunction$/.test(before)) continue;
        found.push({ line, name, source: raw.trim() });
      }
    }
  }
  return found;
}

function commandFiles() {
  return readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md')).sort();
}

/**
 * 전 커맨드를 훑는다.
 * @param {Map<string, string[]>} [asyncExports]
 */
export function scanCommands(asyncExports = collectAsyncExports()) {
  const names = [...asyncExports.keys()];
  const violations = [];
  let scanned = 0;
  for (const f of commandFiles()) {
    scanned += 1;
    const text = readFileSync(join(COMMANDS_DIR, f), 'utf-8');
    for (const v of findMissingAwait(text, names)) {
      violations.push({ file: `commands/${f}`, ...v, declaredIn: asyncExports.get(v.name) });
    }
  }
  return { violations, scanned, asyncCount: asyncExports.size };
}

describe('문서 예제 ↔ async 시그니처 정합 — 분모', () => {
  it('lib/ 에서 async export 를 충분히 수집한다 (0개면 아래 단언이 공허하다)', () => {
    const { asyncCount } = scanCommands();
    expect(asyncCount).toBeGreaterThan(MIN_ASYNC_EXPORTS);
  });

  it('커맨드 문서를 충분히 스캔한다', () => {
    const { scanned } = scanCommands();
    expect(scanned).toBeGreaterThan(MIN_COMMANDS_SCANNED);
  });

  it('js 코드블록이 실제로 존재한다 (펜스 매칭이 깨지면 전부 조용히 통과한다)', () => {
    // 펜스 정규식이 어긋나면 `jsCodeBlockLines` 가 어디서나 [] 를 내고 게이트가
    // 무해하게 초록이 된다. 그 상태를 RED 로 만든다.
    const total = commandFiles().reduce(
      (n, f) => n + jsCodeBlockLines(readFileSync(join(COMMANDS_DIR, f), 'utf-8')).length,
      0,
    );
    expect(total).toBeGreaterThan(100);
  });
});

describe('문서 예제 ↔ async 시그니처 정합 — 본 검사', () => {
  it('js 예제가 async 함수를 await 없이 호출하지 않는다', () => {
    const { violations } = scanCommands();
    const detail = violations
      .map((v) => `  ${v.file}:${v.line}  ${v.name}( — ${v.declaredIn?.join(', ')}\n      ${v.source}`)
      .join('\n');
    expect(violations.map((v) => `${v.file}:${v.line} ${v.name}`), `await 누락:\n${detail}`).toEqual([]);
  });
});

describe('스캐너 자기검증', () => {
  it('await 없는 구조분해를 잡는다', () => {
    const doc = ['```js', 'const { ok } = writePRD({ a: 1 });', '```'].join('\n');
    expect(findMissingAwait(doc, ['writePRD'])).toEqual([
      { line: 2, name: 'writePRD', source: 'const { ok } = writePRD({ a: 1 });' },
    ]);
  });

  it('await 가 있으면 잡지 않는다', () => {
    const doc = ['```js', 'const { ok } = await writePRD({ a: 1 });', '```'].join('\n');
    expect(findMissingAwait(doc, ['writePRD'])).toEqual([]);
  });

  it('js 펜스 밖은 보지 않는다 (오탐 통제 #1)', () => {
    const doc = ['```', 'writePRD({ projectRoot }) -> { ok, prdPath }', '```'].join('\n');
    expect(findMissingAwait(doc, ['writePRD'])).toEqual([]);
  });

  it('주석 줄은 보지 않는다 (오탐 통제 #2)', () => {
    const doc = ['```js', '// writePRD 시그니처: writePRD({ a })', '```'].join('\n');
    expect(findMissingAwait(doc, ['writePRD'])).toEqual([]);
  });

  it('동적 import 의 구조분해는 호출이 아니다', () => {
    const doc = ['```js', 'const { writePRD, ensureADR } = await import(x);', '```'].join('\n');
    expect(findMissingAwait(doc, ['writePRD', 'ensureADR'])).toEqual([]);
  });

  it('메서드 호출과 동명 접미사는 잡지 않는다', () => {
    const doc = ['```js', 'obj.writePRD(1); myWritePRD(2);', '```'].join('\n');
    expect(findMissingAwait(doc, ['writePRD'])).toEqual([]);
  });

  it('펜스가 닫히면 그 뒤는 코드블록이 아니다', () => {
    const doc = ['```js', 'await writePRD({});', '```', 'writePRD({}) 라고 산문에 써도'].join('\n');
    expect(findMissingAwait(doc, ['writePRD'])).toEqual([]);
  });

  // ── 음성 대조 (rules §10.5(e)) ───────────────────────────────────────────
  // 실제로 고친 결함을 스캐너가 잡는지 **불변 아티팩트**(git HEAD blob 시점의
  // 내용)로 확인한다. 워킹트리를 뮤테이션하지 않는다 — 공유 트리 뮤테이션이
  // 관측자들의 시간을 태운 선례가 있다(rules §10.5(a)).
  //
  // 픽스처는 결함 지점을 **실제로 통과해야** 의미가 있다(rules §9): 아래는
  // `commands/plan.md` 가 2026-08-16 수정 전에 갖고 있던 형태 그대로다.
  it('2026-08-16 에 고친 plan.md 결함 형태를 실제로 검출한다', () => {
    const pre = [
      '```js',
      "const { ok, stateFile, progress } = syncTodo({",
      '  projectRoot: process.cwd(),',
      '});',
      "const { ok, prdPath } = writePRD({ projectRoot: process.cwd() });",
      "const { ok, adrPath, number } = ensureADR({ projectRoot: process.cwd() });",
      "  indexArtifacts({ projectRoot: process.cwd(), kind: 'PRD' });",
      '```',
    ].join('\n');
    const hits = findMissingAwait(pre, ['syncTodo', 'writePRD', 'ensureADR', 'indexArtifacts']);
    expect(hits.map((h) => h.name).sort()).toEqual(['ensureADR', 'indexArtifacts', 'syncTodo', 'writePRD']);
  });

  it('async 목록이 비면 위반이 0이다 (검출이 목록에 실제로 의존한다)', () => {
    const { violations, scanned } = scanCommands(new Map());
    expect(violations).toEqual([]);
    expect(scanned).toBeGreaterThan(MIN_COMMANDS_SCANNED); // 분모는 유지
  });

  it('collectAsyncExports 가 실재 함수를 집는다', () => {
    const names = collectAsyncExports();
    // artifacts.js 의 7개는 이 게이트가 태어난 이유다. 사라지면 RED 로 알린다.
    for (const n of ['writePRD', 'ensureADR', 'syncTodo', 'indexArtifacts', 'listArtifacts', 'archiveStale', 'supersede']) {
      expect(names.has(n), `${n} 이 async export 목록에 없다`).toBe(true);
      expect(names.get(n).some((p) => p.includes('lib/planning/artifacts.js'))).toBe(true);
    }
    // sync 함수는 목록에 없어야 한다 — 있으면 과대탐지의 원천이 된다.
    // `sizePlan` 은 `export function` (sync) 이고 문서가 await 없이 부르는 것이 옳다.
    expect(names.has('sizePlan')).toBe(false);
  });
});
