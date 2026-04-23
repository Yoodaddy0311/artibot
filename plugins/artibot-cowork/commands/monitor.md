---
description: (Artibot Cowork) 캠페인 성과 실시간 모니터링 — 로그 패턴 필터, 성과 변동 감지, 알림 워크플로우
argument-hint: '[target] e.g. "campaign Q3 ads" or "SEO keyword rankings" or "email open rates"'
allowed-tools: [Read, Write, WebSearch]
toolset: analytics
---

# /monitor

캠페인 성과 모니터링 워크플로우 설계 및 성과 변동 감지. 실시간 알림 설정과 이상 감지 패턴을 정의합니다.

## Arguments

Parse $ARGUMENTS:
- `target`: Required. 모니터링 대상 (e.g. "ads performance", "SEO rankings", "email campaigns")
- `--metric [name]`: 특정 지표 포커스 (e.g. CTR, CPC, open-rate, impressions)
- `--threshold [value]`: 알림 임계값 (e.g. "CTR<2%", "CPC>5000", "impressions-20%")
- `--interval [period]`: 체크 주기 (hourly / daily / weekly, default: daily)

## 모니터링 타입

### 1. 캠페인 성과 모니터링 (Paid Media)

**감지 패턴:**
```
이상 신호 (alert triggers):
- CTR 급락: CTR < 이전 7일 평균 × 0.7
- CPC 급등: CPC > 이전 7일 평균 × 1.3
- 예산 소진율 이상: 일일 예산의 80% 이전 14:00 소진
- 노출수 급변: ±30% 이상 변동
- ROAS 임계값 이하: ROAS < 설정값
```

**워크플로우:**
```
1. 광고 플랫폼 API에서 일일 성과 수집
2. 베이스라인 대비 이상치 계산
3. 임계값 위반 항목 필터링
4. 원인 가설 생성 (경쟁사 입찰, 타겟 소진, 계절성)
5. 대응 권고사항 작성
6. 알림 전송 (Slack/이메일)
```

**연계 스킬**: [`marketing-analytics`](../skills/marketing-analytics/SKILL.md), [`data-analysis`](../skills/data-analysis/SKILL.md)

### 2. SEO 순위 모니터링

**감지 패턴:**
```
이상 신호:
- 핵심 키워드 순위 하락: 현재 순위 > 이전 주 + 3
- 유기 트래픽 급락: -20% 이상 (7일 이동평균)
- Core Web Vitals 임계값: LCP > 2.5s, CLS > 0.1
- 크롤 에러 증가: 404 또는 5xx 에러 급증
```

**워크플로우:**
```
1. Google Search Console / SEO 툴 API에서 데이터 수집
2. 키워드별 순위 변동 계산
3. 트래픽 감소 랜딩페이지 식별
4. 기술적 이슈 vs. 알고리즘 변화 구분
5. 우선순위 액션 목록 생성
```

**연계 스킬**: [`seo-strategy`](../skills/seo-strategy/SKILL.md), [`technical-seo`](../skills/technical-seo/SKILL.md)

### 3. 이메일 캠페인 모니터링

**감지 패턴:**
```
이상 신호:
- 열람률 하락: 오픈율 < 15% (산업 평균 대비)
- 스팸 신고 증가: 신고율 > 0.1%
- 구독 해지 급증: 해지율 > 0.5%
- 배송 실패: 반송율 > 2%
- 클릭율 급락: CTR < 이전 캠페인 대비 30% 이하
```

**연계 스킬**: [`email-marketing`](../skills/email-marketing/SKILL.md), [`data-analysis`](../skills/data-analysis/SKILL.md)

### 4. 콘텐츠 성과 모니터링

**감지 패턴:**
```
이상 신호:
- 페이지 트래픽 급락: -30% (7일 이동평균)
- 체류시간 하락: avg. session < 1분 (긴 형식 콘텐츠)
- 이탈률 급등: bounce rate > 80%
- 전환 기여 콘텐츠 변화: 전환 콘텐츠 TOP 5 변동
```

**연계 스킬**: [`content-seo`](../skills/content-seo/SKILL.md), [`cro-funnel`](../skills/cro-funnel/SKILL.md)

## 모니터링 대시보드 설계

```
모니터링 대시보드 구성 요청 예시:
"다음 캠페인에 대한 모니터링 대시보드 명세를 만들어줘:
- 캠페인: [캠페인명]
- 모니터링 지표: [지표 목록]
- 알림 임계값: [각 지표별 기준]
- 체크 주기: [hourly/daily/weekly]
- 알림 채널: [Slack/이메일]"
```

## 알림 워크플로우 설계

```
ALERT WORKFLOW
==============
Trigger: [임계값 위반 조건]

Level 1 (Warning):
  Condition: 임계값의 80% 이상
  Action: Slack DM to marketing lead
  Template: "[지표] 주의: 현재 [값], 기준 [임계값]"

Level 2 (Alert):
  Condition: 임계값 위반
  Action: Slack 채널 알림 + 이메일
  Template: "[지표] 이상 감지: [값] | 원인 가설: [가설] | 권고: [액션]"

Level 3 (Critical):
  Condition: 임계값의 150% 이상 위반
  Action: 즉시 에스컬레이션
  Template: "긴급: [캠페인명] [지표] 심각 이상. 즉시 확인 필요."
```

## 루틴 연동

모니터링을 자동화하려면 `routines` 스킬과 연동:

```yaml
routine:
  name: daily-campaign-monitor
  trigger:
    type: schedule
    cron: "0 9 * * *"
    timezone: "Asia/Seoul"
  task: /monitor [target] --interval daily
  output:
    format: slack_message
    channel: "#marketing-alerts"
```

## Execution Flow

1. **Parse**: target, metric, threshold, interval 파싱
2. **Baseline Setup**: 이전 7일/30일 데이터로 베이스라인 설정 가이드
3. **Pattern Definition**: 감지 패턴 + 임계값 명세 생성
4. **Alert Config**: 알림 레벨 + 채널 설정 정의
5. **Dashboard Spec**: 모니터링 대시보드 명세 출력
6. **Routine Integration**: routines 스킬로 자동화 설정 연결

## Output Format

```
MONITORING SETUP: [target]
==========================
Interval:    [period]
Metrics:     [list]

DETECTION PATTERNS
------------------
| Metric | Threshold | Alert Level | Action |
|--------|-----------|-------------|--------|
| [m]    | [t]       | [level]     | [a]    |

ALERT WORKFLOW
--------------
Warning:  [condition + action]
Alert:    [condition + action]
Critical: [condition + action]

DASHBOARD SPEC
--------------
[Visual layout and chart types]

ROUTINE CONFIG
--------------
[YAML for routines integration]

NEXT STEPS
----------
1. [연계 스킬 체인]
```

## Examples

```
/monitor Q3 Google Ads performance
/monitor SEO keyword rankings --metric top-10-keywords --threshold "rank>5"
/monitor email campaigns --metric open-rate --threshold "open<15%" --interval daily
/monitor content performance --interval weekly
```
