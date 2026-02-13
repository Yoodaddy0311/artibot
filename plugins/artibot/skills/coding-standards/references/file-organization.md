# File Organization Rules

## Core Principle
**Many small files > few large files**. Organize by feature/domain, not by type.

## Size Limits
| Metric | Target | Maximum | Action |
|--------|--------|---------|--------|
| File length | 200-400 lines | 800 lines | Split by responsibility |
| Function length | 10-30 lines | 50 lines | Extract helpers |
| Nesting depth | 1-2 levels | 4 levels | Early returns, extract |
| Imports | <10 | 15 | Check SRP violation |

## Directory Structure (Feature-Based)
```
src/
  features/
    auth/
      auth.service.ts
      auth.controller.ts
      auth.schema.ts
      auth.test.ts
    users/
      users.service.ts
      users.controller.ts
      users.schema.ts
      users.test.ts
  shared/
    utils/
    types/
    constants/
```

## File Naming
| Type | Convention | Example |
|------|-----------|---------|
| Modules | kebab-case | `user-service.ts` |
| Components | PascalCase | `UserProfile.tsx` |
| Tests | same + suffix | `user-service.test.ts` |
| Types | kebab-case | `user-types.ts` |
| Constants | kebab-case | `api-constants.ts` |
| Config | kebab-case | `database-config.ts` |

## Splitting Signals
A file should be split when:
- It exceeds 400 lines
- It has multiple distinct responsibilities
- Import count exceeds 10
- Test file grows beyond the source file
- Multiple developers frequently edit it (merge conflicts)

## Co-Location Rules
- Tests next to source files (not in separate `__tests__/` tree)
- Types co-located with their consumers
- Constants co-located with their domain
- Shared utilities in `shared/` only when used by 3+ features
