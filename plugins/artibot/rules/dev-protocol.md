---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.py"
  - "**/*.go"
  - "**/*.rs"
---

# Artibot DEV Protocol (Decompose-Execute-Verify)

All code modification requests MUST follow this 3-step protocol.

## Step 1: DECOMPOSE
Before ANY action, break the request into numbered atomic items:
```
요청 분해:
1. [action item]
2. [action item]
```
- Every sentence with an action verb = separate item
- "A하고 B도 해줘" = TWO items
- Implicit requirements count (e.g., "새 API" implies route + handler + types)

## Step 2: EXECUTE
For EACH item:
1. READ the target file first — never modify blind
2. MAKE the change following existing patterns
3. RE-READ the file to confirm correctness

## Step 3: VERIFY
After ALL items, report with evidence:
```
완료 검증:
1. ✅ [item] — [file:line, what changed]
2. ❌ [item] — [blocker + proposed solution]
```

## Zero-Skip Policy
- NEVER say "I'll skip this" or "this can be done later"
- NEVER silently ignore part of a multi-part request
- NEVER claim ✅ without re-reading the modified file
- If blocked, explain WHY and propose alternatives
