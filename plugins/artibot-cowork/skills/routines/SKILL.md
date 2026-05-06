---
context: fork
name: routines
description: |
  마케팅 자동화 루틴 설계 가이드. Claude Routines로 야간 캠페인 리포트, 주간 콘텐츠
  캘린더 생성, PR 머지 시 문서 업데이트, 경쟁사 모니터링 등 반복 마케팅 워크플로우를
  자동화하는 방법을 설명한다. 스케줄/API/GitHub 트리거별 설정 예시 포함.
  Triggers: routine, automation, schedule, cron, trigger, 루틴, 자동화, 스케줄, 반복 작업
platforms: [claude-cowork, claude-code]
level: 2
triggers:
  - "routine"
  - "automation"
  - "schedule"
  - "cron"
  - "trigger"
  - "루틴"
  - "자동화"
  - "스케줄"
  - "반복 작업"
agents:
  - "orchestrator"
tokens: "~3K"
category: "automation"
---

# 마케팅 자동화 루틴

## When This Skill Applies
- 반복되는 마케팅 작업을 자동화할 때
- 캠페인 성과 리포트를 정기적으로 생성할 때
- 콘텐츠 캘린더를 주기적으로 업데이트할 때
- 외부 이벤트(PR 머지, API 콜백)에 반응하는 워크플로우를 설계할 때
- 경쟁사 변화를 자동 감지하고 싶을 때

## 연관 스킬
- [`marketing-analytics`](../marketing-analytics/SKILL.md) — 성과 데이터 수집/분석
- [`campaign-planning`](../campaign-planning/SKILL.md) — 캠페인 캘린더 설계
- [`data-analysis`](../data-analysis/SKILL.md) — 데이터 파이프라인 정의
- [`competitive-intelligence`](../competitive-intelligence/SKILL.md) — 경쟁사 모니터링

---

## Core Guidance

### Claude Routines 개요

Routines는 Claude가 정해진 조건에서 자동으로 실행하는 반복 워크플로우입니다. 세 가지 트리거 유형을 지원합니다:

| 트리거 타입 | 설명 | 예시 |
|-------------|------|------|
| **Schedule** | 시간 기반 (cron 형식) | 매일 밤 11시 캠페인 리포트 |
| **API** | 외부 HTTP 호출 | 광고 플랫폼 webhook 수신 |
| **GitHub** | 코드 이벤트 | PR 머지 시 문서 업데이트 |

### 루틴 설계 5단계

```
1. 트리거 정의 → 2. 입력 소스 지정 → 3. 작업 명세 → 4. 출력 포맷 → 5. 에러 처리
```

#### Step 1: 트리거 정의

**Schedule 트리거 (cron 형식)**:
```yaml
trigger:
  type: schedule
  cron: "0 23 * * *"        # 매일 23:00
  timezone: "Asia/Seoul"
  description: "야간 캠페인 성과 리포트"
```

**API 트리거**:
```yaml
trigger:
  type: api
  endpoint: /webhooks/campaign-update
  method: POST
  auth: bearer_token
  description: "광고 플랫폼 이벤트 수신"
```

**GitHub 트리거**:
```yaml
trigger:
  type: github
  event: pull_request.merged
  branch: main
  paths: ["marketing/**", "content/**"]
  description: "마케팅 파일 변경 시 문서 업데이트"
```

#### Step 2: 입력 소스 지정

루틴이 읽어올 데이터 소스를 명확히 지정합니다:
- Google Analytics / GA4 API
- 광고 플랫폼 API (Meta Ads, Google Ads)
- 스프레드시트 / 데이터베이스
- RSS 피드 (경쟁사 블로그)
- GitHub 저장소 파일

#### Step 3: 작업 명세

루틴이 수행할 작업을 단계별로 정의합니다:
```
Task: {task_name}
Steps:
  1. [데이터 수집]
  2. [분석/처리]
  3. [콘텐츠 생성]
  4. [출력/전달]
```

#### Step 4: 출력 포맷

| 출력 타입 | 형식 | 전달 방법 |
|----------|------|---------|
| 리포트 | Markdown / PDF | 이메일, Slack |
| 데이터 | CSV / JSON | 저장소, API |
| 콘텐츠 | 초안 텍스트 | 문서, CMS |
| 알림 | 요약 메시지 | Slack webhook |

#### Step 5: 에러 처리

```
Error Policy:
  on_data_unavailable: skip_and_notify
  on_partial_data: proceed_with_warning
  on_api_failure: retry(3) then notify
  notification_channel: [slack_webhook_url]
```

### 루틴 템플릿

전체 루틴 템플릿 목록은 `references/marketing-routine-templates.md`를 참조하세요.

| 루틴 | 트리거 | 시간 |
|------|--------|------|
| 야간 캠페인 리포트 | Schedule | 매일 23:00 |
| 주간 콘텐츠 캘린더 | Schedule | 매주 월 09:00 |
| PR 머지 문서 업데이트 | GitHub | PR 머지 즉시 |
| 경쟁사 모니터링 | Schedule | 매주 수 09:00 |

## Output Format

```
ROUTINE SPEC
============
Name:        [routine name]
Trigger:     [schedule/api/github] — [cron/endpoint/event]
Description: [what this routine does]

TRIGGER CONFIG
--------------
[YAML trigger definition]

TASK FLOW
---------
Step 1: [action] — Input: [source] → Output: [artifact]
Step 2: [action] — Input: [step 1 output] → Output: [artifact]
...

OUTPUT
------
Format:   [format]
Delivery: [how it's delivered]
Sample:   [example output snippet]

ERROR POLICY
------------
[failure handling rules]
```

## Quick Reference

**트리거 타입**: schedule (cron) / api (webhook) / github (event)
**핵심 루틴**: 야간 리포트, 주간 캘린더, PR 문서 업데이트, 경쟁사 모니터링
**템플릿**: `references/marketing-routine-templates.md`
**연계 스킬**: `marketing-analytics`, `campaign-planning`, `data-analysis`, `competitive-intelligence`
