---
context: fork
user-invocable: false
name: ddd-tactical-design
description: |
  DDD 전술적 설계 - Entity, Value Object, Aggregate, Repository, Domain Service, Domain Event 패턴.
  Auto-activates when: implementing domain models, aggregate design, invariant enforcement.
  Triggers: DDD tactical, aggregate, value object, entity, domain event, DDD 전술, 도메인 모델
platforms: [claude-code]
level: progressive
progressive_disclosure:
  enabled: true
  level1_tokens: 150
  level2_tokens: 2500
triggers:
  - "DDD tactical"
  - "aggregate"
  - "value object"
  - "entity"
  - "domain event"
  - "domain service"
  - "DDD 전술"
  - "도메인 모델"
allowed-tools: [Read, Grep, Glob, Edit]
agents:
  - "architect"
  - "backend-developer"
tokens: "~2.5K"
category: "architecture"
version: "1.0.0"
risk: safe
lastVerified: "2026-03-31"
---

# DDD Tactical Design

## When This Skill Applies
- 도메인 규칙을 코드 구조로 변환
- Aggregate 경계와 불변식(invariant) 설계
- Anemic 모델을 행위 풍부한 도메인 객체로 리팩토링
- Repository 계약과 도메인 이벤트 경계 정의

## Do NOT Use When
- 전략적 경계 정의가 아직 미완
- API 문서화 또는 UI 레이아웃만 필요
- 전체 DDD 복잡도가 정당화되지 않는 간단한 CRUD

## Core Guidance (Level 1)

### 전술 패턴 요약

| Pattern | Purpose | Key Rule |
|---------|---------|----------|
| **Entity** | 식별자로 구분되는 객체 | 동일 ID = 동일 객체 |
| **Value Object** | 속성으로 비교되는 불변 객체 | 동일 속성 = 동일 값 |
| **Aggregate** | 일관성 경계 단위 | 트랜잭션 = Aggregate 단위 |
| **Repository** | Aggregate Root 영속화 | Root 경계에서만 접근 |
| **Domain Service** | Entity에 속하지 않는 도메인 로직 | Stateless 연산 |
| **Domain Event** | 의미 있는 상태 전이 통보 | 과거형 명명 (OrderPlaced) |

### 핵심 원칙
1. **불변식 우선**: 불변식을 먼저 식별하고 Aggregate를 그 주위에 설계
2. **행위 in 도메인 객체**: 컨트롤러가 아닌 도메인 객체에 비즈니스 로직 배치
3. **Aggregate Root 경계**: Repository는 Aggregate Root에서만 존재

## Detailed Guide (Level 2)

### Entity
식별자(ID)로 동등성 판단. 생명주기를 가지며 상태가 변할 수 있다.
```typescript
class Order {
  constructor(
    readonly id: OrderId,
    private status: OrderStatus,
    private items: ReadonlyArray<OrderItem>
  ) {}

  get totalAmount(): Money {
    return this.items.reduce((sum, item) => sum.add(item.price), Money.zero());
  }
}
```

### Value Object
속성으로 동등성 판단. 불변. 검증 로직을 캡슐화.
```typescript
class Money {
  private constructor(readonly amount: number, readonly currency: string) {
    if (amount < 0) throw new Error("Money cannot be negative");
  }

  static of(amount: number, currency: string): Money {
    return new Money(amount, currency);
  }

  add(other: Money): Money {
    if (this.currency !== other.currency) throw new Error("Currency mismatch");
    return Money.of(this.amount + other.amount, this.currency);
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }
}
```

### Aggregate
불변식을 보호하는 일관성 경계. 외부에서는 Aggregate Root를 통해서만 접근.
```typescript
class Order {
  private status: "draft" | "submitted" = "draft";

  submit(itemsCount: number): void {
    if (itemsCount === 0) throw new Error("Order cannot be submitted empty");
    if (this.status !== "draft") throw new Error("Order already submitted");
    this.status = "submitted";
    // Domain Event 발행
  }
}
```

**Aggregate 설계 규칙**:
- 작게 유지 (가능하면 Root + 소수 하위 객체)
- ID로 다른 Aggregate 참조 (직접 참조 금지)
- 하나의 트랜잭션 = 하나의 Aggregate 변경
- Aggregate 간 일관성은 도메인 이벤트로 eventual consistency

### Domain Event
```typescript
interface OrderSubmitted {
  readonly type: "OrderSubmitted";
  readonly orderId: string;
  readonly submittedAt: Date;
  readonly totalAmount: Money;
}
```
- 과거형으로 명명 (OrderSubmitted, PaymentReceived)
- 의미 있는 상태 전이에만 발행
- 다른 Aggregate/서비스의 반응 트리거

### Repository
```typescript
interface OrderRepository {
  findById(id: OrderId): Promise<Order | null>;
  save(order: Order): Promise<void>;
  // Aggregate Root 단위로만 메서드 제공
  // findByItem() 같은 하위 객체 직접 조회 금지
}
```

## Limitations
- 배포 아키텍처를 결정하지 않음
- DB 또는 전송 프로토콜을 선택하지 않음
- 불변식 커버리지를 위해 테스팅 패턴과 병행 필요

## Guidelines
1. 불변식을 먼저 식별하고 Aggregate를 설계
2. Value Object는 불변으로, 검증은 생성 시점에
3. 도메인 행위는 도메인 객체 안에 배치
4. 의미 있는 상태 전이에 도메인 이벤트 발행
5. Repository는 Aggregate Root 경계에서만
6. Aggregate는 작게 유지, ID로 참조
