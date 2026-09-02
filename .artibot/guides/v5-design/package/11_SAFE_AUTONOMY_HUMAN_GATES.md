# Safe Autonomy & Human Gates

## Long-term direction

Artibot aims for **Fully Autonomous (C)** operation when technology and foundations are mature. Human gates should become rarer, not proliferate.

## Gate philosophy

Ask humans when a **decision** is required, not whenever information is missing.

| Action | Default |
|---|---|
| Read/search/analyze | auto |
| Local reversible edit | auto |
| Tests/build/lint | auto |
| Worktree/branch | auto |
| Local commit | auto when requested by mission |
| PR creation | policy |
| External system write | policy |
| Production deployment | human gate unless pre-authorized |
| Irreversible destructive action | human gate |
| Product/business choice with multiple valid values | human decision |

## ADR exception

At the beginning of ADR work, Artibot may use `questionUserAnswer` for only the genuinely required decision points. An early high-quality human choice can prevent large downstream rework.

### Good question

> “A는 기존 API 호환성을 최우선하고 B는 신규 런타임 단순화를 최우선합니다. 둘을 동시에 완전히 만족시키기 어렵습니다. 어느 쪽이 우선인가요?”

### Bad question

> “이 파일이 어디에 있나요?”

Artibot should inspect the repository itself.

## Decision factors

Consider reversibility, blast radius, evidence quality, product ambiguity, external effect and previous explicit authorization.
