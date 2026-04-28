---
name: polish
context: fork
triggers:
  - "글 써줘"
  - "블로그"
  - "이메일"
  - "보고서"
  - "카피"
  - "제안서"
  - "AI 같아"
  - "기계적이야"
  - "자연스럽게"
  - "사람처럼"
description: |
  AI-slop auto-detection and human-voice rewriting for any text output produced by Artibot agents (content-marketer, copywriter, ad-specialist, presentation-designer, seo-specialist, doc-updater). Auto-activates on every content-producing agent's output — user does NOT need to invoke this skill. Detects mechanical AI patterns (korean: "~에 대해 살펴보겠습니다", "~라고 할 수 있습니다", "또한/그러나/따라서" 과용, 획일적 문장 길이; english: delve/leverage/pivotal/robust/tapestry/"It's important to note"/"In conclusion" 남용) and rewrites to natural human voice while preserving factual content.

  MUST trigger when:
  - Any content-marketer / copywriter / ad-specialist / presentation-designer / seo-specialist / doc-updater agent finishes producing user-facing text
  - User says "글 써줘", "블로그", "이메일", "보고서", "카피", "제안서", "슬라이드 내용", any generative writing request
  - User says "AI 같아", "기계적이야", "어색해", "자연스럽게", "사람처럼" on any prior text output
  - Any text ≥ 200 characters is emitted as a user deliverable (not code, not internal logs)

  DO NOT trigger for:
  - Code, JSON, YAML, SQL, or other structured non-prose output
  - Internal agent-to-agent messages
  - Short acknowledgements (< 200 chars)
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
category: code-quality
tokens: 2500
agents: [content-marketer, doc-updater]
auto-invoke: true
user-invocable: false
whenNotToUse: "Do not apply polish to code blocks, JSON/YAML/SQL, internal agent-to-agent messages, or outputs shorter than 200 characters. Do not re-run on text that has already been polished in the same session (idempotency guard)."
---

# polish — AI-slop Auto-Remediation (Post-Generation Hook Skill)

This skill is a **post-output remediation layer**. It is invoked automatically as the last step of any content-generating agent chain. Users never type a command for it; Artibot detects producer-type and chains `polish` at the end.

## Pipeline Position

```
user request
  → intent router
  → {content-marketer | copywriter | ad-specialist | ...} produces draft
  → polish (this skill)              ← auto-chained
  → final output delivered to user
```

The producer agent emits draft text → orchestrator routes it through `polish` → cleaned text is what the user actually sees.

## 1-Step Diagnostic

Scan the draft against two pattern sets:

### 🔴 금지 패턴 (Korean)

| 패턴 | 수정 방향 |
|---|---|
| `~에 대해 살펴보겠습니다` | 바로 본론 진입 |
| `~의 중요성은 아무리 강조해도 지나치지 않습니다` | 구체적 이유로 대체 |
| `~을 통해 알 수 있듯이` | 삭제 또는 직접 서술 |
| `다음과 같습니다:` + 목록 남발 | 산문 통합 또는 정말 필요할 때만 |
| `이처럼 ~은 매우 중요한 의미를 가집니다` (공허한 마무리) | 삭제 |
| `종합적인 / 체계적인 / 효율적인` (맥락 없는 수식) | 구체 서술 |
| 문단마다 `또한 / 그러나 / 따라서 / 더불어 / 한편` | 연결어 제거·대체 |
| `~라고 할 수 있습니다` | `~입니다` 또는 구체 서술 |

### 🔴 금지 패턴 (English)

`delve, leverage, utilize, harness, embark, pivotal, robust, seamless, cutting-edge, comprehensive, tapestry, landscape, realm, synergy, testament, "It's important to note", "In today's ever-evolving world", "In conclusion / summary / essence", "Not just X, but Y" 남용, "Certainly!" 서두`

### 🟡 구조 패턴

| 패턴 | 수정 |
|---|---|
| 모든 문장이 20–25자 균일 | 단문·중문·장문 섞기 |
| 모든 단락이 불릿으로 끝남 | 산문 단락 혼합 |
| 수미쌍관형 인사+요약+인사 | 인사 제거, 본문에 녹임 |
| 첫 문장이 결론 선언 | 맥락부터 구성 |

## 2-Step Rewrite Rules

| 규칙 | 적용 |
|---|---|
| Specificity over abstraction | 추상 수식어 → 숫자·고유명사·시간 |
| Active voice | 수동문 → 능동문 (단, 책임 주체가 불명확하면 예외) |
| Varied sentence length | 최소 3종 길이 섞기 |
| Drop hedge words | "일반적으로", "다소", "경우에 따라" 제거 (진짜 불확실할 때만 유지) |
| Preserve facts | 숫자·인용·고유명사 절대 수정 금지 |

## 3-Step Output

1. 교정본(텍스트) — 유저에게 전달될 최종본
2. (내부 로그) 적용한 수정 카운트 — 세션 학습용, 유저 노출 X

## 성능·안전

- **멱등성**: 이미 polished된 텍스트 재입력 시 no-op (변경률 <5%로 탐지)
- **길이 보존**: ±10% 이내 (과도한 축약·팽창 금지)
- **코드 보존**: ``` 코드블록, `inline code`, URL은 절대 건드리지 않음
- **무한 루프 방지**: polish 출력이 다시 polish의 트리거가 되지 않음 (`already-polished` 플래그)

## Trigger by Agent (자동 체인)

| 생산 에이전트 | polish 체인 | 예외 |
|---|:-:|---|
| content-marketer | ✅ | JSON 모드 출력 시 skip |
| copywriter 계열 | ✅ | — |
| ad-specialist | ✅ | ad copy headline만은 human review 경유 |
| presentation-designer | ✅ | speaker notes만 polish, layout 메타 skip |
| seo-specialist | ✅ | meta description은 length 제약 엄격 유지 |
| doc-updater | ✅ | code block·API signature skip |
| planner / code-reviewer / architect | ❌ | 내부 분석물은 polish 대상 아님 |

## Common Rationalizations

| Rationalization | Why it's wrong | What to do instead |
|---|---|---|
| "The draft is already natural, polish will over-edit it" | Polish is idempotent by design — if the change rate is below 5% the skill is a no-op; running it on already-clean text costs almost nothing | Always run polish; let the idempotency guard decide whether changes are needed |
| "Polishing adds latency to the agent chain" | Polish is a regex-and-rewrite pass, not an LLM call; the latency is negligible compared to the producer agent that created the draft | Run polish as the final synchronous step of every content-producing agent chain |
| "The AI tone markers are subtle, users won't notice" | Users reliably notice AI-slop patterns even when they cannot name them; they experience the text as hollow or untrustworthy without knowing why | Apply the diagnostic against both banned-pattern lists regardless of perceived subtlety |
| "Length preservation ±10% is too strict for heavy rewrites" | Outputs that grow beyond ±10% are adding content that was not in the draft; outputs that shrink more than 10% are losing factual content | If the rewrite requires more than ±10% change, the draft has a structural problem that polish should not mask — return it to the producer |
| "I'll polish only when the user complains about AI tone" | Reactive polish means most users see the AI-slop version; proactive auto-chaining means no user sees it | Configure auto-invoke in the agent chain — polish should never be an optional step |

## Red Flags

- Content-marketer or copywriter output reaching the user without a polish pass
- Polish skip logged for output over 200 characters with no justification in the session log
- Rewritten text containing any of the banned English slop patterns (delve, leverage, pivotal)
- Output length changed by more than 10% from the draft
- Code block content modified by the polish rewrite
- Same draft polished twice in the same session (missing idempotency guard)
