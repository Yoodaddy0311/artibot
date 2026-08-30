# NEXT-SESSION — 크로스머신 핸드오프 (2026-08-30, master f3505fd9)

> 로컬 `.artibot/HANDOFF.md` 는 머신별이라 git 을 타지 않는다. 이 파일이 다른
> 머신으로 넘어가는 요지본이다. 갱신 주체: 세션 종료 시 리더가 `/save` 와 함께.

## 다음 할 일 (우선순위순)

| # | 작업 | 근거 |
|---|---|---|
| P0 | **다음 릴리즈에서 라이브 실증 2건 관측** — ① `wait_for_green` 첫 회차 로그가 `total=N (N>0)` 인지 (f3505fd9 의 persist-credentials 수정 실증. 0건이면 rc=2 가 2분 만에 escalate — 그땐 PAT 토큰 종류가 원인) ② 릴리즈 전 사용자에게 `ARTIBOT_LANDING_PAT` 이 fine-grained **user** PAT 인지 확인 요청 | v4.51.0 ff 착지 실패(#114) 원인 = checkout persist-credentials 기본값이 GITHUB_TOKEN 을 영속 → 인라인 PAT 을 덮음(actions/checkout#181) → push 이벤트 미발생. 수정은 착지했으나 라이브 발화 0회 |
| P1 | **decision-events 실세션 관측** — 슬래시 커맨드 몇 번 후 실제 플러그인 루트 `runtime/decisions/` 에 ndjson 이 쌓이는지. 이어서 `/doctor` Check 7 거짓 그린 처방(S3 게이트가 `current-effort.json#updatedAt` 24h 창 밖이면 기록 0건이어도 pass) + `current-effort.json` mtime(08-23)/updatedAt(07-10) 모순 규명(OneDrive 가설) | 구 P0 의 배선 결함은 d6fdd2fa 로 수정 완료(라이브 재현 recorded:2 실측). 남은 것은 실세션 관측과 Check 7 게이트 자체 |
| P2 | **/split limb 권한 모드 정렬** — limb 세션의 권한 모드 클래스가 리더와 달라 크로스세션 완료 보고가 "Held message" 로 걸림(사용자 수동 승인 요구, 무인 진행 깨짐). `/split open` 이 창을 띄울 때 리더와 같은 모드로 정렬 | 2026-08-28 라이브 런 실측. dispatch 자체는 실작동 확인(2e6c123f 첫 라이브 증거). Deny 해도 무해 — 완료 판정은 git 트레일러가 정본 |
| P3 | stash-ref-isolation 타임아웃 처방(스폰 ~60회가 원인, 무부하 8.4s/30s 상한 — 스폰 축소 vs timeout 상향) + runtime/autopilot 잔여 test-engine-state 계열(런당 +11) 정리 배선 | 부하성 간헐 red, 재발 예측 가능 |

## 2026-08-30 세션 총괄 (519e2529 → f3505fd9, 2커밋 — hee 머신)

d6fdd2fa **decision-events 배선 수정** (D5·D7 이 `state.context` 를 넘겨 기록 100%
skipped 이던 것을 `state.input` 으로 — 실파이프라인 회귀 4건 신설) ·
f3505fd9 **릴리즈 ff 착지 수정** (persist-credentials:false + PR_REMOTE 동반 +
wait_for_green total=0 조기판정 + firewall 게이트 release-landing-credentials 9건).
전체 스위트 11,207 pass / 40 skip (513파일, 커밋 직전 실측). 크로스체크·뮤테이션
대조 전건 통과. 사용자 액션 잔여: PAT 토큰 종류 확인 · `ci/sync-badges-v4.51.0`
브랜치 삭제(파생값이라 체리픽 불필요) · #114 수동 종료(자동 해소 조건 영구 거짓).

## 확정 결정 (재논의 불필요)

## 2026-08-28 세션 총괄 (daf7fec0 → 1665eb48, 8커밋)

afe799a9 decision-trail lost-update 해소 · ec53a208 ndjson 증거 -text 고정 ·
6f4821ac trail 격리 firewall 게이트 · 5d30cf6b PRD 스모크 누출 차단 ·
c898461c **trail explainability Step1+2** (/doctor Check 7 + append-only 판단 기록) ·
3f15663b projectRoot 게이트 + deleteSessionArtifacts + 잔재 2,824건 정리 ·
9a024696 ULTRAPLAN 정본 `.artibot/guides/` 구제 · 1665eb48 GRPO 백필 쌍 은퇴(−956줄)

전체 스위트 11,224 pass / 10 skip (511파일). v4.51.0 설치 검증 결함 0.

## 확정 결정 (재논의 불필요)

- **swarm = 의도적 OFF**: 2026-06-08 머지가 로컬 enabled:true 를 되돌린 게 88일
  정지의 근인이었으나, merged-weights 의 프로덕션 소비자가 0 이라 켜지 않기로
  확정. 켤 조건: ① 라우팅이 병합 가중치를 읽는 소비자 배선 ② 2번째 머신 실사용.
- **ledger→학습 승격 = 형식 불일치로 무가치**: 시범 249건 spread 0.0000.
  잔여 2,670건 전량 거부 완료. 재개 조건: `toExperience` 가 결과 차원
  (duration·testsPass)을 싣게 매핑 수정.
- **GRPO 완전 은퇴**: 데이터·백필 쌍 삭제 완료. 보존 필수: config
  `learning.grpoRouting.{skillPolicy,effortPolicy}` 키(라이브 reader 실재),
  `/dreaming`, learning-diag 의 부재 렌더 경로.

## 함정 (다른 머신에서 주의)

- 오늘 8커밋은 **플러그인 미릴리스** — `claude plugin update` 는 4.51.0 까지만.
  설치본으로 신기능을 쓰려면 리포에서 `sync:local` 또는 다음 릴리스 출하.
- 설치 검증 시 `git show HEAD:` blob 대조는 CRLF 로 전건 거짓 불일치 —
  기준선은 마켓플레이스 클론 체크아웃본. 정본은 `installed_plugins.json`.
- 설계문서를 리포에 커밋할 때 `plugins/artibot/docs/` 는 split-config-firewall
  스캔에 걸린다 — `.artibot/guides/` 가 정본 위치.
- 랜딩은 ci/** 브랜치 → SHA 의 체크런 **7종 전부** 그린 → ff master.
  (워치는 run 1개가 아니라 SHA 체크런 전체를 봐야 한다 — 오늘 1회 게이트에 걸림)

## 백로그 (급하지 않음)

collectExperience 크로스 프로세스 RMW(trail 과 동형) · concurrency 테스트
저빈도 플레이크(0/20 까지만 배제) · docs/PRD 역사적 잔재 4,165건 · aux
`.artibot-new` 는 이 머신에서 병합 완료(다른 머신은 각자 sync 시 정리) ·
CI 리눅스에서의 tmpdir lock 이벤트 거동 미확인.
