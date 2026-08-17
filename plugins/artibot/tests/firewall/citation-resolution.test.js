/**
 * 인용 해소 게이트 — firewall.
 *
 * 순서가 규율이다: **자기검증(픽스처·음성 대조)이 라이브 단언보다 먼저** 온다.
 * 스캐너가 뮤테이션에 RED 를 내는 것을 증명하기 전의 라이브 그린은 아무것도
 * 증명하지 않는다 (rules §10.5(e)).
 *
 * 이 게이트가 못 보는 것은 술어 모듈(`./citation-resolution.js`) 헤더의
 * blindspot 7항이 정본이다 — 여기 복제하지 않는다.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkDocument, classifyCitation, countLines, extractCitations, hasSymbol,
  maskFencedBlocks, mdHeadingAnchor, resolveCitation, runCitationRatchet, SKIP_REASONS,
} from './citation-resolution.js';
import { gatherAllDocFiles, headingToAnchor } from '../../scripts/ci/validate-doc-links.js';
import { assertScanFloors, listPluginRoots } from '../../scripts/ci/ci-utils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const BASELINE = JSON.parse(fs.readFileSync(path.join(HERE, 'citation-baseline.json'), 'utf8'));

/** 분모 하한 — 2026-08-17 census 실측(497 파일 · 104 스팬 · 59 checkable)에 여유를 둔 값. */
const FLOOR_FILES = 450;
const FLOOR_SPANS = 80;
const FLOOR_CHECKABLE = 45;

/** 케이스 민감 존재 판정 facade — `existsSync` 단독은 Windows 에서 케이스를 무시한다(FO-6). */
function makeRealFacade() {
  const dirCache = new Map();
  return {
    readFile(joined) {
      const p = path.normalize(joined);
      const dir = path.dirname(p);
      let names = dirCache.get(dir);
      if (names === undefined) {
        names = fs.existsSync(dir) ? fs.readdirSync(dir) : null;
        dirCache.set(dir, names);
      }
      if (!names || !names.includes(path.basename(p))) return null;
      return fs.readFileSync(p, 'utf8');
    },
  };
}

/** 픽스처 전용 인메모리 facade. */
function makeMemFacade(filesByPath) {
  return {
    readFile(joined) {
      if (joined in filesByPath) {
        const v = filesByPath[joined];
        if (v instanceof Error) throw v;
        return v;
      }
      return null;
    },
  };
}

const FIXTURE_DOC = [
  '본문 산문. `lib/core/a.js:2` 와 `lib/core/a.js#alpha` 는 해소된다.',
  '`lib/core/a.js:99` 는 범위 밖, `lib/gone/x.js:1` 은 없는 파일.',
  '플레이스홀더 `file.js:123`, 베어 `index.js:59`, 외부 `../x/y.js:1`,',
  '확장자 밖 `lib/core/a.py:3`, 루트 밖 `vendor/z.js:1`.',
  '백틱 없는 lib/core/a.js:2 는 인용이 아니다.',
  '```',
  '`lib/fenced/only.js:1` — 펜스 안이라 추출되지 않는다',
  '```',
].join('\n');

const FIXTURE_FS = {
  'R/lib/core/a.js': 'export function alpha() {}\nconst beta = 1;\n',
};

describe('자기검증 — 추출·분류 (라이브보다 먼저)', () => {
  it('픽스처에서 정확히 9건 추출한다 (펜스 안 1건은 제외)', () => {
    const cites = extractCitations(FIXTURE_DOC);
    expect(cites.map((c) => c.raw)).toEqual([
      'lib/core/a.js:2', 'lib/core/a.js#alpha', 'lib/core/a.js:99', 'lib/gone/x.js:1',
      'file.js:123', 'index.js:59', '../x/y.js:1', 'lib/core/a.py:3', 'vendor/z.js:1',
    ]);
    expect(cites).toHaveLength(9);
  });

  it('음성 단언: 백틱 없는 인용은 탐지되지 않아야 한다 — 탐지기를 산문으로 넓히려면 이 테스트를 지워야 한다', () => {
    const cites = extractCitations('산문 속 lib/core/a.js:2 언급과 safety.js:141 언급.');
    expect(cites).toHaveLength(0);
  });

  it('펜스 블록 마스킹은 인라인 코드스팬을 보존한다 — maskCodeFences 재사용 금지의 근거', () => {
    const masked = maskFencedBlocks(FIXTURE_DOC);
    expect(masked).toContain('`lib/core/a.js:2`');
    expect(masked).not.toContain('lib/fenced/only.js');
  });

  it('skip 5사유가 각각 발화하고, 전부 SKIP_REASONS 열거형 안이다', () => {
    const byRaw = Object.fromEntries(
      extractCitations(FIXTURE_DOC).map((c) => [c.raw, classifyCitation(c)])
    );
    expect(byRaw['file.js:123']).toEqual({ checkable: false, skip: 'placeholder' });
    expect(byRaw['index.js:59']).toEqual({ checkable: false, skip: 'bare-basename' });
    expect(byRaw['../x/y.js:1']).toEqual({ checkable: false, skip: 'out-of-repo-prefix' });
    expect(byRaw['lib/core/a.py:3']).toEqual({ checkable: false, skip: 'ext-not-checked' });
    expect(byRaw['vendor/z.js:1']).toEqual({ checkable: false, skip: 'root-not-listed' });
    for (const cls of Object.values(byRaw)) {
      if (cls.checkable === false) expect(SKIP_REASONS).toContain(cls.skip);
    }
  });
});

describe('자기검증 — 해소 6상태가 각각 실패영역에 실제 도달한다', () => {
  const facade = makeMemFacade(FIXTURE_FS);
  const ctx = { plugin: 'R', repo: 'REPO' };
  const resolve = (raw) => {
    const [cite] = extractCitations(`\`${raw}\``);
    return resolveCitation(cite, facade, ctx);
  };

  it('ok / missing-file / out-of-range / unknown-symbol', () => {
    expect(resolve('lib/core/a.js:2').status).toBe('ok');
    expect(resolve('lib/core/a.js#alpha').status).toBe('ok');
    expect(resolve('lib/gone/x.js:1').status).toBe('missing-file');
    expect(resolve('lib/core/a.js:99').status).toBe('out-of-range');
    expect(resolve('lib/core/a.js#nope').status).toBe('unknown-symbol');
  });

  it('범위·콤마 표기는 각 숫자를 전부 대조한다', () => {
    expect(resolve('lib/core/a.js:1-2').status).toBe('ok');
    expect(resolve('lib/core/a.js:1,2').status).toBe('ok');
    expect(resolve('lib/core/a.js:1-99').status).toBe('out-of-range');
    expect(resolve('lib/core/a.js:1,99').status).toBe('out-of-range');
  });

  it('read-error: facade 가 throw 하면 통과가 아니라 위반이다 (FO-7)', () => {
    const bad = makeMemFacade({ 'R/lib/core/a.js': new Error('EACCES') });
    const [cite] = extractCitations('`lib/core/a.js:1`');
    expect(resolveCitation(cite, bad, ctx).status).toBe('read-error');
  });

  it('countLines: CRLF / BOM / 말미 개행 없음', () => {
    expect(countLines('a\r\nb\r\n')).toBe(2);
    expect(countLines('\uFEFFa\nb')).toBe(2);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('')).toBe(0);
  });

  it('심볼 타입드 리졸버: json 키경로 / sh 함수 / md 헤딩', () => {
    expect(hasSymbol('.json', '{"team":{"playbooks":[]}}', 'team.playbooks')).toBe(true);
    expect(hasSymbol('.json', '{"team":{}}', 'team.playbooks')).toBe(false);
    expect(hasSymbol('.sh', 'acquire_lock() {\n:\n}', 'acquire_lock')).toBe(true);
    expect(hasSymbol('.sh', 'echo acquire_lock', 'acquire_lock')).toBe(false);
    expect(hasSymbol('.md', '## Grading rules\n', 'Grading-rules')).toBe(true);
    expect(hasSymbol('.md', '## Other\n', 'Grading-rules')).toBe(false);
  });

  it('mdHeadingAnchor 는 validate-doc-links#headingToAnchor 와 lockstep 이다', () => {
    const samples = ['Grading rules', 'Cache Strategy', '3b. Artibot Baseline (pinned — never re-scored mid-benchmark)', 'A/B: 테스트?'];
    for (const h of samples) expect(mdHeadingAnchor(h)).toBe(headingToAnchor(h));
  });
});

describe('자기검증 — 뮤테이션 (적용 확인 단언 포함, rules §10.5(e) 3단)', () => {
  it('줄번호 999999 뮤턴트 → out-of-range RED', () => {
    const original = '`lib/core/a.js:2`';
    const mutated = original.replace(':2', ':999999');
    expect(mutated).not.toBe(original); // ② 뮤테이션이 실제로 적용됐다
    expect(mutated).toContain(':999999');
    const [cite] = extractCitations(mutated);
    expect(resolveCitation(cite, makeMemFacade(FIXTURE_FS), { plugin: 'R', repo: 'REPO' }).status).toBe('out-of-range');
  });

  it('경로 뮤턴트 → missing-file RED', () => {
    const original = '`lib/core/a.js:2`';
    const mutated = original.replace('core', '__nope__');
    expect(mutated).not.toBe(original);
    const [cite] = extractCitations(mutated);
    expect(resolveCitation(cite, makeMemFacade(FIXTURE_FS), { plugin: 'R', repo: 'REPO' }).status).toBe('missing-file');
  });
});

describe('자기검증 — 래칫은 양방향이다', () => {
  it('신규 위반 = FAIL, 해소된 베이스라인 잔존 = FAIL (축소강제 — 선례 runRatchet 과 다른 점)', () => {
    expect(runCitationRatchet(['a::x'], ['a::x']).pass).toBe(true);
    const grew = runCitationRatchet(['a::x', 'b::y'], ['a::x']);
    expect(grew.pass).toBe(false);
    expect(grew.newViolations).toEqual(['b::y']);
    const shrunk = runCitationRatchet([], ['a::x']);
    expect(shrunk.pass).toBe(false);
    expect(shrunk.resolvedBaseline).toEqual(['a::x']);
  });
});

describe('라이브 — 리포 전수 (분모 단언 포함)', () => {
  const { files, counts } = gatherAllDocFiles();
  const facade = makeRealFacade();
  const pluginRoots = listPluginRoots().map((r) => r.replace(/\\/g, '/'));

  it(`스캔 파일 분모: root floor(assertScanFloors) + 총 ${FLOOR_FILES} 이상`, () => {
    expect(assertScanFloors(counts)).toEqual([]);
    expect(files.length).toBeGreaterThanOrEqual(FLOOR_FILES);
  });

  it('인용 분모 + 위반 = 베이스라인과 정확히 일치 (신규도 화석도 없다)', () => {
    let spans = 0; let checkable = 0;
    const skips = {}; const violations = [];
    for (const abs of files) {
      const norm = abs.replace(/\\/g, '/');
      const ownRoot = pluginRoots.find((r) => norm.startsWith(`${r}/`)) ?? PLUGIN_ROOT.replace(/\\/g, '/');
      const docRel = path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
      const rootsCtx = { plugin: ownRoot, repo: REPO_ROOT.replace(/\\/g, '/') };
      const res = checkDocument(fs.readFileSync(abs, 'utf8'), docRel, facade, rootsCtx);
      spans += res.total; checkable += res.checkable;
      for (const [k, v] of Object.entries(res.skips)) skips[k] = (skips[k] ?? 0) + v;
      violations.push(...res.violations);
    }
    // 분모 floor — "0 위반" 과 "0 검사" 를 구분한다 (FO-1/FO-2).
    expect(spans, '추출 스팬 분모가 무너졌다 — 추출 정규식 회귀 의심').toBeGreaterThanOrEqual(FLOOR_SPANS);
    expect(checkable, `checkable 붕괴 — skip 폭주 의심: ${JSON.stringify(skips)}`).toBeGreaterThanOrEqual(FLOOR_CHECKABLE);
    for (const reason of Object.keys(skips)) expect(SKIP_REASONS).toContain(reason);

    const ratchet = runCitationRatchet(violations.map((v) => v.identity), BASELINE.unresolved);
    const detail = violations.map((v) => `${v.identity} → ${v.status}${v.detail ? ` (${v.detail})` : ''}`).join('\n');
    expect(ratchet.newViolations, `신규 유령 인용:\n${detail}`).toEqual([]);
    expect(ratchet.resolvedBaseline, '해소된 항목이 베이스라인에 남았다 — citation-baseline.json 에서 제거하라').toEqual([]);
  });

  it('베이스라인 위생: 정체성 형식 + 중복 없음', () => {
    expect(Array.isArray(BASELINE.unresolved)).toBe(true);
    expect(new Set(BASELINE.unresolved).size).toBe(BASELINE.unresolved.length);
    for (const id of BASELINE.unresolved) expect(id).toMatch(/^[^:]+(\/[^:]+)*::.+$/);
  });
});
