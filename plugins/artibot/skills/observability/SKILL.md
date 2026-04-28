---
context: fork
user-invocable: false
name: observability
description: "통합 관측성 가이드 — Prometheus, Grafana, 분산 트레이싱, SLI/SLO, 알림 규칙. Use when setting up monitoring, tracing, alerting, or defining SLIs and SLOs."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: progressive
triggers:
  - "observability"
  - "monitoring"
  - "tracing"
  - "prometheus"
  - "grafana"
  - "jaeger"
  - "SLI"
  - "SLO"
  - "관측성"
  - "모니터링"
  - "트레이싱"
  - "알림 규칙"
agent: Explore
allowed-tools: [Read, Grep, Glob, Bash]
agents:
  - "devops-engineer"
  - "performance-engineer"
level1_tokens: 200
level2_tokens: 4000
category: "infrastructure"
risk: safe
version: "1.0.0"
lastVerified: "2026-04-01"
source_hash: 31f93e7a
whenNotToUse: "Local development debugging or one-off log inspection; do not apply when there is no production service, no persistent metrics store, and no SLO/alerting requirement."
---

# Observability

## When This Skill Applies
- 서비스 모니터링 시스템 구축
- SLI/SLO 정의 및 에러 버짓 관리
- 분산 트레이싱 도입 및 span 전파 설계
- 알림(alert) 규칙 설정 및 온콜 운영
- Prometheus + Grafana 스택 구성

## Do NOT Use When
- 성능 부하 테스트 (load-testing 참조)
- 로그 분석 전용 작업 (ELK/Loki 별도 참조)
- 보안 감사 (security-standards 참조)

## Core Guidance (Level 1)

### 관측성 3대 축
| 축 | 도구 | 목적 |
|----|------|------|
| **Metrics** | Prometheus + Grafana | 시계열 수치 — 요청률, 에러율, 지연시간 |
| **Traces** | Jaeger / Tempo | 분산 요청 흐름 추적 — 병목 식별 |
| **Logs** | Loki / ELK | 구조화된 이벤트 기록 — 디버깅 |

### SLI/SLO 기본 개념
- **SLI** (Service Level Indicator): 측정 가능한 서비스 품질 지표
- **SLO** (Service Level Objective): SLI 목표값 (예: 가용성 99.9%)
- **Error Budget**: 1 - SLO 목표 (예: 0.1% = 월 43.8분 허용 다운타임)

### RED Method (서비스 지표)
- **R**ate: 초당 요청 수
- **E**rrors: 실패한 요청 비율
- **D**uration: 요청 처리 시간 분포

### 필수 산출물
1. SLI/SLO 정의 문서
2. Prometheus 메트릭 수집 설정
3. Grafana 대시보드
4. 알림 규칙 및 에스컬레이션 정책

## Detailed Guide (Level 2)

### Step 1: Prometheus 메트릭 수집

**Node.js (prom-client)**:
```javascript
import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

const register = new Registry();
collectDefaultMetrics({ register });

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// Express 미들웨어
function metricsMiddleware(req, res, next) {
  const end = httpRequestDuration.startTimer({
    method: req.method,
    route: req.route?.path ?? req.path,
  });

  res.on('finish', () => {
    httpRequestsTotal.inc({
      method: req.method,
      route: req.route?.path ?? req.path,
      status_code: res.statusCode,
    });
    end({ status_code: res.statusCode });
  });

  next();
}
```

**prometheus.yml** 스크랩 설정:
```yaml
scrape_configs:
  - job_name: 'app'
    scrape_interval: 15s
    static_configs:
      - targets: ['app:3000']
    metrics_path: '/metrics'
```

### Step 2: SLI/SLO 정의

```yaml
# SLO 정의서 예시
service: payment-api
slos:
  - name: availability
    sli: |
      sum(rate(http_requests_total{status_code!~"5.."}[5m]))
      / sum(rate(http_requests_total[5m]))
    target: 0.999        # 99.9%
    window: 30d

  - name: latency
    sli: |
      histogram_quantile(0.95,
        sum(rate(http_request_duration_seconds_bucket[5m])) by (le)
      )
    target: 0.5          # p95 < 500ms
    window: 30d

  - name: error_budget
    formula: "1 - slo_target"
    monthly_budget_minutes: 43.8   # 30일 * 24시간 * 60분 * 0.001
```

### Step 3: 분산 트레이싱

**OpenTelemetry 설정** (Node.js):
```javascript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: 'http://tempo:4318/v1/traces',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
  serviceName: 'payment-api',
});

sdk.start();
```

**샘플링 전략**:
| 전략 | 설명 | 적합한 경우 |
|------|------|------------|
| Always On | 모든 trace 수집 | 개발/스테이징 |
| Probabilistic | 확률적 샘플링 (예: 10%) | 트래픽이 많은 프로덕션 |
| Rate Limiting | 초당 N개 제한 | 비용 제어 필요 시 |
| Parent-based | 부모 span 결정 따름 | 분산 시스템 일관성 |

**Span 전파 패턴**:
```
[Gateway] --trace_id--> [Auth Service] --trace_id--> [Payment Service]
     |                                                      |
     +--trace_id--> [User Service]              [DB Query span]
```
모든 서비스가 동일한 `trace_id`를 전파해야 요청 흐름을 완전히 추적할 수 있다.

### Step 4: Grafana 대시보드

**RED Dashboard PromQL 예시**:

```promql
# Rate (초당 요청수)
sum(rate(http_requests_total[5m])) by (route)

# Errors (에러율)
sum(rate(http_requests_total{status_code=~"5.."}[5m]))
/ sum(rate(http_requests_total[5m]))

# Duration (p95 응답시간)
histogram_quantile(0.95,
  sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route)
)
```

**대시보드 구성 권장**:
1. **Overview**: 전체 서비스 상태 (초록/노랑/빨강)
2. **RED Metrics**: Rate, Error, Duration 패널
3. **SLO Burn Rate**: 에러 버짓 소진 속도
4. **Infrastructure**: CPU, Memory, Disk, Network

### Step 5: 알림 규칙 설정

```yaml
# Prometheus alerting rules
groups:
  - name: slo-alerts
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status_code=~"5.."}[5m]))
          / sum(rate(http_requests_total[5m])) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "에러율 1% 초과"
          description: "{{ $labels.service }} 에러율: {{ $value | humanizePercentage }}"

      - alert: HighLatency
        expr: |
          histogram_quantile(0.95,
            sum(rate(http_request_duration_seconds_bucket[5m])) by (le)
          ) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "p95 응답시간 1초 초과"

      - alert: ErrorBudgetBurnRate
        expr: |
          slo:error_budget_remaining:ratio < 0.5
        labels:
          severity: warning
        annotations:
          summary: "에러 버짓 50% 이상 소진"
```

**에스컬레이션 정책**:
| 심각도 | 응답 시간 | 알림 채널 | 조치 |
|--------|----------|----------|------|
| Critical | 5분 | PagerDuty + Slack | 즉시 대응, 온콜 호출 |
| Warning | 30분 | Slack #alerts | 확인 및 계획 수립 |
| Info | 다음 업무일 | Slack #monitoring | 백로그 등록 |

## Workflow Checklist

```
Progress:
- [ ] Step 1: 서비스 메트릭 계측 (Prometheus 클라이언트 설정)
- [ ] Step 2: SLI/SLO 정의 — 가용성, 지연시간, 에러율
- [ ] Step 3: 분산 트레이싱 설정 (OpenTelemetry + Jaeger/Tempo)
- [ ] Step 4: Grafana 대시보드 구성 — RED 메트릭, SLO 현황
- [ ] Step 5: 알림 규칙 설정 — 에러율, 지연시간, 에러 버짓
- [ ] Step 6: 에스컬레이션 정책 문서화
- [ ] Step 7: 런북(runbook) 작성 — 알림별 대응 절차
```

## Quick Reference

| 메트릭 유형 | Prometheus 타입 | 용도 |
|------------|----------------|------|
| 요청 수 | Counter | rate() 로 초당 요청 계산 |
| 응답 시간 | Histogram | histogram_quantile() 로 백분위 |
| 동시 연결 | Gauge | 현재 값 직접 조회 |
| 이벤트 크기 분포 | Summary | 클라이언트 사이드 백분위 |

## Rationalizations

The following table captures common excuses agents make to skip the rigor of this skill, paired with factual rebuttals.

| Excuse | Rebuttal |
|--------|----------|
| "logs are enough" | logs show individual events; metrics show distributions and rates |
| "sampling skews the data" | 100% sampling at scale costs more than it reveals — sample intelligently |
| "we will add tracing when we need it" | you need it the moment latency spikes — add it before the incident, not during |
| "SLIs are vanity metrics" | SLIs are the contract with users; without them you cannot prioritize reliability work |
| "alerts cause fatigue" | fatigue comes from bad alerts, not alerts themselves — tune to symptoms, not causes |
