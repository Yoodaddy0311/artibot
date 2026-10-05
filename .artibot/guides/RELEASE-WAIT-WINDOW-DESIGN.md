# 릴리스 배지 착지 대기창 설계 (#121 재발 방지)

작성일: 2026-10-05 · 개정 1회(감사 반영) · 상태: **구현 완료(2026-10-05), 라이브 미검증** — 변경 내역은 §8
기준: master `5a3bb327` (태그 `v4.71.2` = `bc98327a`)
관련: `VERIFICATION-ECONOMICS-DESIGN.md` §3.0 · 이슈 #121(2026-10-05 00:41 KST 수동 착지 후 종료)

이 문서는 `.github/workflows/release.yml`의 `wait_for_green` 대기 한도를 고치는 설계다. 워크플로·테스트는 이 문서에서 바꾸지 않았다. 측정은 2026-10-05 01:15~01:30 KST 기준이며 재현 명령을 적었다. 확인하지 못한 것은 "미확인"으로 남겼다. 초안은 과거 5건의 실패를 시간 초과로 추정했으나 Fable 감사가 로그로 반증했고(§1), 그에 맞춰 문제 서술과 근거를 고쳤다.

## 1. 문제

릴리스 후 배지 동기화 커밋(`ci/sync-badges-vX.Y.Z`)을 master에 넣기 전에 `wait_for_green`이 그 SHA의 **모든 체크 런**이 끝나기를 기다린다. 한도는 40회 × 15초 = **10분**이다.

| 사실 | 값 | 등급 | 재현 |
|---|---|---|---|
| 한도 | `seq 1 40`, `sleep 15` = 10분 | 실측 | `release.yml:798-799` |
| 대기 대상 | 필수가 아닌 Windows 레그 포함 전 체크 런(`pending` = `status != completed` 전수) | 실측 | `release.yml:821` |
| 의도된 결정 | 필수 4개 이름을 복사하지 않고 푸시는 브랜치 보호가 판정 | 실측 | `release.yml:771-777` 주석 |
| v4.71.2 결과 | 40회 폴링 후 마지막 `total=7 pending=1 failed=0` → 이슈 #121(15:22Z). 체크는 이후 전부 success | 실측 | job 111464648728 로그, `gh issue view 121` |
| Windows 잡 소요(첫 시도, push 런 45건, 제 집계 표본, 2026-09-29~10-04, 완료된 잡만) | 최소 7.78 / 중앙 11.28 / p90 13.30 / **최대 13.63분**, 재시도 0건 | 실측 | `gh api repos/.../actions/runs/<id>/jobs`의 `started_at`~`completed_at` |
| 감사관 재측정(09-28~10-04, 실패 2건 제외, n=58) | 최소 7.78 / 중앙 11.15 / p90 13.29 / 최대 13.63 | 감사 실측 | 같은 방법, 표본 구간이 더 넓음 |
| 일별 중앙값 | 10.82(09-29, n=21) → 11.65(09-30, n=13) → 13.30(10-02, n=7) → 13.42(10-04, n=4) | 실측 | 같은 표본. 백분위 관례에 따라 ±0.1분 차이가 난다 |
| 추세의 실재성 | master와 `ci/**` 양쪽에서 모두 상승(브랜치 구성 변화 때문이 아님) | 감사 실측 | headBranch로 분리 |

**한도가 가동된 것은 09-28 이후 단 1회이고, 그 1회가 실패했다.** v4.67.0·v4.70.1·v4.71.0·v4.71.1의 릴리스는 착지 스텝이 변경 없음으로 건너뛰어(skipped) 대기창이 돌지 않았다(감사 실측, 릴리스 run 30건 중 10건의 잡을 열어 확인). 다음에 배지 변경이 생기면 Windows 중앙값(13.3분)이 한도(10분)를 넘으므로 **결정적으로 다시 초과한다**.

**과거 5건은 시간 초과가 아니었다(초안 오류 정정).** 릴리스 run의 대기 로그 마지막 폴링 줄을 이슈별로 추출한 결과는 다음과 같다. 감사관이 5건을 추출했고 제가 #115·#119 두 건을 직접 재확인했다.

| 이슈 | 폴링 수 | 마지막 폴링 | 판정 |
|---|---:|---|---|
| #115 (v4.53.0, 09-03) | 7 | `total=7 pending=2 failed=2` | 빨간 체크 |
| #117 (v4.58.0, 09-10) | 1 | `total=7 pending=5 failed=1` | 빨간 체크(감사 보고) |
| #118 (v4.59.0, 09-11) | 2 | `total=7 pending=1 failed=3` | 빨간 체크(감사 보고) |
| #119 (v4.60.0, 09-11) | 20 | `total=7 pending=0 failed=1` | 빨간 체크 |
| #120 (v4.62.0, 09-14) | 8 | `total=7 pending=3 failed=1` | 빨간 체크(감사 보고) |
| **#121 (v4.71.2, 10-05)** | **40** | `total=7 pending=1 failed=0` | **시간 초과 — 첫 사례** |

여섯 이슈(와 체크 0건 인증 사례인 #114)의 **본문이 같은 문장**이라 이슈만 봐서는 빨간 체크와 시간 초과를 구분할 수 없다(`release.yml:857-861`이 `wait_rc != 0` 하나로 묶는다). 앞의 5건에서 **무엇이 빨갛게 됐는지는 이번에 조사하지 않았다 — 미확인**. 배지 동기화 브랜치의 체크가 5번 실패한 것은 별개의 문제일 수 있다.

**두 구현이 어긋나 있다.** 같은 계약의 JS 포트 `lib/git/batch-landing.js`는 2026-09-28(커밋 `1b4fbc41`)에 `WAIT_FOR_GREEN_ATTEMPTS = 80`(20분)으로 올렸고 주석이 "release.yml의 40은 Windows 잡보다 앞선 값"이라고 적고 있다. `release.yml`만 갱신되지 않았다. 그 80도 방금 측정한 최대 13.63분에 대해 약 1.47배라 여유가 줄었다(당시 기준 1.8배).

**측정 맹점.** 잡의 `started_at`~`completed_at`은 "푸시→전 체크 완료"(큐 대기 포함)와 다르다. #121에서는 푸시 15:11:47Z, Windows 잡 시작 15:11:49Z(큐 대기 약 2초), 13.63분 → 완료 ≈15:25:27Z, 한도 만료 15:22:04Z로, 이번 표본의 큐 지연은 무시할 수준이었다. 다른 시간대의 큐 지연은 **미측정**이다.

## 2. 대안 비교

| 대안 | 내용 | 판정 | 이유 |
|---|---|---|---|
| A. 상한 상향 | 시도 횟수를 늘린다 | **채택(권장)** | 필수 이름 복사 없음, 기존 결정(:771-777)과 일치. 단 "한 줄 변경"은 아니다(R1) |
| B. 브랜치 보호에서 필수 이름 읽기 | `gh api .../branches/master/protection` | REJECT | 오너 CLI 인증으로는 읽히지만(감사 실측) Actions의 `GITHUB_TOKEN`·`ARTIBOT_LANDING_PAT`의 `administration:read` 여부는 **미확인** |
| C. Windows를 이름으로 제외 | 대기에서 `... on Windows`를 뺀다 | REJECT | 이름 목록을 하나 더 만든다. 주석이 피하려던 결합이다 |
| D. 시간 초과 시 일단 푸시 | 보호가 거부하면 거부되게 둔다 | REJECT(무의미) | 보호가 `enforce_admins=true`, `allow_force_pushes=false`, 푸시 제한 없음, 브랜치 룰셋 0건이라(감사 실측, `gh api .../branches/master/protection`) 오너 PAT도 필수 체크를 우회할 수 없다. pending 상태 푸시는 거부되므로 결과가 지금과 같고 이슈만 약간 빨리 열린다 |
| E. 늦게 green이 되면 나중에 착지 | 별도 스케줄 잡이 잔존 브랜치를 ff-only로 착지 | DEFER | 새 트리거·권한이 필요해 범위가 크다. 이번 문제는 상한만으로 풀린다 |
| F. Windows를 빠르게 | coverage 제거·테스트 분할 등 | 별도 과제 | 원인 미측정. 가이드 §3.1 coverage 4→1은 DEFER |

## 3. 권장 설계

### R1. 상한을 측정 기준으로 다시 정하고 두 구현에서 같은 값을 쓴다

- 규칙: 두 구현이 이미 쓴 **"가장 느린 첫 시도의 약 1.8배"** 를 유지한다. 13.63분 × 1.8 ≈ 24.5분 → **100회 × 15초 = 25분**(감사 재계산 1.83배).
- 변경 범위(**한 줄이 아니다**):
  - `release.yml`: `seq 1 40` → `100`(:798).
  - `lib/git/batch-landing.js`: `WAIT_FOR_GREEN_ATTEMPTS = 80` → `100`.
  - `tests/git/batch-landing.test.js`가 리터럴로 고정한 단언 **5개**: `:275 toBe(80)`, `:277 …/60_000).toBe(20)`, `:346 landingLockStaleMs()).toBe(120 * MIN)`, `:352 toBe(3 * 2 * 80 * 30_000)`, `:397 staleMs).toBe(120 * MIN)`(제가 `grep -nE`로 직접 확인). 감사관은 4개로 보고했고 `:397`이 더 있었다. 구현 전 검색은 `rg "7200000|120"`이 아니라 `rg "WAIT_FOR_GREEN|toBe\(80\)|120 \* MIN|staleMs"`로 한다.
  - 갱신할 주석(감사 보고 기준, 재열람 안 함): `batch-landing.js` ~:38-42·:112-123·:133·:337, `landing-lock.js` ~:34·:83, `batch-landing.test.js` ~:249-255·:337-338, `release.yml:779`. 주석의 근거는 이 문서의 측정(날짜·n·명령)으로 교체한다.
- 부작용(계산): 착지 락 TTL `landingLockStaleMs = max(30분, 3 × (1+maxRebuilds) × attempts × pollMs)`가 80회 기준 120분에서 100회 기준 **150분**이 된다(`3×2×100×15s`). `DEFAULT_STALE_MS`(30분)는 `lib/git/landing-lock.js:86`이다.
- 다른 스텝 영향: `release.yml`에 `timeout-minutes`도 `concurrency` 블록도 없다(grep 0건). 25분 대기는 job 한도(기본 360분)에 걸리지 않고, 긴 대기가 다음 릴리스를 막지도 않는다(두 릴리스의 착지가 겹치면 기존 R5 rebase 1회 재시도가 흡수 — 감사 읽기). 자가치유 reconciler는 **다음** 릴리스 job 상단에서 돌므로 대기 길이와 무관하다.
- 여유의 한계: Windows 중앙값이 5일간 약 +2.5분 올랐다. 이 추세가 이어지면 25분도 소진된다. 그래서 R3(경보)를 함께 둔다.

### R2. 두 구현의 불일치를 잡는 락스텝 테스트

- 파서: 새로 만들지 말고 `tests/firewall/badge-stall-yaml-tools.js`의 `source`·`sliceStep`·`executableShell`을 import한다(`release-landing-push-identity.test.js`는 같은 함수의 로컬 사본을 들고 있다 — 감사 읽기).
- **주석을 먼저 걷어낸다.** `release.yml:779`의 산문이 "40 attempts x 15s"를 문자 그대로 적고 있어, 주석을 안 걷은 정규식은 산문에 매치된다(`release-landing-push-identity` 헤더가 같은 함정을 기록).
- 명세는 `seq 1 N` 파싱이 아니라 **대입문 고정**으로 한다. R3의 60% 경보는 셸이 N으로 산술을 해야 하므로 구현자가 `seq 1 100`을 `WAIT_ATTEMPTS=100` 같은 변수로 뺄 가능성이 높다. 기존 게이트 4의 `^\s*ZERO_POLL_LIMIT=8$`와 같은 형식으로 `WAIT_ATTEMPTS`·`WAIT_POLL_SECONDS` 대입문을 고정하고, JS 상수와 `N === WAIT_FOR_GREEN_ATTEMPTS`, `S*1000 === WAIT_FOR_GREEN_POLL_MS`를 단언한다.
- 착지 스텝 안에서만 찾으면 `seq`는 1회뿐이다(`:1102`의 `seq 1 6`은 다른 스텝 — `sliceStep`으로 모호성이 사라진다).
- 파서 자기검증(음성 대조): 값을 바꾼 사본에서 실제로 RED가 나는지 확인하고, 변조가 적용됐는지 독립 확인한다. 파일·패턴이 없으면 RED(fail-closed).
- 이 테스트가 못 보는 것: 대기 로직의 다른 분기(zero-poll, 실패 판정)의 동치성 — 기존 `landing-serialization.test.js`의 포트 테스트가 따로 맡는다.

### R3. 시간 초과 진단과 조기 경보

계약은 3값으로 유지한다(`return 0/1/2`, `ZERO_POLL_LIMIT=8` — `tests/firewall/release-landing-push-identity.test.js` 게이트 4가 고정). 반환값은 바꾸지 않고 정보만 더한다. 이 항목은 §1 표로 정당화된다: 6건 중 5건의 이슈가 본문만으로 원인을 구분할 수 없었다.

- 가능성(감사 읽기): `wait_for_green`은 `:850`·`:896`에서 서브셸이 아닌 직접 호출이고 `local`을 쓰지 않으므로 `total`·`pending`·`failed`가 호출 뒤 전역에 이미 남는다. 이슈 본문에 "마지막 폴링 기준 pending N, failed M, 총 T, 경과 X분"을 넣으면 빨간 체크(`failed>0`)와 시간 초과(`failed=0`)가 구분된다.
- 주의 3가지: ① 모든 폴링이 빈 payload면 변수가 미할당 → `${pending:-?}`. ② `:812-814` 주석대로 bare `((…))`는 `bash -e`에서 중단하므로 60% 계산은 대입형 산술로. ③ 경과는 `$SECONDS` 또는 시작 스탬프. `for _`를 `for i`로 바꾸는 것은 게이트 4가 고정하지 않아 안전하다.
- 성공 경로(`return 0`)도 경과 시간을 한 줄 로그로 남긴다. 지금은 성공 시 소요가 기록되지 않아 다음 측정 자료가 없다.
- 경과가 한도의 60%(15분)를 넘으면 `::warning::`을 낸다. 60%는 임의 초기값이다.
- **이슈 제목은 바꾸지 않는다.** `LAND_TITLE_PREFIX`/`SUFFIX`로 조립되고 자가치유 reconciler가 제목으로 이슈를 찾는다(`release.yml:833`, `:844-848`).

### R4. 바꾸지 않는 것

필수 이름 목록 복사 없음, 브랜치 보호 우회 경로 없음. PR 모드(자동 병합)는 건드리지 않는다. 그 경로의 정지 감지기는 `wait_for_green`이 아니라 "필수 체크가 시작조차 안 했는지"를 6회 × 20초(2분) 동안 보는 별도 probe다(`release.yml:1102-1103`, 감사관과 제가 해당 구간을 읽었고 PR 모드 전체 흐름은 읽지 않았다).

## 4. 검증 계획

| 단계 | 방법 | 통과 기준 |
|---|---|---|
| 정적 | 락스텝 테스트(R2)와 `release-landing-push-identity`·`landing-serialization`·`batch-landing` 테스트(위 5개 리터럴 갱신 후) | 전부 통과, 락스텝은 음성 대조로 RED 확인 |
| 구문 | `actionlint` 또는 YAML 파싱으로 `release.yml` 확인 | 오류 0 |
| 라이브 | 다음 실제 릴리스에서 `wait_for_green` 로그의 경과 시간과 결과 기록. **배지 변경이 없는 릴리스는 대기창이 가동되지 않아 검증이 되지 않는다** | 25분 안에 착지하고 같은 유형의 이슈 0건 |
| 사후 | 성공 로그의 경과 시간을 §1 표에 이어 붙임 | 경과가 한도의 60% 아래인지 판단 |

라이브 검증은 배지 변경이 있는 릴리스를 일으켜야 하므로 지금은 할 수 없다. 그때까지 이 설계의 효과는 **추론**이다. 단 10분 한도가 Windows 중앙값 13.3분보다 짧다는 것은 실측이라, 25분이 같은 조건에서 통과한다는 것은 #121의 타임라인(완료 ≈15:25:27Z, 푸시 15:11:47Z + 25분 = 15:36:47Z)으로 확인되는 사후 계산이다.

## 5. 오너 결정

| # | 결정 | 선택지 |
|---|---|---|
| 1 | 상한 | 25분(측정 1.8배, 권장) / 더 길게(예: 40분) — 길수록 실패한 릴리스가 job을 오래 잡고 이슈 개설이 늦어진다 |
| 2 | 대안 E(늦은 green 자동 착지) | 지금 하지 않음(권장) / 별도 설계로 진행 |
| 3 | 잔존 브랜치 `ci/sync-badges-v4.66.0` | 삭제(이미 master의 조상, 착지 완료 — 확인함) / 둠. 이번 설계 범위 밖 |
| 4 | 과거 5건의 "빨간 체크" 원인 조사 | 별도 조사로 진행 / 하지 않음 |

## 6. 범위 밖·후속

- **과거 5건에서 무엇이 빨갛게 됐는지**(§1): 이번에 조사하지 않았다. 배지·메타데이터 커밋의 체크가 5번 실패했다면 이 설계와 다른 원인이 있을 수 있다.
- **Windows 잡이 느려지는 원인.** 초안 시점에는 측정하지 않았다(코드 주석의 2026-09-21~28 측정 중앙값 9.10분에서 10-04 표본 중앙값 13.4분까지, 약 열흘 사이. 두 측정은 표본 구성이 달라 엄밀한 비교가 아니다). 이후 조사관이 측정했다 — **조사관 측정(2026-10-05 20:32~21:03 KST), 리더·작성자 미재측정**: 09-17 → 10-05 테스트 18,836 → 26,594(+41%), 테스트 파일 723 → 879(+22%). 같은 기간 Linux 테스트 스텝은 ×2.35, Windows 는 ×1.97 이고 `ci.yml` 은 불변이며, 변하지 않은 594개 파일 대조군은 평평했다 — 따라서 원인은 Windows 러너가 아니라 **스위트 증가**로 보인다(추론). 증가는 테스트가 착지할 때 계단식이고, 10-02 → 10-05 의 n=21 은 p50 13.27 / p90 13.63 / max 13.78분으로 평평하다. Windows 증가분의 약 39% 가 직렬 autopilot 프로젝트이고 그 절반이 `tests/autopilot/safety.test.js`(50~65초)다. 25분에 닿는 시점(테스트 파일 약 390~470개가 더 늘면, 최근 속도로 11월 중·하순)은 **외삽**이다. 미확인: Windows 에서의 coverage 오버헤드, 러너 속도의 이봉성.
- **`Run runtime eval gate` 스텝이 4개 레그 모두 약 2.0분이던 원인**(스위트 자체는 0.37초): `lib/runtime/evaluator.js#evaluateRuntimeSuite` 의 120초 suite-timeout 가드 타이머를 해제하지 않아 프로세스가 약 120초 뒤에야 끝났다(조사관 측정, 리더 미재측정). 담당 팀원이 `finally { clearTimeout }` 로 고쳤다(로컬 Windows: 마지막 출력→종료 119.1~119.3초 → 0.0초. 리더 실측: 러너 1.05초 rc 0, 새 테스트 포함 2파일 15 passed). 이 스텝은 Windows 레그에도 있으므로 줄면 Windows 잡 소요도 줄 것으로 보이나(추론) **CI 러너에서의 단축은 측정하지 않았다.**
- 가이드 §3.1(coverage 4→1)의 Windows 비계측 A/B는 이 과제와 함께 다룬다.
- 같은 제목의 이슈 #114(v4.51.0)는 체크가 한 번도 생성되지 않은 인증 귀속 사례다. 위 표에는 넣지 않았고, 본문이 다른 5건과 같은 문장인지는 제목만 확인해 **미확인**이다.

## 7. 미확인

- 과거 5건에서 어떤 체크가 빨갛게 됐는지, 그것이 같은 원인인지
- Actions 안의 `GITHUB_TOKEN`·`ARTIBOT_LANDING_PAT`가 `branches/master/protection`을 읽을 수 있는지(대안 B의 나머지 절반)
- 푸시→체크 완료 전체 경과(큐 대기 포함)의 시간대별 분포
- Windows 소요 증가의 원인(§6 의 조사관 측정은 리더 미재측정)과 25분에 닿는 시점(외삽), coverage 오버헤드, 러너 속도의 이봉성, runtime eval 타이머 수정이 CI 러너에서 실제로 줄이는 시간
- R3의 경보 임계 60%가 적절한지 — 임의 초기값
- 제 집계 표본 n=45와 감사관 n=46·n=58 사이의 차이가 어느 런 때문인지(표본 구간·실패 런 제외 규칙의 차이로 추정, 런 목록은 보존하지 않았다)
- 다음 실제 릴리스에서의 25분 한도의 라이브 동작

## 8. 구현 기록 (2026-10-05, 라이브 미검증)

오너가 §5 의 권장안을 택했다: 상한 25분(100 × 15초), 늦은 green 자동 착지 없음, 필수 체크 이름 미복사, 브랜치 보호 우회 없음. R1·R2·R3 를 구현했다. 위 분석(§1~§7)은 고치지 않았다.

| 항목 | 변경 | 위치 |
|---|---|---|
| R1 | `seq 1 40`/`sleep 15` → `WAIT_ATTEMPTS=100`·`WAIT_POLL_SECONDS=15` 대입문 + 루프가 변수를 쓴다. 주석의 근거를 2026-10-05 측정으로 교체 | `.github/workflows/release.yml` 착지 스텝 `wait_for_green` |
| R1 | `WAIT_FOR_GREEN_ATTEMPTS` 80 → 100, 락 TTL `landingLockStaleMs()` 120 → 150분(3 × 2 × 100 × 15초), 관련 주석·리터럴 갱신 | `lib/git/batch-landing.js`, `lib/git/landing-lock.js`, `tests/git/batch-landing.test.js`(리터럴 6곳 — §3 R1 이 센 5곳 외에 `landingLockStaleMs({}, 0)` 의 `60 * MIN` → `75 * MIN` 이 하나 더 있었다), `tests/firewall/landing-serialization.test.js` 주석, `commands/split.md`(20분 → 25분, 120분 → 150분) |
| R2 | 락스텝 테스트 신설. 대입문 정확히 1개씩 · JS 상수와 동일 · 루프가 변수를 쓰고 숫자 리터럴이 없음 · 파일/스텝/함수 부재는 RED · 실행 셸 전체에서 `WAIT_ATTEMPTS=`·`WAIT_POLL_SECONDS=` 출현 수 정확히 1(고정 형식 밖의 두 번째 대입 — `;`·`export`·`$((40))`·호출부 접두 — 차단) · 문자열 변조 7종 + 두 번째 대입 5종 + 빈 입력 + JS 상수 불일치로 스캐너 자기검증(19 tests) | `tests/firewall/release-wait-window-lockstep.test.js` |
| R3 | 시간 초과/빨간 체크를 구분하는 `describe_wait`(반환값 0/1/2 불변). 이슈 본문과 `::warning::` 에 "last usable poll: total=T pending=P failed=F after N polls (~M min)" 추가(라벨은 2026-10-06 검수 반영으로 "last poll:" 에서 바뀌었고, 0건 분기는 앞선 폴링의 pending/failed 를 비워 두 폴링의 혼합을 보이지 않는다), 미할당은 `?`. 판정은 관측으로 가른다: 숫자 `failed` > 0 이면 red check, 폴링 수가 한도(`WAIT_ATTEMPTS`)에 닿았으면 timeout(`total` 이 숫자가 아니면 "API never returned a usable check-run payload"), 한도 전에 끝났는데 red 도 아니면 "ended early"(공백·오류 payload). 성공 시 경과 폴링 수 로그 1줄, 한도의 60% 초과 시 `::warning::`(60% 는 임의 초기값). 이슈 제목은 그대로 | 같은 스텝 |

**검증한 것**: `npx vitest run` 8 파일(락스텝 19 · `release-landing-push-identity` · `landing-serialization` · `batch-landing` · badge-stall 3종 · `workflow-branch-lockstep`) 141 passed. 셸 시뮬레이션 두 번: ① 스텁 `gh`·`sleep`·`jq`(bash 함수)로 7개 시나리오 a~g — 초록 · 시간 초과 100회 · 빨간 체크 · 런 0건 · 빈 payload · 60% 경계(60폴링 무경고, 61폴링 경고) · 이전 호출 카운트 비상속(a~g 7개; 70폴링 변형 f70 은 끝까지 도는 것을 확인하지 못했다). ② 교차 검수 후 재작성한 `describe_wait` 는 감사관의 node 기반 `jq` 재구현(실제 JSON 파싱) 하네스에 현재 `release.yml` 에서 추출한 착지 스텝을 얹어 `bash -e` 와 `bash -eu` 로 구동했다: 2폴링 red · 100폴링 시간 초과 · 전 폴링 빈 payload · 공백 payload(1폴링에 rc 1, "ended early") · `total=null` 오류 JSON · total=0 × 8(rc 2, `describe_wait` 미호출) · 초록. 스크래치 사본 음성 대조 10종(`=40`·poll `=20`·주석 처리·JS 80·`seq`/`sleep` 리터럴·두 번째 대입 4종)이 모두 RED 였고 변조 적용과 복원을 해시로 확인했다.

**수정됨(2026-10-05, 라이브 미검증)** — 이 절에 "알려진 잔여 결함(미수정)"으로 적었던 것 중 1·2번과 타임아웃. `release.yml` 착지 스텝 `wait_for_green` 주변만 바꿨고 0/1/2 반환 · 호출형 · 이슈 제목 · `WAIT_ATTEMPTS=100`/`WAIT_POLL_SECONDS=15`/`ZERO_POLL_LIMIT=8` · `describe_wait` 판정 규칙은 그대로다. 세 전제(리셋 없음, `|| echo 0`, 타임아웃 없음)는 코드를 직접 읽어 확인했다.

1. **`zero_polls` 리셋.** `total_count` 가 0 보다 큰 폴링에서 `zero_polls=0` 으로 되돌린다. 이전에는 함수 시작에서만 0 이었어서 로그의 "N consecutive polls" 와 달리 누적이었다(0건 7회 → pending 1회 → 0건 1회에 rc 2). 시뮬레이션으로 같은 시나리오가 수정 전에는 9번째 호출에 rc 2, 수정 후에는 16폴링 만에 초록으로 끝남을 확인했다.
2. **숫자가 아닌 `total_count` 는 API 실패로 센다.** `jq … || echo 0` 이 실패를 0 으로 바꾸던 것을 `|| echo ''` + `case` 숫자 가드(`continue`)로 고쳤다. HTML 502 같은 비JSON 본문, `total_count` 가 null 인 오류 JSON, jq 실패는 이제 "런이 한 번도 안 생김"(rc 2)으로 세지 않고 다음 폴링으로 넘어간다 — 빈 payload 와 같은 원칙이다. `total` 은 마지막 **사용 가능한** 값을 유지하고(없으면 빈 값) `describe_wait` 가 이를 읽는다. 시뮬레이션: HTML 502 본문은 수정 전 8폴링에 rc 2 "no workflow run was ever created", 수정 후 100폴링을 돌고 "timeout, the API never returned a usable check-run payload".
3. **`gh api` 타임아웃.** `timeout "${GH_API_TIMEOUT_SECONDS}" gh api …`, `GH_API_TIMEOUT_SECONDS=10`(JS 포트 `GH_CHECK_RUNS_TIMEOUT_MS` 와 같은 10초 — 폴링 간격 15초 미만, REST GET 1회보다 훨씬 큼). `timeout` 은 이 잡의 `runs-on: ubuntu-latest` 러너의 GNU coreutils 다. 끊긴 호출은 빈 payload(또는 숫자 가드가 거르는 부분 stdout)가 되어 위 2번과 같은 경로를 탄다. **25분은 폴링 사이 sleep 의 합일 뿐 API 지연은 별도다.** 모든 폴링 `gh api` 호출이 타임아웃까지 걸리는 최악은 한 번의 대기가 100 × (15 + 10) 초 = 2500초 = 약 41.7분이고, rebase 재시도로 두 번 기다리면 약 83분(+ git 작업)이다. 묶인 것은 폴링의 `gh api` 뿐이다 — `open_issue` 의 `gh issue` 호출과 git 은 한도가 없고 이 수치에 들어 있지 않다. 정상 지연(호출당 약 1초)이면 약 50~55분(감사관 추정)이다. 이 값은 주석(`release.yml`)과 JS 포트의 같은 계산(`landingLockStaleMs()` 150분 안)과 맞는다.
4. **검수 반영(2026-10-06).** Fable 교차 검수(APPROVE, 차단 0)의 권고를 하나씩 재현한 뒤 고쳤다.
   - **테스트 구멍(4묶음).** 단위 정리: "구멍 4종"은 검수가 지적한 **묶음 4개**이고 "변조 N종"은 그 묶음을 실제로 재현·고정한 **개별 변조의 수**다. 4묶음 = ① 두 번째 대입·호출부 접두, ② 리셋 위치 이동, ③ `echo "0"`·상수 3600, ④ 대입 순서이며 개별 변조로는 6개(두 번째 대입, 호출부 접두, 리셋 이동, `echo "0"`, 상수 3600, 대입 순서)다. 스크래치 사본에서 재현했다: `GH_API_TIMEOUT_SECONDS=0;` 두 번째 대입과 호출부 접두 `GH_API_TIMEOUT_SECONDS=0 wait_for_green …`(`timeout 0` 은 한도를 끈다), `zero_polls=0` 리셋을 0건 분기 **안**으로 옮김(rc 2 가 영영 안 난다), `|| echo "0"`(따옴표)·`GH_API_TIMEOUT_SECONDS=3600`(주 게이트는 통과하고 자기검증의 `mutate()` 예외로만 우연히 RED), `total="${poll_total}"` 를 가드 앞으로 옮김 — 전부 수정 전 테스트에서 28 passed 이거나 우연히만 RED 였다. 같은 파일이 `WAIT_ATTEMPTS`·`WAIT_POLL_SECONDS` 에 쓰던 `\bNAME\+?=` 출현 수 === 1 규칙을 새 상수에 적용하고, 리셋 위치(0건 분기의 닫는 `fi` 직후)·함수 안 `zero_polls=0` 줄 수(정확히 2)·`echo ["']?0` 정규식·`GH_API_TIMEOUT_SECONDS` < `WAIT_POLL_SECONDS`·`total` 대입이 가드보다 뒤임을 고정했다. 마지막(순서)은 문자열 상대 위치 검사라 비용이 작고 깨지면 사용 불가 값이 `total` 을 덮어쓰는 실결함이어서 고정하는 쪽으로 판단했다.
   - **`describe_wait` 의 혼합 값.** `pending → 0건 → HTML×8` 이 "last poll: total=0 pending=1 failed=0"(어느 폴링도 돌려준 적 없는 조합)으로 나왔다. 0건 분기의 `continue` 직전에 `pending=""`·`failed=""` 로 비우고 라벨을 "last usable poll:" 로 바꿨다. 그 문자열을 고정하는 테스트·문서는 리포 전역 grep(`.github/ plugins/artibot/{tests,lib,docs,commands} .artibot/guides` 와 루트)에 없었다 — 과거 라이브 출력을 인용한 기록(아래 v4.71.4)과 이미 출시된 4.71.4 CHANGELOG 항목은 당시 문구라 그대로 둔다. 판정 3분기 의미와 0/1/2 계약은 불변.
   - **주석 3곳 정정.** "연속"은 **사용 가능한 폴링 기준**이다(쓸 수 없는 폴링은 올리지도 리셋하지도 않는다). 타임아웃으로 묶인 것은 폴링의 `gh api` 뿐이다. 끊긴 호출은 빈 payload 이거나 숫자 가드가 거르는 부분 stdout 이다.
5. **2차 검수 반영(2026-10-06).** 2차 Fable 검수(종합 APPROVE, 차단 0; 검수자 실측 2026-10-06 01:00~01:34 KST): 추가분 diff 5곳 확인, 1차에서 통과하던 변조 6종과 검수자 신규 4종이 모두 주 게이트에서 RED, `pending → 0건 → HTML×8` 혼합 제거 재현, red 판정을 잃는 입력열 없음, "last poll" 소비처 0건, 0/1/2 계약 불변. 남은 참고 1건(X1)을 스크래치 사본에서 재현한 뒤 고쳤다: 리셋 줄 바로 뒤에 `zero_polls="$((ZERO_POLL_LIMIT - 1))"` 를 넣어도 주 게이트가 통과했다(실효: 런이 있는 폴링 뒤 0건 1회에 rc 2). 함수 안 `zero_polls=` 대입 출현 수 === 3(초기화·증가·리셋; 현재 함수를 주석 제거 후 세어 3개임을 확인)을 단언에 더했다. **러너 `timeout`·실제 `jq`·실제 100회 상한 경로는 2차 검수에서도 해소되지 않았다.**

고정하는 테스트: `tests/firewall/release-wait-window-lockstep.test.js` 의 "폴링 위생" 블록(2026-10-06 기준 파일 36 tests) — 모든 `gh api` 가 `timeout "${GH_API_TIMEOUT_SECONDS}"` 로 감싸이고 상수는 출현 1회의 양의 정수이며 폴링 간격 미만, `.total_count` 줄에 `|| echo 0` 류(따옴표 포함) 없음 + `case` 가드 + `total` 대입이 가드 뒤, `zero_polls=0` 리셋이 0건 분기의 닫는 `fi` 직후이고 함수 안 줄 수가 정확히 2, 0건 분기가 `continue` 전에 `pending`/`failed` 를 비움(변조 사본 15종으로 자기검증; 2차 검수 반영으로 함수 안 `zero_polls=` 대입 정확히 3개 단언 추가). **못 보는 것**: `timeout` 이 러너에서 실제로 끊는지(coreutils 존재·종료 코드 124·SIGTERM 에 gh 가 즉시 죽는지), 리셋·가드의 런타임 동작과 `case` 가드 뒤 분기의 시맨틱(문자열 존재·상대 위치만 본다), 다른 스텝의 `gh api`·`gh issue`, 변수 간접 참조 같은 다른 우회, 루프 자체를 자르는 파이프(`seq … | head -40`). 시뮬레이션이 보여 준 것이 런타임 동작의 전부이고 그것도 라이브가 아니다.

**남은 결함·위험(미수정)**

- 60% 경고는 **통보 경로가 아니라 런 주석**일 뿐이다. 누군가 런을 열어 봐야 보인다.
- 이슈 개설 시점이 시간 초과 기준으로 10분 → 25분 늦어졌다. 대신 오경보(체크가 아직 도는데 이슈가 열림)는 줄었다.
- 스텝 최악 소요: 위 3번의 계산(정상 지연 약 50~55분, 모든 호출이 타임아웃까지 걸리면 약 83분 + git). 직접 라이브로 재지 않았다.
- `describe_wait` 의 "ended early without a usable check-run payload" 분기는 숫자 가드 이후 **사실상 도달 불가**로 추론된다(빈·공백·오류 payload 는 이제 가드에서 `continue` 하므로 한도 전에 red 가 아닌 채 rc 1 로 끝나는 경로를 찾지 못했다). 방어용으로 남겼고 도달 여부를 실측하지 않았다.
- `timeout` 에 `-k` 가 없다. gh 가 SIGTERM 에 즉시 죽지 않으면 그만큼 늦게 끊긴다(미확인).

**검수가 해소하지 못한 미확인(2026-10-06)**: 러너에서의 `timeout` 실동작(검수 PC 는 MSYS coreutils 8.32), 실제 `jq` 와의 동치(검수 PC 에 jq 가 없어 별도 node 재구현으로 확인), 실제 `WAIT_ATTEMPTS=100` 상한 경로(10회 사본으로만 구동), gh 가 SIGTERM 에 즉시 죽는지, 위 "ended early" 도달 불가는 추론이라는 점.

**검수 후 재검증(2026-10-06)**: 관련 8 파일 158 passed(락스텝 36 · push-identity 9 · landing-serialization 16 · batch-landing 25 · sync-order 8 · workflow-branch-lockstep 34 · yaml-tools 4 · issue-lifecycle 26). 스크래치 사본 음성 대조(변조 적용을 해시로 확인한 뒤): 구멍 4종 재현은 수정 전 테스트에서 주 게이트가 통과(28 passed)했고, 수정 후에는 개별 변조 7종(구멍 4묶음의 6개 + 혼합 비우기 삭제 1개: 두 번째 대입 · 호출부 접두 · 리셋 이동 · `echo "0"` · 상수 3600 · 대입 순서 · 비우기 삭제)과 2차 검수의 1종(리셋 뒤 `zero_polls="$((ZERO_POLL_LIMIT - 1))"` 대입)이 모두 주 게이트에서 RED. 시뮬레이션(감사관 node-`jq` 하네스, `bash -e`/`-eu`, `WAIT_ATTEMPTS=10` 사본): `pending → 0건 → HTML×8` 은 수정 전 "last poll: total=0 pending=1 failed=0", 수정 후 "last usable poll: total=0 pending=? failed=?"; `0건×3 → HTML×7` 은 값은 같고 라벨만 바뀐다. 이전에 보고한 시나리오(0건 8연속 rc 2, 0건 7회 → pending → 0건 7회는 16폴링 초록, HTML 502·오류 JSON 은 timeout "usable payload 없음", 정상 초록·빨강)는 같은 결과로 재확인했다.

**v4.71.4 첫 라이브 실행(2026-10-05)** — 배지 동기화 `8994caed` 의 대기 단계가 18폴링에 `total=7 pending=3 failed=1` 로 끝났고 경고에 "red check, at least one check run failed; last poll: … after 18 polls" 가 찍혔다(당시 문구이며 이후 라벨은 "last usable poll:" 로 바뀌었다). 진단 문구(R3)는 라이브로 작동했다. 원인은 `tests/security/human-gate-enforce-redos.test.js` 의 타이밍 비율 단언 1건(`expected 15.126842833928468 to be greater than 18`, Node 22, 1 failed / 26523 passed)이었고, 실패 잡을 재실행해 통과한 뒤 수동 fast-forward 로 착지했다(이슈 #123). **25분 상한 자체는 이 실행에서 가동되지 않아(폴링 18회에서 red) 여전히 라이브 미검증이다.**

**검증하지 못한 것**: 이 수정은 **라이브에서 한 번도 돌지 않았다.** 배지 변경이 있는 다음 실제 릴리스에서만 증명된다(변경이 없으면 착지 스텝이 skipped 라 대기창이 가동되지 않는다). 셸 시뮬레이션의 `jq` 는 `wait_for_green` 이 쓰는 필터 3종만 흉내 내는 스텁이라 실제 `jq` 의 해석 차이는 보지 못한다. R3 의 60% 임계값과 25분 상한이 충분한지는 추세(Windows 중앙값 상승)에 달려 있다.
