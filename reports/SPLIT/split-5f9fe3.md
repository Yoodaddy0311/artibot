# /split 회고 — split-5f9fe3 (2026-09-05, nowhe 머신)

> 4차 배치. 창 5개(사용자 허가로 `maxWindows` 4→5), 줄기 5 + 리더 브랜치 1 을 단일 배치 `8a874512` 로 착지. 실오퍼레이터 데이터 **n=3** (8f83d7 · 9d6dc2/ff6c63 · 5f9fe3). 로컬 전용 원장(`.artibot/split/{plan,run}.json`·`gotchas.md` #G1~#G25·`runtime/split/split-5f9fe3.events.ndjson` 29이벤트)의 요지본이다.

## 0. 결과

| 항목 | 값 |
|---|---|
| base → master | `09379037`(origin) → **`8a874512`** (배치 6브랜치, ff 수락, rebuilds 0) |
| 변경 | 49파일 +6,383/−356 (`git diff --stat 09379037 8a874512`) |
| 줄기 | usage-receipt `71f3a5ed` · state-store `e1e55750` · human-asked-sym `5aecccfd` · ups-source-guard `5f964aa7` · route-coverage `79f0dabc` · leader-guardrail `f818cdc0` — 6/6 배치 잔여 diff 0(리더 실측 09:47) |
| land | 5/5 PASS(lint 행은 러너 결함 #G14 로 리더가 worktree cwd 재측정 대체) · citations FAIL 1회(픽스처 절대경로 → 동일 길이 치환) |
| 교차 감사 | 4줄기 + 리더 델타 = 5건. 줄기 구현 반증 **0**(18+34+22+18 주장). 리더 전제·중계 반증 **6건** |
| CI | 1회차 `not-green`(15,168 pass / 3 fail) → 리더 수리 → 2회차 `push-failed`(사이드 브랜치 non-ff, #G25) → 3회차 7/7 그린 |
| wall-clock | run **87m24s**(23:04:03Z → 00:45:54Z) · open-windows 12m19s(humanWait) · wait-limbs 47m30s · confirm-integrate 0(위임) · humanWaitPct **14.1%**(미쌍 2 — start 중복 기록, 값은 세그먼트 합으로 유효) |
| 팬아웃 | 5창 distinct agentId 43(6+10+7+10+10, start∪stop; stop-only 재개분 포함) |

## 1. 무엇이 착지했나 (NECESSARY 1~3 최소 단위 + 결함 2)

| limb | 요구 | 착지 내용 | 핵심 실측 |
|---|---|---|---|
| usage-receipt | N2 | SessionEnd 훅 → `usage.receipt` writer(`lib/economics/receipt-envelope.js` 신설, `session-end.js#recordUsageReceipts`), `source:'hook'`(allowlist +1), idempotency key `event:session:run:model` | 실전 4.4MB transcript 10건/152ms, 재발화 deduped 10/appended 0, 표적 123/123 |
| state-store | N1 | `tasks.js` → `createStateStore` 배선, `state.updated` 1:1, `state.yaml` 투영, `git-common-dir.js`(pure-fs) · **P1**: `checkStateVersionGaps` 멀티레코드 오판 수리(`foldTransactions`) | N=1000 프로브 p90 14.8ms, gaps fail→pass, 371/373 |
| human-asked-sym | N3 | `lib/runtime/human-asked-record.js` 헬퍼(L5), pre-write/guard block 지점 `human.asked` 대칭, **차단 확대 0**, pre-bash stdout 바이트 동일 | 312/312(11파일), 뮤테이션 3단 RED, 원장 실발화 3종 |
| ups-source-guard | 결함 | UPS 디스패처 `source` allowlist(`user`,`sdk`) + `<task-notification>` 마커 → 통지 0B/0줄 · 드리프트 테스트 npm 호스트 탐색 | 116/116, 격리 뮤테이션(가드 제거 → 19:02Z 사고 재현) |
| route-coverage | 라이브 ④ | `AGENT_ACTION_CLASS` 20→32(로스터 30 + host 2, 면제 2), census allowlist 테스트, `skipped:unbound` 계약 주석·테스트 | 시뮬 3/8→7/8, 492/492 |
| leader-guardrail | — | guardrail 오탐 allowlist 4종 · claims registry `tests` 키+드리프트 15건 · `.artibot/state.yaml` gitignore · CI 수리 3건 | 배치 트리 tests/ci 860/860 |

## 2. 이번 런이 잡은 실결함 (그린 상태에서)

| # | 결함 | 발견자 | 등급 |
|---|---|---|---|
| 1 | `checkStateVersionGaps` 가 트랜잭션 멀티레코드를 duplicate 로 오판 → 배선 후 라이브 Check 8/9 상시 FAIL | state-store 창 **규모 프로브**(픽스처 1레코드/버전 = §9 미도달) | P1, 착지 |
| 2 | 하네스 task-notification 이 UserPromptSubmit 으로 컴파일돼 mission title 오염 | 오토파일럿 팀원 D | P1, 착지 |
| 3 | guardrail "denied — Agent" 문구 오탐(창 4개 30분 손실 이력) | 리더 실측 | P1, 착지 |
| 4 | `land.mjs` lint 행이 부모 cwd 라 줄기 신규 파일 미탐(3/5 줄기 FAIL 오탐) | 리더 | 러너, 백로그 |
| 5 | `landBatch` 재시도 시 사이드 브랜치 non-ff | 리더 | 러너, 백로그 |
| 6 | `claude --worktree` 가 origin/master 에서 분기(로컬 미푸시 커밋과 base 어긋남 → land 전건 FAIL 위험) | 리더 | 절차, gotchas #G1 |

## 3. 리더 오류 원장 (6+3, 전부 창·감사관이 교정)

| # | 오류 | 교정자 |
|---|---|---|
| 1 | 브리프 인용 `subagent-handler.js:36-39`(실제 :242) | route-coverage |
| 2 | 헬퍼 경로 `lib/security/`(L2 → runtime import 레이어 위반) | human-asked-sym |
| 3 | "guard 는 approve 2곳만"(block 경로 실재) | human-asked-sym |
| 4 | "마케팅 7종"(presentation-designer 는 design) | 감사관 |
| 5 | "writeStdout 계약"(session-end.js 는 stdout 0) | 감사관 |
| 6 | 감사 지시에 "312/312" 를 분모 없이 중계(4경로는 185) | 감사관 |
| 7 | 격리 사본에 `.artibot/split/` 없음(브리프 경로) | 감사관 |
| 8 | Observe "산출물 0" 문구 과도(스토어 저널은 정상) | 감사관 |
| 9 | 브리프 allowlist 에 "깨질 테스트"(T-25)·"심볼 이동 시 전역 인용" 누락 → CI red 2건 | CI |

**승격 규칙(다음 브리프부터)**: ① 신설 파일 경로는 `eslint.config.js` 레이어 블록 선확인 ② affectedPaths 에 소스 심볼을 grep 한 테스트·문서 인용 파일 동반(#14·#23·#G24) ③ 배선 줄기 완료 기준에 "실규모 프로브 1회" ④ 수치 중계 시 분모(파일 세트) 필수 ⑤ 픽스처는 절대경로 치환 후 커밋 ⑥ 감사 지시의 브리프 경로는 부모 루트.

## 4. 라이브 실증

- **base 분기점**: `claude --worktree` 5/5 가 `origin/master`(09379037) 에서 분기 — 로컬 master 가 1커밋 앞이면 plan.base 를 merge-base 로 재확정해야 land 가 산다(#G1).
- **트레일러 배치**: 하네스가 `Co-Authored-By`·`Claude-Session` 을 마지막 블록으로 덧붙여 `-m 'Split-Limb: done'` 이 파서에 빈 값 — `--trailer` 또는 같은 블록(-F) 만 유효(#G10). 5/5 창 교정 성공.
- **끝난 창 재활용**: 교차 감사(읽기 전용, `git clone --shared` 격리 사본)로 4건 회수 — 소유권·커밋 0 이라 안전, 실결함은 없었으나 리더 전제 6건 교정. 구현형 wave 2 는 통합 후 새 worktree 가 정석.
- **Guardrail 오탐 무력화**: 포인터에 한 줄 경고를 실어 5/5 창이 스폰 강행(스폰 43).

## 5. 백로그 (gotchas #G8·#G9·#G11·#G13·#G15·#G16·#G20·#G22·#G25 요지)

| 우선 | 항목 |
|---|---|
| P1 | `land.mjs` lint 행 worktree cwd · `landBatch` 사이드 브랜치 lease push + 이름 접두 중복 · `commands/doctor.md` Check 8 호출 예 `project` 인자 누락(모든 /split 워크트리 위양성) |
| P1 | UPS 디스패처가 `<cross-session-message>` 인사도 컴파일함(이번 런 인사 5건이 팀 권고 주입) — `source` 가드가 이것도 막는지 라이브 확인 |
| P2 | `route.unreceipted` 마커(allowlist 신설 = 오너) vs 전사 분모 읽기모델 · Check 10 "발화-무기록" cannot-see 문장 · COMMAND_ACTION_CLASS JSDoc 정합 · `reader applyUsageReceipt` 최신값 우선 · allowlist spec "ONLY writer" 어휘 · session-end.js 800줄 분리 · 이벤트별 sources 게이트 부재 · `human.resolved` writer(없으면 outcome 게이트 채무 누적) · 카탈로그 `claude-fable-5`·`claude-opus-4-8` |
| 라이브 판정(릴리스 후) | PreToolUse 페이로드 `cwd`/`session_id` 실재(없으면 human.asked 프로덕션 기록 0) · SessionEnd payload `cwd` · `/doctor` Check 8-②/9 PASS · Explore/investigator 영수증 생성 |

## 6. 측정 고지
1. 실오퍼레이터 데이터 3건(n=3) — `/split` vs `-fast` 속도 비교는 여전히 주장할 수 없다.
2. wall-clock 은 인간 대기 포함 — open-windows 739,065ms · confirm-integrate 2ms(오너 위임, 0길이 기록).
3. 사람 대기 비율 14.1%(분자 739,071 / 분모 5,243,993ms, 측정시각 00:45:54Z, 미쌍 2건 = run·wait-limbs start 중복 기록이라 값은 유효) — `humanWaitReevalPct`=50 대비 **미만**. 판정과 C단계 재개는 사람이 결정한다.
