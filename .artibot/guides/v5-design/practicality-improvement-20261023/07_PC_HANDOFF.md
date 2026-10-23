# 07. PC 인수인계 — 클라우드 세션이 못 한 것, 사용자 PC 와 오너 결정으로 넘기는 것 (2026-10-23)

- **출발점**: `git fetch origin && git checkout claude/jolly-newton-qmi4eb` (master `6149446e` 위의 커밋 전부 — 수는 `git log --oneline origin/master..claude/jolly-newton-qmi4eb` 로 센다; 문서 커밋·코드 커밋(RED→GREEN 단위)·측정 기록 커밋 세 종류다). 이 폴더의 [README](README.md) 가 목차다. 클라우드 세션(Linux 컨테이너, 중첩 `claude` 인증 불가, 라이브 원장·세션 스토어 없음)에서 할 수 있는 것은 전부 끝냈고([05 §8](05_REVISED_DESIGN.md)·[06](06_PIPELINE_AUDIT.md)), 아래는 **그 PC 에서만** 되는 것과 **오너만** 정할 수 있는 것이다.
- 표기: ☐ 할 일 · 예상 소요 · 산출물. 수치는 실행 뒤 재현 명령과 함께 05 §8.1 또는 06 에 덧붙인다(규율: 수치에는 재현 명령).

## 0. 시작 — 이 PC 에서 첫 10분 (러너)

이 폴더의 `pc-handoff.mjs` 가 아래 §A 를 실행 가능한 형태로 묶은 러너다(의존성 0 · Node 20+ · 모델 호출 0 — `claude` 는 `--version`/`--help` 로만 띄우고, 비용이 드는 명령은 출력만 한다). 리포 루트에서:

```bash
node .artibot/guides/v5-design/practicality-improvement-20261023/pc-handoff.mjs                 # 점검(브랜치·HEAD·clean·node·claude 버전과 실험 플래그·설치본 vs 브랜치·상태 디렉터리·원장·vitest) + §A 순서 + 킥오프 프롬프트
node .artibot/guides/v5-design/practicality-improvement-20261023/pc-handoff.mjs census          # §A-2 — 라이브 분모 3종 → evidence/pc-handoff-census-<날짜>.md (+ JSON 사이드카; 있는 파일은 덮지 않음)
node .artibot/guides/v5-design/practicality-improvement-20261023/pc-handoff.mjs tests [--full]  # §A-4 — Windows 재현 3파일(--maxWorkers=4) / 전체(--maxWorkers=8, 리포터 스냅샷 gitSha 출력)
node .artibot/guides/v5-design/practicality-improvement-20261023/pc-handoff.mjs host-probe      # §A-3 — 호스트 통합 명령·프롬프트 출력(몇 센트) → 실행 뒤 host-probe --verify 로 PASS/FAIL
node .artibot/guides/v5-design/practicality-improvement-20261023/pc-handoff.mjs experiment-plan # §C — 05 §4 매니페스트 골격 24개 + D-07 군별 명령·사전 점검 (reports/ 아래, gitignore)
```

새 Claude Code 세션을 리포 루트에서 열고 다음을 붙이면 바로 이어진다(러너의 기본 출력 끝에도 같은 글이 나온다):

> 브랜치 `claude/jolly-newton-qmi4eb` 의 인수인계를 이어서 진행해줘. 먼저 .artibot/guides/v5-design/practicality-improvement-20261023/07_PC_HANDOFF.md 를 읽어. 러너는 같은 폴더의 pc-handoff.mjs 이고 리포 루트에서 node 로 돌린다(인자 없이 돌리면 점검과 다음 순서가 나온다). 순서는 07 §A 그대로다: (1) check 로 설치본·로드 확인 — 릴리스 전이면 --plugin-dir 로 한 세션만, (2) census 로 라이브 분모 3종을 evidence/ 에 기록하고 evidence/README 표에 행을 더해, (3) tests 로 Windows 재현(전체는 --full), (4) host-probe 가 출력한 명령으로 호스트 통합 테스트 — 비용(몇 센트)을 먼저 말하고 내 확인을 받은 뒤 실행, 끝나면 host-probe --verify, (5) claude --debug 로 훅 지연 1회. 수치는 전부 재현 명령과 함께 05 §8.1 에 덧붙이고, 07 §B 의 결정 8건은 기본값대로 두되 내가 정할 것을 질문 목록으로 올려. 비교 실험(§C)은 예산 결정 전에는 experiment-plan 의 골격 생성까지만. 커밋은 이 브랜치에만 하고 PR 은 열지 마.

러너가 쓰는 곳은 둘뿐이다: `census` 는 `evidence/`(증거), `experiment-plan` 은 `reports/`(gitignore). 나머지는 읽기 전용이다. 클라우드 컨테이너에서 전 명령을 한 번씩 돌렸다 — 빈 스토어에서는 세 census 가 `unmeasured:*` 를 적고, 격리 홈에 훅을 직접 넣은 뒤 `host-probe --verify` 는 PASS 를 냈다(05 §8.1).

## A. PC 에서 돌릴 것 (API 비용 0)

1. ☐ **설치·로드 확인** — 이 브랜치를 그대로 쓰려면 플러그인 설치본을 갱신해야 한다(NEXT-SESSION 의 절차: 마켓 사본 ff → `claude plugin marketplace update artibot` → `claude plugin update artibot@artibot` → `bash plugins/artibot/install.sh files` → 재시작 후 상태줄 확인). 릴리스 전이라면 **워킹트리 플러그인을 `--plugin-dir plugins/artibot` 로 한 세션만 태우는** 쪽이 안전하다. 5분.
2. ☐ **라이브 분모 3종**(Wave 0, 05 §5·06 §5) — 리포 루트에서:
   ```bash
   node plugins/artibot/scripts/ledger/verify-result-census.mjs            # REPORT 도달 세션 중 verifyResult 가 PASS/FAIL/UNMEASURED 인 비율, 'explicit-pass' 로 바꾸면 늘어날 pause 수
   node plugins/artibot/scripts/ledger/loop-detection-census.mjs           # 루프 감지 warn/block 수 · 도구 분포 · 반복 fingerprint (설치본이 D-01 을 포함한 뒤부터 쌓임)
   node plugins/artibot/scripts/ledger/existence-audit.mjs                 # 훅·스킬·커맨드 발화 수와 소비처 — "소비처 0 + 발화 0 이 2릴리스 연속" 후보 목록
   ```
   산출: 세 JSON 한 줄씩 → 05 §8.1 에 붙이고, `existence-audit` 결과는 06 §8 #3(a) 의 분류 입력이다. 러너 `pc-handoff.mjs census` 가 셋을 돌려 `evidence/pc-handoff-census-<날짜>.md` 에 재현 명령·상태·JSON 을 쓰고(큰 JSON 은 사이드카), evidence/README 표에 붙일 행을 출력한다. 10분.
3. ☐ **훅 통합 테스트(실제 호스트)** — 작은 git 리포에서 `claude --plugin-dir <checkout>/plugins/artibot -p "<같은 README.md 를 Read 로 3번 + Bash 로 echo artibot-probe 1번>" --output-format stream-json --verbose --include-hook-events --max-budget-usd 0.2` 를 돌리고(정확한 명령과 프롬프트는 `pc-handoff.mjs host-probe` 가 출력한다) `~/.claude/artibot/runtime/sessions/<sid>/loop-state.json` 에 `history` 4(Read 3 + Bash 1)와 `detections` 1건(warn, count 3)이 생기는지, `~/.claude/artibot/tool-history.json` 의 `contexts` 에 `bash:unknown:shell` 키가 생기는지 본다 — `pc-handoff.mjs host-probe --verify` 가 이 세 기준으로 PASS/FAIL 을 낸다. 기준값은 같은 payload 를 훅에 직접 넣은 격리 재현의 실측이다(05 §8.1). 이것이 D-01·D-03 의 "호스트 통합 PASS" 다. 몇 센트, 10분.
4. ☐ **Windows 재현** — `npx vitest run tests/hooks/tool-tracker-loop-state.test.js tests/hooks/tool-tracker-bash-receipt.test.js tests/autopilot/report-verify-gate-deterministic.test.js --maxWorkers=4` (경로·원자 쓰기·`git.exe` 유무가 다르다). 테스트 전체는 `npm test -- --maxWorkers=8`(NEXT-SESSION 규칙). 러너로는 `pc-handoff.mjs tests`(3파일) · `tests --full`(전체 + 리포터 스냅샷의 gitSha·failed 출력). 5분.
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
- 본 실험: 6과제 × B/C × 2회 = 24실행. 매니페스트는 05 §4 — `pc-handoff.mjs experiment-plan [--budget-usd N]` 이 골격 24개와 머리(`MANIFEST-HEAD.json`, 무작위 실행 순서 포함)를 `reports/practicality-experiment-<날짜>/`(gitignore)에 만들고 D-07 군별 명령·사전 점검을 출력한다; 예산이 없으면 골격만. 결과는 `evidence/` 관례로 보관(리포에는 요약만), 06 §6 의 "이 필드에 통제 비교 공개 0" 상태를 바꾸는 첫 데이터가 된다.

## D. 클라우드 세션에서 다시 할 수 있게 하려면

- 환경 설정의 네트워크 비밀에 읽기 전용 API 토큰을 두면(변수 `ANTHROPIC_API_KEY`) 다음 세션은 A-3 와 C 를 직접 돌릴 수 있다. 토큰을 채팅에 붙이지 않는다.

## E. 이 브랜치의 상태

- 코드 변경은 전부 테스트와 함께 있고(전체 vitest 28,090건 중 환경 요인 1건 외 그린 — 05 §8.1), 모델에 보이는 두 키는 OFF 다. 바로 바뀐 운영 동작은 넷이다: 루프 이력이 세션별로 매 호출 저장됨 · 미분류 Bash 가 학습 행에 들어감 · 설정 읽기 실패가 경고로 보임 · 두 스킬이 활성화 때 전체 테스트를 돌리지 않음(+ 스킬 본문 선읽기 OFF, 토큰 라벨 정정).
- PR 은 열지 않았다. 열 때는 커밋을 그대로(코드 커밋 각각이 RED→GREEN 단위) 또는 레인별로 묶는다.
