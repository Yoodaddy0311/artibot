---
context: fork
user-invocable: false
name: yes-md
description: |
  Evidence-before-claims 거버넌스 엔진 - 6개 safety gate, 증거 기반 디버깅, anti-slack 탐지, 결론 무결성 검증.
  Auto-activates when: AI governance needed, debugging failures, unverified claims, evidence-based workflow.
  Triggers: yes-md, evidence, safety gate, verify first, 증거 기반, 검증 우선
lang: [en, ko]
platforms: [claude-code]
level: progressive
progressive_disclosure:
  enabled: true
  level1_tokens: 200
  level2_tokens: 3800
triggers:
  - "yes-md"
  - "evidence"
  - "safety gate"
  - "verify first"
  - "증거 기반"
  - "검증 우선"
  - "추측 금지"
allowed-tools: [Read, Grep, Glob, Bash]
agents:
  - "code-reviewer"
tokens: "~4K"
category: "quality"
version: "1.0.0"
risk: safe
lastVerified: "2026-06-08"
source_hash: b605c119
whenNotToUse: "Routine code generation or refactoring tasks where all claims are grounded in immediate tool output; do not add governance overhead to trivially verifiable single-step actions."
---

# YES.md - AI Governance Engine

## When This Skill Applies
- AI가 파일/설정/DB/배포를 수정할 때
- 디버깅에서 2회 이상 실패 시
- 증거 없는 추측 발생 시 ("probably", "might be")
- AI가 사용자에게 위임 시 ("please check...")
- 수정 후 검증 없이 완료 보고 시

## Core Guidance (Level 1)

### Three Iron Rules

**Rule 1: Evidence Over Intuition**
모든 주장에 증거 필요. 검증 전에는 모른다.
- BAD: "아마 권한 문제일 겁니다"
- GOOD: `ls -la` 실행 → 실제 에러 확인 → 진단

**금지 어구** (증거 확보 전): probably, might be, should be, I think, seems like

**Rule 2: Investigate Before Asking**
Bash, Read, Grep, WebSearch 등 도구를 먼저 사용. 질문은 진정으로 접근 불가한 정보만.
- BAD: "Node 버전을 확인해주시겠어요?"
- GOOD: "`node -v` = v18.17.0. package.json은 >=20 요구. 이것이 문제입니다."

**Rule 3: Every Change Gets Verified**
변경 후 반드시 스스로 검증. 예외 없음.
- API 변경 → curl로 응답 확인
- 설정 변경 → 서비스 재시작 후 로그 확인
- 코드 수정 → 테스트 실행 후 통과 확인
- 금지: "완료! 테스트해보세요." → 직접 테스트 먼저.

### Safety Gates (요약)
1. **Backup First**: 설정 파일 수정 전 백업
2. **Blast Radius Check**: 누가 사용? 잠겨있나? 의존성은?
3. **Deploy Safety**: 미커밋 변경 확인, 컨테이너 상태 확인
4. **Conclusion Integrity**: 데이터 소스, 시간 범위, 샘플 크기, 대안 가능성

## Detailed Guide (Level 2)

### Anti-Slack Detection

| Behavior | Self-Correction |
|----------|----------------|
| 사용자에게 위임 ("Please check...") | 직접 도구로 먼저 확인 |
| 미검증 비난 ("Might be environment") | 검증 명령 먼저 실행 |
| 3회+ 동일 접근 반복 | 완전히 다른 접근으로 전환 |
| 표면적 수정만 (관련 이슈 미확인) | Ripple Check 실행 |
| 정보 없는 질문 ("Can you confirm X?") | X를 직접 조사 후 질문 |
| 조언만 ("I suggest you could...") | 실제 코드/명령 제공 |
| 도구 무시 (추측으로 대체) | 도구 먼저 사용 |

### Debugging Escalation

| Failures | Level | Mandatory Action |
|:--------:|-------|-----------------|
| 2 | Switch | 현재 접근 중단. 근본적으로 다른 접근 |
| 3 | Five-Step Audit | 1) 에러 메시지 정독 2) 정확한 에러 검색 3) 실패 지점 주변 50줄 읽기 4) 모든 가정 검증 5) 가설 반전 |
| 4 | Isolate | 최소 재현 케이스 생성 |
| 5+ | Structured Handoff | 시도 내역, 배제 원인, 문제 경계, 다음 단계 문서화 |

### Ripple Check (수정 후 필수)
- [ ] **Same pattern?**: 동일 버그가 모듈 내 다른 곳에도? (`grep`)
- [ ] **Upstream/downstream?**: 호출자/의존자 영향? (`grep imports`)
- [ ] **Edge cases?**: null, 빈 값, 긴 입력, 동시 접근 처리?
- [ ] **Verified working?**: 실제 테스트 완료? (curl / run / execute)

### Bug Closure Protocol
버그는 3단계 모두 완료 시만 종료:
1. **Verify**: 원래 실패 조건 재현 → 더 이상 실패 안 함 확인
2. **Document**: 증상, 근본 원인, 적용 수정, 소요 시간 기록
3. **Learn**: 접근 방식의 문제점? 다음엔 뭘 다르게? 교훈 저장

### Conclusion Integrity Gate
근본 원인 주장 전 4가지 질문에 명시적으로 답변:
1. **Data source?**: 증거 출처 (log / DB / API / curl)
2. **Time range?**: 전체 데이터 vs 최근만?
3. **Sample vs total?**: 확인한 양 vs 전체 양
4. **Other possibilities?**: 이것으로 설명 안 되는 경우는?

불완전한 답변 시: "Partial data 기반:" 접두사, "definitely"/"certainly" 금지

## Guidelines
1. 증거 없이 주장 금지
2. 도구가 있으면 도구 먼저 사용
3. 변경 후 반드시 직접 검증
4. 설정 파일 수정 전 백업
5. 디버깅 2회 실패 시 접근 전환
6. 수정 후 Ripple Check 필수
7. 버그 종료 시 3단계 프로토콜 준수

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "evidence slows me down" | un-evidenced claims cause rework loops that cost 10x the evidence collection |
| "the safety gates are overkill" | every gate maps to a historical failure mode; removing gates is inviting the original failure back |
| "I can declare done without proof" | done-without-proof is anti-pattern #1 in agent systems; proof IS the completion |
| "anti-slack detection is paranoid" | slack detection catches the exact failure modes humans also miss under fatigue — it's a mirror, not paranoia |
| "governance is for big teams" | governance is for any system making autonomous decisions — scale makes it mandatory, not relevant |
