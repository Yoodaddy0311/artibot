/**
 * 검사 목적: **인스톨러가 사용자 머신으로 내보내는 콘텐츠**에 유령 도구명이
 * 섞이지 않는가.
 *
 * 이건 `frontmatter-tool-names.test.js` 와 다른 표면이다. 그쪽은 프론트매터를
 * 보고, 이건 **생성기가 뱉는 본문 문자열**을 본다. 유령 이름이 여기 들어가면
 * 리포 안에서 조용히 앉아 있는 게 아니라 **설치될 때마다 남의 프로젝트로
 * 복제된다.** 실제로 그런 상태였다 — `install.sh`/`install.ps1` 의 MEMORY.md
 * 시드가 `use \`Task()\` to delegate` 를 써 넣고 있었고, `Task` 는 하네스에서
 * `Agent` 로 개명된 이름이다.
 *
 * ── 왜 기존 게이트로 안 잡혔나 ─────────────────────────────────────────────
 * `scripts/ci/validate-install.js#PARITY_MATRIX` 는 두 인스톨러의 **함수 이름
 * 존재 여부**만 대조한다(`sh.includes(cap.sh)`). 함수가 뱉는 **내용**은 보지
 * 않으므로, 한쪽만 고치고 다른 쪽을 잊어도 통과한다. 아래 파리티 테스트가 그
 * 구멍을 닫는다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9) ──────────────────────────────────────
 *
 *  1. **인스톨러를 실행하지 않는다.** 문자열이 파일에 있다는 것만 보고, 그게
 *     실제로 사용자 디스크에 그렇게 쓰이는지는 확인하지 않는다. heredoc 안의
 *     변수 전개·이스케이프가 깨져도 이 테스트는 green 이다.
 *  2. **이미 설치된 사용자의 MEMORY.md 는 여전히 낡은 채로 남는다.** 시드는
 *     write-once 이고, 그 파일은 이미 사용자 문서라 덮어쓰지 않는다. 2026-08-15
 *     부터 인스톨러가 유령 문자열을 감지하면 최신 시드를 `MEMORY.md.artibot-new`
 *     로 **옆에 park** 하고 경고하지만(`install.sh#park_stale_memory_seed` /
 *     `install.ps1#Save-StaleMemorySeed`), 병합은 사람이 해야 한다. 원본은
 *     사용자가 손대기 전까지 낡은 채다. 그 파킹 동작 자체의 검증은 이 파일이
 *     아니라 `tests/scripts/install-memory-seed-stale.test.js` 에 있다(실제 셸을
 *     띄워 돌리는 실행형). 이 파일은 여전히 **앞으로의 유입**만 본다.
 *  3. **금지 이름 목록은 수동 사본이다.** 하네스가 또 개명하면 같이 낡는다.
 *     정본은 `frontmatter-tool-names.test.js#KNOWN_TOOL_NAMES` 쪽 주석에 있는
 *     재확인 절차다.
 *  4. **본문 바이트 차이는 보지 않는다.** 아래 "도구명 파리티" describe 는
 *     이름 그대로 **도구명 멘션만** 비교한다(`toolMentions` 가 백틱을 걷어내고
 *     `/\b[A-Z][A-Za-z]*\(\)/g` 만 뽑는다). 두 시드는 실제로 바이트 동일하지
 *     않다 — `install.sh` 는 em dash 와 `→` 를, `install.ps1` 은 `-` 와 `->` 를
 *     쓴다. 그 비대칭은 **의도된 것**이다(install.ps1 에 BOM 이 없어 PS 5.1 이
 *     ANSI 로 읽으므로 비-ASCII 는 사용자 파일에 `??` 로 떨어진다). 사유와
 *     강제는 `install.ps1#Get-MemorySeed` 주석과
 *     `tests/scripts/install-memory-seed-stale.test.js` 의 ASCII describe 에 있다.
 *     여기서 전문 바이트 비교를 도입하면 그 의도된 비대칭이 RED 가 된다.
 *  5. **배포 대상 전체를 스캔하지 않는다.** 인스톨러가 복사하는 `agents/`
 *     `commands/` `skills/` 는 프론트매터 게이트와 별개로 본문 산문이 남을 수
 *     있고, 그중 일부는 의도적 보존이다(플랫폼 변환 예시, 비교 산문). 여기서는
 *     **생성기가 직접 만드는 텍스트**와 `rules/` 만 본다.
 *
 * @module tests/firewall/installer-distributed-content
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 플러그인 루트 (`plugins/artibot/`) */
const PLUGIN_ROOT = join(__dirname, '..', '..');

const INSTALL_SH = join(PLUGIN_ROOT, 'install.sh');
const INSTALL_PS1 = join(PLUGIN_ROOT, 'install.ps1');
const RULES_DIR = join(PLUGIN_ROOT, 'rules');

/**
 * 하네스에서 사라졌거나 개명된 이름. 생성기 출력에 이게 있으면 남의 머신으로
 * 나간다.
 *
 * `Task` 는 **호출 형태**(`Task(`)로만 잡는다. "task" 라는 낱말 자체는 정상
 * 어휘이고, `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` 은 실재 도구다.
 */
const FORBIDDEN = [
  { label: 'TeamCreate', re: /TeamCreate/ },
  { label: 'TeamDelete', re: /TeamDelete/ },
  { label: 'TodoWrite', re: /TodoWrite/ },
  { label: 'Task( (개명됨 → Agent)', re: /\bTask\(/ },
];

/** @param {string} file */
const read = (file) => readFileSync(file, 'utf-8');

/**
 * 인스톨러에서 **사용자에게 나가는 텍스트 블록**만 뽑는다.
 *
 * 스크립트 자신의 로직·주석까지 검사하면 오탐이 난다(예: 가드 주석이 옛 이름을
 * 인용하는 경우). 여기서는 MEMORY.md 시드 본문 — sh 의 `<<SEED_MEMORY` 히어독과
 * ps1 의 `$seed = @"` 히어스트링 — 만 잘라낸다.
 *
 * @param {string} text
 * @param {RegExp} start
 * @param {RegExp} end
 * @returns {string | null} 못 찾으면 null (호출부가 RED 로 처리)
 */
function extractBlock(text, start, end) {
  const lines = text.split(/\r?\n/);
  const from = lines.findIndex((l) => start.test(l));
  if (from === -1) return null;
  const rel = lines.slice(from + 1).findIndex((l) => end.test(l));
  if (rel === -1) return null;
  return lines.slice(from + 1, from + 1 + rel).join('\n');
}

const shSeed = () => extractBlock(read(INSTALL_SH), /<<SEED_MEMORY\s*$/, /^SEED_MEMORY\s*$/);
const ps1Seed = () => extractBlock(read(INSTALL_PS1), /\$seed\s*=\s*@"/, /^"@\s*$/);

describe('인스톨러 MEMORY.md 시드 — 유령 도구명 유입 차단', () => {
  it('시드 블록을 두 인스톨러 모두에서 잘라낼 수 있다', () => {
    // 못 자르면 아래 검사가 통째로 공허해진다. null 을 통과시키지 않는다.
    expect(shSeed(), 'install.sh 의 SEED_MEMORY 히어독을 찾지 못했다').not.toBeNull();
    expect(ps1Seed(), 'install.ps1 의 $seed 히어스트링을 찾지 못했다').not.toBeNull();
    expect(shSeed().length).toBeGreaterThan(200);
    expect(ps1Seed().length).toBeGreaterThan(200);
  });

  for (const { label, re } of FORBIDDEN) {
    it(`install.sh 시드에 ${label} 이 없다`, () => {
      expect(shSeed()).not.toMatch(re);
    });
    it(`install.ps1 시드에 ${label} 이 없다`, () => {
      expect(ps1Seed()).not.toMatch(re);
    });
  }
});

describe('인스톨러 시드 — sh ↔ ps1 도구명 파리티', () => {
  /**
   * 시드 본문에서 도구 호출 표기를 뽑는다. sh 는 `\`Agent()\``, ps1 은
   * ``Agent()`` 로 이스케이프가 달라서, 백틱을 걷어낸 뒤 이름만 본다.
   * @param {string} seed
   */
  const toolMentions = (seed) => {
    const found = seed.replace(/[`\\]/g, '').match(/\b[A-Z][A-Za-z]*\(\)/g) ?? [];
    return [...new Set(found)].sort();
  };

  it('두 인스톨러 시드가 같은 도구 이름을 안내한다', () => {
    // PARITY_MATRIX 는 함수 **이름** 존재만 본다(validate-install.js:92-94).
    // 함수가 뱉는 **내용**은 안 보므로, 한쪽만 고치면 조용히 갈라진다.
    // 실제로 이 파일이 생긴 이유가 그 갈라짐이었다.
    expect(toolMentions(shSeed())).toEqual(toolMentions(ps1Seed()));
  });

  it('안내하는 도구 이름이 비어 있지 않다', () => {
    // 위 비교는 양쪽이 다 비어도 통과한다. 그 공허한 green 을 막는다.
    expect(toolMentions(shSeed()).length).toBeGreaterThan(0);
  });
});

describe('배포되는 rules/ — 유령 도구명 유입 차단', () => {
  // rules/ 는 두 인스톨러가 ~/.claude/rules/artibot/ 로 복사한다
  // (install.sh#install_rules, install.ps1 의 Copy-MdFiles -Preserve).
  // 복사는 non-destructive 라 기존 사용자 파일은 덮이지 않는다 — 즉 여기 들어간
  // 유령 이름도 신규 설치에만 나가고, 기존 설치본은 낡은 채 남는다.
  const files = readdirSync(RULES_DIR).filter((f) => f.endsWith('.md'));

  it('rules 디렉터리가 비어 있지 않다', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const { label, re } of FORBIDDEN) {
    it(`rules/*.md 에 ${label} 이 없다`, () => {
      const hits = files.filter((f) => re.test(read(join(RULES_DIR, f))));
      expect(hits, `${label} 발견: ${hits.join(', ')}`).toEqual([]);
    });
  }
});

describe('스캐너 자기검증', () => {
  it('추출기가 엉뚱한 마커에는 null 을 준다', () => {
    expect(extractBlock('a\nb\nc', /NOPE/, /ALSO_NOPE/)).toBeNull();
    expect(extractBlock('START\nx', /START/, /END/)).toBeNull();
  });

  it('추출기가 마커 사이만 자른다', () => {
    expect(extractBlock('pre\nSTART\nmid\nEND\npost', /START/, /END/)).toBe('mid');
  });

  it('금지 정규식이 실재 Task* 도구를 오탐하지 않는다', () => {
    const taskRe = FORBIDDEN.find((f) => f.label.startsWith('Task(')).re;
    for (const live of ['TaskCreate(', 'TaskUpdate(', 'TaskList(', 'TaskGet(', 'TaskStop(']) {
      expect(taskRe.test(live), `${live} 를 오탐했다`).toBe(false);
    }
    expect(taskRe.test('Task(')).toBe(true);
  });

  it('금지 정규식이 실제로 무언가를 잡는다 (뮤테이션)', () => {
    // 정규식이 전부 무력해지면 위 검사들이 항상 green 인 헛돌이가 된다.
    const hostile = 'use `Task()` and TeamCreate and TeamDelete and TodoWrite';
    expect(FORBIDDEN.filter(({ re }) => re.test(hostile))).toHaveLength(FORBIDDEN.length);
  });
});
