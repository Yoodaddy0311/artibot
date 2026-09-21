/**
 * Firewall — 헌법 단계 B-1: 22 SKILL.md 체크포인트 재표기(Checkpoint → Self-check).
 *
 * ── 무엇을 지키는가 ─────────────────────────────────────────────────────────
 *  22개 스킬의 `## Human Checkpoints` 절에는 기준선 시점(2026-09-21) 기준
 *  `### Checkpoint N: <제목>` 헤딩이 **66개** 있다. B-1 은 그중 자기검증형을
 *  `### Self-check N: <제목>` 으로 **재표기**한다 — 삭제 0, 번호·제목·본문 보존.
 *
 *   (a) 존속 결정형은 `### Checkpoint N: <제목>` 줄이 문자열 그대로 남는다.
 *   (b) 재표기분은 같은 번호·같은 제목의 `### Self-check N:` 으로 바뀌고,
 *       옛 `### Checkpoint N:` 형태는 남지 않는다.
 *   (c) 파일별 Checkpoint/Self-check 개수가 분류표와 정확히 일치한다.
 *   (d) 체크포인트 외 헤딩이 **전부, 순서대로** 살아 있다(무손실).
 *   (e) Checkpoint·Self-check 헤딩은 전부 `## Human Checkpoints` 절 안에 있다.
 *   (f) Self-check 가 1개 이상인 13파일에는 안내 줄 리터럴이 그 절 안에 정확히
 *       1번 있고, Self-check 가 0인 나머지 9파일에는 Self-check 도 안내 줄도 없다
 *       (= 그 9파일은 이 변경에서 무변경이어야 한다).
 *   전역: Checkpoint + Self-check 총수 = 66, 분류표 합계도 66(SELF 24 / DECISION 42).
 *
 *  기준선(BASELINE)·분류표(CLASSIFICATION)는 **파일 안 리터럴**이다. 테스트는
 *  실행 시점에 git·HEAD·다른 산출물을 읽지 않는다 — 기준선을 현재 상태에서
 *  다시 뽑아 비교하면 게이트가 제 기준선을 파괴하며 통과한다(rules §10).
 *
 * ── 단계 A 추출기와의 차이 ──────────────────────────────────────────────────
 *  `constitution-stage-a-rules.test.js#headings` 는 줄 앞 `#` 만 보는 순진한
 *  추출기라 **코드펜스 안의 `#` 줄도 헤딩으로 집는다**. rules/*.md 에서는 그게
 *  무해했지만 SKILL.md 에서는 아니다 — 실측(2026-09-21) 기준 펜스 안 가짜 헤딩이
 *  session-worklog 22줄 · spec-format 9줄 · tdd-workflow 1줄, 합 32줄이다
 *  (예: spec-format 의 템플릿 예시 `## Feature: [Name]`). 그래서 이 파일의
 *  `headings()` 는 ``` / ~~~ 펜스를 건너뛴다. 두 추출기는 의도적으로 다르며,
 *  단계 A 쪽을 고치지 않았다(그 파일의 기준선이 순진한 추출 결과에 맞춰져 있다).
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 못 보는 것을 적어라) ─────
 *
 *  1. **헤딩 밖 본문의 삭제.** 검사는 헤딩 줄과 안내 줄 리터럴만 본다. 어떤
 *     체크포인트의 헤딩을 남긴 채 그 아래 Context/Ask/Options 를 통째로 지워도
 *     통과한다. 본문 해시를 고정하면 정당한 문구 수정마다 RED 라 하지 않았다.
 *  2. **분류 자체의 옳고 그름.** CLASSIFICATION 은 "무엇이 자기검증형인가" 라는
 *     **판정의 사본**일 뿐이다. 판정이 틀렸어도 리터럴과 파일이 일치하면 그린이다.
 *     이 게이트는 판정을 검증하지 않는다 — 일관성만 본다.
 *  3. **설치본·런타임 반영.** 리포 정본 `skills/<name>/SKILL.md` 만 읽는다.
 *     `~/.claude/skills/` 사본이나 실행 중 세션에 로드된 스킬은 미확인이다.
 *  4. **Self-check 가 실제로 질문을 줄이는지.** 헤딩 이름이 바뀌었다는 것과
 *     모델이 사람에게 덜 묻는다는 것은 다른 진술이다(존재 ≠ 작동, rules §2).
 *     발화 기준 효과는 **미측정**이며 이 게이트의 그린은 그 근거가 못 된다.
 *  5. **범위 밖 파일.** `skills/git-unified/references/*.md` 6파일은 SKILL.md 가
 *     아니라 스캔 대상이 아니다. 거기에 체크포인트 형식 문단이 있어도 조용하다.
 *  6. **동명 헤딩.** (e) 절 포함 검사는 헤딩 문자열 집합으로 비교한다. 같은 문자열
 *     헤딩이 절 안팎에 동시에 있으면 절 밖의 것을 못 잡는다.
 *  7. **헤딩 추가.** 무손실 검사는 기준선이 **부분수열로 순서대로** 남았는지만
 *     본다. 새 헤딩이 끼어들어도 RED 가 아니다 — 스킬에 절이 추가되는 것은
 *     정당한 변경이라 그것까지 막으면 게이트를 깎게 된다(rules §10).
 */

import { describe, expect, it } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'skills',
);

const SECTION_HEADING = '## Human Checkpoints';

/**
 * 안내 줄 — Self-check 가 1개 이상인 13파일에 동일 리터럴로 들어간다.
 * 말미의 fail-closed 절("스스로 해소할 수 없거나 … 중단하고 사용자에게 보고한다")이
 * 핵심이다. 그게 없으면 Self-check 는 "혼자 판단하고 넘어가라" 로 읽힌다.
 */
const GUIDANCE_LINE = '> `### Self-check` 항목은 사람에게 묻지 않는다 — 모델이 Ask 문장을 기준으로 스스로 검증하고, 통과하지 못하면 해당 Step 으로 돌아가 고친다. 스스로 해소할 수 없거나(사람만 할 수 있는 조치·예외 인정) 판단에 확신이 없으면 중단하고 사용자에게 보고한다. 사람의 결정이 필요한 것은 `### Checkpoint` 뿐이다.';

const CHECKPOINT_RE = /^### Checkpoint (\d+): (.+)$/;
const SELFCHECK_RE = /^### Self-check (\d+): (.+)$/;

/** 기준선 시점(2026-09-21, base 57f15175)의 체크포인트 총수. */
const TOTAL_CHECKPOINTS = 66;

/**
 * 헤딩 추출 — 단계 A 와 달리 코드펜스(``` / ~~~) 안쪽을 건너뛴다.
 * 이유는 파일 상단 "단계 A 추출기와의 차이" 참조.
 */
function headings(source) {
  const out = [];
  let fence = null;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    const open = /^(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (fence === null) fence = open[1][0];
      else if (line.startsWith(fence.repeat(3))) fence = null;
      continue;
    }
    if (fence === null && /^#{1,6}\s/.test(line)) out.push(line);
  }
  return out;
}

/** `## Human Checkpoints` 부터 다음 `## ` 헤딩 직전까지. 없으면 null. */
function humanCheckpointSection(source) {
  const lines = source.split(/\r?\n/);
  let fence = null;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const open = /^(`{3,}|~{3,})/.exec(line);
    if (open) {
      if (fence === null) fence = open[1][0];
      else if (line.startsWith(fence.repeat(3))) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (start === -1) {
      if (line === SECTION_HEADING) start = i;
    } else if (/^## /.test(line)) {
      return lines.slice(start, i).join('\n');
    }
  }
  return start === -1 ? null : lines.slice(start).join('\n');
}

function checkpointNumbers(list, re) {
  return list.map((h) => re.exec(h)).filter(Boolean).map((m) => Number(m[1]));
}

function sortedNumbers(values) {
  return [...values].sort((a, b) => a - b).join(',');
}

/**
 * 순수 함수 검사기 — 입력은 파일 본문 + 그 파일의 기준선/분류, 출력은 위반 목록.
 * 파일시스템을 읽지 않으므로 아래 self-check 테스트가 합성 입력으로 직접 검증한다.
 */
function scan(source, baseline, classification) {
  const violations = [];
  if (typeof source !== 'string' || source.trim() === '') {
    return ['empty-source'];
  }
  if (!classification
    || !Array.isArray(classification.decision)
    || !Array.isArray(classification.selfCheck)) {
    // fail-closed — 분류가 주입되지 않았으면 통과시키지 않는다.
    return ['no-classification'];
  }

  const baseNumbers = checkpointNumbers(baseline, CHECKPOINT_RE);
  const claimed = [...classification.decision, ...classification.selfCheck];
  if (sortedNumbers(claimed) !== sortedNumbers(baseNumbers)) {
    violations.push(`classification-mismatch: got ${sortedNumbers(claimed)} want ${sortedNumbers(baseNumbers)}`);
  }

  const selfSet = new Set(classification.selfCheck);
  const expected = baseline.map((h) => {
    const m = CHECKPOINT_RE.exec(h);
    return m && selfSet.has(Number(m[1])) ? `### Self-check ${m[1]}: ${m[2]}` : h;
  });

  const actual = headings(source);
  let cursor = -1;
  for (const heading of expected) {
    const at = actual.indexOf(heading, cursor + 1);
    if (at < 0) violations.push(`missing-or-out-of-order: ${heading}`);
    else cursor = at;
  }

  for (const n of selfSet) {
    if (actual.some((h) => h.startsWith(`### Checkpoint ${n}:`))) {
      violations.push(`stale-checkpoint: ${n}`);
    }
  }

  const cpCount = actual.filter((h) => CHECKPOINT_RE.test(h)).length;
  const scCount = actual.filter((h) => SELFCHECK_RE.test(h)).length;
  if (cpCount !== classification.decision.length) {
    violations.push(`checkpoint-count: ${cpCount} != ${classification.decision.length}`);
  }
  if (scCount !== classification.selfCheck.length) {
    violations.push(`selfcheck-count: ${scCount} != ${classification.selfCheck.length}`);
  }

  const section = humanCheckpointSection(source);
  if (section === null) {
    violations.push('no-human-checkpoints-section');
    return violations;
  }
  const inSection = new Set(headings(section));
  for (const heading of actual) {
    if ((CHECKPOINT_RE.test(heading) || SELFCHECK_RE.test(heading)) && !inSection.has(heading)) {
      violations.push(`outside-section: ${heading}`);
    }
  }
  if (classification.selfCheck.length > 0) {
    if (!section.includes(GUIDANCE_LINE)) violations.push('missing-guidance-line');
  } else if (source.includes(GUIDANCE_LINE)) {
    // Self-check 0 인 파일은 무변경이어야 한다 — 안내 줄만 들어가면 있지도 않은
    // Self-check 규칙을 선언하는 꼴이 된다. 절 안팎 어디든 있으면 위반.
    violations.push('unexpected-guidance-line');
  }
  return violations;
}

function read(name) {
  return fsSync.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf-8');
}

/**
 * 기준선 — base 57f15175 워킹트리에서 일회용 추출기로 뽑은 헤딩 전체 목록.
 * 순서까지 포함한다. 손으로 고치지 마라; 스킬 문서가 정당하게 바뀌면 그 변경과
 * 같은 커밋에서 재산출하고, 왜 바뀌었는지 커밋 메시지에 남겨라.
 */
const BASELINE = {
  'token-efficiency': [
    '# Token Efficiency Engine',
    '## When This Skill Applies',
    '## Core Guidance',
    '### Compression Levels',
    '### Key Techniques',
    '### Quality Preservation',
    '## Quick Reference',
    '### Core Symbols',
    '### Status',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 압축 레벨 적합성 확인 (After Step 2)',
    '### Checkpoint 2: 압축 결과물 품질 검증 (After Step 6)',
    '## Freedom Levels',
    '## Rationalizations',
  ],
  'strategic-compact': [
    '# Strategic Compaction',
    '## When This Skill Applies',
    '## Core Guidance',
    '### 현재 정책 티어 (1M 컨텍스트) 전략',
    '## Output Template',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 컨텍스트 존 평가 확인 (After Step 1)',
    '### Checkpoint 2: 분류 결과 검토 (After Step 3)',
    '### Checkpoint 3: 압축 후 필수 컨텍스트 생존 검증 (After Step 5)',
    '## Freedom Levels',
    '## Output Template',
    '## Quick Reference',
    '## Rationalizations',
    '## Common Rationalizations',
    '## Red Flags',
  ],
  'vibe-coding': [
    '# Vibe Coding Quality Protocol',
    '## When This Skill Applies',
    '## 모호한 빌드 요청: 설계 합의 게이트 (HARD-GATE)',
    '## MANDATORY Protocol: DEV (Decompose-Execute-Verify)',
    '## Zero-Skip Mandate',
    '## Multi-Part Request Handling',
    '## Quality Checklist (Quick)',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 분해 완전성 승인 (After Step 2)',
    '### Checkpoint 2: 모호한 요청 해석 선택 (After Step 4)',
    '### Checkpoint 3: 완료 증거 최종 확인 (After Step 7)',
    '## Freedom Levels',
    '## Rationalizations',
  ],
  'verification-completion': [
    '# Verification Before Completion',
    '## When This Skill Applies',
    '## Core Guidance',
    '### Iron Law: Evidence Before Claims',
    '### Red Flag Expressions',
    '### Rationalization Prevention',
    '### Verification Protocol',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 테스트 결과 수용 여부 (After Step 2)',
    '### Checkpoint 2: 증거 충분성 승인 (After Step 5)',
    '### Checkpoint 3: 레드 플래그 표현 최종 점검 (After Step 6)',
    '## Freedom Levels',
    '## Quick Reference',
    '## Integration with !rv Trigger',
    '## Rationalizations',
    '## Common Rationalizations',
    '## Red Flags',
  ],
  'testing-standards': [
    '# Testing Standards',
    '## When This Skill Applies',
    '## Core Guidance',
    '### Coverage Requirements',
    '### Testing Pyramid',
    '### TDD Workflow (Mandatory)',
    '### Test Quality Rules',
    '### Troubleshooting Test Failures',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 테스트 행동 검증 (After Step 1)',
    '### Checkpoint 2: 리팩토링 결과 승인 (After Step 5)',
    '### Checkpoint 3: 커버리지 미달 시 추가 테스트 결정 (After Step 6)',
    '### Checkpoint 4: 테스트 품질 최종 검토 (After Step 7)',
    '## Freedom Levels',
    '## Quick Reference',
    '## Rationalizations',
    '## Common Rationalizations',
    '## Red Flags',
  ],
  'systematic-debugging': [
    '# Systematic Debugging',
    '## Current State',
    '## Contents',
    '## When This Skill Applies',
    '## Iron Law',
    '## Core Guidance',
    '### Phase 1: Root Cause Investigation',
    '### Phase 2: Hypothesis Validation',
    '### Phase 3: Fix Application',
    '### Phase 4: Fix Verification',
    '## Output Template',
    '## Output Template',
    '## Quick Reference',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 조사 전략 선택 (After Step 2)',
    '### Checkpoint 2: 근본 원인 확인 (After Step 3)',
    '### Checkpoint 3: 수정 전략 선택 (After Step 6)',
    '### Checkpoint 4: 추가 검증 범위 (After Step 8)',
    '## Freedom Levels',
    '## Rationalizations',
    '## Common Rationalizations',
    '## Red Flags',
  ],
  'tdd-workflow': [
    '# TDD Workflow',
    '## Current State',
    '## When This Skill Applies',
    '## Core Guidance',
    '## Output Template',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 테스트 범위 결정 (After Step 1)',
    '### Checkpoint 2: 테스트 실패 검증 (After Step 2)',
    '### Checkpoint 3: 리팩토링 범위 결정 (After Step 5)',
    '### Checkpoint 4: 커버리지 갭 대응 (After Step 6)',
    '## Freedom Levels',
    '## Output Template',
    '## Quick Reference',
    '## Rationalizations',
    '## Common Rationalizations',
    '## Red Flags',
  ],
  'spec-format': [
    '# SPEC Format: Structured Requirements & Specifications',
    '## Contents',
    '## When This Skill Applies',
    '## Core Guidance',
    '### 1. EARS Requirement Templates',
    '#### Ubiquitous Requirements',
    '#### Event-Driven Requirements',
    '#### State-Driven Requirements',
    '#### Optional (Feature-Gated) Requirements',
    '#### Unwanted Behavior (Negative) Requirements',
    '### 2. Complex (Combined) Requirements',
    '### 3. Acceptance Criteria Format',
    '### 4. Technical Specification Template',
    '### 5. Requirement Quality Checklist',
    '### 6. Priority Classification',
    '## Quick Reference',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 요구사항 의도 검토 (After Step 3)',
    '### Checkpoint 2: 인수 기준 완성도 확인 (After Step 4)',
    '### Checkpoint 3: 우선순위 분류 합의 (After Step 6)',
    '### Checkpoint 4: 이해관계자 최종 승인 (After Step 7)',
    '## Freedom Levels',
    '## Rationalizations',
    '## Common Rationalizations',
    '## Red Flags',
  ],
  'session-worklog': [
    '# Session Worklog',
    '## When This Skill Applies',
    '## Worklog Location',
    '## Entry Format (STRICT)',
    '## Rules',
    '### Auto-Append Trigger',
    '### Size Management',
    '### Content Rules',
    '### Token Budget',
    '## Example Entries',
    '## Output Template',
    '## Output Template',
    '## Integration with Other Skills',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 엔트리 내용 확인 (After Step 3)',
    '### Checkpoint 2: 오래된 엔트리 삭제 승인 (After Step 5)',
    '## Freedom Levels',
    '## Recovery Protocol',
    '## Rationalizations',
  ],
  'repo-benchmarking': [
    '# Repo Benchmarking',
    '## When This Skill Applies',
    '## Core Guidance',
    '### 1. Clone and Isolation Protocol',
    '### 2. Analysis Pipeline',
    '### 3. Evaluation Dimensions (10-point scale)',
    '#### 3a. `N/A` — 4 rules (apply before you sum)',
    '### 3b. Artibot Baseline (pinned — never re-scored mid-benchmark)',
    '### 4. Cache Strategy',
    '### 5. Large Repo Handling',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 클론 성공 및 크기 확인 (After Step 3)',
    '### Checkpoint 2: 평가 점수 공정성 승인 (After Step 6)',
    '### Checkpoint 3: 채택 요소 우선순위 선택 (After Step 8)',
    '## Freedom Levels',
    '## Quick Reference',
    '## Rationalizations',
  ],
  'security-standards': [
    '# Security Standards',
    '## When This Skill Applies',
    '## Core Guidance',
    '### Mandatory Pre-Commit Checks',
    '### Secret Management',
    '### Input Validation',
    '### Threat Response Protocol',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 시크릿 노출 여부 확인 (After Step 1)',
    '### Checkpoint 2: SQL 인젝션 방어 검증 (After Step 3)',
    '### Checkpoint 3: 인증/인가 커버리지 확인 (After Step 6)',
    '### Checkpoint 4: 의존성 취약점 대응 방식 선택 (After Step 8)',
    '## Freedom Levels',
    '## Quick Reference',
    '## Rationalizations',
    '## Common Rationalizations',
    '## Red Flags',
  ],
  'memory-management': [
    '# Memory Management',
    '## When This Skill Applies',
    '## Architecture',
    '## Memory Types',
    '## Core Operations',
    '## RAG Search Scoring',
    '## Hook Integration',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 메모리 저장 가치 판단 (After Step 2)',
    '### Checkpoint 2: 세션 요약 정확도 승인 (After Step 4)',
    '### Checkpoint 3: 프루닝 안전성 확인 (After Step 6)',
    '## Freedom Levels',
    '## Anti-Patterns',
    '## Quick Reference',
    '## Rationalizations',
    '## Common Rationalizations',
    '## Red Flags',
  ],
  'cognitive-routing': [
    '# Cognitive Routing',
    '## When This Skill Applies',
    '## Core Guidance',
    '### 1. Dual-Process Architecture',
    '### 2. Routing Criteria',
    '### 3. Threshold Management',
    '### 4. Escalation Rules',
    '### 5. System 1 (Fast / Intuitive)',
    '### 6. System 2 (Deep / Deliberative)',
    '### 7. Integration with Orchestration',
    '### 8. Adaptive Learning Loop',
    '## Advisor Routing',
    '### Escalation Triggers',
    '### When NOT to Escalate',
    '### Routing Integration',
    '### Cost Profile',
    '### Configuration',
    '## Configuration',
    '## Quick Reference',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 라우팅 결정 검토 (After Step 3)',
    '### Checkpoint 2: 에스컬레이션 승인 (After Step 5)',
    '### Checkpoint 3: 임계값 조정 확인 (After Step 7)',
    '## Freedom Levels',
    '## Rationalizations',
  ],
  'coding-standards': [
    '# Coding Standards',
    '## When This Skill Applies',
    '## Core Guidance',
    '### Immutability (CRITICAL)',
    '### Error Handling',
    '### File Organization',
    '### Naming Conventions',
    '### Code Quality Checklist',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 기존 패턴 확인 (After Step 1)',
    '### Checkpoint 2: 파일 분할 전략 선택 (After Step 4)',
    '### Checkpoint 3: 품질 위반 처리 방향 결정 (After Step 6)',
    '## Freedom Levels',
    '## Quick Reference',
    '## Project-Specific Rules',
    '## Rationalizations',
    '## Common Rationalizations',
    '## Red Flags',
  ],
  'ai-security-standards': [
    '# AI Security Standards',
    '## When This Skill Applies',
    '## Core Threat Model — Artibot\'s Real Attack Surface',
    '## The Input-Sanitization Rule (load-bearing)',
    '## Reasoning-Native Model Guard (CoT)',
    '## OWASP LLM Top 10 — Artibot Mapping',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 신뢰 경계 식별 확인 (After Step 1)',
    '### Checkpoint 2: 도구 출력 신뢰경계 검증 (After Step 4)',
    '### Checkpoint 3: 과도한 에이전시 검토 (After Step 5)',
    '## Freedom Levels',
    '## Quick Reference',
    '## Rationalizations',
    '## Red Flags',
  ],
  'setup': [
    '# Artibot Setup Wizard',
    '## 목적',
    '## Activation',
    '## Workflow',
    '### Step 1 — 언어 설정',
    '### Step 2 — 개발 환경',
    '### Step 3 — Agent Teams & Swarm',
    '### Step 4 — 권한 (Permissions)',
    '### Step 5 — MCP 서버',
    '### Step 6 — Git 자동화',
    '## 완료 메시지',
    '## Human Checkpoints',
    '### Checkpoint 1: 권한 변경 확인 (Step 4 후)',
    '### Checkpoint 2: Git Full 자동화 확인 (Step 6 후)',
    '## Checklist',
    '## Guardrails',
    '## Quick Reference',
    '## Rationalizations',
  ],
  'scheduled-learning': [
    '# Scheduled Learning',
    '## When This Skill Applies',
    '## Key Constraints',
    '## Configuration',
    '## Scheduling via CronCreate',
    '### Nightly Learner Job',
    '### Drift Check Job',
    '## Activation Methods',
    '### Method 1: Manual (User Request)',
    '### Method 2: Session-Start Integration',
    '### Method 3: One-Shot',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: Schedule Confirmation (After Step 2)',
    '## Freedom Levels',
    '## Integration with Other Skills',
    '## Quick Reference',
    '## Rationalizations',
  ],
  'self-evaluation': [
    '# Self-Evaluation (Self-Rewarding + GRPO Pattern)',
    '## When This Skill Applies',
    '## Core Guidance',
    '### Hybrid Learning Loop',
    '### Self-Rewarding Evaluation Dimensions',
    '### Scoring Scale',
    '### GRPO: Group Relative Policy Optimization',
    '#### CLI Rule-Based Evaluators',
    '#### Team Composition Rules',
    '#### GRPO Workflow',
    '#### Team GRPO',
    '### Improvement Loop Workflow',
    '### Hybrid Learning Architecture',
    '## API Reference',
    '## Storage',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 평가 점수 검토 (After Step 1)',
    '### Checkpoint 2: GRPO 랭킹 유효성 확인 (After Step 4)',
    '### Checkpoint 3: 개선 제안 실행 여부 (After Step 7)',
    '## Freedom Levels',
    '## Quick Reference',
    '## Rationalizations',
  ],
  'self-learning': [
    '# Self-Learning Tool Selection (Toolformer + GRPO)',
    '## Contents',
    '## When This Skill Applies',
    '## Core Concept: Meta Toolformer',
    '### GRPO Layer: Group Relative Policy Optimization',
    '## Architecture',
    '### Context Key Format',
    '### Scoring Model',
    '### Success Score Heuristics',
    '## API Reference',
    '### `suggestTool(context, options?)`',
    '### `recordUsage(tool, context, score, meta?)`',
    '### `getToolStats(toolName?)`',
    '### `suggestToolCandidates(context, count?)`',
    '### `recordGroupComparison(context, results[])`',
    '### `getGrpoHistory(context, limit?)` / `getGrpoScores(context)`',
    '### `pruneOldRecords(retentionMs?)`',
    '## GRPO Scoring Criteria',
    '### GRPO Learning Dynamics',
    '## Data Storage',
    '## Integration Points',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 도구 추천 검토 (After Step 3)',
    '### Checkpoint 2: GRPO 그룹 비교 조건 검증 (After Step 4)',
    '### Checkpoint 3: 데이터 정리 결과 확인 (After Step 6)',
    '## Freedom Levels',
    '## Anti-Patterns',
    '## Quick Reference',
    '## Rationalizations',
  ],
  'principles': [
    '# Development Principles',
    '## When This Skill Applies',
    '## Core Guidance',
    '### SOLID Principles',
    '### Design Principles',
    '### Decision Framework',
    '### Quality Gate Integration',
    '### Execution Discipline (MANDATORY for ALL agents)',
    '## Quick Reference',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 분해 결과 승인 (After Step 1)',
    '### Checkpoint 2: 설계 트레이드오프 선택 (After Step 3)',
    '### Checkpoint 3: 완료 증거 검증 (After Step 5)',
    '## Freedom Levels',
    '## Rationalizations',
  ],
  'lifelong-learning': [
    '# Lifelong Learning',
    '## Contents',
    '## When This Skill Applies',
    '## Core Guidance',
    '### 1. Learning Pipeline',
    '### 2. Experience Collection',
    '### 3. GRPO (Group Relative Policy Optimization)',
    '### 4. Knowledge Transfer',
    '#### Promotion (System 2 -> System 1)',
    '#### Demotion (System 1 -> System 2)',
    '### 5. Knowledge Transfer Parameters',
    '### 6. Persistence',
    '### 7. Integration with Cognitive Routing',
    '## Configuration',
    '### Automatic Scheduling (CronCreate)',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: GRPO 비교 결과 검토 (After Step 4)',
    '### Checkpoint 2: 임계값 조정 방향 확인 (After Step 5)',
    '### Checkpoint 3: 승격/강등 결정 검토 (After Step 6)',
    '## Freedom Levels',
    '## Quick Reference',
    '## Rationalizations',
  ],
  'continuous-learning': [
    '# Continuous Learning',
    '## When This Skill Applies',
    '## Core Guidance',
    '## Workflow Checklist',
    '## Human Checkpoints',
    '### Checkpoint 1: 패턴 저장 승인 (After Step 2)',
    '### Checkpoint 2: 학습 분류 선택 (After Step 3)',
    '### Checkpoint 3: 오래된 항목 정리 선택 (After Step 6)',
    '## Freedom Levels',
    '## Quick Reference',
    '## Rationalizations',
  ],
};

/**
 * 분류표 — `decision` 은 사람 결정형(그대로 Checkpoint), `selfCheck` 는 재표기 대상.
 * 2026-09-21 리더 확정판: judge 2인 **독립 분류의 교집합 SELF 만** 재표기했다.
 * 불일치 4건(strategic-compact#2 · systematic-debugging#2 · tdd-workflow#2 ·
 * security-standards#1)과 리더 보수 판정 1건(verification-completion#1 — Accept
 * 선택지가 "무관 실패" 면제 발급을 포함한다)은 결정형으로 남겼다. 즉 이 표는
 * **의심스러우면 사람에게 묻는 쪽**으로 기울어 있다. 합계 SELF 24 / DECISION 42.
 * 비어 있으면 scan 이 fail-closed(RED) — 분류 미주입 상태로 통과시키지 않는다.
 */
const CLASSIFICATION = {
  'token-efficiency': { decision: [1], selfCheck: [2] },
  'strategic-compact': { decision: [2], selfCheck: [1, 3] },
  'vibe-coding': { decision: [2], selfCheck: [1, 3] },
  'verification-completion': { decision: [1], selfCheck: [2, 3] },
  'testing-standards': { decision: [3], selfCheck: [1, 2, 4] },
  'systematic-debugging': { decision: [1, 2, 3, 4], selfCheck: [] },
  'tdd-workflow': { decision: [1, 2, 3, 4], selfCheck: [] },
  'spec-format': { decision: [3, 4], selfCheck: [1, 2] },
  'session-worklog': { decision: [1, 2], selfCheck: [] },
  'repo-benchmarking': { decision: [1, 3], selfCheck: [2] },
  'security-standards': { decision: [1, 4], selfCheck: [2, 3] },
  'memory-management': { decision: [1, 2, 3], selfCheck: [] },
  'cognitive-routing': { decision: [1, 2, 3], selfCheck: [] },
  'coding-standards': { decision: [2, 3], selfCheck: [1] },
  // 전건 Self-check — 재표기 후 이 파일에는 `### Checkpoint` 가 하나도 남지 않는다.
  'ai-security-standards': { decision: [], selfCheck: [1, 2, 3] },
  setup: { decision: [1, 2], selfCheck: [] },
  'scheduled-learning': { decision: [1], selfCheck: [] },
  'self-evaluation': { decision: [2, 3], selfCheck: [1] },
  'self-learning': { decision: [2], selfCheck: [1, 3] },
  principles: { decision: [2], selfCheck: [1, 3] },
  'lifelong-learning': { decision: [1, 2, 3], selfCheck: [] },
  'continuous-learning': { decision: [1, 2, 3], selfCheck: [] },
};

/** 무변경이어야 하는 파일 — selfCheck 가 빈 것에서 파생, 손으로 적지 않는다. */
const UNCHANGED_FILES = Object.keys(CLASSIFICATION)
  .filter((name) => CLASSIFICATION[name].selfCheck.length === 0);

const NAMES = Object.keys(BASELINE);

describe('constitution stage B-1 — 22 SKILL.md 체크포인트 재표기', () => {
  it('헤딩 추출기가 코드펜스 안쪽을 건너뛴다 (self-check)', () => {
    const sample = headings([
      '# A', '본문', '```md', '## 펜스안', '```', '## B',
      '~~~', '### 물결펜스안', '~~~', '### C', '텍스트 ## 아님',
    ].join('\n'));
    expect(sample).toEqual(['# A', '## B', '### C']);
  });

  it('절 추출기가 다음 ## 직전에서 끊는다 (self-check)', () => {
    const src = ['# T', '## Human Checkpoints', '### Checkpoint 1: X', 'body', '## Next', '### Checkpoint 9: Y'].join('\n');
    const section = humanCheckpointSection(src);
    expect(section).toContain('### Checkpoint 1: X');
    expect(section).not.toContain('### Checkpoint 9: Y');
    expect(humanCheckpointSection('# 없음')).toBeNull();
  });

  it('검사기가 빈 문자열을 조용히 통과시키지 않는다 (self-check)', () => {
    expect(scan('', ['# A'], { decision: [], selfCheck: [] })).toEqual(['empty-source']);
  });

  it('검사기가 분류 미주입을 fail-closed 로 막는다 (self-check)', () => {
    const src = '# T\n## Human Checkpoints\n### Checkpoint 1: X\n';
    expect(scan(src, ['# T', SECTION_HEADING, '### Checkpoint 1: X'], undefined))
      .toEqual(['no-classification']);
    expect(scan(src, ['# T', SECTION_HEADING, '### Checkpoint 1: X'], {}))
      .toEqual(['no-classification']);
  });

  it('검사기가 체크포인트 블록 삭제를 잡는다 (self-check)', () => {
    const baseline = ['# T', SECTION_HEADING, '### Checkpoint 1: X', '### Checkpoint 2: Y'];
    const deleted = ['# T', SECTION_HEADING, '', '### Checkpoint 1: X', 'body'].join('\n');
    const violations = scan(deleted, baseline, { decision: [1, 2], selfCheck: [] });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join('|')).toContain('### Checkpoint 2: Y');
  });

  it('검사기가 분류 밖 재표기를 잡는다 (self-check)', () => {
    // 분류상 decision 인데 파일에서는 Self-check 로 바뀐 경우.
    const baseline = ['# T', SECTION_HEADING, '### Checkpoint 1: X'];
    const renamed = ['# T', SECTION_HEADING, '', '### Self-check 1: X', 'body'].join('\n');
    const violations = scan(renamed, baseline, { decision: [1], selfCheck: [] });
    expect(violations.length).toBeGreaterThan(0);
  });

  it('검사기가 안내 줄 누락을 잡는다 (self-check)', () => {
    const baseline = ['# T', SECTION_HEADING, '### Checkpoint 1: X'];
    const renamed = ['# T', SECTION_HEADING, '', '### Self-check 1: X', 'body'].join('\n');
    expect(scan(renamed, baseline, { decision: [], selfCheck: [1] }))
      .toContain('missing-guidance-line');
    const withLine = ['# T', SECTION_HEADING, '', GUIDANCE_LINE, '', '### Self-check 1: X', 'body'].join('\n');
    expect(scan(withLine, baseline, { decision: [], selfCheck: [1] })).toEqual([]);
  });

  it('검사기가 Self-check 0 인 파일의 안내 줄 혼입을 잡는다 (self-check)', () => {
    const baseline = ['# T', SECTION_HEADING, '### Checkpoint 1: X'];
    const polluted = ['# T', SECTION_HEADING, '', GUIDANCE_LINE, '', '### Checkpoint 1: X'].join('\n');
    expect(scan(polluted, baseline, { decision: [1], selfCheck: [] }))
      .toContain('unexpected-guidance-line');
  });

  it('검사기가 절 밖 체크포인트를 잡는다 (self-check)', () => {
    const baseline = ['# T', SECTION_HEADING, '## Other', '### Checkpoint 1: X'];
    const src = ['# T', SECTION_HEADING, '', '## Other', '', '### Checkpoint 1: X'].join('\n');
    expect(scan(src, baseline, { decision: [1], selfCheck: [] }))
      .toContain('outside-section: ### Checkpoint 1: X');
  });

  it('기준선이 22파일 · 체크포인트 66개를 담고 있다 (self-check)', () => {
    expect(NAMES).toHaveLength(22);
    const total = NAMES.reduce(
      (sum, name) => sum + checkpointNumbers(BASELINE[name], CHECKPOINT_RE).length,
      0,
    );
    expect(total).toBe(TOTAL_CHECKPOINTS);
  });

  it('`## Human Checkpoints` 를 가진 SKILL.md 집합이 정확히 이 22개다', () => {
    // allowlist 방식이되, 목록이 현실과 어긋나면 알려야 한다. 범위 밖:
    // skills/git-unified/references/*.md 는 SKILL.md 가 아니라 세지 않는다.
    const found = fsSync.readdirSync(SKILLS_DIR)
      .filter((dir) => {
        const file = path.join(SKILLS_DIR, dir, 'SKILL.md');
        return fsSync.existsSync(file)
          && fsSync.readFileSync(file, 'utf-8').includes(SECTION_HEADING);
      })
      .sort();
    expect(found).toEqual([...NAMES].sort());
  });

  it('분류표가 66개 체크포인트를 빠짐없이 덮는다', () => {
    const covered = NAMES.reduce((sum, name) => {
      const entry = CLASSIFICATION[name];
      expect(entry, `classification missing: ${name}`).toBeDefined();
      return sum + entry.decision.length + entry.selfCheck.length;
    }, 0);
    expect(covered).toBe(TOTAL_CHECKPOINTS);
  });

  it('전체 Checkpoint + Self-check 헤딩 총수가 66이다', () => {
    const total = NAMES.reduce((sum, name) => {
      const all = headings(read(name));
      return sum
        + all.filter((h) => CHECKPOINT_RE.test(h)).length
        + all.filter((h) => SELFCHECK_RE.test(h)).length;
    }, 0);
    expect(total).toBe(TOTAL_CHECKPOINTS);
  });

  it('Self-check 0 인 9파일에는 Self-check 도 안내 줄도 없다 (무변경)', () => {
    expect(UNCHANGED_FILES).toHaveLength(9);
    for (const name of UNCHANGED_FILES) {
      const source = read(name);
      expect(source.includes(GUIDANCE_LINE), `guidance leaked into ${name}`).toBe(false);
      expect(
        headings(source).filter((h) => SELFCHECK_RE.test(h)),
        `unexpected Self-check in ${name}`,
      ).toEqual([]);
    }
  });

  it('Self-check 를 가진 13파일에는 안내 줄이 정확히 1번만 있다', () => {
    const changed = NAMES.filter((name) => CLASSIFICATION[name].selfCheck.length > 0);
    expect(changed).toHaveLength(13);
    for (const name of changed) {
      const hits = read(name).split(GUIDANCE_LINE).length - 1;
      expect(hits, `${name}: guidance line x${hits}`).toBe(1);
    }
  });

  describe.each(NAMES)('%s/SKILL.md', (name) => {
    it('기준선·분류표와 일치한다 (삭제 0, 무손실, 절 안, 안내 줄)', () => {
      const violations = scan(read(name), BASELINE[name], CLASSIFICATION[name]);
      expect(violations, `${name}: ${violations.join(' | ')}`).toEqual([]);
    });
  });
});
