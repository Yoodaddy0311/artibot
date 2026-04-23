# Marketing Routine Templates

실전 마케팅 자동화 루틴 템플릿 모음. 각 템플릿을 복사하여 필요에 맞게 수정하세요.

---

## Template 1: 야간 캠페인 리포트

**목적**: 매일 밤 모든 활성 캠페인의 성과를 자동 수집하여 팀 슬랙에 요약 리포트 전송

```yaml
routine:
  name: nightly-campaign-report
  description: "매일 밤 11시 캠페인 성과 자동 리포트"
  trigger:
    type: schedule
    cron: "0 23 * * *"
    timezone: "Asia/Seoul"

  inputs:
    - source: google_ads_api
      scope: [impressions, clicks, ctr, cpc, conversions, roas]
      period: today
    - source: meta_ads_api
      scope: [impressions, reach, clicks, cpm, conversions]
      period: today
    - source: google_analytics4
      scope: [sessions, bounce_rate, goal_completions]
      period: today

  task: |
    수집된 오늘의 캠페인 성과 데이터를 분석하여 다음을 포함하는 리포트를 생성하세요:

    1. 오늘 요약 (채널별 주요 지표 vs. 어제 vs. 7일 평균)
    2. 이상 감지 (임계값 위반 항목 하이라이트)
    3. 상위/하위 퍼포밍 캠페인 TOP 3
    4. 내일 권고 액션 1-3가지

    출력 형식: Slack 블록 메시지 (emoji 포함)

  output:
    format: slack_blocks
    channel: "#campaign-daily"
    mention_on_alert: "@channel"
    fallback_email: marketing@company.com

  error_policy:
    on_api_failure: use_cached_data_with_warning
    on_missing_data: skip_channel_with_note
    notification: "#ops-alerts"
```

**예상 리포트 형식:**
```
📊 *캠페인 데일리 리포트 — {날짜}*

| 채널 | 지출 | 전환 | ROAS | vs 어제 |
|------|------|------|------|---------|
| Google Ads | ₩1.2M | 45 | 3.8x | ▲+12% |
| Meta Ads | ₩800K | 28 | 2.9x | ▼-8% |

⚠️ *이상 감지*: Meta 캠페인 CTR 1.2% (기준 2.0% 이하)
🏆 *최고 성과*: 검색_브랜드키워드 ROAS 6.2x
📌 *내일 액션*: Meta 입찰가 10% 상향 검토
```

---

## Template 2: 주간 콘텐츠 캘린더 생성

**목적**: 매주 월요일 아침 다음 주 콘텐츠 캘린더를 자동 초안 생성

```yaml
routine:
  name: weekly-content-calendar
  description: "매주 월요일 다음 주 콘텐츠 캘린더 초안 생성"
  trigger:
    type: schedule
    cron: "0 9 * * 1"
    timezone: "Asia/Seoul"

  inputs:
    - source: content_calendar_sheet
      scope: [past_4_weeks_topics, published_count_by_type, top_performing_posts]
    - source: google_trends
      scope: [trending_topics_in_category]
      category: [your_industry_keywords]
    - source: competitor_rss
      urls: [competitor1_blog_rss, competitor2_blog_rss]
      scope: [recent_topics]

  task: |
    다음 주(월~금) 콘텐츠 캘린더 초안을 생성하세요:

    1. 지난 4주 퍼포먼스 기반 콘텐츠 유형 배분 결정
    2. 트렌딩 토픽 3개 후보 제안
    3. 경쟁사 공백 기회 1개 식별
    4. 일별 콘텐츠 플랜:
       - 제목 후보 (2개/항목)
       - 포맷 (블로그/인스타/링크드인/뉴스레터)
       - 담당자 제안
       - SEO 타겟 키워드

    주의: 기존 캘린더와 중복 주제 피하기

  output:
    format: google_sheets_rows
    sheet_id: "{YOUR_SHEET_ID}"
    tab: "Content Calendar"
    also_notify:
      slack: "#content-team"
      message: "다음 주 콘텐츠 캘린더 초안이 준비되었습니다. 검토 후 확정해주세요."

  error_policy:
    on_api_failure: generate_without_trends_data
    notify_on_complete: true
```

---

## Template 3: PR 머지 시 문서 업데이트

**목적**: 마케팅 관련 코드 변경 시 자동으로 관련 문서와 랜딩페이지 카피 업데이트 초안 생성

```yaml
routine:
  name: pr-merge-doc-update
  description: "마케팅/콘텐츠 파일 PR 머지 시 문서 자동 업데이트"
  trigger:
    type: github
    event: pull_request.merged
    branch: main
    paths:
      - "marketing/**"
      - "content/**"
      - "landing-pages/**"
      - "product/**"

  inputs:
    - source: github_pr
      scope: [changed_files, pr_title, pr_description, diff]
    - source: repository
      paths: ["docs/marketing/**", "README.md", "CHANGELOG.md"]

  task: |
    머지된 PR의 변경 내용을 분석하여:

    1. 변경된 마케팅 자산/기능 파악
    2. 영향받는 문서 목록 식별
    3. 각 문서별 업데이트 초안 생성:
       - 변경 사항 반영 문구
       - 삭제되어야 할 구버전 내용
       - 추가되어야 할 신버전 내용
    4. 랜딩페이지 카피 업데이트 필요 여부 판단
    5. SEO 임팩트 체크 (메타 태그, H1 변경 필요 여부)

  output:
    format: github_pr
    branch: "docs/auto-update-{pr_number}"
    pr_title: "docs: PR #{pr_number} 변경사항 문서 반영"
    reviewer: ["@marketing-lead"]
    also_notify:
      slack: "#marketing-dev"

  error_policy:
    on_no_doc_impact: skip_and_notify_anyway
    on_large_diff: request_human_review
```

---

## Template 4: 경쟁사 모니터링

**목적**: 매주 경쟁사의 주요 변화(신규 콘텐츠, 가격 변경, 기능 출시)를 탐지하여 요약 리포트 생성

```yaml
routine:
  name: competitor-monitoring
  description: "매주 수요일 경쟁사 변화 탐지 및 전략 인사이트 리포트"
  trigger:
    type: schedule
    cron: "0 9 * * 3"
    timezone: "Asia/Seoul"

  inputs:
    - source: competitor_websites
      urls: [competitor1.com, competitor2.com, competitor3.com]
      scope: [new_pages, price_changes, homepage_changes]
    - source: competitor_rss
      feeds: [blog_rss_list]
      scope: [new_posts_since_last_week]
    - source: social_monitoring
      handles: [competitor1_twitter, competitor2_linkedin]
      scope: [posts_last_7_days]
    - source: app_stores
      app_ids: [app1_id, app2_id]
      scope: [rating_changes, new_reviews, version_updates]

  task: |
    지난 7일간의 경쟁사 변화를 분석하여 주간 인텔리전스 리포트를 생성하세요:

    1. 주요 변화 요약 (경쟁사별, 중요도 순)
       - 신규 기능/제품 출시
       - 가격 정책 변화
       - 메시지/포지셔닝 변화
       - 콘텐츠 전략 패턴

    2. 위협 평가 (High/Medium/Low)
    3. 기회 식별: 경쟁사가 다루지 않는 주제/포지셔닝
    4. 권고 대응 전략 2-3가지
    5. 다음 주 주목할 신호 (예상 동향)

  output:
    format: document
    save_to: "reports/competitive-intel/week-{week_number}.md"
    also_notify:
      slack:
        channel: "#competitive-intel"
        summary: "이번 주 경쟁사 변화 요약 리포트가 생성되었습니다."
      email:
        to: [marketing-team@company.com]
        subject: "주간 경쟁사 인텔리전스 — {date}"

  error_policy:
    on_scrape_failure: skip_failed_source_with_note
    min_sources_required: 2
```

---

## Template 5: 월간 마케팅 성과 요약

**목적**: 매월 1일 전월 마케팅 전체 성과 요약 및 다음 달 목표 제안

```yaml
routine:
  name: monthly-marketing-review
  description: "매월 1일 전월 성과 요약 + 이번 달 목표 제안"
  trigger:
    type: schedule
    cron: "0 9 1 * *"
    timezone: "Asia/Seoul"

  inputs:
    - source: all_ad_platforms
      scope: [monthly_performance, budget_utilization, channel_roi]
      period: last_month
    - source: google_analytics4
      scope: [traffic, conversions, revenue, top_pages]
      period: last_month
    - source: email_platform
      scope: [list_growth, avg_open_rate, avg_ctr, unsubscribes]
      period: last_month
    - source: seo_tool
      scope: [keyword_rankings, organic_traffic, new_keywords]
      period: last_month

  task: |
    전월 마케팅 성과를 종합 분석하여 월간 리뷰 리포트를 생성하세요:

    1. 전월 대비 / YoY 주요 지표 비교 테이블
    2. 채널별 ROI 및 기여도 분석
    3. 목표 달성률 (OKR / KPI 기준)
    4. TOP 3 성공 요인, TOP 3 개선 필요 사항
    5. 이번 달 권고 목표 (전월 기반 + 계절성 반영)
    6. 예산 재배분 제안 (저성과 → 고성과 채널)

  output:
    format: presentation_outline
    also_create: executive_summary_500chars
    notify:
      slack: "#marketing-leadership"
      email: [cmo@company.com, marketing-leads@company.com]
```

---

## 루틴 설정 체크리스트

루틴 배포 전 확인 사항:

```
PRE-DEPLOYMENT CHECKLIST
========================
Trigger:
- [ ] cron 표현식 시간대 확인 (Asia/Seoul)
- [ ] 트리거 조건이 의도한 대로 동작하는지 테스트

Inputs:
- [ ] 모든 API 자격증명 설정 완료
- [ ] 데이터 소스 접근 권한 확인
- [ ] 빈 데이터 / 오류 케이스 처리 정의

Task:
- [ ] 프롬프트에 명확한 출력 형식 지정
- [ ] 엣지 케이스 처리 지시 포함
- [ ] 예상 실행 시간 (토큰 사용량) 검토

Output:
- [ ] 출력 채널 (Slack webhook URL, 이메일 등) 설정
- [ ] 저장 위치 (시트, 파일) 권한 확인
- [ ] 알림 수신자 목록 최신화

Error Policy:
- [ ] 각 오류 유형에 대한 폴백 동작 정의
- [ ] 에스컬레이션 채널 지정
- [ ] 오류 무한 루프 방지 (retry 횟수 제한)
```
