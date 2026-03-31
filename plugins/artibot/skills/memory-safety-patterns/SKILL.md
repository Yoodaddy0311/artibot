---
context: fork
user-invocable: false
name: memory-safety-patterns
description: |
  메모리 안전 패턴 - RAII, 소유권, 스마트 포인터, 크로스 언어 리소스 관리, use-after-free/leak 방지.
  Auto-activates when: memory management, resource cleanup, RAII patterns, ownership design.
  Triggers: memory safety, RAII, smart pointer, ownership, use-after-free, 메모리 안전, 리소스 관리
platforms: [claude-code]
level: progressive
progressive_disclosure:
  enabled: true
  level1_tokens: 150
  level2_tokens: 2500
triggers:
  - "memory safety"
  - "RAII"
  - "smart pointer"
  - "ownership"
  - "use-after-free"
  - "memory leak"
  - "메모리 안전"
  - "리소스 관리"
allowed-tools: [Read, Grep, Glob, Bash]
agents:
  - "architect"
tokens: "~2.5K"
category: "development"
version: "1.0.0"
risk: safe
lastVerified: "2026-03-31"
---

# Memory Safety Patterns

## When This Skill Applies
- 메모리 안전한 시스템 코드 작성
- 리소스(파일, 소켓, 메모리) 관리
- use-after-free, 메모리 누수 방지
- RAII 패턴 구현
- 언어 간 리소스 관리 전략 선택
- 메모리 이슈 디버깅

## Do NOT Use When
- 메모리 안전과 무관한 태스크
- GC 언어에서 기본 리소스 관리로 충분한 경우

## Core Guidance (Level 1)

### RAII (Resource Acquisition Is Initialization)
리소스 획득을 객체 생성에, 해제를 객체 소멸에 바인딩. 스코프 종료 시 자동 해제 보장.

### 소유권 모델

| Pattern | Language | Mechanism |
|---------|----------|-----------|
| RAII + Move semantics | C++ | unique_ptr, shared_ptr, RAII guard |
| Ownership + Borrowing | Rust | 소유권 이전, &ref, &mut ref, lifetime |
| GC + Disposable | C#, Java | using/try-with-resources, IDisposable |
| GC + Finalizer | JS, Python | WeakRef, context manager, __del__ |

### 핵심 원칙
1. **단일 소유자**: 리소스는 정확히 하나의 소유자. 소유자가 해제 책임.
2. **Scope-bound lifetime**: 리소스 수명 = 소유 스코프 수명.
3. **Explicit transfer**: 소유권 이전은 명시적 (move, transfer).
4. **Borrowing over copying**: 불필요한 복사 대신 참조 빌림.

## Detailed Guide (Level 2)

### C++: Smart Pointers & RAII
```cpp
// unique_ptr: 단일 소유권
auto resource = std::make_unique<Resource>();
// scope 종료 시 자동 해제

// shared_ptr: 공유 소유권 (reference counting)
auto shared = std::make_shared<Resource>();
auto copy = shared; // ref count = 2
// 마지막 shared_ptr 소멸 시 해제

// RAII guard (파일, mutex 등)
class FileGuard {
  FILE* f;
public:
  FileGuard(const char* path) : f(fopen(path, "r")) {
    if (!f) throw std::runtime_error("open failed");
  }
  ~FileGuard() { if (f) fclose(f); }
  // 복사 금지, 이동만 허용
  FileGuard(const FileGuard&) = delete;
  FileGuard(FileGuard&& other) noexcept : f(other.f) { other.f = nullptr; }
};
```

### Rust: Ownership & Borrowing
```rust
// 소유권 이전 (move)
let s1 = String::from("hello");
let s2 = s1; // s1은 더 이상 유효하지 않음

// 불변 참조 (borrowing)
fn print_len(s: &String) { println!("{}", s.len()); }

// 가변 참조 (한 번에 하나만)
fn push_str(s: &mut String) { s.push_str(" world"); }

// Lifetime annotation
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() { x } else { y }
}
```

### TypeScript/JavaScript: 리소스 패턴
```typescript
// using 패턴 (TC39 Explicit Resource Management)
{
  using file = await openFile("data.txt");
  // scope 종료 시 file[Symbol.dispose]() 자동 호출
}

// 수동 cleanup 패턴
class ConnectionPool {
  private connections: Connection[] = [];

  async acquire(): Promise<Connection> { /* ... */ }

  async release(conn: Connection): Promise<void> { /* ... */ }

  async [Symbol.asyncDispose](): Promise<void> {
    await Promise.all(this.connections.map(c => c.close()));
    this.connections = [];
  }
}
```

### Common Bugs & Fixes

| Bug | Cause | Fix |
|-----|-------|-----|
| Use-after-free | 해제 후 포인터 사용 | RAII, unique_ptr, Rust ownership |
| Double free | 두 번 해제 | 단일 소유자 원칙, move semantics |
| Memory leak | 해제 누락 | RAII guard, disposable pattern |
| Dangling pointer | 유효하지 않은 참조 | Lifetime annotation, weak_ptr |
| Buffer overflow | 경계 미체크 | Bounds checking, safe containers |

### Cross-Language Resource Management
FFI(외국어 함수 인터페이스) 사용 시:
- 할당한 언어에서 해제 (C에서 malloc → C에서 free)
- 래퍼 타입으로 소유권 명확화
- Drop/Dispose/Destructor에서 외부 리소스 해제
- Error path에서도 해제 보장 (finally, defer, RAII)

## Guidelines
1. 리소스에 단일 소유자 원칙 적용
2. RAII/Disposable로 자동 해제 보장
3. 복사보다 참조(borrowing) 선호
4. 소유권 이전은 명시적으로
5. FFI 경계에서 할당/해제 일치
6. Error path에서도 리소스 해제 보장
