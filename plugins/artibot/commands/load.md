---
description: (Artibot) Load project context with framework detection and dependency mapping
argument-hint: '[path] e.g. "프로젝트 구조 분석"'
allowed-tools: [Read, Glob, Grep, Bash, Task]
toolset: meta
---

# /load

Load and analyze project context for a directory or monorepo. Detects frameworks, maps dependencies, identifies patterns, and builds a working understanding of the codebase. Supports sub-agent delegation for large projects.

## Arguments

Parse $ARGUMENTS:
- `path`: Directory path or `@<path>` reference. Default: current working directory
- `--depth [level]`: `shallow` (structure + config only) | `deep` (full dependency mapping)
- `--focus [area]`: Limit context loading to specific area (e.g., `src/api`, `packages/core`)
- `--delegate`: Enable sub-agent delegation for monorepo/multi-directory scanning
- `--full-context`: (Claude Opus 4.8) 대형 코드베이스 전체를 1M 컨텍스트에 로드

### `--full-context` (Claude Opus 4.8 only)
대형 코드베이스 전체를 1M 컨텍스트에 로드. 프로젝트 전체(<500k 토큰 추정)에 권장.
- 활성화 조건: 모델이 `opus-4-8`이고 `--full-context` 플래그 명시
- 대안: 기본 동작은 선택적 로드 (framework 감지 + 핵심 파일만)
- 토큰 추정: `find src -type f | xargs wc -c` 결과 / 3 (conservative)

## Execution Flow

1. **Parse**: Resolve target path. Determine if monorepo or single project
2. **Structure**: Scan directory tree:
   - Top-level files: package.json, tsconfig.json, .env.example, Dockerfile, etc.
   - Directory structure: src/, lib/, tests/, docs/, etc.
   - Workspace detection: monorepo packages, turborepo/nx config
3. **Framework Detection**: Identify from config files and dependencies:
   - Frontend: React, Vue, Angular, Svelte, Next.js, Nuxt
   - Backend: Express, Fastify, NestJS, Hono
   - Build: Vite, Webpack, Turbopack, esbuild
   - Test: Jest, Vitest, Playwright, Cypress
   - Language: TypeScript, JavaScript, Python, Go
4. **Dependency Mapping** (if `--depth deep`):
   - Package dependencies and versions
   - Internal module dependency graph
   - Circular dependency detection
   - Unused dependency identification
5. **Pattern Recognition**:
   - Code organization patterns (feature-based, layer-based)
   - Naming conventions
   - Import style and module resolution
   - Error handling patterns
6. **Delegate** (if monorepo or `--delegate`):
   - Spawn sub-agents per workspace/package
   - Each sub-agent loads one package context
   - Aggregate results into unified project map
7. **Report**: Output project context summary

## Output Format

```
PROJECT CONTEXT
===============
Path:       [resolved path]
Type:       [single|monorepo]
Language:   [primary language]
Framework:  [detected frameworks]

STRUCTURE
---------
[directory tree with annotations]

FRAMEWORKS & TOOLS
------------------
Runtime:    [node version, etc.]
Framework:  [name + version]
Build:      [tool]
Test:       [tool]
Lint:       [tool]

DEPENDENCIES
------------
Production: [count]
Dev:        [count]
Key deps:   [list of important packages]

PATTERNS
--------
Organization: [feature-based|layer-based|hybrid]
Conventions:  [naming, import style, etc.]

ENTRY POINTS
-------------
[file] -> [purpose]
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 프로젝트 분석 | `/analyze` | 로드된 프로젝트 심층 분석 |
| 2 | 기능 구현 시작 | `/implement` | 프로젝트 기능 구현 착수 |
| 3 | 기능 목록 조회 | `/index` | 사용 가능한 기능 탐색 |
