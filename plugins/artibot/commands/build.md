---
description: (Artibot) Project build with framework auto-detection and optimization
argument-hint: '[target] e.g. "React 프로젝트 빌드"'
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Task, TaskCreate]
---

# /build

Build projects with automatic framework detection, dependency resolution, and optimization.

## Arguments

Parse $ARGUMENTS:
- `target`: Project directory or `@<path>` reference. Default: current working directory
- `--framework [name]`: Override auto-detection (next, fastapi, vite, remix, astro, django, express, nest)
- `--optimize`: Enable build optimization (tree-shaking, minification, bundle analysis)
- `--dev`: Development build with hot reload
- `--clean`: Clean build artifacts before building

## Execution Flow

1. **Decompose**: Break user request into numbered items. If multiple build targets or options, track each.
2. **Parse**: Resolve target directory. Check for `--clean` flag
3. **Detect Framework**: Scan for framework indicators:
   - `next.config.*` -> Next.js
   - `vite.config.*` -> Vite
   - `pyproject.toml` with `[tool.fastapi]` or `uvicorn` -> FastAPI
   - `angular.json` -> Angular
   - `remix.config.*` -> Remix
   - `astro.config.*` -> Astro
   - `nest-cli.json` -> NestJS
   - `manage.py` -> Django
   - `package.json` scripts -> fallback detection
3. **Resolve Dependencies**: Check lock files, validate versions, install if missing
4. **Build**: Execute framework-specific build command
6. **Optimize** (if `--optimize`): Analyze bundle size, check for unused dependencies, suggest code splitting
7. **Verify**: Confirm build output exists, check for errors/warnings, validate build artifacts. Check every item from step 1.
8. **Report**: Output build summary with metrics and per-item completion evidence

## Framework Build Matrix

| Framework | Build Command | Output Dir | Config File |
|-----------|--------------|------------|-------------|
| Next.js | `next build` | `.next/` | `next.config.*` |
| Vite | `vite build` | `dist/` | `vite.config.*` |
| FastAPI | `uvicorn` check | N/A | `pyproject.toml` |
| Angular | `ng build` | `dist/` | `angular.json` |
| Remix | `remix build` | `build/` | `remix.config.*` |
| NestJS | `nest build` | `dist/` | `nest-cli.json` |

## Output Format

```
BUILD SUMMARY
=============
Framework:   [detected framework]
Command:     [build command executed]
Status:      [SUCCESS|FAILED]
Duration:    [time]
Output:      [output directory]
Warnings:    [count]

ARTIFACTS
---------
[file]: [size]

OPTIMIZATION (if --optimize)
----------------------------
Bundle Size: [total] ([delta from last])
Suggestions: [tree-shaking, code-split, lazy-load candidates]
```
