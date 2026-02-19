# SOLID Principles

> Detailed SOLID reference with TypeScript examples and violation detection.

## Single Responsibility Principle (SRP)

**Rule**: Each class/module/function has exactly one reason to change.

```typescript
// VIOLATION: Mixed concerns
class UserService {
  async createUser(data: UserData) { /* DB logic */ }
  async sendWelcomeEmail(user: User) { /* Email logic */ }
  formatUserReport(user: User) { /* Report logic */ }
}

// CORRECT: Separated responsibilities
class UserRepository {
  async create(data: UserData): Promise<User> { /* DB only */ }
}

class EmailService {
  async sendWelcome(user: User): Promise<void> { /* Email only */ }
}

class UserReportFormatter {
  format(user: User): string { /* Report only */ }
}
```

**Violation signals**: Class >300 lines, mixed I/O + business logic, "and" in class name.

## Open/Closed Principle (OCP)

**Rule**: Open for extension, closed for modification.

```typescript
// VIOLATION: Modify existing code for new types
function calculateDiscount(type: string, price: number) {
  if (type === 'regular') return price * 0.1
  if (type === 'premium') return price * 0.2
  if (type === 'vip') return price * 0.3  // Added later - modifying function
}

// CORRECT: Extend via new implementations
interface DiscountStrategy {
  calculate(price: number): number
}

class RegularDiscount implements DiscountStrategy {
  calculate(price: number) { return price * 0.1 }
}

class PremiumDiscount implements DiscountStrategy {
  calculate(price: number) { return price * 0.2 }
}

// New type = new class, no modification to existing code
class VipDiscount implements DiscountStrategy {
  calculate(price: number) { return price * 0.3 }
}
```

**Violation signals**: Growing switch/if-else chains, frequently modified functions.

## Liskov Substitution Principle (LSP)

**Rule**: Subtypes must be substitutable for their base types without breaking behavior.

```typescript
// VIOLATION: Subtype changes base behavior
class Rectangle {
  setWidth(w: number) { this.width = w }
  setHeight(h: number) { this.height = h }
  area() { return this.width * this.height }
}

class Square extends Rectangle {
  setWidth(w: number) { this.width = w; this.height = w }  // Breaks expectation
}

// CORRECT: Separate types or use composition
interface Shape {
  area(): number
}

class Rectangle implements Shape {
  constructor(private width: number, private height: number) {}
  area() { return this.width * this.height }
}

class Square implements Shape {
  constructor(private side: number) {}
  area() { return this.side * this.side }
}
```

**Violation signals**: Override that throws "not supported", override that restricts input.

## Interface Segregation Principle (ISP)

**Rule**: No client should be forced to depend on methods it doesn't use.

```typescript
// VIOLATION: Fat interface
interface Worker {
  work(): void
  eat(): void
  sleep(): void
  code(): void
}

// CORRECT: Segregated interfaces
interface Workable {
  work(): void
}

interface Feedable {
  eat(): void
}

interface Codeable {
  code(): void
}

class Developer implements Workable, Feedable, Codeable {
  work() { /* ... */ }
  eat() { /* ... */ }
  code() { /* ... */ }
}
```

**Violation signals**: Empty method implementations, "not applicable" throws.

## Dependency Inversion Principle (DIP)

**Rule**: Depend on abstractions, not concretions.

```typescript
// VIOLATION: Direct dependency on concretion
class UserService {
  private db = new PostgresDatabase()  // Tight coupling
  async getUser(id: string) {
    return this.db.query('SELECT * FROM users WHERE id = $1', [id])
  }
}

// CORRECT: Depend on abstraction
interface UserRepository {
  findById(id: string): Promise<User | null>
}

class UserService {
  constructor(private repo: UserRepository) {}  // Injected abstraction
  async getUser(id: string) {
    return this.repo.findById(id)
  }
}

// Implementation separate from business logic
class PostgresUserRepository implements UserRepository {
  async findById(id: string) { /* Postgres-specific */ }
}
```

**Violation signals**: `new` in business logic, import of infrastructure in domain layer.

## Quick Detection Checklist

| Principle | Check | Violation Signal |
|-----------|-------|-----------------|
| SRP | Does it have one reason to change? | Multiple unrelated methods |
| OCP | Can you add behavior without modifying? | Growing switch/if chains |
| LSP | Can subtypes substitute base? | Override changes semantics |
| ISP | Are all interface methods used? | Empty implementations |
| DIP | Do you depend on abstractions? | `new` in business logic |
