---
context: fork
user-invocable: false
name: fp-refactor
description: |
  함수형 프로그래밍 마이그레이션 패턴 - try-catch→Either, null→Option, callbacks→Task, class DI→Reader.
  Auto-activates when: refactoring to FP patterns, fp-ts migration, functional error handling.
  Triggers: fp refactor, Either, Option, TaskEither, fp-ts, 함수형 리팩토링
platforms: [claude-code]
level: progressive
progressive_disclosure:
  enabled: true
  level1_tokens: 180
  level2_tokens: 3500
triggers:
  - "fp refactor"
  - "Either"
  - "Option"
  - "TaskEither"
  - "fp-ts"
  - "functional programming"
  - "함수형 리팩토링"
  - "함수형 프로그래밍"
allowed-tools: [Read, Grep, Glob, Edit]
agents:
  - "typescript-pro"
  - "refactor-cleaner"
tokens: "~3.5K"
category: "development"
version: "1.0.0"
risk: safe
lastVerified: "2026-03-31"
source_hash: 59d3e5ea
---

# FP Refactor: Imperative → Functional

## When This Skill Applies
- try-catch를 Either/TaskEither로 전환
- null/undefined 체크를 Option으로 전환
- 콜백을 Task로 전환
- 클래스 기반 DI를 Reader로 전환
- 명령형 루프를 함수형 연산으로 전환
- fp-ts 점진적 도입 전략

## Core Guidance (Level 1)

### 핵심 전환 매핑

| Imperative | Functional (fp-ts) | 이유 |
|-----------|-------------------|------|
| try-catch | Either / TaskEither | 타입 시스템이 실패 추적, 합성 가능 |
| null check | Option | null 안전성, 체이닝 가능 |
| callback | Task / TaskEither | 지연 실행, 합성 가능 |
| class DI | Reader | 부수효과 격리, 테스트 용이 |
| for loop | map/filter/reduce | 선언적, 불변 |

### 점진적 도입 원칙
1. 새 코드부터 FP 패턴 적용
2. 경계층에 어댑터 패턴 (toEither, fromNullable)
3. 유틸리티 함수 → 서비스 레이어 → 도메인 순서로 마이그레이션
4. pipe()로 합성, 중간 변수 제거

## Detailed Guide (Level 2)

### try-catch → Either/TaskEither

**Before (Imperative)**:
```typescript
function parseJSON(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error}`);
  }
}
```

**After (Functional)**:
```typescript
import { Either, tryCatch } from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

const parseJSON = (input: string): Either<Error, unknown> =>
  tryCatch(
    () => JSON.parse(input),
    (error) => new Error(`Invalid JSON: ${error}`)
  );
```

**비동기 (TaskEither)**:
```typescript
import { TaskEither, tryCatch } from 'fp-ts/TaskEither';

const fetchUser = (id: string): TaskEither<Error, User> =>
  tryCatch(
    () => fetch(`/api/users/${id}`).then(r => r.json()),
    (error) => new Error(`Fetch failed: ${error}`)
  );
```

### null → Option

**Before**:
```typescript
function getUserEmail(user: User | null): string | null {
  if (!user) return null;
  if (!user.email) return null;
  return user.email;
}
```

**After**:
```typescript
import { Option, fromNullable, chain, map } from 'fp-ts/Option';
import { pipe } from 'fp-ts/function';

const getUserEmail = (user: User | null): Option<string> =>
  pipe(
    fromNullable(user),
    chain(u => fromNullable(u.email))
  );
```

### Composition with pipe

**Before (중첩 호출)**:
```typescript
const result = format(validate(parse(input)));
```

**After (파이프라인)**:
```typescript
const result = pipe(
  input,
  parse,       // string → Either<Error, Data>
  E.chain(validate),  // Data → Either<Error, ValidData>
  E.map(format)       // ValidData → FormattedData
);
```

### 점진적 마이그레이션 전략

**Phase 1 - 경계 어댑터**:
```typescript
// 기존 코드 래핑
const safeParseJSON = (s: string) => E.tryCatch(() => JSON.parse(s), E.toError);
// 기존 코드로 복귀
const result = pipe(safeParseJSON(input), E.getOrElse(() => defaultValue));
```

**Phase 2 - 내부 전환**: 서비스 내부 로직을 Either/Option 체인으로 변환

**Phase 3 - 도메인 전환**: 도메인 모델에서 불변 패턴 + 함수형 타입 사용

### When NOT to Refactor
- 단순 CRUD에 과도한 FP 추상화
- 팀이 FP에 익숙하지 않은 상태에서 전면 전환
- 성능 크리티컬 경로 (FP 추상화 오버헤드 고려)
- 이미 잘 동작하는 안정적 코드

## Guidelines
1. 새 코드에 먼저 적용, 기존 코드는 점진적 마이그레이션
2. pipe() 기반 합성으로 가독성 확보
3. 경계 어댑터로 FP ↔ 명령형 코드 공존
4. Either의 left를 도메인 에러 타입으로 구체화
5. Option.none을 비즈니스 로직 분기에 활용
6. 불필요한 추상화 회피 (YAGNI)

## Rationalizations

The following table captures common excuses agents make to skip idiomatic patterns in this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "Mutable state is faster" | For hot loops the JIT often optimizes immutable updates via structural sharing (Immer, Immutable.js). The real cost is debugging shared mutation — measurable in bug-density studies, not microbenchmarks. |
| "FP is academic, real teams use OOP" | Cats Effect, ZIO, fp-ts, and Effect ship in banks, fintechs, and compilers. The patterns (Either, Option, Task) are the same ones TypeScript's Result types and Rust's ? operator encode. |
| "Monads are scary math" | A monad is just `flatMap` + a constructor — you already use it with Array.flatMap and Promise.then. Naming it doesn't add complexity; it adds composability (do-notation, for-comprehensions). |
| "A plain for-loop is clearer than reduce" | Loops mix iteration, accumulation, and mutation in one scope, making off-by-one and early-exit bugs common. reduce/fold separate the step function from the traversal and are trivially parallelizable. |
| "Side effects are inevitable, why pretend?" | FP doesn't ban effects — it reifies them (IO, Task, Effect) so they're scheduled, testable, and cancellable. "Inevitable" effects that aren't tracked become untestable race conditions. |
