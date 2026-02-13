# Routing Table

## Master Routing Matrix

| Pattern | Domain | Complexity | Auto-Activates | Agent | Delegation Mode | Confidence |
|---------|--------|------------|----------------|-------|----------------|------------|
| "analyze architecture" | infra | complex | architect, --ultrathink, Sequential | architect | Team | 95% |
| "create component" | frontend | simple | frontend, Magic, --uc | frontend-developer | Direct | 90% |
| "implement feature" | any | moderate | domain persona, Context7, Sequential | domain-specific | Sub-Agent | 88% |
| "implement API" | backend | moderate | backend, --seq, Context7 | backend-developer | Sub-Agent | 92% |
| "implement UI" | frontend | simple | frontend, Magic, --c7 | frontend-developer | Direct | 94% |
| "implement auth" | security | complex | security, backend, --validate | security-reviewer | Team | 90% |
| "fix bug" | any | moderate | analyzer, --think, Sequential | domain-specific | Sub-Agent | 85% |
| "optimize performance" | backend | complex | performance, --think-hard, Playwright | backend-developer | Team | 90% |
| "security audit" | security | complex | security, --ultrathink, Sequential | security-reviewer | Team | 95% |
| "write documentation" | docs | moderate | scribe, Context7 | doc-updater | Sub-Agent | 95% |
| "write tests" | testing | moderate | qa, Playwright | tdd-guide | Sub-Agent | 90% |
| "refactor code" | any | moderate | refactorer, Sequential | refactor-cleaner | Sub-Agent | 88% |
| "deploy/CI-CD" | infra | moderate | devops, --validate | devops-engineer | Sub-Agent | 85% |
| "code review" | any | moderate | qa, Sequential | code-reviewer | Sub-Agent | 92% |
| "plan feature" | any | complex | architect, Sequential | planner | Team | 90% |
| "comprehensive audit" | multi | complex | multi-persona, --ultrathink | team-lead | Team | 95% |
| "large-scale migration" | multi | complex | architect, devops, --wave-mode | team-lead | Team | 92% |

## Delegation Mode Decision

| Scope | Mode | Tools | Orchestration |
|-------|------|-------|---------------|
| Single file edit | Direct | Edit, Write | No delegation |
| Focused task (<20 files, 1 domain) | Sub-Agent | Task(subagent_type) | One-way, fire-and-forget |
| Multi-file feature (20+ files, 1-2 domains) | Sub-Agent or Team | Task or TeamCreate | Score-based decision |
| Multi-domain operation (3+ domains) | Team | TeamCreate, TaskCreate, SendMessage | Full coordination |
| Enterprise operation (100+ files) | Team | Full Agent Teams API | Wave + team orchestration |

## Team Mode API Tools

| Tool | When Used | Pattern |
|------|-----------|---------|
| `TeamCreate` | Start of complex operation | Create named team once |
| `Task(type, team_name, name)` | After TeamCreate | Spawn each teammate |
| `TaskCreate` | Work distribution | Add items to shared list |
| `TaskUpdate` | Assignment and progress | Assign, claim, complete |
| `TaskList` | Coordination | View available/blocked tasks |
| `TaskGet` | Before starting work | Read full task details |
| `SendMessage(message)` | Coordination | DM a specific teammate |
| `SendMessage(broadcast)` | Critical announcements | Message all teammates |
| `SendMessage(shutdown_request)` | Completion | Request teammate exit |
| `TeamDelete` | Cleanup | Remove team after done |

## Wave Mode Triggers

| Condition | Threshold | Wave Strategy | Delegation Mode |
|-----------|-----------|---------------|----------------|
| High complexity + many files | complexity >0.7, files >20, ops >2 | adaptive | Team |
| Enterprise scale | files >100, complexity >0.7, domains >2 | enterprise | Team |
| Security audit | production or critical | wave_validation | Team |
| Large refactoring | structural changes, complexity >0.8 | systematic | Team |
| Moderate improvement | complexity 0.5-0.7, single domain | progressive | Sub-Agent |
