# 07. PC 인수인계 — 클라우드 세션이 못 한 것, 사용자 PC 와 오너 결정으로 넘기는 것 (2026-10-23)

- **출발점**: `git fetch origin && git checkout claude/jolly-newton-qmi4eb` (master `6149446e` 위 13 커밋: 문서 4 + 코드 5 + 기록 4). 이 폴더의 [README](README.md) 가 목차다. 클라우드 세션(Linux 컨테이너, 중첩 `claude` 인증 불가, 라이브 원장·세션 스토어 없음)에서 할 수 있는 것은 전부 끝냈고([05 §8](05_REVISED_DESIGN.md)·[06](06_PIPELINE_AUDIT.md)), 아래는 **그 PC 에서만** 되는 것과 **오너만** 정할 수 있는 것이다.
- 표기: ☐ 할 일 · 예상 소요 · 산출물. 수치는 실행 뒤 재현 명령과 함께 05 §8.1 또는 06 에 덧붙인다(규율: 수치에는 재현 명령).

## A. PC 에서 돌릴 것 (API 비용 0)

1. ☐ **설치·로드 확인** — 이 브랜치를 그대로 쓰려면 플러그인 설치본을 갱신해야 한다(NEXT-SESSION 의 절차: 마켓 사본 ff → `claude plugin marketplace update artibot` → `claude plugin update artibot@artibot` → `bash plugins/artibot/install.sh files` → 재시작 후 상태줄 확인). 릴리스 전이라면 **워킹트리 플러그인을 `--plugin-dir plugins/artibot` 로 한 세션만 태우는** 쪽이 안전하다. 5분.
2. ☐ **라이브 분모 3종**(Wave 0, 05 §5·06 §5) — 리포 루트에서:
   ```bash
   node plugins/artibot/scripts/ledger/verify-result-census.mjs            # REPORT 도달 세션 중 verifyResult 가 PASS/FAIL/UNMEASURED 인 비율, 'explicit-pass' 로 바꾸면 늘어날 pause 수
   node plugins/artibot/scripts/ledger/loop-detection-census.mjs           # 루프 감지 warn/block 수 · 도구 분포 · 반복 fingerprint (설치본이 D-01 을 포함한 뒤부터 쌓임)
   node plugins/artibot/scripts/ledger/existence-audit.mjs                 # 훅·스킬·커맨드 발화 수와 소비처 — "소비처 0 + 발화 0 이 2릴리스 연속" 후보 목록
   ```
   산출: 세 JSON 한 줄씩 → 05 §8.1 에 붙이고, `existence-audit` 결과는 06 §8 #3(a) 의 분류 입력이다. 10분.
3. ☐ **훅 통합 테스트(실제 호스트)** — 작은 git 리포에서 `claude --plugin-dir <checkout>/plugins/artibot -p "같은 파일을 Read 로 3번 읽어라" --output-format stream-json --include-hook-events --max-budget-usd 0.2` 를 돌리고 `~/.claude/artibot/runtime/sessions/<sid>/loop-state.json` 에 `detections` 3건과 `history` 3이 생기는지, `tool-history.json` 에 Bash 행이 `bash:test:shell`/`bash:unknown:shell` 로 들어가는지 본다. 이것이 D-01·D-03 의 "호스트 통합 PASS" 다(지금은 훅 직접 스폰 재현까지만 실측). 몇 센트, 10분.
4. ☐ **Windows 재현** — `npx vitest run tests/hooks/tool-tracker-loop-state.test.js tests/hooks/tool-tracker-bash-receipt.test.js tests/autopilot/report-verify-gate-deterministic.test.js --maxWorkers=4` (경로·원자 쓰기·`git.exe` 유무가 다르다). 테스트 전체는 `npm test -- --maxWorkers=8`(NEXT-SESSION 규칙). 5분.
5. ☐ **훅 지연 실측(P-13)** — `claude --debug` 로 Write/Edit 1회의 PreToolUse 5개 훅 소요를 읽는다. 06 §2 의 벤치(샌드박스, 호스트 IPC 제외)와 비교해 디스패처 통합(06 §8 #6)을 할지 정한다. 10분.

## B. 오너 결정 (가치 결정만 — 사실은 조사로 해소됨)

| # | 결정 | 기본값(결정 없으면) | 근거 위치 |
|---|---|---|---|
| 1 | 루프 제어의 최종 형태 — 권고(`cognitive.loopDetector.advisory=true`)에서 멈출지, 오탐 데이터 뒤 PreToolUse deny 를 열지 | 키 OFF 유지, 2번 census 로 오탐 표본부터 | 05 §7 #1 · D-02 |
| 2 | REPORT 게이트 `evidenceMode` 목표값(`'ack'` → `'explicit-pass'` → `'deterministic'`)과 테스트 없는 작업의 예외 정책 | `'ack'` 유지, 2번 census 의 `wouldPauseUnderExplicitPass` 를 본 뒤 | 05 §7 #2 · D-04 |
| 3 | config invalid 의 정책(fail-open 유지 vs fail-closed) | 기존 결정 #4(2026-10-05) 유지 | 05 §7 #3 |
| 4 | 비교 실험 예산(USD) 과 B 군 정의 | 시작 안 함 | 05 §7 #4 · 02 |
| 5 | IMP/D 항목의 거처(이 폴더 vs V5-BACKLOG §3 부채 트랙) | 이 폴더 | 05 §7 #5 |
| 6 | `disable-model-invocation` 분류 — 스킬 105 · 커맨드 76 이 매 턴 목록에 실린다(06 §1·§8 #3(a)). 2번의 existence-audit 로 "모델이 실제로 부른 것" 을 보고 작업형(사람이 `/name` 으로 부르는 것)을 뺀다 | 현행 | 06 §8 #3(a) |
| 7 | `rules/verification-discipline.md` 12,910자 축약(사례 서술 분리) — 오너가 손본 규칙 4개와 겹침 | 현행 | 06 §8 #5 · NEXT-SESSION v4.71.11 |
| 8 | 정적 배선 감사 도구(`triage-wiring-gaps.mjs`)의 입력 재생성 경로 복원 vs 폐기 | 현행(실행 불가) | 06 §0 #6 |

## C. 비교 실험 (결정 4 뒤, API 비용 발생)

- 절차는 [02](02_BASELINE_ROI_PROTOCOL.md) 를 [05 §4](05_REVISED_DESIGN.md) 로 고친 것. 격리는 05 D-07(`CLAUDE_CONFIG_DIR` · `--setting-sources project` · `--plugin-dir` · `--bare`; 프로젝트 `CLAUDE.md` 의 Artibot 절 제거).
- 첫 시운전(Phase 0 잔여, API 0): B 군 프로필에서 `node plugins/artibot/scripts/ledger/usage-cost-table.mjs --projects-dir <B의 CLAUDE_CONFIG_DIR>/projects --live-session <id>` 가 transcript 를 영수증으로 접는지 확인(05 §6 미확인).
- 본 실험: 6과제 × B/C × 2회 = 24실행. 매니페스트는 05 §4. 결과는 `evidence/` 관례로 보관, 06 §6 의 "이 필드에 통제 비교 공개 0" 상태를 바꾸는 첫 데이터가 된다.

## D. 클라우드 세션에서 다시 할 수 있게 하려면

- 환경 설정의 네트워크 비밀에 읽기 전용 API 토큰을 두면(변수 `ANTHROPIC_API_KEY`) 다음 세션은 A-3 와 C 를 직접 돌릴 수 있다. 토큰을 채팅에 붙이지 않는다.

## E. 이 브랜치의 상태

- 코드 변경은 전부 테스트와 함께 있고(전체 vitest 28,090건 중 환경 요인 1건 외 그린 — 05 §8.1), 모델에 보이는 두 키는 OFF 다. 바로 바뀐 운영 동작은 넷이다: 루프 이력이 세션별로 매 호출 저장됨 · 미분류 Bash 가 학습 행에 들어감 · 설정 읽기 실패가 경고로 보임 · 두 스킬이 활성화 때 전체 테스트를 돌리지 않음(+ 스킬 본문 선읽기 OFF, 토큰 라벨 정정).
- PR 은 열지 않았다. 열 때는 커밋 13개를 그대로(각 커밋이 RED→GREEN 단위) 또는 레인별로 묶는다.
