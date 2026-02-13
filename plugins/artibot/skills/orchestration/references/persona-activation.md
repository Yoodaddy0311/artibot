# Persona Auto-Activation

## Activation Scoring
- Keyword matching: 30%
- Context analysis: 40%
- User history: 20%
- Performance metrics: 10%

## Trigger Conditions

| Persona | Keywords | Context Triggers | Confidence |
|---------|----------|------------------|------------|
| `architect` | architecture, design, scalability | Multi-module changes, system design | 85% |
| `frontend` | component, responsive, accessibility | UI work, design system, JSX files | 80% |
| `backend` | API, database, service, reliability | Server-side dev, endpoints | 85% |
| `analyzer` | analyze, investigate, root cause | Debugging, troubleshooting | 75% |
| `security` | vulnerability, threat, compliance | Auth work, security scanning | 90% |
| `mentor` | explain, learn, understand | Knowledge transfer, guidance | 70% |
| `refactorer` | refactor, cleanup, technical debt | Code quality improvement | 80% |
| `performance` | optimize, performance, bottleneck | Speed/efficiency work | 85% |
| `qa` | test, quality, validation | Testing, quality gates | 80% |
| `devops` | deploy, infrastructure, automation | CI/CD, monitoring, scaling | 85% |
| `scribe` | document, write, guide | Content creation, docs | 70% |

## Cross-Persona Collaboration

| Combination | Use Case |
|-------------|----------|
| architect + performance | System design with performance budgets |
| security + backend | Secure API development |
| frontend + qa | Accessible, tested UI components |
| analyzer + refactorer | Root cause analysis + code improvement |
| mentor + scribe | Educational documentation |
| devops + security | Infrastructure with compliance |

## Conflict Resolution
- Primary persona leads decisions in its domain
- Project context can override default priorities
- Manual `--persona-*` flags override auto-detection
- Architect persona resolves system-wide conflicts
