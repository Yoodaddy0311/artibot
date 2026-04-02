# Event Sourcing 패턴

> `ddd-strategic-design` 스킬의 참조 문서. 이벤트 소싱, Event Store, Projection, Saga, CQRS 연계를 다룬다.

## 1. 이벤트 소싱 개요

상태를 직접 저장하는 대신, **상태 변경 이벤트의 시퀀스**를 저장한다. 현재 상태는 이벤트를 순차적으로 재생(replay)하여 도출한다.

```
기존 방식 (CRUD):
  UPDATE orders SET status = 'shipped' WHERE id = 123

이벤트 소싱:
  OrderCreated { orderId: 123, items: [...], total: 50000 }
  PaymentReceived { orderId: 123, amount: 50000 }
  OrderShipped { orderId: 123, trackingNo: 'KR123456' }
```

### 장점
- **완전한 감사 로그**: 모든 상태 변경 기록 보존
- **시간 여행**: 과거 시점의 상태 재현 가능
- **이벤트 기반 통합**: 다른 서비스에 이벤트 발행 용이
- **디버깅**: 문제 시점의 이벤트 시퀀스 재현

### 단점 및 주의사항
- 복잡성 증가: 학습 곡선 높음
- 이벤트 스키마 버전 관리 필요
- 쿼리가 어려움 → CQRS 조합 필수
- 모든 도메인에 적합하지 않음 — Core 서브도메인에만 적용 권장

## 2. Event Store 설계

### 이벤트 스키마

```javascript
// 이벤트 기본 구조
const event = {
  eventId: 'evt_abc123',               // 전역 고유 ID
  aggregateId: 'order_123',            // 집합체 ID
  aggregateType: 'Order',              // 집합체 유형
  eventType: 'OrderShipped',           // 이벤트 유형
  version: 3,                          // 집합체 내 시퀀스 번호
  timestamp: '2026-04-01T09:00:00Z',   // 발생 시점
  data: {                              // 이벤트 페이로드
    trackingNo: 'KR123456',
    carrier: 'CJ대한통운',
  },
  metadata: {                          // 부가 정보
    userId: 'user_456',
    correlationId: 'req_789',
    causationId: 'evt_abc122',
  },
};
```

### Event Store 인터페이스

```javascript
class EventStore {
  /**
   * 이벤트 저장 (낙관적 동시성 제어)
   * @param {string} aggregateId
   * @param {Array} events - 저장할 이벤트 배열
   * @param {number} expectedVersion - 기대하는 현재 버전
   * @throws {ConcurrencyError} 버전 충돌 시
   */
  async append(aggregateId, events, expectedVersion) {
    const currentVersion = await this.getVersion(aggregateId);
    if (currentVersion !== expectedVersion) {
      throw new ConcurrencyError(aggregateId, expectedVersion, currentVersion);
    }

    const versioned = events.map((e, i) => ({
      ...e,
      version: expectedVersion + i + 1,
      timestamp: new Date().toISOString(),
    }));

    await this.store.insertMany(versioned);
    await this.publishToSubscribers(versioned);
  }

  /** 집합체의 전체 이벤트 스트림 조회 */
  async getEvents(aggregateId, fromVersion = 0) {
    return this.store
      .find({ aggregateId, version: { $gt: fromVersion } })
      .sort({ version: 1 });
  }

  /** 집합체 상태 복원 */
  async loadAggregate(aggregateId) {
    const events = await this.getEvents(aggregateId);
    return events.reduce(
      (state, event) => applyEvent(state, event),
      createInitialState()
    );
  }
}
```

### 낙관적 동시성 제어

```
Client A: append(order_123, [Shipped], expectedVersion=2)
Client B: append(order_123, [Cancelled], expectedVersion=2)

Timeline:
  A reads version 2 → prepares Shipped event
  B reads version 2 → prepares Cancelled event
  A writes version 3 → SUCCESS
  B writes version 3 → CONFLICT (current=3, expected=2) → retry or reject
```

`expectedVersion` 검사가 없으면 동시 수정이 이벤트 순서를 꼬이게 만든다. 이는 Event Store의 핵심 안전장치이다.

## 3. Projection 패턴

이벤트 스트림을 읽기 최적화된 뷰(Read Model)로 변환한다.

### Projection 유형

| 유형 | 갱신 방식 | 지연 | 용도 |
|------|----------|------|------|
| **Synchronous** | 이벤트 저장과 동시 | 0 | 강한 일관성 필요 시 |
| **Async (Catch-up)** | 폴링 또는 구독 | 수초 | 일반적인 읽기 뷰 |
| **Replay** | 전체 스트림 재생 | 전체 재구축 | 스키마 변경, 새 뷰 |

### Projection 구현

```javascript
class OrderProjection {
  constructor(readDb) {
    this.readDb = readDb;
    this.handlers = {
      OrderCreated: this.onOrderCreated.bind(this),
      PaymentReceived: this.onPaymentReceived.bind(this),
      OrderShipped: this.onOrderShipped.bind(this),
      OrderCancelled: this.onOrderCancelled.bind(this),
    };
  }

  async handle(event) {
    const handler = this.handlers[event.eventType];
    if (handler) await handler(event);
  }

  async onOrderCreated(event) {
    await this.readDb.insert('orders', {
      id: event.aggregateId,
      status: 'created',
      items: event.data.items,
      total: event.data.total,
      createdAt: event.timestamp,
    });
  }

  async onPaymentReceived(event) {
    await this.readDb.update('orders', event.aggregateId, {
      status: 'paid',
      paidAt: event.timestamp,
    });
  }

  async onOrderShipped(event) {
    await this.readDb.update('orders', event.aggregateId, {
      status: 'shipped',
      trackingNo: event.data.trackingNo,
      shippedAt: event.timestamp,
    });
  }

  async onOrderCancelled(event) {
    await this.readDb.update('orders', event.aggregateId, {
      status: 'cancelled',
      cancelledAt: event.timestamp,
      reason: event.data.reason,
    });
  }
}
```

### Projection 재구축

```javascript
async function rebuildProjection(eventStore, projection, readDb) {
  // 1. 기존 읽기 모델 초기화
  await readDb.truncate(projection.tableName);

  // 2. 전체 이벤트 스트림 재생
  let lastPosition = 0;
  const batchSize = 1000;

  while (true) {
    const events = await eventStore.getAllEvents(lastPosition, batchSize);
    if (events.length === 0) break;

    for (const event of events) {
      await projection.handle(event);
    }

    lastPosition = events[events.length - 1].globalPosition;
  }
}
```

## 4. Saga / Process Manager

여러 집합체에 걸친 비즈니스 프로세스를 이벤트 기반으로 조율한다.

### Saga 패턴 (Choreography)

```
OrderCreated → [Payment Service] → PaymentReceived
                                       ↓
                               [Inventory Service] → ItemReserved
                                                        ↓
                                                [Shipping Service] → OrderShipped
```

각 서비스가 이벤트를 듣고 독립적으로 반응. 중앙 조율자 없음.

### Process Manager (Orchestration)

```javascript
class OrderProcess {
  constructor() {
    this.state = 'INITIATED';
    this.commands = [];
  }

  handle(event) {
    switch (this.state) {
      case 'INITIATED':
        if (event.eventType === 'OrderCreated') {
          this.state = 'AWAITING_PAYMENT';
          this.commands.push({
            type: 'RequestPayment',
            data: { orderId: event.aggregateId, amount: event.data.total },
          });
        }
        break;

      case 'AWAITING_PAYMENT':
        if (event.eventType === 'PaymentReceived') {
          this.state = 'AWAITING_SHIPMENT';
          this.commands.push({
            type: 'ReserveInventory',
            data: { orderId: event.aggregateId, items: event.data.items },
          });
        }
        if (event.eventType === 'PaymentFailed') {
          this.state = 'CANCELLED';
          this.commands.push({
            type: 'CancelOrder',
            data: { orderId: event.aggregateId, reason: 'Payment failed' },
          });
        }
        break;

      case 'AWAITING_SHIPMENT':
        if (event.eventType === 'ItemReserved') {
          this.state = 'COMPLETED';
          this.commands.push({
            type: 'ShipOrder',
            data: { orderId: event.aggregateId },
          });
        }
        break;
    }

    return this.commands.splice(0);
  }
}
```

### 보상 트랜잭션 (Compensating Actions)

| 정방향 액션 | 보상 액션 | 트리거 |
|------------|----------|--------|
| ReserveInventory | ReleaseInventory | PaymentFailed |
| ChargePayment | RefundPayment | ShipmentFailed |
| CreateShipment | CancelShipment | OrderCancelled |

## 5. CQRS 연계

Command Query Responsibility Segregation: 쓰기 모델과 읽기 모델을 분리한다.

```
[Client]
   ├── Command ──→ [Command Handler] ──→ [Event Store] ──→ [Events]
   │                                                          │
   │                                                    [Projection]
   │                                                          │
   └── Query ───→ [Query Handler] ──→ [Read Database] ←──────┘
```

**쓰기 경로**: Command → 도메인 로직 → 이벤트 생성 → Event Store 저장
**읽기 경로**: Query → Read Database (Projection이 구축한 뷰) → 응답

### CQRS 구현 팁
- 읽기 모델은 쿼리 패턴에 최적화된 비정규화 구조
- 쓰기와 읽기 간 **최종 일관성** (eventual consistency) 허용
- 읽기 모델은 언제든 재구축 가능해야 함
- 단순한 도메인에는 CQRS 불필요 — 복잡성 대비 이점이 있을 때만 적용

## 6. 스냅샷 최적화

이벤트가 수천 개 이상 쌓이면 상태 복원이 느려진다. 스냅샷으로 최적화한다.

```javascript
class SnapshotStore {
  async saveSnapshot(aggregateId, state, version) {
    await this.store.upsert({
      aggregateId,
      state: JSON.stringify(state),
      version,
      createdAt: new Date().toISOString(),
    });
  }

  async loadWithSnapshot(aggregateId, eventStore) {
    // 1. 최신 스냅샷 로드
    const snapshot = await this.store.findLatest(aggregateId);

    // 2. 스냅샷 이후 이벤트만 재생
    const fromVersion = snapshot ? snapshot.version : 0;
    const events = await eventStore.getEvents(aggregateId, fromVersion);

    // 3. 상태 복원
    const initialState = snapshot
      ? JSON.parse(snapshot.state)
      : createInitialState();

    return events.reduce(
      (state, event) => applyEvent(state, event),
      initialState
    );
  }
}
```

**스냅샷 전략**:
| 전략 | 조건 | 장점 |
|------|------|------|
| **N번째 이벤트마다** | 매 100개 이벤트 | 구현 단순 |
| **시간 기반** | 매 1시간 | 예측 가능한 복원 시간 |
| **임계값 기반** | 이벤트 수 > N일 때 | 필요한 경우에만 |

**권장**: 이벤트 100개 또는 복원 시간 100ms 초과 시 스냅샷 생성.

## Quick Reference

| 패턴 | 핵심 질문 | 적용 기준 |
|------|---------|----------|
| Event Sourcing | "왜 이 상태가 되었는가?" | 감사, 시간 여행 필요 |
| Projection | "어떻게 조회할 것인가?" | 읽기 최적화 필요 |
| Saga | "여러 서비스를 어떻게 조율하는가?" | 분산 트랜잭션 |
| CQRS | "쓰기와 읽기 요구가 다른가?" | 읽기/쓰기 비대칭 |
| Snapshot | "복원이 너무 느린가?" | 이벤트 수 > 100 |
