# Symbol System

> Unified symbol and abbreviation reference for token-efficient communication.

## Core Logic & Flow Symbols

| Symbol | Meaning | Example |
|--------|---------|---------|
| `->` | leads to, implies | `auth.js:45 -> security risk` |
| `=>` | transforms to | `input => validated_output` |
| `<-` | rollback, reverse | `migration <- rollback` |
| `<->` | bidirectional | `sync <-> remote` |
| `&` | and, combine | `security & performance` |
| `\|` | separator, or | `react\|vue\|angular` |
| `:` | define, specify | `scope: file\|module` |
| `>>` | sequence, then | `build >> test >> deploy` |
| `therefore` | logical conclusion | `tests fail therefore code broken` |
| `because` | causal reason | `slow because O(n^2) algorithm` |

## Status Indicators

Use text labels for clarity across all environments:

| Label | Meaning | Usage |
|-------|---------|-------|
| PASS | completed, passed | Validation results |
| FAIL | failed, error | Requires immediate action |
| WARN | warning | Needs review |
| INFO | information | Awareness only |
| WIP | in progress | Monitor status |
| WAIT | pending | Scheduled for later |
| CRIT | critical, urgent | Immediate action required |
| TARGET | goal, objective | Execute toward this |

## Domain Tags

| Tag | Domain | Usage |
|-----|--------|-------|
| [PERF] | Performance | Speed, optimization |
| [SEC] | Security | Protection, vulnerabilities |
| [ARCH] | Architecture | System structure |
| [UI] | Frontend | User interface |
| [API] | Backend | Endpoints, services |
| [DB] | Database | Data, queries |
| [TEST] | Testing | Coverage, validation |
| [CONF] | Configuration | Setup, settings |
| [DEPLOY] | Deployment | Release, packaging |

## Standard Abbreviations

### System & Architecture
| Short | Full |
|-------|------|
| cfg | configuration |
| impl | implementation |
| arch | architecture |
| perf | performance |
| ops | operations |
| env | environment |
| deps | dependencies |
| infra | infrastructure |

### Development Process
| Short | Full |
|-------|------|
| req | requirements |
| val | validation |
| test | testing |
| docs | documentation |
| std | standards |
| spec | specification |
| ref | reference |

### Quality & Analysis
| Short | Full |
|-------|------|
| qual | quality |
| sec | security |
| err | error |
| rec | recovery |
| sev | severity |
| opt | optimization |
| cov | coverage |

## Compressed Output Template

```
## [Title]

### Findings
- [Domain] item -> impact (status)
- [Domain] item -> impact (status)

### Metrics
| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| ... | ... | ... | ... |

### Actions
1. [Priority] Action description
2. [Priority] Action description

Next: [immediate next step]
```

## Compression Rules

1. Tables over prose for comparisons (saves 40-60% tokens)
2. Bullet points over paragraphs for lists (saves 20-30%)
3. Abbreviations for repeated technical terms
4. Omit obvious context (e.g., "the file" when file path given)
5. Code blocks only for actionable/runnable code
6. Status labels instead of explanatory sentences
7. One-line summaries before detailed sections
