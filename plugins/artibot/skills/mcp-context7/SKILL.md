---
name: mcp-context7
description: |
  Context7 MCP server workflow for library documentation and framework patterns.
  Auto-activates when: external library docs needed, framework patterns, API reference lookup.
  Triggers: documentation, library, framework, import, package, Context7, official docs, 라이브러리, 프레임워크
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
triggers:
  - "documentation"
  - "library"
  - "framework"
  - "import"
  - "package"
  - "Context7"
  - "official docs"
agents:
  - "backend-developer"
  - "frontend-developer"
tokens: "~2K"
category: "tooling"
---
# MCP: Context7

## When This Skill Applies
- Implementing features with external libraries
- Looking up framework-specific patterns and conventions
- Verifying API signatures, parameters, options
- Finding official best practices for a technology

## Core Guidance

**Workflow**: resolve-library-id -> query-docs -> apply patterns -> cache results

**Step-by-Step**:
1. Detect library need (import statement, framework question, dependency)
2. Call `resolve-library-id` with library name + user query
3. Call `query-docs` with resolved library ID + specific topic
4. Apply patterns with proper version compatibility
5. Cache successful patterns for session reuse

**Usage Rules**:
- Always resolve library ID first, never guess
- Max 3 calls per question; use best result after 3 attempts
- Be specific: include version and topic in queries
- Verify docs match project dependency versions

**Good Queries**: "How to set up JWT auth in Express.js", "React useEffect cleanup examples", "Next.js App Router dynamic routes TypeScript"

**Bad Queries**: "auth", "hooks", "how to code"

**Error Recovery**:
| Failure | Recovery |
|---------|----------|
| Library not found | Broader search terms -> WebSearch fallback |
| Timeout | Cached knowledge -> note limitations |
| Invalid ID | Retry different terms -> WebSearch |
| Version mismatch | Find compatible version -> suggest upgrade |
| Server down | WebSearch for official docs |

## Quick Reference
- Always: resolve-library-id before query-docs
- Max 3 attempts per question
- Cache results within session
- Fallback: WebSearch -> cached knowledge -> built-in knowledge
