# Routing Table

> Complete routing decision matrix for Artibot orchestration engine.

## Master Routing Table

| User Intent | Complexity | Domain | Auto-Activates | Confidence |
|-------------|-----------|--------|----------------|-----------|
| "analyze architecture" | complex | infrastructure | persona-architect, --ultrathink, Sequential | 95% |
| "create component" | simple | frontend | persona-frontend, Magic, --uc | 90% |
| "implement feature" | moderate | any | domain persona, Context7, Sequential | 88% |
| "implement API" | moderate | backend | persona-backend, --seq, Context7 | 92% |
| "implement UI component" | simple | frontend | persona-frontend, Magic, --c7 | 94% |
| "implement authentication" | complex | security | persona-security, persona-backend, --validate | 90% |
| "fix bug" | moderate | any | persona-analyzer, --think, Sequential | 85% |
| "optimize performance" | complex | backend | persona-performance, --think-hard, Playwright | 90% |
| "security audit" | complex | security | persona-security, --ultrathink, Sequential | 95% |
| "write documentation" | moderate | documentation | persona-scribe, Context7 | 95% |
| "create content strategy" | moderate | marketing | content-marketer agent | 92% |
| "improve iteratively" | moderate | iterative | intelligent persona, --seq | 90% |
| "analyze large codebase" | complex | any | --delegate, domain specialists | 95% |
| "comprehensive audit" | complex | multi | multi-agent parallel | 95% |
| "code review" | moderate | quality | code-reviewer agent | 92% |
| "refactor module" | moderate | quality | persona-refactorer, --seq | 88% |
| "deploy application" | moderate | infrastructure | persona-devops, --validate | 90% |
| "design system" | complex | frontend | persona-architect, persona-frontend, Magic | 90% |
| "write tests" | moderate | testing | persona-qa, tdd-guide agent | 90% |
| "explain concept" | simple | education | persona-mentor, Context7 | 85% |

## Domain Detection Rules

### Frontend Detection
```
Keywords: UI, component, React, Vue, CSS, responsive, accessibility, layout
File patterns: *.jsx, *.tsx, *.vue, *.css, *.scss, *.html
Directories: components/, pages/, layouts/, styles/
```

### Backend Detection
```
Keywords: API, database, server, endpoint, authentication, middleware
File patterns: *.ts, *.js, *.py, *.go, controllers/*, routes/*
Directories: api/, services/, models/, controllers/
```

### Infrastructure Detection
```
Keywords: deploy, Docker, CI/CD, monitoring, scaling, Kubernetes
File patterns: Dockerfile, *.yml, *.yaml, .github/*, terraform/*
Directories: infra/, .github/workflows/, deploy/
```

### Security Detection
```
Keywords: vulnerability, authentication, encryption, audit, compliance
File patterns: *auth*, *security*, *encrypt*, *.pem, *.key
Directories: auth/, security/, middleware/auth/
```

## Complexity Scoring

### Simple (Score: 0.0-0.3)
- Single file operations
- Basic CRUD tasks
- Straightforward queries
- <3 step workflows

### Moderate (Score: 0.3-0.7)
- Multi-file operations (2-10 files)
- Analysis or refactoring tasks
- 3-10 step workflows
- Single domain focus

### Complex (Score: 0.7-1.0)
- System-wide changes (>10 files)
- Architectural decisions
- >10 step workflows
- Multi-domain coordination

## Tool Selection Matrix

| Task Type | Primary Tools | Secondary Tools |
|-----------|--------------|-----------------|
| Search/Find | Grep, Glob | Read |
| Understand | Read, Sequential | Context7 |
| Create | Write, Magic | Context7 |
| Modify | Edit | Sequential |
| Test | Bash, Playwright | Sequential |
| Document | Write, Context7 | Sequential |
| Review | Read, Grep | Sequential |
