# Product UX — Natural Language Runtime

## Highest-priority user-facing principle

Artibot will be used by non-developers. A non-developer should not need to know what `/plan`, `/ultraplan`, `/team`, `/split`, or model tiers mean. Those are runtime responsibilities.

## UX contract

```text
Natural-language request
→ infer intent
→ infer work type
→ infer depth
→ infer commands
→ infer command flags
→ infer skills
→ infer topology
→ infer models
→ infer settings
→ execute
```

Power users may explicitly override `/plan`, `/ultraplan`, `/review`, `/split`, `/team`, `autopilot --fast`, etc. Explicit overrides win unless they violate a hard runtime constraint.

## Command invisibility example

User:

> “이거 구조부터 분석해서 제대로 고치고 테스트하고 커밋까지 해줘.”

Internal compilation:

```yaml
compiled_runtime:
  planning: ultraplan
  execution: autopilot
  topology: auto
  implementation_model: opus
  independent_review:
    enabled: true
    model: fable-5.1
  verification:
    tests: true
    regression: true
  git:
    commit: true
```

The user should not need to write this configuration.

## Intent-to-runtime activation

Infer at least:

- work purpose: explain/investigate/design/implement/debug/review/compare/migrate/refactor/release/document/operate
- depth: direct/plan/deep-plan/ultraplan
- completion expectation: answer/artifact/implement/test/commit/PR/deploy
- performance preference: economy/balanced/high-quality/fast/maximum-performance
- required skills
- relevant settings
- review strictness
- cache/context strategy
- long-running checkpointing

## Non-developer language examples

| User language | Runtime interpretation |
|---|---|
| “간단히 고쳐줘” | direct or plan-lite |
| “구조부터 보고 제대로 해줘” | deep plan |
| “근본적으로 해결해줘” | systemic diagnosis + blindspot scan |
| “최대한 빨리 정확하게” | consider `autopilot --fast` |
| “토큰 아끼지 말고 제대로 처리해” | high-resource mode |
| “작업량이 크니 병렬로 처리해” | consider `split` |
| “중요한 작업이니 꼼꼼하게 검토해” | strict Fable review |
| “알아서 끝까지 해줘” | autonomous completion loop |

## Progressive transparency

Default output stays concise: cause, change, verification, completion. Optional surfaces: `/why`, `/status`, `/cost`, `/review`, `/doctor`, `/undo`.
