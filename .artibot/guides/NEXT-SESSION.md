# NEXT-SESSION — 크로스머신 핸드오프 (2026-09-02, master 1d895903 + 2차 커밋)

> 로컬 `.artibot/HANDOFF.md` 는 머신별이라 git 을 타지 않는다. 이 파일이 다른
> 머신으로 넘어가는 요지본이다. 갱신 주체: 세션 종료 시 리더가 `/save` 와 함께.

## 다음 할 일 (우선순위순, 2026-09-02 갱신)

| # | 작업 | 근거 |
|---|---|---|
| P0 | **릴리스** — 버전 범프(4.51.0 → 다음) → push → 마켓플레이스 갱신 → `claude plugin update`. 그 전까지 이번 주 커밋 전부(/save P0 수정 · /split 스크립트 8종+lane-state · supervisor 스파인 · Fable 2티어 · PostCompact 훅)가 **설치본에 없다** — Ontology 창은 지금도 결함 있는 /save 를 쓴다 | blindspot 2026-09-02 1순위. 설치본 cache/4.51.0 = daf7fec, `scripts/split` 0·`lib/supervisor` 0 실측 |
| P0 | **Fable 첫 실스폰 1회 확인** — `Agent(subagent_type="artibot:architect")` 같은 allowlist 8종을 한 번 띄워 실제 5.1 로 뜨는지(스폰 원장 `.artibot/ledger/spawns.ndjson` 의 canonicalModel, 또는 SubagentStart 경고 유무) | 프론트매터 `model: fable` 을 호스트가 받는다는 것은 문서 근거뿐, 실행 미확인 |
| P1 | **PostCompact 훅 라이브 1회 관찰 후 켜기** — `split.contextLifecycle.enabled=true` 로 바꾸기 전에 compact 1회 발생 시 `~/.claude/artibot/post-compact/<stamp>.md` 가 생기는지 | 라이브 compact 0회. 하네스가 PostCompact 를 실제 스폰하는지·systemMessage 가 모델에게 보이는지 미확인 |
| P1 | **다음 /split 캠페인에서 3가지** — ① `lane-state <limb> active|review|done` 를 적기 시작(probe 오탐 억제·watch ops 열이 그때 켜진다) ② 첫 랜딩에 `land --base <라이브 ref>` 를 손 체크리스트와 나란히 ③ `dispatch <limb>` 포인터를 받은 창이 prompt.md 를 따르는지 관찰 | 스크립트 8종 전부 임시 리포 테스트 + Ontology 읽기 전용 스모크까지만 실측 |
| P1 | **/split limb 권한 모드 정렬** — limb 세션의 권한 모드 클래스가 리더와 달라 크로스세션 완료 보고가 "Held message" 로 걸림 | 2026-08-28 라이브 런 실측. 미해결 |
| P2 | vNext 다음 PR 순서: DR01(checkpoint store — suspend 의 `Split-Limb: wip` 와 재개 정본 결정 선행) → CX02(첫 emitter) → DR02(입력이 쌓인 뒤) | `.artibot/guides/vnext-design/ADDENDUM-2026-09-02.md` §6 |
| P2 | stash-ref-isolation 타임아웃 처방 — 단독 27s/30s 상한, 동시 실행 시 33s 로 red(2026-09-02 재현 2회) | 부하성 플레이크, 코드 무관 |

## 2026-09-02 세션 총괄

- 오너 요청 3건: Fable 5.1 활용 감사(제안) · 상위 커맨드 8종 점검(제안 + 문서 오기 정정) · /split 업그레이드(구현). 이후 2차 라운드: Fable 2티어 적용(설계·검수 8종만) · PostCompact 재주입(기본 OFF) · blindspot 후속(lane-state) · 설계 정합성 점검.
- 커밋: f0157141 /save 추적 보호+슬러그 · 219ab8b3 split 1단계 · 1d895903 커맨드 문서 정정 · (2차 커밋은 이 파일과 같은 묶음).
- 보고서(아티팩트) 에 운영자 관점 "어제까지 → 이제" 표와 설계안 대비 구축률(PR 14개 중 구현 4·부분 2·미착수 8)이 있다.
- 확정 결정: 완료 판정은 first-parent 최신 트레일러(ADDENDUM §1, 되돌리지 말 것) · Fable 은 allowlist 8종 + phaseRoles(build opus/review fable) · PostCompact 는 기본 OFF.

## 이전 우선순위 (2026-08-28) — 참고

| # | 작업 | 근거 |
|---|---|---|
| P0 | **decision-events 라이브 발화 검증** — 새 세션에서 `/doctor` Check 7(Explainability Health) 실동작 확인 + 슬래시 커맨드 몇 번 후 `runtime/decisions/` 에 ndjson 이 실제로 쌓이는지 | `c898461c` 의 D5·D7 배선은 테스트로만 검증됨. 폴백 없음 설계라 session_id 가 안 오면 전량 skip — Check 7 의 skipped 카운터가 그걸 드러낸다 |
| P1 | **/split limb 권한 모드 정렬** — limb 세션의 권한 모드 클래스가 리더와 달라 크로스세션 완료 보고가 "Held message" 로 걸림(사용자 수동 승인 요구, 무인 진행 깨짐). `/split open` 이 창을 띄울 때 리더와 같은 모드로 정렬 | 2026-08-28 라이브 런 실측. dispatch 자체는 실작동 확인(2e6c123f 첫 라이브 증거). Deny 해도 무해 — 완료 판정은 git 트레일러가 정본 |
| P2 | stash-ref-isolation 타임아웃 처방(스폰 ~60회가 원인, 무부하 8.4s/30s 상한 — 스폰 축소 vs timeout 상향) + runtime/autopilot 잔여 test-engine-state 계열(런당 +11) 정리 배선 | 부하성 간헐 red, 재발 예측 가능 |

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
