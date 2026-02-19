---
name: spec-format
description: "SPEC format for structured requirements, acceptance criteria, and technical specifications."
level: 2
triggers: ["spec", "requirements", "specification", "acceptance criteria", "EARS", "user story"]
agents: ["persona-architect"]
tokens: "~3K"
category: "workflow"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# SPEC Format: Structured Requirements & Specifications

## When This Skill Applies
- Writing requirements for new features or systems
- Defining acceptance criteria for user stories
- Creating technical specifications for implementation
- Translating business requirements into testable statements
- Reviewing and improving requirement quality
- Communicating design intent to development teams

## Core Guidance

### 1. EARS Requirement Templates

EARS (Easy Approach to Requirements Syntax) provides five patterns for unambiguous, testable requirements.

#### Ubiquitous Requirements
Always-active behavior with no conditions or triggers.

```
The [system] shall [action].
```

**Examples**:
- The API shall respond within 200ms for all GET requests.
- The system shall encrypt all data at rest using AES-256.
- The application shall support UTF-8 encoding for all text fields.

#### Event-Driven Requirements
Behavior triggered by a specific event or action.

```
When [trigger event], the [system] shall [action].
```

**Examples**:
- When a user submits the login form, the system shall validate credentials against the auth service.
- When a payment fails, the system shall retry the transaction up to 3 times with exponential backoff.
- When a file upload completes, the system shall generate a thumbnail and update the media library.

#### State-Driven Requirements
Behavior that applies only while a specific condition holds.

```
While [state/condition], the [system] shall [action].
```

**Examples**:
- While the system is in maintenance mode, the API shall return 503 for all non-health-check endpoints.
- While the user session is active, the system shall refresh the auth token 5 minutes before expiry.
- While offline, the application shall queue mutations and sync when connectivity is restored.

#### Optional (Feature-Gated) Requirements
Behavior that applies only when a feature or configuration is enabled.

```
Where [feature/configuration], the [system] shall [action].
```

**Examples**:
- Where two-factor authentication is enabled, the system shall require a TOTP code after password verification.
- Where the premium tier is active, the API shall allow up to 10,000 requests per hour.
- Where dark mode is selected, the UI shall apply the dark color scheme to all components.

#### Unwanted Behavior (Negative) Requirements
Behavior the system must prevent or handle.

```
If [unwanted condition], the [system] shall [response].
```

**Examples**:
- If a SQL injection pattern is detected in input, the system shall reject the request and log the attempt.
- If memory usage exceeds 90%, the system shall trigger garbage collection and alert the operations team.
- If an API response exceeds 30 seconds, the system shall timeout and return a 504 Gateway Timeout.

### 2. Complex (Combined) Requirements

Combine patterns for nuanced behavior specifications.

**State + Event**:
```
While [state], when [trigger], the [system] shall [action].
```
- While the user is authenticated, when they access a protected resource, the system shall verify their role permissions.

**Feature + Event**:
```
Where [feature], when [trigger], the [system] shall [action].
```
- Where email notifications are enabled, when an order ships, the system shall send a shipping confirmation email.

**State + Feature + Event**:
```
While [state], where [feature], when [trigger], the [system] shall [action].
```
- While the system is in production mode, where rate limiting is enabled, when a client exceeds 100 requests/minute, the system shall return 429 Too Many Requests.

### 3. Acceptance Criteria Format

Use the Given-When-Then pattern alongside EARS for testable criteria.

```
GIVEN [precondition/context]
WHEN  [action/trigger]
THEN  [expected outcome]
AND   [additional outcome]
```

**Example**:
```
Feature: User Registration

GIVEN a visitor on the registration page
WHEN  they submit a valid email and password (min 8 chars, 1 uppercase, 1 number)
THEN  the system shall create a new user account
AND   send a verification email within 30 seconds
AND   redirect to the email verification pending page

GIVEN a visitor on the registration page
WHEN  they submit an email that already exists
THEN  the system shall display "An account with this email already exists"
AND   not reveal whether the email is registered (timing-safe response)
```

### 4. Technical Specification Template

```markdown
## Feature: [Name]

### Overview
[1-2 sentence description of the feature and its purpose]

### Requirements

#### Functional
- REQ-001: [Ubiquitous] The system shall ...
- REQ-002: [Event] When ..., the system shall ...
- REQ-003: [State] While ..., the system shall ...

#### Non-Functional
- NFR-001: [Performance] The API shall respond within [X]ms at p95
- NFR-002: [Security] The system shall [security requirement]
- NFR-003: [Availability] The service shall maintain [X]% uptime

### Acceptance Criteria
- AC-001: GIVEN ... WHEN ... THEN ...
- AC-002: GIVEN ... WHEN ... THEN ...

### Technical Design
- Architecture: [approach]
- Data model: [entities and relationships]
- API contracts: [endpoints and schemas]
- Dependencies: [external services, libraries]

### Constraints & Assumptions
- [Constraint or assumption with rationale]

### Out of Scope
- [Explicitly excluded items]
```

### 5. Requirement Quality Checklist

Every requirement should be:

| Quality | Test | Bad Example | Good Example |
|---------|------|-------------|--------------|
| **Atomic** | One behavior per statement | "The system shall validate and store data" | "The system shall validate input" + "The system shall store validated data" |
| **Testable** | Can write a pass/fail test | "The system shall be fast" | "The API shall respond within 200ms at p95" |
| **Unambiguous** | One interpretation only | "The system shall handle large files" | "The system shall accept files up to 100MB" |
| **Complete** | Covers all conditions | "When login fails, show error" | "When login fails, the system shall display the error reason and increment the failed attempt counter" |
| **Consistent** | No contradictions | Conflicting timeout values across specs | Single source of truth for all thresholds |
| **Traceable** | Links to source need | Orphan requirement | "REQ-042 (from: USER-STORY-15)" |

### 6. Priority Classification

| Priority | Label | SLA | Decision Rule |
|----------|-------|-----|---------------|
| P0 | Critical | Must have for launch | System cannot function without it |
| P1 | High | Must have for release | Core user journey depends on it |
| P2 | Medium | Should have | Improves experience significantly |
| P3 | Low | Nice to have | Enhancement, can defer |

## Quick Reference

**EARS Patterns**:
```
Ubiquitous:  The [system] shall [action]
Event:       When [trigger], the [system] shall [action]
State:       While [condition], the [system] shall [action]
Optional:    Where [feature], the [system] shall [action]
Negative:    If [unwanted], the [system] shall [response]
Combined:    While + When, Where + When, etc.
```

**Acceptance Criteria**: `GIVEN [context] WHEN [action] THEN [outcome]`

**Quality Gates**: Atomic, Testable, Unambiguous, Complete, Consistent, Traceable
