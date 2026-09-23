/**
 * Firewall — 헌법 단계 B-2: Rationalizations 절 강등(제자리 안내 줄).
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────────
 *  설계 §D18 R3(ARTIBOT-5.0-DESIGN.md "Rationalizations `references/` 강등")의
 *  채택안(리더 전달: 오너 결정 5 의 1안)은 파일을 옮기지 않는다. `skills/**` 의
 *  `## Rationalizations` / `## Common Rationalizations` 헤딩은 **문자열 그대로**
 *  두고, 각 헤딩 **바로 다음 줄**에 고정 안내 줄 리터럴(GUIDANCE_LINE) 1줄을 넣는다.
 *  그 줄이 "이 절은 참고 자료다 — 질문 목록·게이트가 아니다" 를 선언한다.
 *
 *   (a) 헤딩을 가진 파일 집합이 기준선(BASELINE)의 133파일과 정확히 같다.
 *   (b) 파일별 헤딩 개수가 기준선과 같다(헤딩 문자열 무변경 — 합 149).
 *   (c) 모든 헤딩의 바로 다음 줄이 GUIDANCE_LINE 과 바이트 단위로 같다.
 *   (d) GUIDANCE_LINE 은 파일 안에 헤딩 수만큼만 있다 — 헤딩 바로 아래가 아닌
 *       곳(다른 절·중복·줄 중간·코드펜스 안)에 있으면 위반.
 *   (e) 헤딩이 없는 파일에는 GUIDANCE_LINE 이 0번이다.
 *
 *  기준선(BASELINE)은 **파일 안 리터럴**이다. 테스트는 실행 시점에 git·HEAD·다른
 *  산출물을 읽지 않는다 — 현재 트리에서 기준선을 다시 뽑아 비교하면 게이트가
 *  제 기준선을 파괴하며 통과한다(rules §10).
 *
 *  B-1(`constitution-stage-b.test.js`)과의 관계: 안내 줄은 `> ` 로 시작하는
 *  인용문이라 헤딩이 아니다. B-1 의 헤딩 기준선은 이 변경으로 바뀌지 않는다.
 *
 * ── 펜스 처리의 비대칭(의도) ────────────────────────────────────────────────
 *  헤딩은 ``` / ~~~ 펜스 **밖**의 것만 센다(B-1 `headings()` 와 같은 규칙 — 템플릿
 *  예시 안의 `## Rationalizations` 는 절이 아니다). 반면 안내 줄 리터럴은 펜스
 *  **안에서도** 센다. 펜스 안 가짜 헤딩 아래에 안내 줄을 복제해도, 예시 블록에
 *  안내 줄을 붙여 넣어도 헤딩 수와 어긋나 RED 다 — 안내 줄이 있어야 할 곳은
 *  진짜 헤딩 바로 아래 한 곳뿐이다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 못 보는 것을 적어라) ─────
 *
 *  1. **헤딩 아래 본문의 삭제·변경.** 검사는 헤딩 줄 개수와 안내 줄 리터럴만 본다.
 *     헤딩과 안내 줄을 남긴 채 그 아래 변명·반박 표를 통째로 지워도 통과한다.
 *     본문 해시를 고정하면 정당한 문구 수정마다 RED 라 하지 않았다.
 *  2. **질문 빈도에 미치는 효과.** 안내 줄이 있다는 것과 모델이 사람에게 덜
 *     묻는다는 것은 다른 진술이다(존재 ≠ 작동, rules §2). 발화 기준 효과는
 *     **미측정**이며 SH-09 는 이 게이트가 그린이어도 진행 중으로 남는다.
 *  3. **설치본·런타임 반영.** 리포 정본 `plugins/artibot/skills/**` 만 읽는다.
 *     `~/.claude/` 아래 설치 사본이나 실행 중 세션에 로드된 스킬은 미확인이다.
 *  4. **cowork 플러그인.** `plugins/artibot-cowork/skills/**` 는 범위 밖이다.
 *     그쪽에도 같은 헤딩을 가진 파일이 있으나(2026-09-23 grep 기준 2파일) 여기서는
 *     안내 줄 유무를 보지 않는다.
 *  5. **다른 레벨·다른 이름의 절.** 정확히 `## Rationalizations` 와
 *     `## Common Rationalizations` 두 문자열만 헤딩으로 센다. 레벨 3
 *     `### Rationalization Prevention`(verification-completion), skill-authoring 의
 *     `## 5. Letter vs. Spirit: No Rationalization` 은 범위 밖이다.
 *  6. **신규 파일의 변형 헤딩.** 들여쓰기·후행 공백·대소문자가 다른 헤딩은 세지
 *     않는다. 기준선 파일의 헤딩이 그렇게 바뀌면 개수 불일치로 RED 지만, 새 파일이
 *     처음부터 변형 헤딩을 쓰면 조용하다(새 파일의 정확한 헤딩은 (a)로 RED).
 *  7. **안내 줄의 의미.** 문구를 바이트로 비교할 뿐, 모델이 그 문구를 어떻게
 *     해석하는지는 보지 않는다. 문구 자체가 옳은지도 검증하지 않는다.
 *  8. **한 글자 틀린 사본.** 누출 검사는 정확한 리터럴만 센다. 헤딩 아래가 아닌
 *     곳이나 기준선 밖 파일에 글자 하나 다른 사본이 있으면 조용하다.
 */

import { describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'skills',
);

/** 헤딩으로 세는 문자열 — 줄 전체가 정확히 이것이어야 한다(`\r` 만 벗긴다). */
const SECTION_HEADINGS = new Set(['## Rationalizations', '## Common Rationalizations']);

/**
 * 안내 줄 — 133파일 149헤딩 바로 아래에 동일 리터럴로 들어간다(UTF-8 317바이트).
 * 말미의 "스스로 바로잡을 수 없으면 … Step·Checkpoint 규칙을 따른다" 가 핵심이다.
 * 그게 없으면 "참고 자료" 가 "반박이 막히면 그냥 넘어가라" 로 읽힌다.
 */
const GUIDANCE_LINE = '> 이 절은 참고 자료다 — 아래 변명·반박은 모델이 작업 중 스스로 지름길을 점검하는 데 쓰고, 사용자에게 묻는 질문 목록이나 별도 게이트로 쓰지 않는다. 반박에 비추어 스스로 바로잡을 수 없으면 이 스킬의 Step·Checkpoint 규칙을 따른다.';
const GUIDANCE_BYTES = 317;

/** 기준선 시점(2026-09-23, base 200ea54f)의 총수 — `##` 124 + `## Common` 25. */
const TOTAL_FILES = 133;
const TOTAL_HEADINGS = 149;
const TOTAL_PLAIN = 124;
const TOTAL_COMMON = 25;

/** 헤딩이 없지만 "Rationalization" 을 언급하는 파일 — 안내 줄이 새면 안 된다. */
const MENTION_ONLY_FILES = [
  'persona-distill/references/six-layer-persona.md',
  'skill-authoring/SKILL.md',
];

function toLines(source) {
  return source.split('\n').map((line) => line.replace(/\r$/, ''));
}

/**
 * 펜스(``` / ~~~) 밖에서 SECTION_HEADINGS 와 정확히 같은 줄의 0-based 인덱스.
 * 펜스 판정은 B-1 `headings()` 와 같다(앞뒤 공백을 벗긴 줄로 연다/닫는다).
 */
function sectionHeadingIndices(lines) {
  const out = [];
  let fence = null;
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    const open = /^(`{3,}|~{3,})/.exec(trimmed);
    if (open) {
      if (fence === null) fence = open[1][0];
      else if (trimmed.startsWith(fence.repeat(3))) fence = null;
      return;
    }
    if (fence === null && SECTION_HEADINGS.has(line)) out.push(i);
  });
  return out;
}

function countGuidance(source) {
  return source.split(GUIDANCE_LINE).length - 1;
}

/**
 * 순수 함수 검사기 — 입력은 파일 본문, 출력은 위반 목록(줄 번호는 1-based).
 * 파일시스템을 읽지 않으므로 아래 self-check 테스트가 합성 입력으로 직접 검증한다.
 * 헤딩이 하나도 없으면 fail-closed — 기준선 파일에 대해 부르는 검사기라 헤딩 0 은
 * "통과" 가 아니라 "헤딩이 사라졌다" 다.
 */
function scan(source) {
  if (typeof source !== 'string' || source.trim() === '') return ['empty-source'];
  const lines = toLines(source);
  const heads = sectionHeadingIndices(lines);
  if (heads.length === 0) return ['no-rationalizations-heading'];

  const violations = [];
  const guided = new Set();
  for (const i of heads) {
    if (lines[i + 1] === GUIDANCE_LINE) guided.add(i + 1);
    else violations.push(`missing-guidance: line ${i + 1}`);
  }
  lines.forEach((line, i) => {
    if (line === GUIDANCE_LINE && !guided.has(i)) violations.push(`stray-guidance: line ${i + 1}`);
  });
  // 줄 전체 비교가 못 보는 것(줄 중간·들여쓴 복제)을 부분 문자열 개수로 잡는다.
  const hits = countGuidance(source);
  if (hits !== heads.length) violations.push(`guidance-count: ${hits} != ${heads.length}`);
  return violations;
}

function walk(dir) {
  return fsSync.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function relative(file) {
  return path.relative(SKILLS_DIR, file).split(path.sep).join('/');
}

function read(rel) {
  return fsSync.readFileSync(path.join(SKILLS_DIR, rel), 'utf-8');
}

/**
 * 기준선 — base 200ea54f 워킹트리에서 일회용 추출기로 뽑은 "파일 → 헤딩 수".
 * 키는 `skills/` 기준 posix 상대경로. 손으로 고치지 마라; 스킬 문서가 정당하게
 * 바뀌면 그 변경과 같은 커밋에서 재산출하고, 왜 바뀌었는지 커밋 메시지에 남겨라.
 * 설계 §D18 R3 의 "108 Rationalizations" 는 SKILL.md 수다 — 133파일 = SKILL.md 108
 * + references 25(git-unified 9 · lang-reference 16), 헤딩 149. 게이트는 133 전체를 본다.
 */
const BASELINE = {
  'ab-testing/SKILL.md': 1,
  'adr-format/SKILL.md': 1,
  'adversarial-review/SKILL.md': 1,
  'advertising/SKILL.md': 1,
  'advisor-strategy/SKILL.md': 1,
  'agent-memory-snapshot/SKILL.md': 1,
  'ai-security-standards/SKILL.md': 1,
  'brand-guidelines/SKILL.md': 1,
  'campaign-planning/SKILL.md': 1,
  'ci-cd-pipelines/SKILL.md': 1,
  'clarify/SKILL.md': 2,
  'code-slop-reviewer/SKILL.md': 1,
  'codex-integration/SKILL.md': 1,
  'coding-standards/SKILL.md': 2,
  'cognitive-routing/SKILL.md': 1,
  'compaction-survival/SKILL.md': 1,
  'competitive-intelligence/SKILL.md': 1,
  'content-seo/SKILL.md': 1,
  'context-degradation/SKILL.md': 1,
  'continuous-learning/SKILL.md': 1,
  'copywriting/SKILL.md': 1,
  'cro-forms/SKILL.md': 1,
  'cro-funnel/SKILL.md': 1,
  'cro-page/SKILL.md': 1,
  'customer-journey/SKILL.md': 1,
  'daily/SKILL.md': 1,
  'data-analysis/SKILL.md': 1,
  'data-visualization/SKILL.md': 1,
  'ddd-strategic-design/SKILL.md': 1,
  'ddd-tactical-design/SKILL.md': 2,
  'delegation/SKILL.md': 1,
  'design-system-reference/SKILL.md': 1,
  'email-marketing/SKILL.md': 1,
  'fp-refactor/SKILL.md': 2,
  'git-unified/SKILL.md': 1,
  'git-unified/references/autopilot.md': 1,
  'git-unified/references/collab.md': 1,
  'git-unified/references/conflict.md': 1,
  'git-unified/references/guide.md': 1,
  'git-unified/references/safe.md': 1,
  'git-unified/references/strategy.md': 1,
  'git-unified/references/sync.md': 1,
  'git-unified/references/workflow.md': 1,
  'git-unified/references/worktree.md': 1,
  'guardrails/SKILL.md': 1,
  'hook-event-emitter/SKILL.md': 1,
  'hook-feedback-merge/SKILL.md': 1,
  'image-generation/SKILL.md': 1,
  'lang-reference/SKILL.md': 1,
  'lang-reference/references/cpp.md': 1,
  'lang-reference/references/csharp.md': 1,
  'lang-reference/references/elixir.md': 1,
  'lang-reference/references/flutter.md': 1,
  'lang-reference/references/go.md': 1,
  'lang-reference/references/java.md': 1,
  'lang-reference/references/javascript.md': 1,
  'lang-reference/references/kotlin.md': 1,
  'lang-reference/references/php.md': 1,
  'lang-reference/references/python.md': 1,
  'lang-reference/references/r.md': 1,
  'lang-reference/references/ruby.md': 1,
  'lang-reference/references/rust.md': 1,
  'lang-reference/references/scala.md': 1,
  'lang-reference/references/swift.md': 1,
  'lang-reference/references/typescript.md': 1,
  'lead-management/SKILL.md': 1,
  'library-mermaid/SKILL.md': 1,
  'library-shadcn/SKILL.md': 1,
  'lifelong-learning/SKILL.md': 1,
  'load-testing/SKILL.md': 1,
  'marketing-analytics/SKILL.md': 1,
  'marketing-strategy/SKILL.md': 1,
  'mcp-context7/SKILL.md': 1,
  'mcp-coordination/SKILL.md': 1,
  'mcp-playwright/SKILL.md': 1,
  'memory-management/SKILL.md': 2,
  'memory-safety-patterns/SKILL.md': 1,
  'multi-agent-patterns/SKILL.md': 2,
  'observability/SKILL.md': 1,
  'orchestration-patterns/SKILL.md': 1,
  'persona-analyzer/SKILL.md': 1,
  'persona-architect/SKILL.md': 1,
  'persona-backend/SKILL.md': 1,
  'persona-devops/SKILL.md': 1,
  'persona-distill/SKILL.md': 1,
  'persona-frontend/SKILL.md': 1,
  'persona-mentor/SKILL.md': 1,
  'persona-performance/SKILL.md': 1,
  'persona-qa/SKILL.md': 1,
  'persona-refactorer/SKILL.md': 1,
  'persona-scribe/SKILL.md': 1,
  'persona-security/SKILL.md': 1,
  'platform-auth/SKILL.md': 1,
  'platform-database-cloud/SKILL.md': 1,
  'platform-deployment/SKILL.md': 1,
  'polish/SKILL.md': 1,
  'presentation-design/SKILL.md': 1,
  'principles/SKILL.md': 1,
  'problem-validation/SKILL.md': 1,
  'production-code-audit/SKILL.md': 2,
  'prompt-caching-strategy/SKILL.md': 1,
  'prompt-engineering/SKILL.md': 2,
  'quality-framework/SKILL.md': 1,
  'quickstart/SKILL.md': 1,
  'repo-benchmarking/SKILL.md': 1,
  'report-generation/SKILL.md': 1,
  'scheduled-learning/SKILL.md': 1,
  'security-standards/SKILL.md': 2,
  'segmentation/SKILL.md': 1,
  'self-evaluation/SKILL.md': 1,
  'self-learning/SKILL.md': 1,
  'seo-strategy/SKILL.md': 1,
  'session-worklog/SKILL.md': 1,
  'setup/SKILL.md': 1,
  'social-media/SKILL.md': 1,
  'source-driven-development/SKILL.md': 1,
  'spec-format/SKILL.md': 2,
  'split/SKILL.md': 1,
  'strategic-compact/SKILL.md': 2,
  'swarm-intelligence/SKILL.md': 1,
  'systematic-debugging/SKILL.md': 2,
  'tdd-workflow/SKILL.md': 2,
  'team/SKILL.md': 1,
  'technical-seo/SKILL.md': 1,
  'testing-standards/SKILL.md': 2,
  'token-efficiency/SKILL.md': 1,
  'tool-approval/SKILL.md': 1,
  'tool-design/SKILL.md': 2,
  'verification-completion/SKILL.md': 2,
  'vibe-coding/SKILL.md': 1,
  'visual-validation/SKILL.md': 1,
  'yes-md/SKILL.md': 1,
  'zero-downtime-migration/SKILL.md': 1,
};

const FILES = Object.keys(BASELINE);

/** 합성 입력 빌더 — 줄 배열을 원하는 줄바꿈으로 잇는다. */
function doc(lines, eol = '\n') {
  return lines.join(eol);
}

describe('constitution stage B-2 — Rationalizations 제자리 안내 줄', () => {
  it('안내 줄 리터럴이 317바이트 인용문 1줄이다 (self-check)', () => {
    expect(Buffer.byteLength(GUIDANCE_LINE, 'utf-8')).toBe(GUIDANCE_BYTES);
    expect(GUIDANCE_LINE.startsWith('> ')).toBe(true);
    expect(/[\r\n]/.test(GUIDANCE_LINE)).toBe(false);
  });

  it('헤딩 추출기가 펜스 안쪽·다른 레벨·다른 이름을 세지 않는다 (self-check)', () => {
    const lines = toLines(doc([
      '# T', '## Rationalizations', '```md', '## Rationalizations', '```',
      '~~~', '## Common Rationalizations', '~~~', '### Rationalizations',
      '## Rationalizations extra', '## Rationalization', '### Rationalization Prevention',
      '## Common Rationalizations',
    ]));
    expect(sectionHeadingIndices(lines)).toEqual([1, 12]);
  });

  it('검사기가 빈 문자열·헤딩 없는 본문을 조용히 통과시키지 않는다 (self-check)', () => {
    expect(scan('')).toEqual(['empty-source']);
    expect(scan(' \r\n\n')).toEqual(['empty-source']);
    expect(scan(undefined)).toEqual(['empty-source']);
    expect(scan('# T\nbody\n')).toEqual(['no-rationalizations-heading']);
  });

  it('검사기가 안내 줄 누락을 잡는다 (음성 대조)', () => {
    const src = doc(['# T', '## Rationalizations', '', '| a | b |']);
    expect(scan(src)).toEqual(['missing-guidance: line 2', 'guidance-count: 0 != 1']);
  });

  it('검사기가 헤딩 바로 아래 안내 줄을 통과시킨다 (양성 대조)', () => {
    const src = doc([
      '# T', '## Rationalizations', GUIDANCE_LINE, '', '| a | b |',
      '## Common Rationalizations', GUIDANCE_LINE, '', '| c | d |',
    ]);
    expect(scan(src)).toEqual([]);
  });

  it('검사기가 빈 줄을 사이에 둔 안내 줄을 "바로 아래" 로 치지 않는다 (self-check)', () => {
    const src = doc(['# T', '## Rationalizations', '', GUIDANCE_LINE, 'body']);
    expect(scan(src)).toEqual(['missing-guidance: line 2', 'stray-guidance: line 4']);
  });

  it('검사기가 펜스 안 헤딩에는 안내 줄을 요구하지 않는다 (양성 대조)', () => {
    const src = doc([
      '# T', '```md', '## Rationalizations', 'example', '```',
      '## Rationalizations', GUIDANCE_LINE, 'body',
    ]);
    expect(scan(src)).toEqual([]);
  });

  it('검사기가 펜스 안에 복제된 안내 줄을 잡는다 (음성 대조)', () => {
    const src = doc([
      '# T', '## Rationalizations', GUIDANCE_LINE, 'body',
      '```md', '## Rationalizations', GUIDANCE_LINE, '```',
    ]);
    expect(scan(src)).toEqual(['stray-guidance: line 7', 'guidance-count: 2 != 1']);
  });

  it('검사기가 절 밖·중복·줄 중간의 안내 줄을 잡는다 (음성 대조)', () => {
    const outside = doc(['# T', GUIDANCE_LINE, '## Rationalizations', GUIDANCE_LINE, 'body']);
    expect(scan(outside)).toEqual(['stray-guidance: line 2', 'guidance-count: 2 != 1']);

    const duplicated = doc(['# T', '## Rationalizations', GUIDANCE_LINE, GUIDANCE_LINE, 'body']);
    expect(scan(duplicated)).toEqual(['stray-guidance: line 4', 'guidance-count: 2 != 1']);

    // 줄 전체 비교로는 안 보이는 들여쓴 복제 — 개수 검사가 잡는다.
    const indented = doc(['# T', '## Rationalizations', GUIDANCE_LINE, `  ${GUIDANCE_LINE}`]);
    expect(scan(indented)).toEqual(['guidance-count: 2 != 1']);
  });

  it('검사기가 레벨 3·다른 이름 헤딩 아래 안내 줄을 헤딩으로 인정하지 않는다 (self-check)', () => {
    const level3 = doc(['# T', '## Rationalizations', GUIDANCE_LINE, '### Rationalizations', GUIDANCE_LINE]);
    expect(scan(level3)).toEqual(['stray-guidance: line 5', 'guidance-count: 2 != 1']);

    const extra = doc(['# T', '## Rationalizations extra', GUIDANCE_LINE]);
    expect(scan(extra)).toEqual(['no-rationalizations-heading']);
  });

  it('검사기가 CRLF 입력을 LF 와 똑같이 판정한다 (self-check)', () => {
    const good = ['# T', '## Rationalizations', GUIDANCE_LINE, '', '## Common Rationalizations', GUIDANCE_LINE];
    const bad = ['# T', '## Rationalizations', '', GUIDANCE_LINE, '```', '## Common Rationalizations', '```'];
    expect(scan(doc(good, '\r\n'))).toEqual([]);
    expect(scan(doc(good, '\r\n'))).toEqual(scan(doc(good)));
    expect(scan(doc(bad, '\r\n'))).toEqual(scan(doc(bad)));
    expect(scan(doc(bad, '\r\n'))).toEqual(['missing-guidance: line 2', 'stray-guidance: line 4']);
  });

  it(`기준선이 ${TOTAL_FILES}파일 · 헤딩 ${TOTAL_HEADINGS}개를 담고 있다 (self-check)`, () => {
    expect(FILES).toHaveLength(TOTAL_FILES);
    const total = FILES.reduce((sum, rel) => sum + BASELINE[rel], 0);
    expect(total).toBe(TOTAL_HEADINGS);
    expect(TOTAL_PLAIN + TOTAL_COMMON).toBe(TOTAL_HEADINGS);
  });

  it('skills/** 에서 헤딩을 가진 파일 집합과 파일별 개수가 기준선과 같다', () => {
    const found = {};
    let plain = 0;
    let common = 0;
    for (const file of walk(SKILLS_DIR)) {
      const lines = toLines(fsSync.readFileSync(file, 'utf-8'));
      const heads = sectionHeadingIndices(lines);
      if (heads.length === 0) continue;
      found[relative(file)] = heads.length;
      for (const i of heads) {
        if (lines[i] === '## Rationalizations') plain += 1;
        else common += 1;
      }
    }
    expect(Object.keys(found).sort()).toEqual([...FILES].sort());
    expect(found).toEqual(BASELINE);
    expect({ plain, common }).toEqual({ plain: TOTAL_PLAIN, common: TOTAL_COMMON });
  });

  it('헤딩이 없는 파일에는 안내 줄이 0번이다', () => {
    const baselineSet = new Set(FILES);
    const others = walk(SKILLS_DIR).map(relative).filter((rel) => !baselineSet.has(rel));
    expect(others.length).toBeGreaterThan(0);
    for (const rel of others) {
      expect(countGuidance(read(rel)), `guidance leaked into ${rel}`).toBe(0);
    }
  });

  it.each(MENTION_ONLY_FILES)('%s — 언급만 있고 헤딩·안내 줄은 없다', (rel) => {
    const source = read(rel);
    expect(source).toContain('Rationalization');
    expect(sectionHeadingIndices(toLines(source))).toEqual([]);
    expect(countGuidance(source)).toBe(0);
  });

  describe.each(FILES)('%s', (rel) => {
    it('모든 헤딩 바로 아래에 안내 줄이 있고, 그 밖에는 없다', () => {
      const violations = scan(read(rel));
      expect(violations, `${rel}: ${violations.join(' | ')}`).toEqual([]);
    });
  });
});
