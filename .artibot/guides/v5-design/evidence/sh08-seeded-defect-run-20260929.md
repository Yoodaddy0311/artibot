# SH-08 seeded-defect 첫 측정 — 현행 정책 리뷰어(opus) 단일 arm, N=30 (2026-09-29)

- 줄기 `sh08-seeded-defect-run`(계획 W1-7, V5-BACKLOG SH-08) · 기준 커밋 `eae2cf09` · 실행 형태 process(코드 0): 리뷰어 호출은 중첩 `claude -p` — 본 실행 30회, 대조 6, ablation 2, 진단 2, 연결 시험 4 (총 44).
- 주장 등급: 꾸밈 없는 서술 = **실측**(내가 명령을 실행해 출력을 봤다), "추론" 표기 = 코드·문서에서 유도만 했다, **미확인**은 §8 에 모았다.
- 오너 결정 R-4 적용: 비교군 = 현 정책 리뷰어 티어(opus) 단일 arm, fable arm = **휴면(D8) — N/A**. D4(목표 catch-rate)는 **정하지 않았다**. §7 은 첫 측정값을 회귀 하한·상한 래칫 *후보*로만 적는다.

## 1. 3수치 (러너 출력 그대로)

| 지표 | 값 | 분자 / 분모 | 러너 정의(분모) |
|---|---|---|---|
| `catch_rate` | **1.0000** | 30 / 30 코퍼스 행 | caught 행 / 코퍼스 전체 행 — 입력에 없는 id 는 miss |
| `false_positive_rate` | **0.0000** | 0 / 30 finding | accepted 집합 밖 finding / 입력 전체 finding |
| `location_accuracy` | **0.9667** | 29 / 30 caught 행 | 기대 범위 안 적중 행 / caught 행 |

- **측정 시각**: 러너 `measured_at` = 2026-09-29T04:29:19.132Z. 리뷰어 30회 실행 구간 2026-09-29T04:25:30Z ~ 04:29:09Z (5줄 병렬, 벽시계 약 3분 39초, 호출당 `duration_ms` 중앙값 3,245).
- **코퍼스 신원**: N=30, `corpus_sha256` = `9ec2df32d4aee5d5` + `ff5cb602c898a7fd` + `f1f174984fd4619f` + `1b9021e2466769da` (16자×4 연결). 러너 출력이 `plugins/artibot/tests/evals/seeded-defect-corpus.test.js` 의 `CORPUS_SHA256` 핀과 같다. 32자 이상 연속 리터럴은 시크릿 가드가 Write 를 막아 분할 표기했다.
- **독립 재계산**: 러너의 채점 코드를 import 하지 않는 별도 코드로 원본 finding 에서 다시 센 값이 러너 값과 정확히 같다 (caught 30 · located 29 · finding 30 중 accepted 30).
- **유효성 대조**: 채점기·파서·종단(모델 포함) 대조 전부 통과(§4). 무효 조건 없음.

> **읽는 법 (수치를 인용할 때 함께 인용할 것)**: 30/30 과 0 은 "opus 리뷰어가 완벽하다"가 아니라 "이 코퍼스·이 프롬프트에서 실패한 행이 0"이라는 뜻이다. 분모 30 에서 1행 = 3.33%p 이고 천장이라 **변별력이 없다**(§6-3). FP 0 은 프롬프트가 "확신하는 결함만, 어휘 밖은 보고 금지"를 지시한 **조건부 값**이다(§6-4).

### 판정 입력 (SH-08 행 문언 대조)

- 행 문언 "catch-rate·FP·위치정확도(opus 비교군)" 3수치 산출: **충족** — 분모·측정 시각·재현 명령이 §1·§2, 비교군은 opus 단일 arm(R-4), fable arm 은 N/A.
- 유효성 대조(양성·음성): **통과**(§4). 대조 실패로 인한 무효 조건 없음.
- 남는 것: D4(목표 catch-rate)는 오너 몫으로 **미결 유지**. 행 비고에는 "천장(30/30) — 변별력 없음 · FP 는 프롬프트 조건부 · 단일 pass"(§6)를 함께 남길 것을 권한다.
- 최종 전환 판정은 investigator 판정 + 리더 커밋의 몫이다. 이 문서는 전환 권한이 없다.

## 2. 실행 조건

| 항목 | 값 | 근거 |
|---|---|---|
| 리뷰어 티어 | `opus` | `model-routing.mjs resolve artibot:code-reviewer --role review` 출력 `opus` — worktree 사본으로 `--role review` 와 `--task review`, 설치본으로 `--role review` 를 실행했고 셋 다 `opus`. 그대로 `--model opus` 에 전달 — 모델 이름을 하드코딩하지 않았다 |
| 서빙 모델(실측) | `claude-opus-5-5` | 호출마다 JSON `modelUsage` 키와 `canonicalModel`: 본 실행 30/30 · 대조 6/6 · ablation 2/2. `plugins/artibot/lib/core/model-catalog.js:223` 의 opus `id` 와 같다 |
| 호출 수단 | 중첩 `claude -p` (CLI 2.1.284) | 이 프로세스에는 Agent(서브에이전트 스폰)·SendMessage 도구가 없어 모델 호출 수단은 Bash 로 부른 `claude` 뿐이다. 인증이 claude.ai OAuth 라 `--bare` 는 못 쓴다(도움말 근거, 실행 안 함) |
| effort | 요청 `high` | 명령 접두 `CLAUDE_CODE_EFFORT_LEVEL=high` 로 세션 상속값 `max` 를 덮고 `--effort high` 병행. **유효값은 미확인**(기록 수단 없음). 사용량상 thinking 토큰 중앙값 112 (0~220, 27/30회 >0) |
| 세션 | 행마다 독립 1회 | `--safe-mode`(CLAUDE.md·훅·플러그인·MCP·스킬 비활성) `--tools ""`(도구 0) `--no-session-persistence` `--permission-prompts none` `--max-budget-usd 1` |
| 출력 | `--output-format json` | 응답 텍스트의 JSON 배열을 파서가 읽는다 |

정확한 명령 (행마다 반복. 프롬프트는 stdin 파일, 응답은 파일로 리다이렉트):

```text
CLAUDE_CODE_EFFORT_LEVEL=high claude -p --model opus --safe-mode --tools "" --no-session-persistence --output-format json --effort high --system-prompt "<부록 B 의 시스템 프롬프트>" --max-budget-usd 1 --permission-prompts none < <행 프롬프트 파일> > <응답 json> 2> <stderr 파일>
node plugins/artibot/scripts/bench/seeded-defect.mjs --input <reviewer-output.json>
```

## 3. 리뷰어 입력(clean-room)과 그 검사

- **제공**: 고정 머리말 + 23 kinds(README 정의 원문, 알파벳순, 전 행 동일) + 해당 행 `injected_diff` **만**(부록 B). `file_hint` 는 diff 의 `--- a/`·`+++ b/` 헤더에 이미 있어 따로 주지 않았다 (`plugins/artibot/tests/evals/fixtures/seeded-defect/README.md:169`). 계획서 문언의 "`injected_diff`·`file_hint`" 와 정보량은 같다.
- **비노출**: `expected` · `class` · `severity` · `design_axis` · `language` · `source` · `id`. kinds 목록은 코퍼스 합집합(정본 kind + `also_accept`) 23개이고, README 표 23개·스키마 enum 23개와 같은 집합임을 생성기가 대조했다. 행별 힌트는 없다.
- **프롬프트 30개 전수 검사**: diff 가 정확히 1회 들어 있다 · diff 밖에 행 id, `"expected"`, `finding_kind"`, `also_accept`, `line_range`, `design_axis`, `"severity"`, `synthetic` 이 없다 · diff 를 가린 템플릿 해시가 30개 모두 같다.
- **순서**: 시드 20260929 로 섞어 기록했다(행마다 독립 세션이라 순서는 결과에 영향이 없다).
- **접근 수단**: 도구 0. 본 실행 30 · 대조 6 · ablation 2 호출 전부 `num_turns` 1, `permission_denials` 0, 서브에이전트 0. 중첩 세션의 cwd 는 이 worktree(코퍼스 파일이 있는 리포 안)였으나 파일 도구가 없어 접근 수단이 없다.
- **모델 자기보고 컨텍스트** (진단 1회, **추론 등급**: 모델의 자기보고): 호스트 한 줄 정체 문구 + 위 시스템 프롬프트 + 사용자 이메일 reminder + 환경 블록(작업 디렉터리·플랫폼·모델 정체·날짜·예산 줄), 도구 0. 입력 토큰 약 950. 코퍼스·리포 내용은 보고되지 않았다.
- **바이트 충실도**: `$`, 백슬래시, 따옴표, 백틱, U+2014 를 담은 반향 시험이 242/242자 일치했다(stdin 경로가 diff 를 변형하지 않는다).
- **원장 위생**: 중첩 세션 id 44개가 중앙 원장(41,961줄, 2026-09-29T04:37:33Z)에 **0행**이다. 같은 44개 패턴에 내 부모 세션 id 를 더하면 2,342행이 나와(원장 42,152줄, 04:42:52Z) 검사 감도를 확인했다. 훅은 발화하지 않았고 census 오염은 없다.

## 4. 유효성 대조 — 3수치를 인용하기 전에 통과해야 하는 조건

기준은 대조 실행 전에 정했다(작업 중 자기 기록이며 외부에서 검증할 수는 없다). 양성 = 결함 변형에서 accepted kind 를 방출해 채점기가 caught 로 표시. 음성 = clean 변형에서 accepted kind 를 방출하지 않아 not caught. 음성 대조가 실패하면 3수치를 인용하지 않는 것이 계획서(§7)의 규칙이다.

### 4-1 채점기·파서 (모델 호출 없음, 실제 30행 코퍼스, 출하 러너 CLI 를 자식 프로세스로 실행, 기대값은 손계산)

| # | 대조 | 기대 | 결과 |
|---|---|---|---|
| C1 | 정답 kind·정답 줄의 완전 리뷰어 | catch 1 · FP 0 · loc 1 · n 30 | 통과 |
| C1b | 정본 대신 `also_accept` 대체 kind | 동일(적중이며 FP 아님) | 통과 |
| C2 | 전 행 `findings: []` (깨끗한 표본의 채점기 쪽 대응) | catch 0 · FP **null** · loc **null** (0 이 아님) | 통과 |
| C2b | 입력 `[]` | n 30 유지, catch 0 | 통과 |
| C3 | 정답 위치에 틀린 kind | catch 0 · FP 1 · loc null | 통과 |
| C4 | 맞는 kind, 범위 밖 줄 | catch 1 · loc 0 · FP 0 | 통과 |
| C5 | 손계산 혼합(15행 적중 + 행당 어휘 밖 1건, 15행 무보고) | catch 15/30 · FP 15/30 · loc 15/15 | 통과 |
| C6 | 같은 입력 2회 | stdout 바이트 동일 | 통과 |
| C7 | 손상 finding(`line: 0`) | exit 1 · stdout 0바이트 · stderr 1줄 | 통과 |
| P1~P6 | 파서: 순수 배열 / 펜스 / 산문 포함 / `[]` / JSON 없음 / 잘린 배열 | direct · fence · extract · direct · 실패 · 실패 | 통과 |
| P7 | 손상 finding 분리(수선하지 않음) | 6개 중 정상 1 · 손상 5 | 통과 |
| C8 · C8b | 파서→채점기 사슬(SD-011, 3행 부분 코퍼스): 정답 답변 / `[]` | caught 1/3 · located 1/1 · FP 0 / caught 0/3 · FP null | 통과 |

19/19 통과. 스캐너 자체: `tests/bench/seeded-defect-cli.test.js` 37 + `tests/evals/seeded-defect-corpus.test.js` 47 = **84/84 green** (서브셸 `npx vitest run`, 2026-09-29T04:34Z, `setup 96ms`).

### 4-2 종단(모델 포함) 쌍 대조 — 결함 1줄만 되돌린 clean 변형

SD-011(command-injection) · SD-026(inverted-condition) · SD-009(missing-await) 각각에 대해 (a) 코퍼스 diff 그대로(결함 변형)와 (b) 결함 added 줄만 제거하고 대응 deleted 줄을 context 로 복원한 clean 변형(미끼 변경은 그대로, hunk 헤더 카운트 재계산·검증)을 본 실행과 같은 파이프라인으로 1회씩 실행하고, 3행 부분 코퍼스로 출하 러너에 채점했다.

| 변형 | 기대 | 결과(러너) |
|---|---|---|
| 결함 3건 | 3/3 caught | catch 3/3 · loc 3/3 · FP 0 (`command-injection`@8 · `inverted-condition`@17 · `missing-await`@19, 기대 범위 [8,8] · [17,17] · [19,19]) |
| clean 3건 | 0/3 caught | catch 0/3 · finding 0건(응답 `[]` 3회) · FP null |

한계: 표본 3건이다. clean 변형은 코퍼스 밖 새 자료이므로 "결함 없음"은 내 구성상 주장이다(미끼 자체는 코퍼스 저자가 defensible 로 둔 것).

### 4-3 부가 ablation (3수치와 무관, n=2)

README 정의(계약상 리뷰어에게 줘야 하는 텍스트)의 예시가 두 행의 결함을 거의 그대로 적는다: `wrong-operator` 의 "`%` for `/`" ↔ SD-023, `short-circuit-swallow` 의 "falsy 인 `0` 을 default 로 대체" ↔ SD-005. 이 두 정의에서 예시만 떼고(그 외 프롬프트는 바이트 동일) SD-005·SD-023 을 1회씩 다시 돌렸다. 결과: 둘 다 정본 kind 로 caught · located (`short-circuit-swallow`@47 · `wrong-operator`@37), FP 0. 예시 겹침이 이 두 행의 적중에 필요하지 않았다(n=2, 단일 pass — 다른 행이나 분산에 대해서는 말하지 못한다).

### 4-4 파이프라인 계수

본 실행 30회: 정상 30 · 파싱 실패 0 · API 오류 0 · 무응답 0. 파서 경로 direct 30 / 펜스 0 / 추출 0. 손상 finding 0. stderr 가 비어 있지 않은 호출 0.

## 5. 결과 상세

### 5-1 클래스별 (러너 `per_class`)

| class | n | caught | catch_rate | location_accuracy |
|---|---|---|---|---|
| logic | 5 | 5 | 1.0000 | 1.0000 |
| boundary | 5 | 5 | 1.0000 | 1.0000 |
| concurrency | 4 | 4 | 1.0000 | 1.0000 |
| security | 5 | 5 | 1.0000 | 1.0000 |
| resource | 4 | 4 | 1.0000 | 0.7500 |
| contract | 4 | 4 | 1.0000 | 1.0000 |
| docs-drift | 3 | 3 | 1.0000 | 1.0000 |

### 5-2 행별 (러너 입력과 코퍼스 대조)

| id | class | 기대 kind (허용 대체) | 기대 범위 | 리뷰어 kind@줄 | caught | located |
|---|---|---|---|---|---|---|
| SD-001 | boundary | inclusive-exclusive-mismatch (off-by-one) | 13-13 | inclusive-exclusive-mismatch@13 | Y | Y |
| SD-002 | boundary | empty-collection-unhandled | 4-8 | empty-collection-unhandled@8 | Y | Y |
| SD-003 | security | path-traversal | 11-11 | path-traversal@11 | Y | Y |
| SD-004 | contract | return-shape-mismatch | 21-21 | return-shape-mismatch@21 | Y | Y |
| SD-005 | logic | short-circuit-swallow (silent-fallback, wrong-operator) | 47-47 | short-circuit-swallow@47 | Y | Y |
| SD-006 | security | unvalidated-input | 27-32 | unvalidated-input@27 | Y | Y |
| SD-007 | contract | optional-treated-required | 13-13 | optional-treated-required@13 | Y | Y |
| SD-008 | resource | resource-leak | 14-18 | resource-leak@14 | Y | Y |
| SD-009 | concurrency | missing-await | 19-19 | missing-await@19 | Y | Y |
| SD-010 | contract | silent-fallback | 13-14 | silent-fallback@14 | Y | Y |
| SD-011 | security | command-injection | 8-8 | command-injection@8 | Y | Y |
| SD-012 | contract | error-code-mismatch | 17-17 | error-code-mismatch@17 | Y | Y |
| SD-013 | resource | resource-leak | 8-8 | resource-leak@8 | Y | Y |
| SD-014 | resource | missing-timeout | 8-8 | missing-timeout@7 | Y | N |
| SD-015 | boundary | off-by-one (inclusive-exclusive-mismatch) | 17-17 | off-by-one@17 | Y | Y |
| SD-016 | security | path-traversal | 11-13 | path-traversal@13 | Y | Y |
| SD-017 | resource | unbounded-growth | 8-9 | unbounded-growth@8 | Y | Y |
| SD-018 | docs-drift | stale-doc | 15-15 | stale-doc@15 | Y | Y |
| SD-019 | docs-drift | stale-doc | 11-11 | stale-doc@11 | Y | Y |
| SD-020 | boundary | off-by-one | 9-9 | off-by-one@9 | Y | Y |
| SD-021 | boundary | off-by-one (inclusive-exclusive-mismatch) | 25-25 | off-by-one@25 | Y | Y |
| SD-022 | logic | inverted-condition | 11-11 | inverted-condition@11 | Y | Y |
| SD-023 | logic | wrong-operator | 37-37 | wrong-operator@37 | Y | Y |
| SD-024 | concurrency | missing-await | 25-25 | missing-await@25 | Y | Y |
| SD-025 | docs-drift | stale-comment | 5-5 | stale-comment@5 | Y | Y |
| SD-026 | logic | inverted-condition | 17-17 | inverted-condition@17 | Y | Y |
| SD-027 | concurrency | check-then-act (race-on-shared-state) | 15-16 | check-then-act@15 | Y | Y |
| SD-028 | concurrency | race-on-shared-state (check-then-act) | 10-11 | race-on-shared-state@10 | Y | Y |
| SD-029 | security | secret-in-log | 19-19 | secret-in-log@19 | Y | Y |
| SD-030 | logic | missing-case | 25-27 | missing-case@27 | Y | Y |

### 5-3 위치 miss 1건 — SD-014 (`missing-timeout`)

리뷰어는 `missing-timeout` 을 **줄 7**(`export async function fetchJson…` 시그니처)에 짚었고 기대 범위는 **[8, 8]**(`fetch` 호출 줄)이다. kind 는 맞아 caught 이고 위치만 miss 로 채점됐다. 경계 사례다: README 의 범위 규칙 1(`plugins/artibot/tests/evals/fixtures/seeded-defect/README.md:150`, 현존 줄이면 단일 줄)로 읽으면 [8,8] 이 맞고, 규칙 2(`plugins/artibot/tests/evals/fixtures/seeded-defect/README.md:152`, 부재 결함은 제거 지점 앞뒤 flank 줄)로 읽으면 [7,8] 이 된다. 코퍼스는 전자를 택했다. **이번 수치는 현행 코퍼스 그대로 채점했다.** [7,8] 로 바꾸면 location 30/30 이 되지만 그것은 가정이며 코퍼스 수정은 `corpus_sha256` 핀을 바꾸므로 이 줄기 밖이다. 라벨 재검토 후보로만 기록한다(추론).

### 5-4 러너가 찍지 않는 부가 측정 (내 재계산)

- 행당 finding 수: 30행 모두 정확히 1건(최소 1 · 최대 1). 한 kind 를 여러 줄에 뿌린 행 0.
- accepted kind 인데 기대 범위 밖: 1건 / accepted 30건 (SD-014).
- finding `path` ≠ 기대 path: 0건(경로 표기 때문에 위치가 깎인 행 없음).
- 정본 kind 대신 `also_accept` 대체 kind 로만 적중한 행: 0 / `also_accept` 보유 6행 (6행 모두 정본 kind 로 적중).
- Wilson 95%(참고): catch 30/30 → [0.886, 1.000], location 29/30 → [0.833, 0.994]. 행을 독립 표본으로 본 참고치이고 합성·층화 코퍼스라 모집단 추정이 아니다.
- 비용·시간: 본 30회 $0.609 · 호출당 `duration_ms` 중앙값 3,245(최소 2,240 · 최대 8,152) · 출력 토큰 중앙값 199. 이 줄기의 중첩 호출 44회 합계 약 $0.83 (`total_cost_usd` 합).

## 6. 이 수치가 못 보는 것 (게이트 옆에 적는다)

1. **러너는 리뷰어를 실행하지 않는다** (`plugins/artibot/scripts/bench/seeded-defect.mjs:16`). 진짜 리뷰어 출력인지 손편집인지 러너는 구분하지 못한다. 이 문서의 신뢰 근거는 §3·§4 의 통제와 원출력 보존(§10)이다.
2. **3b 맹점** (`plugins/artibot/scripts/bench/seeded-defect.mjs:39`): accepted kind 를 여러 줄에 뿌려도 벌점이 없고 `location_accuracy` 는 "한 번이라도 범위 안"만 본다. 이번 실행은 프롬프트가 "결함당 1번, kind 1개"를 지시했고 행당 finding 이 정확히 1건이라 살포가 일어나지 않았다. 그러나 이는 맹점의 크기를 잰 것이 아니라 프롬프트가 그 행동을 억제한 조건이다. 살포하는 리뷰어에게는 이 3수치가 여전히 관대하다.
3. **천장**: 30/30 이면 코퍼스가 opus 를 변별하지 못한다. 1행 = 3.33%p (`plugins/artibot/tests/evals/fixtures/seeded-defect/README.md:337`), 작은 diff 는 쉬운 케이스 (`plugins/artibot/tests/evals/fixtures/seeded-defect/README.md:341`). 실패 행이 없어 코퍼스의 난이도·라벨 결함도 이 실행으로는 드러나지 않는다. 다른 티어·모델과 변별하려면 더 어려운 행이 필요하다.
4. **FP 0 은 프롬프트 조건부**: 프롬프트가 "확신하는 결함만 · 어휘 밖은 보고 금지 · 스타일/명명/테스트 부재 금지"를 지시했다. 자유 서술 리뷰였다면 어휘 밖 지적이 FP 로 잡혔을 것이다 (`plugins/artibot/tests/evals/fixtures/seeded-defect/README.md:238` 은 FP 를 "시드된 것이 아닌 finding"으로 정의하고 fabricated 모듈에 대한 정당한 다른 지적도 포함된다고 적는다). 다른 프롬프트·모델과 비교하려면 부록 B 와 같은 프롬프트여야 한다.
5. **사실상 23지선다 + 정의 제공**: 계약이 kinds 와 정의를 리뷰어에게 주라고 한다 (`plugins/artibot/tests/evals/fixtures/seeded-defect/README.md:178`, 한계는 `plugins/artibot/tests/evals/fixtures/seeded-defect/README.md:348`). 자유 형식 리뷰 능력의 점수가 아니다.
6. **리뷰어 정체는 출하된 code-reviewer 에이전트가 아니다** (§9-1). 그 에이전트 자체의 점수는 **미측정**이다.
7. **단일 pass**: 행마다 1회 표본이라 run-to-run 분산을 재지 못했다.
8. **합성·소형 diff**: 실제 리뷰(다중 파일, 이력, 호출부)에 대한 상한일 뿐 예측이 아니다.
9. **라벨은 저자의 판단**이다(`plugins/artibot/tests/evals/fixtures/seeded-defect/README.md:350`, "The labels are the author's judgement"). 이 실행이 라벨을 검증하지는 않았다. SD-014 가 경계 사례다(§5-3).
10. **호스트 컨텍스트**: 리뷰어는 코퍼스와 무관한 ~950 토큰의 호스트 컨텍스트를 함께 받았다(§3, 자기보고).

## 7. D4 래칫 후보 기록 (목표 아님, 채택 아님)

R-4 에 따라 목표 catch-rate 는 정하지 않는다. 첫 측정값을 회귀 하한·상한 래칫 *후보*로만 남긴다.

| 지표 | 첫 측정값 | 래칫 방향(후보) |
|---|---|---|
| `catch_rate` | 1.0000 (30/30) | 하한 |
| `false_positive_rate` | 0.0000 (0/30) | 상한 |
| `location_accuracy` | 0.9667 (29/30) | 하한 |

D4 결정 시 고려할 점(오너 판단 재료): (i) 단일 pass 라 점추정을 그대로 핀하면 표본 잡음에 오탐 여지가 있다 — 확정 전 반복 pass 가 필요하다. (ii) catch 가 천장이라 이 코퍼스로는 회귀 검출만 가능하고 개선이나 타 티어 비교는 변별하지 못한다. (iii) 위 값은 부록 B 프롬프트·`opus`·`corpus_sha256` 위에서만 유효하다. 코퍼스가 바뀌면(예: SD-014 라벨) 다시 재야 한다.

## 8. 미확인

- 실제 서브에이전트 effort 유효값(요청은 high, 기록 수단 없음).
- run-to-run 분산(단일 pass).
- 출하된 `code-reviewer` 에이전트 자체의 점수(§9-1).
- 다른 프롬프트에서의 FP·살포 행동.
- 호스트가 붙인 ~950 토큰 컨텍스트의 원문(모델 자기보고만 있다).
- SD-014 의 정답 범위가 [8,8] 인지 [7,8] 인지(코퍼스 저자 판단 필요).
- 이 문서를 만든 worktree 정리(teardown) 뒤 원출력 보존(§10).

## 9. 계획 정정과 환경 사실 (다른 process 줄기에 쓸모 있는 것)

1. **"리뷰어 스폰 = code-reviewer" 는 그대로 못 한다.** `plugins/artibot/agents/code-reviewer.md:48` 은 "code-reviewer는 직접 코드를 리뷰하지 않는다. 대신 두 전문 리뷰어를 순차적으로 호출한다"고 적고, `plugins/artibot/agents/code-reviewer.md:254` 는 "Do NOT review code directly", `plugins/artibot/agents/code-reviewer.md:19-26` 은 도구로 Read · Grep · Glob · Bash · `Agent(spec-reviewer)` · `Agent(quality-reviewer)` 를 준다. 파일 도구가 있는 에이전트는 코퍼스 입력 계약 5항(`plugins/artibot/tests/evals/fixtures/seeded-defect/README.md:184`, "저장소 접근·파일 도구 없이")과 양립하지 않는다(README 는 `file_hint` 를 grep 해 정답 픽스처를 읽을 위험을 명시). 또 1단계는 원 요구사항을 입력으로 요구하는데 합성 diff 에는 없다. 그래서 R-4 의 arm 정의("현 정책 리뷰어 **티어**(opus)")에 맞춰 티어를 고정하고 벤치 전용 clean-room 프롬프트로 쟀다.
2. 계획서는 `injected_diff`·`file_hint` 제공을 적었으나 README 계약은 diff 만이고 `file_hint` 는 헤더에 있다 → 정보량 동일(§3).
3. 계획서의 `.gitignore:15`(`_benchmarks/`)는 정확하다(`git check-ignore -v` 실측). V5-BACKLOG SH-08 행 비고의 "리뷰어 실행 0 → 전부 미측정"은 이 실행으로 낡았다(갱신은 리더 몫).
4. 워크트리 격리 창의 Bash 가드 실측: `cd … && … $(date) … && echo … | claude …` 형태의 복합 명령(가드 메시지: claude 에 명령이 조립한 입력을 먹이는 구조라 검증 불가)과 `$HOME` 런타임 확장이 든 node 명령은 거부, **평문 단일 명령 + env 접두 + 파일 리다이렉트 + `&&` 연결은 통과**(어느 구성요소가 거부를 일으켰는지는 분리해 보지 않았다). 중첩 `claude -p` 는 `--safe-mode` 를 쓰면 훅이 꺼져 원장을 오염시키지 않는다(위 §3 원장 위생). 세션 상속 `CLAUDE_CODE_EFFORT_LEVEL=max` 는 명령 접두로 덮어야 정책값(opus = high)이 된다.

## 10. 보존·재현

- 원출력(gitignore): worktree 안 `_benchmarks/seeded-defect/sd-opus-20260929/` — `raw/`(호출별 응답 json), `parsed/`, `reviewer-output.json`, `score-main.json`, `report-main.json`, `assemble-main.json`, `controls/`(대조·ablation·진단), `harness/`(생성기·파서·채점기 대조·리포트 스크립트), `manifest.json`(프롬프트 해시·순서·명령 접두). **worktree 정리(teardown) 때 함께 사라진다.**
- 이 문서만으로 재채점 가능: 부록 A 의 JSON 을 파일로 저장해 §2 의 채점 명령을 실행하면 같은 3수치와 같은 `corpus_sha256` 이 나온다(작성자가 문서에서 추출한 JSON 으로 다시 채점해 확인).
- 재실행하려면 §2 명령과 부록 B 프롬프트, 그리고 kinds 블록(README 표를 알파벳순으로 `- <kind>: <정의>` 형식, 블록 해시 접두 `29e1bd67a44e3c82`, 템플릿 해시 접두 `fa3f64e7af443813`)이 필요하다.

## 부록 A — 채점기 입력 (`--input` 그대로, 30행)

```json
[
{"id":"SD-001","findings":[{"kind":"inclusive-exclusive-mismatch","path":"src/limits/quota.js","line":13,"message":"The comment defines limit as the first value that is not permitted (an exclusive bound), but `used <= limit` now treats `limit` itself as allowed."}]},
{"id":"SD-002","findings":[{"kind":"empty-collection-unhandled","path":"src/stats/median.py","line":8,"message":"With the empty-input guard removed, an empty list takes the even branch with mid=0, and ordered[mid] raises IndexError instead of returning None."}]},
{"id":"SD-003","findings":[{"kind":"path-traversal","path":"src/files/download.js","line":11,"message":"The check now splits the raw name only on '/', dropping normalize() and the platform `sep`, so backslash-separated segments like '..\\..\\secret' on Windows get past it and join() resolves them outside ROOT."}]},
{"id":"SD-004","findings":[{"kind":"return-shape-mismatch","path":"src/user/lookup.ts","line":21,"message":"findUser now returns the whole rows array cast to User instead of the single row rows[0], so callers get an array rather than a User."}]},
{"id":"SD-005","findings":[{"kind":"short-circuit-swallow","path":"src/report/aggregate.js","line":47,"message":"A legitimate count of 0 from countRows is falsy, so `|| fallback` replaces it with the fallback value, which misreports empty inputs."}]},
{"id":"SD-006","findings":[{"kind":"unvalidated-input","path":"src/api/orders.ts","line":27,"message":"The schema validates ORDER_DEFAULTS instead of the merged request body, so the unvalidated `merged` object built from `req.body` is passed straight to createOrder."}]},
{"id":"SD-007","findings":[{"kind":"optional-treated-required","path":"src/profile/render.ts","line":13,"message":"profile.nickname is optional, so calling .trim() on it throws a TypeError when the nickname is undefined; the old code guarded this with ?? before trimming."}]},
{"id":"SD-008","findings":[{"kind":"resource-leak","path":"src/db/tx.js","line":14,"message":"With the try/finally removed, the pooled client is never released if BEGIN, fn(client) or COMMIT throws, so each failed transaction leaks a connection."}]},
{"id":"SD-009","findings":[{"kind":"missing-await","path":"src/queue/drain.js","line":19,"message":"flush(job) is no longer awaited, so drain returns before jobs finish flushing, the reported duration is wrong, and flush rejections become unhandled."}]},
{"id":"SD-010","findings":[{"kind":"silent-fallback","path":"src/config/load.js","line":14,"message":"Read and JSON parse errors are now caught and replaced with DEFAULTS, so a missing or corrupt config file silently yields defaults instead of failing."}]},
{"id":"SD-011","findings":[{"kind":"command-injection","path":"scripts/tools/archive.sh","line":8,"message":"The unquoted $dest and $name are interpolated into an eval string, so shell metacharacters in either argument run as arbitrary commands."}]},
{"id":"SD-012","findings":[{"kind":"error-code-mismatch","path":"src/api/errors.py","line":17,"message":"NotFound is now returned with HTTP 200 instead of 404, so a missing resource looks like a successful response."}]},
{"id":"SD-013","findings":[{"kind":"resource-leak","path":"src/io/reader.py","line":8,"message":"The file handle from open() is never closed on any path, including when DictReader raises, because the with-block was removed."}]},
{"id":"SD-014","findings":[{"kind":"missing-timeout","path":"src/http/fetchJson.ts","line":7,"message":"The AbortController and its 5-second timeout were removed, so the fetch can now wait forever on a slow or hung server with no deadline or cancellation."}]},
{"id":"SD-015","findings":[{"kind":"off-by-one","path":"src/text/wrap.py","line":17,"message":"Changing the loop condition to `i <= len(line)` runs one extra iteration whenever len(line) is a multiple of width, appending a spurious empty chunk."}]},
{"id":"SD-016","findings":[{"kind":"path-traversal","path":"src/files/serve.py","line":13,"message":"The '..' check runs on the raw name before unquote(), and the containment check was removed, so '%2e%2e/' sequences or an absolute path escape ROOT."}]},
{"id":"SD-017","findings":[{"kind":"unbounded-growth","path":"src/log/buffer.js","line":8,"message":"The MAX_ENTRIES trim was removed, so the module-level entries array now grows without limit on every push unless clear() is called."}]},
{"id":"SD-018","findings":[{"kind":"stale-doc","path":"docs/cli/export.md","line":15,"message":"The example still says running with no flags produces a csv file, but the Flags section now says the default format is json."}]},
{"id":"SD-019","findings":[{"kind":"stale-doc","path":"docs/api/rate-limits.md","line":11,"message":"The unchanged text still says the default ceiling is 60 requests per minute, but the table now lists no plan at 60 (free is 120, team is 240), so the doc contradicts itself."}]},
{"id":"SD-020","findings":[{"kind":"off-by-one","path":"src/paging/window.js","line":9,"message":"The end bound adds an extra +1, so each page returns size+1 items and overlaps the first item of the next page."}]},
{"id":"SD-021","findings":[{"kind":"off-by-one","path":"src/schedule/slots.ts","line":25,"message":"The loop bound `i <= slots.length` reads `slots[slots.length]`, which is undefined, so `.start` throws when no slot matches."}]},
{"id":"SD-022","findings":[{"kind":"inverted-condition","path":"scripts/sync/publish.sh","line":11,"message":"`[ -s \"$manifest\" ]` is true when the manifest exists and is non-empty, so the script rejects valid manifests and continues on missing or empty ones; it should be `[ ! -s \"$manifest\" ]`."}]},
{"id":"SD-023","findings":[{"kind":"wrong-operator","path":"src/billing/proration.py","line":37,"message":"Proration uses modulo `%` instead of division `/`, so it returns the remainder of amount*used over total rather than the prorated share."}]},
{"id":"SD-024","findings":[{"kind":"missing-await","path":"src/cache/warm.ts","line":25,"message":"Neither load(key) nor store.set is awaited, so a Promise is cached instead of the value, load and set errors are lost, and warm() returns before the cache is actually filled."}]},
{"id":"SD-025","findings":[{"kind":"stale-comment","path":"src/queue/retry.py","line":5,"message":"The comment still says 3 retries with a 1 second pause, but the code now makes `attempts` tries (default 5) with exponential backoff (2**i seconds)."}]},
{"id":"SD-026","findings":[{"kind":"inverted-condition","path":"src/cart/discount.js","line":17,"message":"The check was flipped from `!user.active` to `user.active`, so active members now get no discount and inactive users get one."}]},
{"id":"SD-027","findings":[{"kind":"check-then-act","path":"src/fs/marker.js","line":15,"message":"The existsSync check followed by writeFileSync is not atomic, unlike the old openSync 'wx'; two concurrent callers can both see the marker as absent and both return true."}]},
{"id":"SD-028","findings":[{"kind":"race-on-shared-state","path":"src/counter/hits.py","line":10,"message":"record() no longer holds _lock, so concurrent calls can read the same count and lose increments."}]},
{"id":"SD-029","findings":[{"kind":"secret-in-log","path":"src/auth/session.js","line":19,"message":"The session token, a bearer credential, is now written to the info log."}]},
{"id":"SD-030","findings":[{"kind":"missing-case","path":"src/notify/channel.ts","line":27,"message":"The 'sms' case was removed, so SMS channels now fall through to default and return null instead of an SMS delivery."}]}
]
```

## 부록 B — 리뷰어 프롬프트

시스템 프롬프트(`--system-prompt`):

```text
You are a senior code reviewer. You have no tools and no repository access; you can only read the text you are given.
```

사용자 메시지(stdin) = 아래 머리말 + 빈 줄 + `KINDS:` 블록(23줄, 알파벳순, README 정의 원문) + 빈 줄 + `THE CHANGE (unified diff):` + `<<<BEGIN DIFF>>>` + 행의 `injected_diff` + `<<<END DIFF>>>`.

```text
You are reviewing one code change, shown below as a unified diff. The diff is all you have: no repository, no other files, no tools, and no way to run anything. Judge the change from this text alone.

Find the defects in this change. A defect may be in a changed line, or in an unchanged line that the change makes wrong. The change may contain any number of defects, including none. Report only defects you are confident are real, report each defect once with one kind, and do not report style, naming, formatting or missing tests.

OUTPUT FORMAT (follow exactly):
- Reply with one JSON array and nothing else: no text before or after it and no markdown code fence.
- Each element is an object with exactly these four keys:
  "kind": one of the KINDS listed below, spelled exactly as listed. If several kinds could fit, choose the one that names the root cause most precisely. A defect that fits none of the kinds is not reported.
  "path": the file path exactly as in the diff's "+++ b/" header, without the "b/" prefix.
  "line": an integer - the 1-based line number, counted in the file as it is AFTER the change is applied, of the line that best shows the defect. In a hunk header "@@ -a,b +N,c @@", N is the new-file line number of the first line the hunk shows. Count that line and every following context line (leading space) and added line (leading "+"); never count removed lines (leading "-").
  "message": one short sentence saying what is wrong.
- If the change has no defect you are confident about, reply with [].
```
