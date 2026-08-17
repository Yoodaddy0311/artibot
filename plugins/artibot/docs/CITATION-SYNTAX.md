# 인용 문법 (Citation Syntax) — 규범 정본

> 이 문서가 코드 인용 표기의 **유일한 정본**이다. 게이트(`tests/firewall/citation-resolution.test.js`)가
> 이 문법만 검사하므로, 여기 적힌 규칙이 사실상의 표준이 된다. 규칙을 바꾸려면 이 문서와
> 술어(`tests/firewall/citation-resolution.js`)를 함께 바꿔야 한다.
> 관련 규율: 검증 규율 §10.5(b) — 줄번호는 한 세션 안에서도 썩으므로 `file#symbol` 을 권장한다 (cross-ref, 중복 서술 금지).

## 문법

| 요소 | 규칙 | 예 |
|---|---|---|
| 백틱 | **필수** — 인용은 단일 코드스팬(백틱) 안에 쓴다 | `lib/core/model-policy.js#resolveModel` |
| 경로 | **루트 세그먼트부터** 쓴다 (`lib/` `scripts/` `commands/` `skills/` `docs/` `tests/` …). 베이스네임 단독(`index.js:59`)은 해소 불가라 검사되지 않는다 | `scripts/ci/ci-utils.js:90` |
| 타깃 | `#symbol` **권장**, `:NN` 허용. 범위 `:NN-MM`·콤마·혼합(`:207,215-224`) 지원. **타깃이 없으면 인용이 아니라 언급이다** — 판정 없이 `no-target` 으로 계수만 된다 | `install.sh#acquire_install_lock` |
| 심볼 종류 | JS 선언(function/const/class/export) · JSON 키경로(`config.json#team.playbooks`) · 셸 함수 · MD 헤딩 앵커. 점 표기는 JSON 만 전체 경로, 그 외 머리 세그먼트만 검사 | |

**백틱 필수는 검사 편의가 아니라 언어 설계 결정이다.** 백틱은 저자의 명시적 "코드 참조" 신호이고,
백틱을 빼면 게이트 밖(산문)이다 — 이것이 저자의 opt-out 장치다. 탐지기를 산문까지 넓히면 오탐 대응용
부정 목록이 자라기 시작해 fail-open 으로 끝난다. 테스트의 음성 단언("백틱 없는 인용은 탐지되지
않아야 한다")이 이 확장을 명시적으로 막는다.

## 판정

- **skip (검사 대상 아님, 사유별 계수)**: 플레이스홀더 리터럴 · 리포 밖 prefix · 미등록 확장자 · **타깃 없음(no-target)** · 베어 베이스네임 · 미등록 루트 세그먼트. 사유는 열거형 allowlist — 미분류 skip 은 위반이다.
- **위반**: `missing-file` · `out-of-range`(줄번호 > 파일 줄수) · `unknown-symbol` · `read-error`. 신규 위반은 CI 에서 실패한다 — **인용을 고쳐라, 베이스라인에 추가하지 마라.**

## 해소 기준점 (폴백 없음)

첫 세그먼트가 기준점을 **하나로** 결정한다 (`SEGMENT_ROOT_KIND`): `lib/` `scripts/` `docs/` 등 →
**문서가 속한 플러그인 루트**, `plugins/` `.github/` → **리포 루트**. 여러 루트를 순차 시도하는
폴백은 cowork 문서의 `lib/x.js` 가 artibot 루트에서 우연히 해소되는 위음성을 만들므로 금지
(2026-08-17 적대 검증). `runtime/` 은 gitignore 라 CI 체크아웃에 없어 **의도적으로 미등록**이다 —
등록하면 로컬 초록/CI 빨강 분기가 생긴다.

## 베이스라인 (`tests/firewall/citation-baseline.json`)

정당한 **역사 기록**만 담는다 — "삭제됨"을 명기하며 과거 파일을 인용하는 문서, 릴리즈 노트의 그 시점
좌표 등. 역사는 개서하지 않는다. 래칫은 **양방향**이다: 신규 위반도 FAIL, 베이스라인 항목이 해소된
채 남아 있어도 FAIL(제거 강제) — 축소 미강제 래칫은 화석화된다는 실측(2026-08-17)에 따른 설계다.

**갱신 경로는 수동 편집이다** (의도적 — 규율상 신규 게이트는 vitest 전용이라 `--update-baseline`
스크립트를 두지 않는다). FAIL 메시지가 추가/제거할 정체성 키(`문서경로::인용원문`)를 그대로
출력하므로, 그 키를 이 파일의 `unresolved` 배열에서 넣거나 빼면 된다. 현재 3건 규모다.

## 이 게이트가 못 보는 것

정본은 `tests/firewall/citation-resolution.js` 모듈 헤더의 blindspot 7항이다. 요지 한 줄:
**이 게이트는 "매달린 인용이 아님"만 증명하며, 줄번호가 범위 안에서 엉뚱한 줄을 가리키는 것(가장
흔한 실제 썩음)은 원리적으로 잡지 못한다.** 그래서 `#symbol` 이 권장 표기다.

실측 규모(2026-08-17, 새 회계 기준): 총 1,701 스팬 중 **no-target 1,177 · ext-not-checked 406 ·
베어 베이스네임 41 · 리포 밖 14 · checkable 63**. 베어 베이스네임엔 `artibot.config.json#…` 같은
해소 가치가 있는 루트 파일 인용도 포함된다(회수는 v2 후보). no-target 층에 대한 적대 검증의 광의
census 는 매달린 참조 ~55건(대부분 GRPO/voyager 철거로 삭제된 파일을 가리키는 역사 기록물)을
관측했다 — 판정 승격과 부채 해소는 별도 v2 과제다.

## 스코프

스캔 대상은 `validate-doc-links.js#gatherAllDocFiles` 를 승계한다 (플러그인 루트들의
commands/skills/docs/rubrics + CLAUDE/README/AGENTS; CHANGELOG 는 append-only 이력이라 제외).
v2 후보: `agents/` `rules/` `.artibot/guides/`(추적 1파일, `#symbol` 최다 보유) 편입,
`/repo` 오케스트레이터 인용 검증·`problem-validation` check 2 에 술어 재사용.
