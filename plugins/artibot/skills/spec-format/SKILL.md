---
context: fork
name: spec-format
description: "SPEC format for structured requirements, acceptance criteria, and technical specifications. Use when writing requirements, defining acceptance criteria, or creating technical specs."
level: 2
triggers: ["spec", "requirements", "specification", "acceptance criteria", "EARS", "user story"]
agents: ["architect"]
tokens: "~3K"
category: "workflow"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
source_hash: 022945ba
---

# SPEC Format: Structured Requirements & Specifications

## Contents
- [When This Skill Applies](#when-this-skill-applies)
- [Core Guidance](#core-guidance)
- [Feature: [Name]](#feature-name)
- [Quick Reference](#quick-reference)
- [Workflow Checklist](#workflow-checklist)
- [Human Checkpoints](#human-checkpoints)
- [Freedom Levels](#freedom-levels)

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

## Workflow Checklist

Copy this checklist and track progress:

```
Progress:
- [ ] Step 1: Gather business requirements and user stories
- [ ] Step 2: Select EARS pattern(s) for each requirement
- [ ] Step 3: Write requirements using EARS templates
- [ ] Step 4: Write acceptance criteria (Given-When-Then)
- [ ] Step 5: Apply quality checklist (atomic, testable, unambiguous, complete)
- [ ] Step 6: Classify priority (P0-P3)
- [ ] Step 7: Review with stakeholders
```

## Human Checkpoints

### Checkpoint 1: 요구사항 의도 검토 (After Step 3)
**Context**: EARS 패턴을 적용하여 요구사항 문장이 작성된 시점. 문법은 맞더라도 원래 비즈니스 의도를 정확히 반영하지 못할 수 있어 검토가 필요하다.
**Ask**: "작성된 요구사항이 **원래 의도를 정확히 표현**하고 있나요?"
**Options**:
1. Approve — 요구사항을 승인하고 인수 기준 작성으로 진행
2. Revise wording — 표현을 수정하고 재검토
**Default**: 1 (EARS 패턴이 올바르게 적용된 경우)
**Skippable**: No — 승인 또는 수정을 명시적으로 결정해야 함
**Freedom**: LOW

### Checkpoint 2: 인수 기준 완성도 확인 (After Step 4)
**Context**: Given-When-Then 형식으로 인수 기준이 작성된 시점. 누락된 시나리오(엣지 케이스, 오류 케이스)가 있으면 나중에 테스트 커버리지 갭이 발생한다.
**Ask**: "인수 기준이 **테스트 가능하고 모든 시나리오를 포함**하고 있나요?"
**Options**:
1. Proceed — 완성도를 확인하고 우선순위 분류로 진행
2. Add missing scenarios — 누락된 시나리오를 추가한 후 재검토
**Default**: 1 (모든 주요 경로와 오류 케이스가 작성된 경우)
**Skippable**: No — 진행 또는 추가 작성을 명시적으로 결정해야 함
**Freedom**: LOW

### Checkpoint 3: 우선순위 분류 합의 (After Step 6)
**Context**: P0-P3 프레임워크로 각 요구사항의 우선순위가 분류된 시점. 우선순위는 비즈니스 컨텍스트에 따라 달라지므로 이해관계자 합의가 필요하다.
**Ask**: "**우선순위 분류(P0-P3)가 현재 비즈니스 상황**에 맞게 결정되었나요?"
**Options**:
1. Confirm priorities — 우선순위를 확정하고 이해관계자 검토로 진행
2. Reprioritize — 일부 항목의 우선순위를 조정하고 재확인
3. Escalate decision — 비즈니스 오너에게 결정을 위임
**Default**: 1 (팀 내 합의가 이루어진 경우)
**Skippable**: Yes (skip 시 Confirm priorities로 처리)
**Freedom**: MEDIUM

### Checkpoint 4: 이해관계자 최종 승인 (After Step 7)
**Context**: 요구사항·인수 기준·우선순위가 모두 완성되어 이해관계자 검토를 마친 시점. 승인 없이 구현을 시작하면 나중에 재작업이 발생할 수 있다.
**Ask**: "이해관계자가 **현재 스펙 문서를 최종 승인**했나요?"
**Options**:
1. Approved — 승인 완료, 구현 단계로 이관
2. Changes requested — 피드백 반영 후 재검토 요청
**Default**: 1 (검토 미팅 후 명시적 승인을 받은 경우)
**Skippable**: No — 승인 또는 변경 요청을 명시적으로 기록해야 함
**Freedom**: LOW

## Freedom Levels

| Step | Freedom | Guidance |
|------|:-------:|----------|
| Gather requirements | HIGH | Elicitation approach depends on context |
| Select EARS pattern | MEDIUM | 5 patterns defined, but choosing the right one requires judgment |
| Write requirements | LOW | Must follow EARS template syntax exactly |
| Write acceptance criteria | LOW | Given-When-Then format mandatory |
| Quality checklist | LOW | All 6 quality attributes must be verified |
| Classify priority | MEDIUM | P0-P3 framework defined, but business context drives decisions |
| Stakeholder review | HIGH | Review format and cadence are flexible |

## Rationalizations

The following table captures common excuses agents make to skip the rigor of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "specs slow down development" | unspec'd features cost 3x to fix post-launch; spec is the cheap refactor |
| "we are agile, specs are waterfall" | agile specs are lightweight and iterative — SPEC format is one page, not a requirements doc |
| "acceptance criteria are obvious" | if obvious, they are easy to write; if hard to write, they were not obvious |
| "the ticket description is enough" | ticket descriptions drift; SPEC is the durable contract between PM and engineering |
| "I will write the spec after coding" | post-hoc specs are documentation, not requirements — the whole value is up-front alignment |
