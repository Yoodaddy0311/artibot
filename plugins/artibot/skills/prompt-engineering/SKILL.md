---
context: fork
user-invocable: false
name: prompt-engineering
description: |
  프롬프트 엔지니어링 패턴 - Few-shot, Chain-of-Thought, 시스템 프롬프트 설계, 템플릿 시스템, 최적화 기법.
  Auto-activates when: prompt optimization, system prompt design, few-shot learning, CoT prompting.
  Triggers: prompt engineering, few-shot, chain of thought, system prompt, 프롬프트 설계
platforms: [claude-code]
level: progressive
progressive_disclosure:
  enabled: true
  level1_tokens: 180
  level2_tokens: 3000
triggers:
  - "prompt engineering"
  - "few-shot"
  - "chain of thought"
  - "system prompt"
  - "프롬프트 설계"
  - "프롬프트 최적화"
  - "CoT"
allowed-tools: [Read, Grep, Glob]
agents:
  - "llm-architect"
tokens: "~3K"
category: "development"
version: "1.0.0"
risk: safe
lastVerified: "2026-03-31"
source_hash: 947e33e8
---

# Prompt Engineering Patterns

## When This Skill Applies
- 프롬프트 품질/일관성 개선
- 시스템 프롬프트 설계
- Few-shot 예제 구성
- Chain-of-Thought 추론 유도
- 프로덕션 프롬프트 최적화 및 버전 관리

## Core Guidance (Level 1)

### 5 Core Capabilities
1. **Few-Shot Learning**: 2-5개 입출력 예제로 패턴 교육 (규칙 설명보다 효과적)
2. **Chain-of-Thought**: "단계별로 생각해보자"로 추론 유도 (분석 정확도 30-50% 향상)
3. **System Prompt Design**: 역할/전문성/출력 포맷/안전 가이드라인 설정
4. **Template Systems**: 변수/조건부 섹션/모듈식 재사용 구조
5. **Prompt Optimization**: 단순→제약→추론→예제 순으로 반복 개선

### Instruction Hierarchy
```
[System Context] → [Task Instruction] → [Examples] → [Input Data] → [Output Format]
```

### Progressive Disclosure
- **Level 1**: 직접 지시 ("이 기사를 요약해주세요")
- **Level 2**: 제약 추가 ("3개 핵심 발견을 중심으로 3줄로")
- **Level 3**: 추론 추가 ("핵심 발견을 식별한 후 요약")
- **Level 4**: 예제 추가 (2-3개 입출력 쌍 포함)

## Detailed Guide (Level 2)

### Few-Shot Learning
```markdown
지원 티켓에서 핵심 정보를 추출하세요:

Input: "로그인이 안 되고 403 에러가 계속 뜹니다"
Output: {"issue": "authentication", "error_code": "403", "priority": "high"}

Input: "기능 요청: 설정에 다크 모드 추가"
Output: {"issue": "feature_request", "error_code": null, "priority": "low"}

Now process: "10MB 이상 파일 업로드 시 타임아웃 발생"
```

**Best Practice**:
- 예제 수: 2-5개 (정확도 vs 토큰 균형)
- 에지 케이스 포함
- 대상 태스크와 형식 일치

### Chain-of-Thought
```markdown
이 버그 리포트를 분석하고 근본 원인을 판단하세요.

단계별로 생각하세요:
1. 예상 동작은?
2. 실제 동작은?
3. 최근 변경 중 원인이 될 수 있는 것은?
4. 관련 컴포넌트는?
5. 가장 가능성 높은 근본 원인은?

Bug: "어제 캐시 업데이트 배포 후 사용자가 초안을 저장할 수 없습니다"
```

### System Prompt Design
```markdown
System: 당신은 API 설계 전문 시니어 백엔드 엔지니어입니다.

Rules:
- 확장성과 성능을 항상 고려
- RESTful 패턴을 기본으로 제안
- 보안 우려사항을 즉시 플래그
- Python 코드 예제 제공
- early return 패턴 사용

Format:
1. 분석
2. 권장안
3. 코드 예제
4. 트레이드오프
```

### Template Systems
```python
template = """
이 {language} 코드를 {focus_area} 관점에서 리뷰하세요.

Code:
{code_block}

검토 항목:
{checklist}
"""

prompt = template.format(
    language="TypeScript",
    focus_area="보안 취약점",
    code_block=user_code,
    checklist="1. SQL injection\n2. XSS\n3. Authentication"
)
```

### Error Recovery in Prompts
- 폴백 지시 포함
- 신뢰도 점수 요청
- 불확실 시 대안 해석 요청
- 누락 정보 표시 방법 명시

### Optimization Loop
```
Version 1 (Simple): "이 기사를 요약" → 비일관적 길이, 핵심 누락
Version 2 (Constrained): "3개 핵심 발견을 3줄로 요약" → 구조 개선
Version 3 (Reasoning): "핵심 발견 3개를 식별한 후 각각 요약" → 일관적, 정확
```

### Common Pitfalls
- **Over-engineering**: 단순한 것부터 시도하지 않고 복잡하게 시작
- **Example pollution**: 대상 태스크와 맞지 않는 예제 사용
- **Context overflow**: 과도한 예제로 토큰 초과
- **Ambiguity**: 다중 해석 가능한 지시문
- **Edge case 무시**: 경계 입력 테스트 누락

## Guidelines
1. 구체적으로 작성 (모호한 프롬프트 = 비일관적 결과)
2. 설명보다 예제가 효과적 (Show, Don't Tell)
3. 다양한 입력으로 충분히 테스트
4. 프롬프트를 코드처럼 버전 관리
5. 프로덕션 프롬프트는 메트릭 모니터링
6. 단순한 것부터 시작, 필요 시에만 복잡도 추가

## Rationalizations

The following table captures common excuses agents make to skip the discipline of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "more examples always help" | too many examples dilute the signal and blow the context budget |
| "the model will figure it out" | hope is not a strategy — explicit constraints beat implicit intent every time |
| "Chain-of-Thought is for weak models" | CoT measurably improves strong models on multi-step reasoning; the "weak model" framing is outdated |
| "system prompts and user prompts are interchangeable" | system prompts have higher weight and better persistence; misplacing constraints loses them |
| "I'll tune the prompt after seeing failures" | post-hoc tuning overfits to observed failures; structured design catches unseen failures too |
