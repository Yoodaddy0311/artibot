# SOLID Principles

## Single Responsibility (SRP)
Each class/function has ONE reason to change.

```typescript
// WRONG: Mixed responsibilities
class UserService {
  createUser(data) { /* ... */ }
  sendEmail(user) { /* ... */ }
  generateReport(user) { /* ... */ }
}

// CORRECT: Separated concerns
class UserService { createUser(data) { /* ... */ } }
class EmailService { sendEmail(user) { /* ... */ } }
class ReportService { generateReport(user) { /* ... */ } }
```

## Open/Closed (OCP)
Open for extension, closed for modification.

```typescript
// CORRECT: Strategy pattern for extension
interface PaymentStrategy { process(amount: number): Promise<Result> }
class StripePayment implements PaymentStrategy { /* ... */ }
class PayPalPayment implements PaymentStrategy { /* ... */ }
// Add new payment: create new class, no existing code changes
```

## Liskov Substitution (LSP)
Subtypes must work wherever base types are expected.
- Preconditions: Subtypes cannot strengthen
- Postconditions: Subtypes cannot weaken
- Invariants: Subtypes must preserve

## Interface Segregation (ISP)
No client should depend on methods it does not use.

```typescript
// WRONG: Fat interface
interface Worker { code(); test(); deploy(); manage(); }

// CORRECT: Segregated
interface Coder { code() }
interface Tester { test() }
interface Deployer { deploy() }
```

## Dependency Inversion (DIP)
Depend on abstractions, not concretions.

```typescript
// WRONG: Direct dependency
class OrderService { private db = new PostgresDB() }

// CORRECT: Abstraction
class OrderService {
  constructor(private db: Database) {}
}
```

## Violation Detection
| Principle | Smell | Fix |
|-----------|-------|-----|
| SRP | Class >300 lines, multiple "and" in name | Extract classes |
| OCP | Switch statements on type | Strategy/Plugin pattern |
| LSP | Type checks in consuming code | Redesign hierarchy |
| ISP | Unused method implementations | Split interfaces |
| DIP | `new` keyword in business logic | Inject dependencies |
