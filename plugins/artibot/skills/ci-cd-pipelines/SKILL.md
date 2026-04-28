---
context: fork
user-invocable: false
name: ci-cd-pipelines
description: "GitHub Actions 심화 패턴 — matrix strategy, reusable workflows, composite actions, 시크릿 관리, 캐싱 전략. Use when designing CI/CD pipelines, GitHub Actions workflows, or deployment automation."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: progressive
triggers:
  - "CI/CD"
  - "github actions"
  - "pipeline"
  - "github workflow"
  - "ci workflow"
  - "reusable workflow"
  - "composite action"
  - "파이프라인"
  - "워크플로우"
  - "배포 자동화"
agent: Explore
allowed-tools: [Read, Grep, Glob, Bash]
agents:
  - "devops-engineer"
level1_tokens: 200
level2_tokens: 3500
category: "infrastructure"
risk: safe
version: "1.0.0"
lastVerified: "2026-04-01"
source_hash: 82209682
whenNotToUse: "Non-GitHub CI systems (GitLab CI, Jenkins, CircleCI) or local dev scripts — this skill focuses specifically on GitHub Actions patterns and composable workflow design."
---

# CI/CD Pipelines (GitHub Actions)

## When This Skill Applies
- GitHub Actions 워크플로우 설계 및 최적화
- Matrix strategy로 다중 환경 테스트
- Reusable workflows / Composite actions 설계
- 시크릿 관리 및 환경별 배포 구성
- 빌드 캐싱 및 파이프라인 속도 최적화
- Artifact 관리 및 릴리스 자동화

## Do NOT Use When
- 단순 로컬 빌드 스크립트 (build 커맨드 사용)
- 배포 인프라 자체 설계 (platform-deployment 참조)
- 성능 테스트 파이프라인 (load-testing 참조)

## Core Guidance (Level 1)

### 파이프라인 설계 원칙
1. **Fast Feedback**: 빠른 검사를 먼저 실행 (lint → typecheck → unit → build → integration → e2e)
2. **Fail Fast**: 첫 실패에서 중단, 불필요한 리소스 소비 방지
3. **Deterministic**: 동일 입력 = 동일 결과, 캐시 키에 lock 파일 포함
4. **Secure**: 시크릿은 GitHub Secrets에만, OIDC로 클라우드 인증

### 워크플로우 종류
| 타입 | 트리거 | 용도 |
|------|--------|------|
| **CI** | push, pull_request | 린트, 테스트, 빌드 검증 |
| **CD** | push to main, tag | 스테이징/프로덕션 배포 |
| **Scheduled** | cron | 의존성 감사, 회귀 테스트 |
| **Manual** | workflow_dispatch | 핫픽스 배포, 수동 릴리스 |

### 필수 산출물
1. CI 워크플로우 (린트 + 테스트 + 빌드)
2. CD 워크플로우 (환경별 배포)
3. 캐싱 전략 문서
4. 시크릿 관리 정책

## Detailed Guide (Level 2)

### Step 1: Matrix Strategy

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node-version: [18, 20, 22]
        os: [ubuntu-latest, windows-latest]
        include:
          - node-version: 22
            os: ubuntu-latest
            coverage: true
        exclude:
          - node-version: 18
            os: windows-latest

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm test
      - if: matrix.coverage
        run: npm run test:coverage
```

**Matrix 팁**:
- `fail-fast: false` — 하나의 조합 실패가 다른 조합을 중단시키지 않음
- `include` — 특정 조합에 추가 변수 (예: coverage 리포트)
- `exclude` — 불필요한 조합 제거

### Step 2: Reusable Workflows

**호출 가능한 워크플로우** (`.github/workflows/ci-reusable.yml`):
```yaml
name: Reusable CI
on:
  workflow_call:
    inputs:
      node-version:
        type: string
        default: '20'
      run-e2e:
        type: boolean
        default: false
    secrets:
      NPM_TOKEN:
        required: false

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ inputs.node-version }}
          cache: 'npm'
          registry-url: 'https://registry.npmjs.org'
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - if: inputs.run-e2e
        run: npm run test:e2e
```

**호출하는 워크플로우**:
```yaml
name: PR Check
on: pull_request

jobs:
  ci:
    uses: ./.github/workflows/ci-reusable.yml
    with:
      node-version: '20'
      run-e2e: true
    secrets:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### Step 3: Composite Actions

**`.github/actions/setup-project/action.yml`**:
```yaml
name: 'Setup Project'
description: 'Checkout, setup Node, install dependencies'
inputs:
  node-version:
    description: 'Node.js version'
    default: '20'

runs:
  using: 'composite'
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0

    - uses: actions/setup-node@v4
      with:
        node-version: ${{ inputs.node-version }}
        cache: 'npm'

    - run: npm ci
      shell: bash

    - name: Cache build
      uses: actions/cache@v4
      with:
        path: .next/cache
        key: build-${{ hashFiles('package-lock.json') }}-${{ hashFiles('src/**') }}
        restore-keys: |
          build-${{ hashFiles('package-lock.json') }}-
          build-
```

**사용**:
```yaml
steps:
  - uses: ./.github/actions/setup-project
    with:
      node-version: '22'
  - run: npm test
```

### Step 4: 캐싱 전략

```yaml
# npm 의존성 캐시 (setup-node에 내장)
- uses: actions/setup-node@v4
  with:
    cache: 'npm'

# 커스텀 캐시 (빌드 산출물, Playwright 브라우저 등)
- uses: actions/cache@v4
  with:
    path: |
      ~/.cache/ms-playwright
      .next/cache
    key: ${{ runner.os }}-cache-${{ hashFiles('package-lock.json') }}
    restore-keys: |
      ${{ runner.os }}-cache-
```

**캐시 키 설계 원칙**:
- Lock 파일 해시를 키에 포함 → 의존성 변경 시 자동 갱신
- `restore-keys` 로 부분 매치 → 완전 미스 시 최신 캐시 재사용
- 캐시 크기 제한: 리포지토리당 10GB, 7일 미사용 시 삭제

### Step 5: 시크릿 관리 및 환경별 배포

```yaml
jobs:
  deploy-staging:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - run: npm run deploy
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          API_KEY: ${{ secrets.API_KEY }}

  deploy-production:
    needs: deploy-staging
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://app.example.com
    steps:
      - uses: actions/checkout@v4
      - run: npm run deploy:prod
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

**시크릿 관리 규칙**:
- 환경(Environment)별 시크릿 분리 — staging과 production 시크릿은 별도
- OIDC 인증 사용 — AWS, GCP, Azure에 장기 자격증명 대신 OIDC 토큰
- `GITHUB_TOKEN` 권한 최소화 — `permissions:` 블록으로 명시적 제한
- 시크릿을 로그에 출력하지 않음 — `::add-mask::` 자동 마스킹 확인

### Step 6: Artifact 관리

```yaml
# 빌드 산출물 업로드
- uses: actions/upload-artifact@v4
  with:
    name: build-${{ github.sha }}
    path: dist/
    retention-days: 7

# 다운스트림 job에서 다운로드
- uses: actions/download-artifact@v4
  with:
    name: build-${{ github.sha }}
    path: dist/
```

## Workflow Checklist

```
Progress:
- [ ] Step 1: CI 워크플로우 — lint, typecheck, test, build
- [ ] Step 2: Matrix strategy — 다중 Node/OS 버전 테스트
- [ ] Step 3: Reusable workflow 또는 Composite action 추출
- [ ] Step 4: 캐싱 설정 — 의존성, 빌드 산출물
- [ ] Step 5: 환경별 시크릿 분리 — staging, production
- [ ] Step 6: CD 워크플로우 — 환경별 배포 + 승인 게이트
- [ ] Step 7: Artifact 관리 — 빌드 산출물 보존 정책
```

## Quick Reference

| 패턴 | 용도 | 키워드 |
|------|------|--------|
| Matrix | 다중 환경 병렬 테스트 | `strategy.matrix` |
| Reusable Workflow | 워크플로우 재사용 | `workflow_call` |
| Composite Action | 스텝 묶음 재사용 | `runs.using: composite` |
| Environment | 배포 승인 + 시크릿 분리 | `environment:` |
| OIDC | 클라우드 인증 (무자격증명) | `permissions.id-token: write` |
| Concurrency | 중복 실행 방지 | `concurrency:` |

## Rationalizations

The following table captures common excuses agents make to skip the rigor of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "local tests pass, CI is redundant" | local envs drift — CI is the shared source of truth for every contributor |
| "skip the matrix build, it is slow" | matrix catches OS/runtime differences you cannot reproduce locally |
| "hardcoding the secret is fine for now" | committed secrets survive force-push and leak to forks — use OIDC or encrypted secrets |
| "I will add caching later" | unbounded CI cost is how teams lose pipeline budget — cache dependencies from day one |
| "reusable workflows are overkill" | copy-paste pipelines drift across repos — one fix becomes twenty edits |
