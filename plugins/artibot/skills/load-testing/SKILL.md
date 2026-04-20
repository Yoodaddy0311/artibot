---
context: fork
user-invocable: false
name: load-testing
description: "k6 기반 성능/부하 테스트 가이드 — 시나리오 설계, 임계값 설정, CI/CD 통합. Use when designing load tests, stress tests, performance benchmarks, or k6 scripts."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: progressive
triggers:
  - "load test"
  - "performance test"
  - "k6"
  - "stress test"
  - "spike test"
  - "soak test"
  - "부하 테스트"
  - "성능 테스트"
  - "스트레스 테스트"
agent: Explore
allowed-tools: [Read, Grep, Glob, Bash]
agents:
  - "performance-engineer"
  - "devops-engineer"
level1_tokens: 200
level2_tokens: 3500
category: "testing"
risk: safe
version: "1.0.0"
lastVerified: "2026-04-01"
source_hash: 999cc1bf
---

# Load Testing (k6)

## When This Skill Applies
- 새 API 엔드포인트의 성능 기준선 측정
- 배포 전 부하 테스트 실행
- SLA/SLO 기반 성능 임계값 검증
- CI/CD 파이프라인에 성능 게이트 추가
- 병목 지점 식별 및 용량 계획

## Do NOT Use When
- 단순 단위 테스트 또는 E2E 기능 테스트
- 프론트엔드 렌더링 성능 (Lighthouse 사용)
- 네트워크 보안 스캔 (security-standards 참조)

## Core Guidance (Level 1)

### 테스트 시나리오 유형
| 시나리오 | 목적 | VU | 지속시간 |
|---------|------|-----|---------|
| **Smoke** | 기본 동작 확인 | 1-5 | 1분 |
| **Load** | 정상 부하 검증 | 예상 사용자수 | 10-30분 |
| **Stress** | 한계 탐색 | 점진적 증가 | 15-30분 |
| **Spike** | 갑작스러운 급증 대응 | 급격한 증가/감소 | 5-10분 |
| **Soak** | 장시간 안정성 | 정상 부하 | 1-4시간 |

### 핵심 메트릭
- **http_req_duration**: p95 < 500ms, p99 < 1s
- **http_req_failed**: < 1%
- **iteration_duration**: 전체 시나리오 완료 시간
- **vus**: 동시 가상 사용자 수

### 필수 산출물
1. 시나리오별 k6 스크립트
2. 임계값(threshold) 정의
3. CI/CD 통합 워크플로우
4. 성능 기준선 문서

## Detailed Guide (Level 2)

### Step 1: k6 스크립트 기본 구조

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 50 },   // ramp-up
    { duration: '5m', target: 50 },   // steady
    { duration: '2m', target: 0 },    // ramp-down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get('https://api.example.com/endpoint');

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });

  sleep(1);
}
```

### Step 2: 시나리오별 설정

**Smoke Test**:
```javascript
export const options = {
  vus: 1,
  duration: '1m',
  thresholds: {
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(99)<1500'],
  },
};
```

**Stress Test** (단계적 증가):
```javascript
export const options = {
  stages: [
    { duration: '2m', target: 100 },
    { duration: '5m', target: 100 },
    { duration: '2m', target: 200 },
    { duration: '5m', target: 200 },
    { duration: '2m', target: 300 },
    { duration: '5m', target: 300 },
    { duration: '5m', target: 0 },
  ],
};
```

**Spike Test**:
```javascript
export const options = {
  stages: [
    { duration: '1m', target: 10 },
    { duration: '10s', target: 500 },   // spike
    { duration: '3m', target: 500 },
    { duration: '10s', target: 10 },    // recover
    { duration: '3m', target: 10 },
  ],
};
```

### Step 3: 커스텀 메트릭

```javascript
import { Trend, Rate, Counter } from 'k6/metrics';

const loginDuration = new Trend('login_duration');
const loginFailRate = new Rate('login_failures');
const apiCalls = new Counter('api_calls');

export default function () {
  const start = Date.now();
  const res = http.post('https://api.example.com/login', payload);
  loginDuration.add(Date.now() - start);
  loginFailRate.add(res.status !== 200);
  apiCalls.add(1);
}
```

### Step 4: GitHub Actions CI/CD 통합

```yaml
name: Performance Test
on:
  pull_request:
    branches: [main]

jobs:
  k6-load-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install k6
        run: |
          sudo gpg -k
          sudo gpg --no-default-keyring \
            --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
            --keyserver hkp://keyserver.ubuntu.com:80 \
            --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D68
          echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] \
            https://dl.k6.io/deb stable main" | \
            sudo tee /etc/apt/sources.list.d/k6.list
          sudo apt-get update && sudo apt-get install k6

      - name: Run smoke test
        run: k6 run --out json=results.json tests/performance/smoke.js

      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: k6-results
          path: results.json
```

### Step 5: Threshold 기반 품질 게이트

```javascript
export const options = {
  thresholds: {
    // 전역 임계값
    http_req_duration: [
      { threshold: 'p(95)<500', abortOnFail: true },
      { threshold: 'p(99)<1000', abortOnFail: false },
    ],
    http_req_failed: [
      { threshold: 'rate<0.01', abortOnFail: true },
    ],
    // 태그별 임계값
    'http_req_duration{name:login}': ['p(95)<800'],
    'http_req_duration{name:search}': ['p(95)<300'],
  },
};
```

`abortOnFail: true` 설정 시 임계값 초과 시 테스트가 즉시 중단되며, CI에서 non-zero exit code를 반환한다.

## Workflow Checklist

```
Progress:
- [ ] Step 1: Smoke test 작성 — 기본 동작 확인
- [ ] Step 2: Load test 작성 — 정상 부하 시나리오
- [ ] Step 3: Threshold 정의 — p95, p99, 실패율 기준
- [ ] Step 4: 커스텀 메트릭 추가 — 비즈니스 메트릭 측정
- [ ] Step 5: CI/CD 통합 — GitHub Actions 워크플로우
- [ ] Step 6: 기준선 문서화 — 현재 성능 수치 기록
- [ ] Step 7: Stress/Spike/Soak 시나리오 추가 (필요 시)
```

## Quick Reference

| 메트릭 | 좋음 | 주의 | 위험 |
|--------|------|------|------|
| p95 응답시간 | <500ms | 500ms-1s | >1s |
| p99 응답시간 | <1s | 1s-2s | >2s |
| 에러율 | <0.1% | 0.1%-1% | >1% |
| 처리량 | 목표 이상 | 목표의 80% | 목표 미만 |

## Rationalizations

The following table captures common excuses agents make to skip the rigor of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "it works on my machine under load" | your machine is not production scale — load test against production-like infra |
| "we will add load tests after launch" | post-launch load failures are incidents; pre-launch load tests are cheap insurance |
| "load tests do not match real traffic" | that is why you model traffic with ramp-up and think-time — synthetic traffic beats no traffic |
| "one 5-minute run is enough" | soak tests find leaks; spike tests find scaling gaps — one scenario only finds happy-path |
| "p95 is fine if p50 is fast" | p95 is the experience of 1 in 20 users — treat it as a threshold, not a footnote |
