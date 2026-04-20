---
description: (Artibot) Interactive quickstart guide with project detection and command suggestions
argument-hint: '[--type node|python|rust|go]'
allowed-tools: [Read, Glob, Bash]
toolset: meta
---

# /quickstart

Interactive first-run guide that detects your project type and suggests the most relevant Artibot commands to get started.

## Arguments

Parse $ARGUMENTS:
- `--type [name]`: Override auto-detection with explicit project type (node, python, rust, go, java, ruby, dotnet)

## Execution Flow

1. **Detect**: Scan the current directory for project config files:
   - `package.json` -> Node.js
   - `pyproject.toml` / `setup.py` / `requirements.txt` -> Python
   - `Cargo.toml` -> Rust
   - `go.mod` -> Go
   - `pom.xml` / `build.gradle` -> Java
   - `Gemfile` -> Ruby
   - `*.csproj` -> .NET
   - `Dockerfile` -> Docker
2. **Suggest**: Show 3 most relevant commands based on project type
3. **Guide**: Display a welcome message with quick tips for getting started

## Output Format

```
=======================================
  Welcome to Artibot!
=======================================

  [Project type] detected ([config file])

  Recommended commands to get started:

    1. /sc load
    2. /sc analyze
    3. /sc implement

  Quick tips:
    - Use /sc help to see all available commands
    - Use /sc load to analyze your project structure
    - Use /sc orchestrate to create agent teams

  Project: [detected type]
=======================================
```

## Next Steps

작업 완료 후 추천 후속 액션:

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 프로젝트 로드 | `/load` | 프로젝트 컨텍스트 전체 로드 |
| 2 | 기능 탐색 | `/index` | 사용 가능한 커맨드/스킬 탐색 |
| 3 | 첫 기능 구현 | `/implement` | 첫 번째 기능 구현 시작 |
