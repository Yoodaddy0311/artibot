---
name: library-mermaid
description: "Mermaid diagramming patterns for technical documentation including flowcharts, sequence diagrams, ERDs, and more."
level: 2
triggers: ["mermaid", "diagram", "flowchart", "sequence diagram", "ERD", "class diagram", "Gantt", "mindmap"]
agents: ["persona-architect", "persona-scribe"]
tokens: "~3K"
category: "library"
platforms: [claude-code, gemini-cli, codex-cli, cursor]
---

# Mermaid Diagramming Patterns

## When This Skill Applies
- Creating technical documentation with visual diagrams
- Illustrating system architecture, data flows, or state machines
- Generating entity-relationship diagrams for database design
- Documenting API sequences and interaction patterns
- Building project timelines with Gantt charts
- Creating knowledge maps and decision trees

## Core Guidance

### 1. Diagram Type Selection

| Diagram | Use For | Complexity |
|---------|---------|------------|
| Flowchart | Decision logic, process flows, system overview | Low-Medium |
| Sequence | API calls, service interactions, auth flows | Medium |
| ERD | Database schema, entity relationships | Medium |
| Class | OOP structure, interface hierarchy | Medium-High |
| State | State machines, lifecycle transitions | Medium |
| Gantt | Project timelines, sprint planning | Low |
| Mindmap | Brainstorming, topic exploration | Low |
| C4 (Context/Container) | Architecture overview, system boundaries | High |

### 2. Flowchart Patterns

**Basic Process Flow**:
```mermaid
flowchart TD
    A[Start] --> B{Condition?}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
    C --> E[End]
    D --> E
```

**Subgraph for Grouping**:
```mermaid
flowchart LR
    subgraph Frontend
        A[React App] --> B[API Client]
    end
    subgraph Backend
        C[API Gateway] --> D[Service]
        D --> E[(Database)]
    end
    B --> C
```

**Node Shapes**:
- `[text]` - Rectangle (process)
- `{text}` - Diamond (decision)
- `([text])` - Stadium (terminal)
- `[(text)]` - Cylinder (database)
- `((text))` - Circle (connector)
- `>text]` - Flag (event)

### 3. Sequence Diagram Patterns

**API Request Flow**:
```mermaid
sequenceDiagram
    participant C as Client
    participant A as API Gateway
    participant S as Auth Service
    participant D as Database

    C->>A: POST /api/login
    A->>S: Validate credentials
    S->>D: Query user
    D-->>S: User record
    alt Valid credentials
        S-->>A: JWT token
        A-->>C: 200 OK + token
    else Invalid
        S-->>A: Auth error
        A-->>C: 401 Unauthorized
    end
```

**Key Syntax**:
- `->>` solid arrow (request)
- `-->>` dashed arrow (response)
- `alt/else/end` conditional blocks
- `loop/end` repeated actions
- `par/and/end` parallel actions
- `Note over A,B: text` annotations
- `activate/deactivate` lifeline activation

### 4. Entity-Relationship Diagram

```mermaid
erDiagram
    USER ||--o{ POST : creates
    USER ||--o{ COMMENT : writes
    POST ||--o{ COMMENT : has
    POST }o--|| CATEGORY : belongs_to

    USER {
        uuid id PK
        string email UK
        string name
        timestamp created_at
    }
    POST {
        uuid id PK
        uuid author_id FK
        uuid category_id FK
        string title
        text content
        enum status
    }
```

**Relationship Notation**:
- `||--||` one-to-one
- `||--o{` one-to-many
- `}o--o{` many-to-many
- `||--o|` one-to-zero-or-one

### 5. Class Diagram

```mermaid
classDiagram
    class Repository~T~ {
        <<interface>>
        +findAll() T[]
        +findById(id) T
        +create(data) T
        +update(id, data) T
        +delete(id) void
    }
    class UserRepository {
        -db DatabaseClient
        +findByEmail(email) User
    }
    Repository <|.. UserRepository : implements
```

### 6. State Diagram

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Review : submit
    Review --> Approved : approve
    Review --> Draft : request_changes
    Approved --> Published : publish
    Published --> Archived : archive
    Archived --> [*]
```

### 7. Gantt Chart

```mermaid
gantt
    title Sprint 1 Timeline
    dateFormat YYYY-MM-DD
    section Backend
        API Design       :a1, 2025-01-06, 3d
        Implementation   :a2, after a1, 5d
        Testing          :a3, after a2, 2d
    section Frontend
        UI Mockups       :b1, 2025-01-06, 2d
        Components       :b2, after b1, 4d
        Integration      :b3, after a2, 3d
```

### 8. Mindmap

```mermaid
mindmap
  root((System Design))
    Frontend
      React
      Next.js
      Tailwind CSS
    Backend
      Node.js
      PostgreSQL
      Redis
    Infrastructure
      Docker
      Kubernetes
      CI/CD
```

### 9. Rendering Tips

**Markdown Integration**:
- Use fenced code blocks with `mermaid` language identifier
- GitHub, GitLab, Notion, and VS Code render natively
- For static sites, use `mermaid-cli` or `rehype-mermaid` plugin

**Performance**:
- Keep diagrams under 50 nodes for readability
- Split complex systems into multiple focused diagrams
- Use subgraphs to manage visual complexity
- Prefer left-to-right (`LR`) for wide diagrams, top-down (`TD`) for deep ones

**Accessibility**:
- Add descriptive text before or after diagrams
- Use consistent color themes via `%%{init: {'theme': 'neutral'}}%%`
- Provide alt-text descriptions for rendered images
- Label all edges and connections clearly

**Common Issues**:
- Special characters in labels: wrap in quotes `["Label with (parens)"]`
- Long labels: use line breaks with `<br/>`
- Rendering differences across platforms: test on target platform
- Syntax errors: validate with Mermaid Live Editor (mermaid.live)

## Quick Reference

**Diagram Selection**:
```
Process/logic flow? -> Flowchart
Service interactions? -> Sequence diagram
Database schema? -> ERD
Code structure? -> Class diagram
Lifecycle/states? -> State diagram
Timeline? -> Gantt chart
Brainstorm? -> Mindmap
Architecture? -> C4 with flowchart subgraphs
```

**Direction Options**: `TD` (top-down), `LR` (left-right), `BT` (bottom-top), `RL` (right-left)
