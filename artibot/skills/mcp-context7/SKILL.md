---
name: mcp-context7
description: |
  Context7 MCP server integration for library documentation lookup,
  framework patterns, and best practices retrieval.

  Use proactively when working with external libraries, frameworks,
  or when official documentation patterns are needed.

  Triggers: documentation, library, framework, import, package,
  dependency, official docs, API reference, Context7,
  라이브러리, 프레임워크, 문서, 패키지,
  ライブラリ, フレームワーク, ドキュメント

  Do NOT use for: internal code analysis, debugging,
  or tasks not involving external libraries.
---

# Context7 Integration

> Official docs, real patterns, version-accurate. No hallucinated APIs.

## When This Skill Applies

- Working with external library or framework
- Need official API documentation
- Implementing framework-specific patterns
- Checking version compatibility
- Looking up best practices for a dependency

## Activation Signals

Auto-activate when detecting:
- `import`/`require`/`from`/`use` statements for external packages
- Framework-specific file patterns (*.jsx, *.vue, next.config.*)
- Questions about library APIs or framework conventions
- Package.json/pyproject.toml dependency references

## Workflow

### 1. Library Detection
Scan the code for external library references:
- Package imports in source files
- Dependencies in package.json / pyproject.toml
- Framework configuration files

### 2. ID Resolution
```
resolve-library-id(libraryName, query)
```
- Find the Context7-compatible library ID
- Prioritize by: name match, documentation coverage, reputation

### 3. Documentation Retrieval
```
query-docs(libraryId, specificQuestion)
```
- Ask specific, targeted questions
- Extract relevant code patterns
- Note version constraints

### 4. Implementation
- Apply patterns with proper imports
- Verify version compatibility
- Follow framework conventions

## Usage Rules

- Maximum 3 calls per question to resolve-library-id
- Maximum 3 calls per question to query-docs
- Cache successful lookups for session reuse
- If library not found after 3 attempts, fall back to WebSearch

## Error Recovery

| Error | Recovery |
|-------|----------|
| Library not found | Try broader search terms, then WebSearch |
| Documentation timeout | Use cached knowledge, note limitations |
| Invalid library ID | Retry with different search terms |
| Version mismatch | Find compatible version, suggest upgrade |
| Server unavailable | Fall back to WebSearch + native knowledge |

## Common Library IDs

Frequently used libraries (cache these):
- React: `/facebook/react`
- Next.js: `/vercel/next.js`
- TypeScript: `/microsoft/TypeScript`
- Tailwind: `/tailwindlabs/tailwindcss`
- Express: `/expressjs/express`
- Prisma: `/prisma/prisma`

## Anti-Patterns

- Do NOT guess API signatures without checking docs
- Do NOT assume latest version if project pins a specific version
- Do NOT make multiple redundant calls for the same library
- Do NOT ignore version-specific differences
