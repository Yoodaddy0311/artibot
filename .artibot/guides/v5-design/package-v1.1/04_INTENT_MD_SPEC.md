# intent.md — Canonical Mission Intent

## Purpose

`intent.md` answers:

> **What must this mission achieve, and why?**

It is not a transcript of the user's request.

It is the interpreted, bounded, testable mission definition.

## Creation rule

Create `intent.md` for a **substantive mission**.

Do not create a mission artifact for:
- greetings
- tiny rewrites
- trivial factual questions
- ephemeral interactions with no durable project effect

## Recommended format

```markdown
---
mission_id: M-20260902-001
status: active
intent_revision: 2
created_at: 2026-09-02T13:00:00+09:00
updated_at: 2026-09-02T13:40:00+09:00

execution_profile:
  planning: ultraplan
  performance: maximum
  topology: split

review:
  independent: true
  model: fable-5.1
---

# Intent

## Original Request
Split 성능을 개선해줘.

## Interpreted Goal
대규모 병렬 작업의 속도·정확도·안정성을 높이고
사용자의 수동 모니터링 부담을 줄인다.

## Explicit Scope
- Split 자체 실행 구조
- worker orchestration
- merge/conflict
- monitoring

## Systemic Scope
직접적인 인과관계가 확인될 경우:
- context handoff
- session lifecycle
- recovery
- verification

## Success Criteria
- wall-clock 개선
- context 누락 감소
- worker failure 자동 감지
- merge conflict 감소
- human intervention 감소
- regression 없음

## Constraints
- unrelated runtime refactor 금지
- 기존 UX 호환 유지

## Intent Refinements

### Revision 2
Context reconstruction이 핵심 병목으로 확인되어
systemic scope에 context lifecycle 추가.

Evidence:
- ...
```

## Intent rules

### Stable, but not immutable

Intent should not change because the implementation becomes inconvenient.

Intent may change only if:
- evidence reveals the problem was framed incorrectly,
- the user explicitly changes direction,
- a required product decision changes,
- the mission scope must be formally redefined.

## Intent history

Do not create `intent-v2.md`.

Maintain one file and record:
- revision,
- reason,
- evidence,
- updater.

Git remains the detailed historical version record.
