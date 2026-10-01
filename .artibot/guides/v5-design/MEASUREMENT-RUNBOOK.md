# 실사용 프로젝트 측정 런북 — v5.1 트랙 Shadow·Canary 판정 (다른 리포용, 2026-09-30)

- 대상: 오너와, 오너의 새 플랫폼 프로젝트(이하 대상 리포)에서 이 절차를 수행하는 세션.
- 목적: 대상 리포에서 Artibot 플러그인을 실제로 쓰며 Shadow·Canary 판정의 입력(분자·분모·측정 시각)을 만들고, 이 리포 백로그로 되돌린다.
- 관련 문서: 결정 배경 [V5-RESCOPE-20260930.md](V5-RESCOPE-20260930.md) · 행의 정본 [V5-BACKLOG.md](V5-BACKLOG.md) · 증거 보관 관례 [evidence/README.md](evidence/README.md) · 판정 기준의 정본 [ARTIBOT-5.0-DESIGN.md](ARTIBOT-5.0-DESIGN.md) §4.
- 기준: master `1ec215bf` 트리, 설치본 4.69.0(홈 `installed_plugins.json` 열람 2026-09-30, `gitCommitSha` `ad8e5b28`). 체감 패키지(v4.70.0 계획)가 착지하면 §1.4 의 스위치 값이 달라진다.
- 검증 수준: 명령은 스크립트 머리 주석의 USAGE 와 커맨드 문서에서 옮겼고 파일 존재는 Glob 으로 확인했다. 이 문서를 쓴 작업자에게는 셸이 없어 **어떤 명령도 실행하지 못했다**. 첫 실행은 §5 의 점검으로 검증한다. 미확인은 §8 에 모았다.
- 예외 — §3.6 한 줄 census: 그 스크립트(`v51-census.mjs`)는 이 리포 작업 트리에서 실행했다(실측 2026-09-30, 출력은 §3.6 에 인용). §1~§7 의 나머지 명령이 미실행이라는 위 문단은 그대로다.
- 절 참조: 숫자만 있는 §N 은 이 문서의 절이고, 백로그의 절은 "백로그 §N" 이나 소문자 접미가 붙은 §4-c 처럼 쓴다.
- 이 문서의 위치: 배포 사용자용이 아니라 이 리포 내부 절차라서 `plugins/artibot/docs/` 가 아닌 이 디렉터리에 둔다. 이유는 셋이다. (1) 결과를 되돌리는 절차(백로그 · 증거 README)가 이 리포 전용이다. (2) 플러그인 패키지에 넣으면 릴리스에 묶인다 — 설치본에는 `docs/` 가 실리지만(4.69.0 캐시 Glob 확인) v4.70.0 뒤에 커밋하면 다음 릴리스 전까지 설치본에 없다. (3) 판독기 사용법은 각 스크립트 머리 주석이 이미 설치본에 실려 있다. 대상 리포의 세션은 이 리포 메인 체크아웃의 이 파일을 읽는다(설치본에는 없다).

## 0. 순서 한눈에

| 단계 | 하는 일 | 산출 | 절 |
|---|---|---|---|
| 준비 | 플러그인 버전 · 판독기 경로 · 원장 위치 · 스위치 확인 | 준비 기록 | 1 |
| 기준선 T0 | 스위치 ON 전 상태를 같은 판독기로 재서 기록 | T0 기록 | 2 |
| 사용 | 대상 리포에서 플러그인을 평소처럼 쓴다 | 원장 행 | 없음 |
| 측정 | 창마다 판독기를 돌려 분자·분모·시각을 적는다(원장 판독기 한 번에: 3.6) | 원시 출력 | 3 |
| 정합성 | 관측치가 서로 모순되지 않는지 점검 | 정합성 블록 | 4 |
| 반환 | 증거 문서로 만들어 이 리포 백로그로 되돌린다 | 증거 문서와 백로그 행 갱신 | 6 |
| B-3 표 | 완료 보고의 모델별 사용량 표를 원장과 대조 | B-3 착지 뒤 | 7 |

## 1. 준비

### 1.1 플러그인 버전

- 확인: 홈 `.claude/plugins/installed_plugins.json` 의 `plugins["artibot@artibot"][0]` 에서 `version` · `gitCommitSha` · `lastUpdated` · `installPath` 를 읽고, `installPath` 아래 `.claude-plugin/plugin.json` 의 `version` 이 같은지 본다.
- 이 머신의 값(2026-09-30 열람): `version` 4.69.0, `gitCommitSha` `ad8e5b28`, `lastUpdated` 2026-09-30T00:05:00.328Z, `installPath` 는 홈 `.claude/plugins/cache/artibot/artibot/4.69.0`.
- 필요한 버전: 체감 패키지를 담을 v4.70.0(계획). 4.69.0 에 없는 것(설치본 4.69.0 캐시를 2026-09-30 에 grep·Glob 으로 확인): `scripts/checkpoint/read-order-guard.mjs`(CA-08) · SH-19 depth 기록(`scripts/hooks/subagent-handler.js` 에 `depth_source` 0건) · 설정 키 `runtime.resume.staleGuard` 와 `split.missionBinding`(4.69.0 `artibot.config.json` 에 없다) · 체감 패키지 스위치 ON · R1(OB-24, 계획 문서 기준 착지 전). 있는 것: CA-15 입력 공급(`lib/runtime/middleware/tasks.js` 에 `interpretForGate`).
- 업데이트 뒤에는 세션을 재시작한다. 실행 중 세션은 옛 훅을 유지한다(`plugins/artibot/scripts/evals/nl-activation-report.mjs:40-43`).
- 업데이트마다 §1.4 의 스위치 표와 판독기 존재를 다시 확인한다. 설치 디렉터리가 버전마다 다르다(`plugins/artibot/lib/core/config.js:12-19`).

### 1.2 판독기 경로와 실행 위치

- 실행 위치는 대상 리포 루트(`.git` 이 있는 디렉터리)다. 판독기는 `--cwd` 기본값이 `process.cwd()` 라서 다른 디렉터리에서 실행하면 그 디렉터리를 잰다(`plugins/artibot/scripts/ledger/verify-rate.mjs:29-37`). `existence-audit.mjs` 머리 주석은 하위 디렉터리에서 실행하면 경로 해석기가 위로 올라가지 않아 없는 폴백 경로를 읽고 빈 결과를 낸다고 실측 기록으로 남겼다(`plugins/artibot/scripts/ledger/existence-audit.mjs:107-111`). 같은 `readLedgerCensus` 를 쓰는 다른 판독기도 같은 해석기를 거친다(추론).
- 스크립트 경로는 설치 캐시다: `installPath` 아래 `scripts/ledger/` · `scripts/evals/` · `scripts/checkpoint/`. 4.69.0 캐시에서 ledger 11개 · evals 2개 · checkpoint 1개 · bench 5개를 Glob 으로 확인했다. 폴백은 마켓 사본 `~/.claude/plugins/marketplaces/artibot/plugins/artibot/scripts/`(ledger 11개 Glob 확인). `/model-routing` 커맨드도 캐시 최신 버전, 마켓 사본 순으로 찾는다(`plugins/artibot/commands/model-routing.md:19-24`).
- 실행 예(PowerShell, 미실행). node 가 PATH 에 없으면 PowerShell 에서 실행한다(이 리포 작업 경험).

```text
Set-Location "<대상 리포 루트>"
$AB = "<installPath>"
node "$AB\scripts\ledger\verify-rate.mjs"
```

- 출력은 대부분 한 줄 JSON 이다. exit 0 이어도 원장이 없거나 읽지 못했을 수 있으므로 `ok` 와 `census.file.present` 를 먼저 읽는다(`verify-rate.mjs:43-46`). exit 2 는 사용법 오류이고 stdout 은 비어 있다.
- 출력의 입력 경로 필드(`ledger_path` · `file` · `inputPath`)가 대상 리포의 `.git/artibot/ledger.jsonl` 인지 매번 확인한다. 빈 결과와 엉뚱한 트리의 결과는 이 경로로만 구별된다(`plugins/artibot/scripts/ledger/session-coverage.mjs:54-62`).
- 원시 출력은 그대로 보존한다(재가공 금지). 파일로 저장할 때는 UTF-8 로 저장되는 방식을 쓰고(PowerShell 의 `>` 는 버전에 따라 UTF-16 이 될 수 있다 — 미확인) 저장 직후 다시 읽어 JSON 으로 파싱되는지 확인한다.

### 1.3 데이터가 어디에 있나

| 저장소 | 위치 | 읽는 것 | 근거 |
|---|---|---|---|
| 중앙 원장 | `<git-common-dir>/artibot/ledger.jsonl`(모든 linked worktree 공유). git 이 아니면 `<projectRoot>/.artibot/runtime/ledger.jsonl` | verify-rate · verify-call-rate · session-coverage · route-compare · outcome-census · existence-audit | `plugins/artibot/lib/runtime/event-writer.js:9-15` |
| 스폰 원장 | `<git-common-dir>/artibot/spawns.ndjson`. git 이 아니면 `<projectRoot>/.artibot/runtime/spawns.ndjson` | topology-agreement, SH-19 임시 계수 | `plugins/artibot/lib/learning/ledger/spawn-ledger.js:10` · `:74` · `:94` |
| 결정 스토어 | `<projectRoot>/.artibot/runtime/decisions/*.events.ndjson` — 작업 트리 안, 워크트리별 | topology-agreement, nl-activation-report | `plugins/artibot/lib/observability/decision-events.js:153` · `plugins/artibot/commands/doctor.md:285-288` |
| 증거 레지스트리 | `<git-common-dir>/artibot/evidence.jsonl` | 전용 판독기 미확인 | `plugins/artibot/lib/verification/evidence-registry.js#evidenceRegistryPath` |
| 상태 스토어 | `<git-common-dir>/artibot/project-state.json` 과 `project-state.jsonl` | resume-report | `plugins/artibot/lib/runtime/middleware/tasks.js:103` |
| 자동조종 세션 저장소 | `<상태 디렉터리>/runtime/autopilot/<sessionId>.json` — 기본 `~/.claude/artibot/runtime/autopilot/`(D2, 오너 결정 2026-09-30). 대상 리포도 설치 버전 디렉터리도 아니라서 `/update` 를 넘어 남는다(v4.70.1 까지는 `<플러그인 루트>/runtime/autopilot` 이었다) | recovery-journal-census(`--dir`), 함수 censusReportVerifyEvidence | `plugins/artibot/lib/autopilot/session-store.js:185-193` · `plugins/artibot/scripts/ledger/recovery-journal-census.mjs:256-263` |
| 호스트 transcript | `~/.claude/projects/<slug>/*.jsonl`(main 만) | question-rate | `plugins/artibot/scripts/evals/question-rate.mjs:7-9` |

- `<git-common-dir>` 는 대상 리포 루트에서 `git rev-parse --git-common-dir` 로 얻는다(설정의 `plugins/artibot/artibot.config.json#stateStore.location` 이 이 값을 기준으로 선언한다).
- 주의 1 — 자동조종 세션 저장소는 v4.70.1 까지 플러그인 캐시 안(`<플러그인 루트>/runtime/autopilot`)이라 `/update` 가 새 버전 디렉터리를 만들면 새 버전은 옛 저장소를 읽지 않았다(`getStoreDir` 가 `getPluginRoot()` 기준이었다). 이 리포 CA-13 행이 저장 세션 id 46 에서 10 으로의 감소를 보고하고 원인을 "D10 캐시 삭제로 보이나 미확인"으로 둔다 — 그 감소는 옛 배치 아래의 일이다. D2 이후의 빌드는 기본 저장소가 사용자 상태 디렉터리 `~/.claude/artibot/runtime/autopilot` 이라 업데이트를 넘어 같은 저장소를 읽는다(`plugins/artibot/lib/autopilot/session-store.js:185-193`). 옛 위치(플러그인 루트 · 캐시된 모든 버전 디렉터리 · 마켓플레이스 미러)에 남은 세션은 자동조종 프로세스가 기본 저장소를 처음 열 때 새 저장소로 **복사**되고 원본은 그대로 남는다(채택 기록은 저장소 옆 `legacy-migration.ledger`, `session-store.js:155-158` · `plugins/artibot/lib/autopilot/legacy-store-adoption.js`). 채택 전에는 판독기가 옛 위치를 대신 읽고 `census.legacyFallback` 이 true 로 찍힌다(`plugins/artibot/scripts/ledger/recovery-journal-census.mjs`). v4.71.0 미만에서 올릴 때만 채택 전 저장소가 버전 디렉터리에 있다 — 그때 CA-03·CA-13 을 재려면 업데이트 전에 판독하거나 폴더를 복사해 `--dir` 로 읽는다. 저장 위치를 고정하는 환경 변수 쌍(`ARTIBOT_AUTOPILOT_STORE_DIR` 와 `ARTIBOT_AUTOPILOT_STORE_DIR_ROOT`)은 지금도 플러그인 루트가 같을 때만 유효하다(`session-store.js:185-193`). 버전이 바뀌면 다시 맞춰야 한다.
- 주의 2 — 플러그인이 작업 트리에 쓰는 `.artibot/` 하위 산출물(결정 스토어 등)은 대상 리포에서 untracked 로 보일 수 있다. 이 리포는 `.gitignore:146`(`**/.artibot/runtime/`) · `:148`(`**/.artibot/transcripts/`) · `:154`(`**/.artibot/state.yaml`)로 막는다. 대상 리포 `.gitignore` 에 무엇을 넣을지는 오너 결정이었고, 결정은 D1(2026-09-30)이다: v4.71.0 부터 SessionStart 훅 `project-bootstrap` 이 대상 리포의 `<git-common-dir>/info/exclude` 에 관리 블록을 써서 이 산출물이 `git add .` 에 딸려 들어가지 않게 한다. 프로젝트의 `.gitignore` 는 건드리지 않고 git 리포가 아니면 아무것도 하지 않으며, 끄는 길은 `projectBootstrap.gitExclude: false` 또는 환경변수 `ARTIBOT_PROJECT_BOOTSTRAP=0` 이다(`plugins/artibot/artibot.config.json#projectBootstrap.comment`). 이미 쓴 블록은 끄더라도 지워지지 않는다.
- 주의 3 — 원장은 세션이 도는 동안 계속 는다. 판독기 출력의 `census` 는 같은 읽기에서 줄 수와 바이트를 함께 낸다(`plugins/artibot/lib/runtime/ledger.js:211-237`). 총계와 내역은 같은 출력에서 취한다.

### 1.4 스위치

- 설정은 플러그인 루트의 `artibot.config.json` 한 파일에서 읽는다(`plugins/artibot/lib/core/config.js:119-120`). 프로젝트별 오버라이드 계층은 이 로더에 없고, `plugins/artibot` 의 js·mjs 에서 프로젝트 config 를 읽는 코드를 grep 했으나 0건이었다(그 밖 디렉터리 미확인). 그래서 스위치는 그 머신의 모든 프로젝트에 적용된다. 예외: `runtime.artifactLifecycle.enabled` 는 전역 스위치와 프로젝트 마커 파일(`.artibot/artifact-lifecycle.optin`)이 둘 다 있어야 쓴다(`plugins/artibot/artibot.config.json#runtime.artifactLifecycle.comment`).
- 모델 라우팅은 별개다: 사용자 파일 `~/.claude/artibot/model-routing.json`(`plugins/artibot/commands/model-routing.md:104`).

| 스위치(설정 키) | 1ec215bf 출하값 | 체감 패키지에서 | 켜졌는지 확인 | 끄는 법 | 관련 행 |
|---|---|---|---|---|---|
| `autopilot.reportVerifyGate.enforce` | false | A-1 켜질 예정 | 설치본 설정 파일의 그 키. 리터럴 true 만 ON | 값을 false 로. 파일 부재나 파싱 실패도 OFF 로 읽힌다 | CA-13 |
| `runtime.resume.staleGuard` | false | A-2 켜질 예정 | 설정 파일의 그 키. OFF 면 판독 스크립트가 무출력이라 출력으로는 모른다 | false | CA-08 |
| `routing.canary.actionClasses` | 빈 배열 | B-1 메커니즘 미확인 | 설정 파일과 `/model-routing show` | 빈 배열로, 또는 `/model-routing reset task classify` 와 `reset task status` | CA-02 · GA-02 |
| 자동 활성 allowlist 키 | 키 없음 | B-2 켜질 예정 | 착지 뒤 확인(키 이름 미확인) | 미확인 | CA-01 |

- 패키지 밖 스위치(출하 false — 켜지 않는다, T0 기록용): `autopilot.recovery.transitionFromVerdict`(CA-03) · `runtime.checkpoint.saveOnSave`(CA-05) · `runtime.questionGate.enforce`(CA-15) · `runtime.artifactLifecycle.enabled`(SH-01·SH-02, 마커 포함) · `split.missionBinding.enabled`(SH-11) · `team.followWorkflowPlan`(SH-04). 읽는 규칙은 각 키 옆 `comment` 에 적혀 있다.
- `ledger.hookFired.slots` 는 출하 기본이 6 슬롯 전부(Shadow 캐리어)다. `PostToolUse` 를 빼면 하루 약 679행이 줄지만(2026-09-15 실측, `plugins/artibot/artibot.config.json#ledger.hookFired.comment`) OB-24 의 분모가 줄고, 슬롯을 끄면 그 슬롯의 훅이 발화 0 으로 읽히는 거짓 0 이 생긴다(`plugins/artibot/scripts/ledger/existence-audit.mjs:176-181`). 측정 중에는 6 슬롯을 유지한다. 발화 기록의 비용은 R1 검수 노트가 이후 발화 +8~17ms, 첫 발화 +25~33ms 로 적었다(웨이브 3 계획 문서 Leader status 인용, 미재현).
- 켜졌는지 확인하는 법: 설치본 `artibot.config.json` 을 직접 열어 키 경로를 읽는다. 훅의 리더는 대부분 엄격 비교라서 문자열 "true" 나 1 은 꺼진 것이다.
- 끄는 법(임시): 설치본 `artibot.config.json` 의 값을 고친다. `/update` 는 새 버전 디렉터리를 만들므로 이 편집은 옛 디렉터리에 남고 새 설치본에서는 사라진다(추론 — SH-11 행이 같은 문제를 플래너 지적으로 적는다). 영구 변경은 이 리포의 설정 커밋과 릴리스(리더 몫)다. 편집 뒤에는 JSON 문법을 확인한다. 읽지 못하는 설정은 게이트 리더가 조용히 OFF 로 읽는다(`plugins/artibot/artibot.config.json#autopilot.reportVerifyGate.comment`). 진행 중인 세션이 편집을 즉시 반영하는지는 미확인이므로 편집 뒤 새 세션에서 확인한다.
- 켜고 끈 시각은 §2 의 창 경계로 기록한다.

### 1.5 오염 방지

- 측정 목적의 `claude -p` 나 프로브 세션은 원장에 세션을 만든다. 세션 id 를 적어 두고 `session-coverage.mjs` 의 `--exclude-sessions` 에 넘기되, 출력의 raw 수치를 항상 병기한다(`plugins/artibot/scripts/ledger/session-coverage.mjs:45-52`). 제외를 썼다면 `views` 아래 `exclusion.with_receipts` 가 빈 배열인지 확인한다. 영수증이 있는 세션을 뺐다면 분모를 깎은 것이다(백로그 §4-k M0 판독 절차 주). 이 리포 선례: 하네스가 중앙 원장에 6세션을 만들었다([evidence/ca04-host-ask-probe.md](evidence/ca04-host-ask-probe.md) §5.4).
- 측정을 수행하는 세션도 훅을 통해 원장에 행을 남긴다. 판독기가 쓰는 것이 아니라 호스트 훅이 쓴다(판독기는 쓰기 함수를 import 하지 않는다, `plugins/artibot/scripts/ledger/verify-rate.mjs:21-27`). 그 세션의 id 를 기록하고, 정합성 블록에 그 세션의 행이 어느 분모에 들어가는지 적는다. `session.ended` 는 세션이 끝나야 쓰이므로(`plugins/artibot/scripts/ledger/session-coverage.mjs:6-12`) 진행 중인 측정 세션은 ④ 분모에 아직 없다.
- 의도적으로 만든 표본(프로브)은 자연 발생 표본과 구분해 표기한다. 이 리포 선례는 L-1 이다 — 리더가 진짜 `/verify` 를 1회 실행해 self_report 를 만들고 그 사실을 적었다(백로그 §4-k).

## 2. 기준선(T0)과 기록 규칙

### 2.1 T0 에 기록할 것

- 플러그인 버전 · `gitCommitSha` · `lastUpdated`(§1.1), 호스트 `claude` 버전, 대상 리포 HEAD 커밋.
- §1.4 의 스위치 값 전체: 표 4행, 패키지 밖 6개, `ledger.hookFired.slots`.
- 원장 상태: 판독기 출력의 `census`(줄 수 · 바이트 · `file.present`)와 입력 경로. 원장이 없으면 "없음"을 값으로 적는다.
- UTC 시각. 판독기가 시각 필드를 내지 않는 경우(`verify-rate.mjs` · `verify-call-rate.mjs` · `resume-report.mjs` — 각 파일 grep 확인)에는 실행 직전 UTC 시각을 직접 적는다. 다른 판독기는 `measured_at` 또는 `measuredAt` 을 낸다.
- T0 에서 §3.1 의 판독기를 한 번씩 돌려 전부 기록한다. 0 이나 null 이어도 기록한다.

### 2.2 Canary 는 "이전 대비"다

설계 정본은 Canary 종료 조건을 "카나리 오작동 0, 되돌림률 임계 이하, PAUSE/재시도 횟수 이전 대비"로 적는다(`ARTIBOT-5.0-DESIGN.md:257`). "이전 대비"는 스위치를 켜기 전의 기준선이 있어야 성립한다. 그러므로 스위치 ON 전 창(OFF)과 ON 창을 같은 판독기로 재고, 창 경계는 스위치를 켠 시각과 플러그인 버전으로 적는다. 설정이 전역이라(§1.4) 대상 리포 안에서 켜진 쪽과 꺼진 쪽을 나란히 비교할 수 없고 시간 창만 비교할 수 있다. 시간 교란(작업 종류 · 세션 길이)은 증거 문서의 "못 보는 것"에 적는다. "오작동"과 "되돌림률 임계"의 정의는 설계에 없다(미확인) — 첫 ON 창이 시작되기 전에 오너가 정하고 기록한다.

### 2.3 수치마다 붙이는 것

1. 분자/분모와 n. 분모가 0 이면 null 로 적는다(0 과 다르다).
2. 측정 시각(UTC).
3. 명령 원문과 실행 위치(cwd).
4. 입력 경로 필드가 대상 리포임을 확인한 결과.
5. `ok` 값과 `census`. exit 0 을 성공으로 읽지 않는다.
6. raw 와 제외를 병기하고, 창 수치와 전체 이력 수치를 병기한다(백로그 §4-j R-11 — 창만 보고하는 것은 금지).
7. 그 시각의 스위치 값과 플러그인 버전.
8. 정합성 블록(§4). 관측치가 3건 이상이면 필수다.
9. 확인하지 못한 것은 "미확인"으로 남기고 지우지 않는다.

## 3. 무엇을 언제 세는가

### 3.1 전용 판독기가 있는 지표 (실행 위치 = 대상 리포 루트)

| 지표 | 관련 행 | 명령과 플래그 | 읽는 곳 | 최소 설치본 |
|---|---|---|---|---|
| 영수증 커버리지(Observe ④) | 종료 판정, SH-01 플립 조건 a | `session-coverage.mjs` `--cwd` `--since`(ISO 또는 epoch 밀리초) `--exclude-sessions`(파일 또는 id 목록) | 중앙 원장의 `session.ended` 와 `usage.receipt` | 4.69.0 |
| verdict 파싱률(Observe ③) | OB-07 | `verify-rate.mjs` `--cwd` `--session` `--since`(ISO). 호출률은 `verify-call-rate.mjs`(같은 플래그) | `verify.completed`. 호출률은 `intent.detected` 와 `tool.used` | 4.69.0 |
| 추천 대 실제 스폰 모델(Observe ②)과 영수증 비교 | SH-05 | `route-compare.mjs` `--cwd` `--since`. 카드는 `/scorecard --compare` | `route.bound` · `usage.receipt` · `review.claim_audit` | 4.69.0 |
| 훅·커맨드·스킬 발화(Observe ⑤) | OB-24 · SH-29 | `existence-audit.mjs` `--cwd` `--plugin-root` `--since` | `hook.fired` · `tool.used` · `intent.detected` 와 설치본 인벤토리 | 4.69.0. 직접 등록 훅의 발화는 R1 착지 뒤 |
| 질문 빈도 | SH-09 | `question-rate.mjs` `--cwd` `--slug` `--dir` `--projects-dir` `--with-worktrees` `--window 이름=ISO` `--now` | 호스트 main transcript | 4.69.0 |
| NL 활성 | SH-03 | `nl-activation-report.mjs` `--project-root` `--fixture` | 결정 스토어와 중앙 원장 | 4.69.0 |
| 토폴로지 일치 | SH-04 | `topology-agreement.mjs` `--cwd` `--since` `--json` | 결정 스토어와 스폰 원장 | 4.69.0 |
| 복구 저널 분모 | CA-03 · SH-06 | `recovery-journal-census.mjs` `--dir` `--session` | 자동조종 세션 저장소 | 4.69.0 |
| outcome 게이트 계수 | SH-02 · SH-20 | `outcome-census.mjs` `--cwd` `--since`. 카드는 `/scorecard --mission <id>` | `mission.completed` 와 missions 산출물 | 4.69.0. SH-01 이 켜지기 전에는 missions 가 없다 |
| 체크포인트·resume 계약 | CA-05 · SH-13 | `resume-report.mjs` `--all` `--cwd` `--json`. 한 미션은 `--mission <id>` | 상태 스토어와 run.json | 4.69.0 |
| stale guard | CA-08 | `read-order-guard.mjs` `--mission <M-id>` `--cwd` | missions 산출물과 상태 스토어 | v4.70.0 이상(4.69.0 캐시에 없다) |
| 모델 라우팅 적용 | CA-02 · GA-02 | `/model-routing validate --live` `--since` `--cwd` `--json`(CLI 는 `model-routing.mjs`) | `route.bound` 와 `usage.receipt` | 4.69.0(설치본 `model-routing.mjs` 에 `--live` 문자열 8건 grep 확인, 동작은 미실행) |
| 기준선 건강 점검 | 전체 | `/doctor` 의 Check 7(topology 일치 info 행) · 8(원장·상태 정합) · 9(산출물 상태) · 10(route bind 잔여) | 각 Check 의 입력 | 4.69.0 |

- 공통: 출력은 한 줄 JSON 이고 입력 경로 필드와 `census` 를 먼저 읽는다. `--since` 는 ISO 시각을 쓰는 것이 안전하다. 숫자만이면 epoch 밀리초로 읽는다(`plugins/artibot/scripts/ledger/session-coverage.mjs:32-33`).
- Observe ④: `views` 의 `window` 와 `history` 가 나란히 나오고 제외를 쓰면 raw 가 항상 함께 나온다(`session-coverage.mjs:45-52` · `:103-110`). `unresolved_models` 는 모델이 카탈로그에 없어 영수증이 버려진 세션을 센다(`plugins/artibot/lib/replay/session-coverage.js:34-35`).
- SH-05: `score` 블록은 `review.claim_audit` 행이 없으면 null 이고 이유가 `no-spawn-keyed-score-writer` 다(`plugins/artibot/scripts/ledger/route-compare.mjs:118-127`). `pairs` 는 agent id 째로 출력된다(`:102-105`). §6 에서 옮길 때 프로젝트 식별 정보가 있는지 본다.
- OB-24: 직접 등록 훅은 인벤토리에 없고 `hooksOutsideCarrier` 로 개수만 나온다. 그 발화는 audit 되지 않는다(`existence-audit.mjs:171-175`).
- SH-03: 4번째 축 `activation.hint-followed` 는 슬래시 타이핑 수락의 하한이다(백로그 SH-03 행). 실사용 n 이 정의돼 있지 않다(미확인).
- SH-04: 값은 상한이다(start 유실). 결정 스토어는 워크트리별이므로 메인 워크트리 루트에서 실행한다(`plugins/artibot/commands/doctor.md:285-288`).
- CA-03: rows 가 0 이면 `ratio` 는 null 이고 `unmeasured:no-journal` 이다(`plugins/artibot/scripts/ledger/recovery-journal-census.mjs:67-74`). 이 판독기는 설정을 읽지 않는다. 게이트가 꺼져 있으면 divergent 100% 는 설정이 말하는 것이다(`:104-109`).
- CA-05: exit 0 이어도 report 가 blocked 일 수 있다. 출력 문서를 읽는다(`plugins/artibot/scripts/checkpoint/resume-report.mjs:59-71`).
- CA-08: OFF 면 stdout 도 stderr 도 없이 exit 0 이다(`plugins/artibot/artibot.config.json#runtime.resume.comment`). 켜짐 여부는 설정으로 확인한다.

### 3.2 전용 판독기가 없는 지표 (임시 계수)

판독기가 없으면 임시 스크립트로 센다. 규칙: 읽기 전용(파일을 열어 쓰지 않는다) · 줄마다 JSON 파싱하고 파싱 실패 줄 수를 함께 출력 · 입력 경로와 크기와 줄 수와 실행 UTC 시각을 같이 출력 · 스크립트 원문을 증거 문서 부록에 붙인다([evidence/ca05-save-roundtrip.md](evidence/ca05-save-roundtrip.md) 부록 A~D 관례) · ASCII 파일로 저장해 실행한다(셸 heredoc 에 한글과 백슬래시가 섞이면 깨진다 — 이 리포 작업 경험). 원장을 판독기와 같은 규칙으로 읽으려면 `plugins/artibot/lib/runtime/ledger.js#readLedgerCensus` 를 import 할 수 있다(중복 제거와 census 규칙이 같다, 미실행).

| 지표 | 관련 행 | 읽는 곳 | 행 선택 | 셀 것 | 최소 설치본 |
|---|---|---|---|---|---|
| 중첩 스폰 depth | SH-19 | 스폰 원장(함수 `readSpawns`) | `event` 가 stop 인 행 | `depth` 가 null 이 아니고 `parent_agent_id` 가 그 스폰의 호스트 meta 파일(`agent-<id>.meta.json`)의 `parentAgentId` 와 일치하는 행이 1 이상 | v4.70.0 이상(필드 정의 `plugins/artibot/lib/learning/ledger/spawn-ledger.js:131-142`) |
| lane heartbeat | SH-12 | 중앙 원장 `state.updated` 중 `reason` 이 `split.lane-lease` 인 행과 상태 스토어의 lease | `heartbeat_source` 가 `lane-heartbeat` 인 lease 의 갱신 | 갱신 1 이상 | 4.69.0. 필드 위치는 SH-12 행의 인용만 있고 확인하지 못했다(미확인) |
| question gate 입력 | CA-15 | 중앙 원장 `adr.question_gate_evaluated` | `interpretation_present` 가 true 인 행. 입력 공급 착지 전 행과 후 행은 같은 분모로 비교하지 않는다(분할 키) | Q2-O1 권장안(미결정)은 20 이상 | 4.69.0(설치본 `lib/runtime/middleware/tasks.js` 에 `interpretForGate` 2건 grep 확인) |
| REPORT 게이트 증거 | CA-13 | 자동조종 세션 저장소의 세션 파일과 함수 `censusReportVerifyEvidence` | 파싱한 세션 상태를 함수에 넘긴다. `nextTarget` 과 `PHASES` 도 넘겨야 `pauseAtReport` 가 null 이 아니다 | `pauseAtReport` · `byCode` · terminal 대 live | 4.69.0(함수 `plugins/artibot/lib/autopilot/report-verify-gate.js:452`, CLI 는 scripts grep 0건) |
| 라우팅 대상 모델 사용 | GA-02 · CA-02 | 중앙 원장 `usage.receipt` | `data.model_identity.model_id` 가 라우팅 대상 모델인 행 | 1 이상(D1) | 4.69.0 |
| 증거 레지스트리 | SH-15 · OB-07 | `evidence.jsonl` | 행 수 | 상시 등록률은 이 리포에서도 미측정 | 4.69.0 |

### 3.3 착지 전이거나 판독기를 못 찾은 것

- CA-04 L0b 섀도 계수: 코드 미착수(백로그 CA-04 행).
- PAUSE·재시도 횟수: 판독기를 못 찾았다(`plugins/artibot/scripts` 의 mjs 에서 `pausedReason` grep 0건, 그 밖 디렉터리 미확인).
- CA-01 게이트 히트: 판독기 미확인. 키와 함께 B-2 착지 뒤 확인한다.
- 모델별 사용량 표: §7.

### 3.4 창 크기 n 과 통과선 (정본에 있는 것만)

- Observe ④ 영수증 커버리지: 통과선 95%, 표본 조건 ended 50 이상(백로그 §4-c 결정 (2)). 이 리포의 관측 속도는 하루 약 4세션(웨이브 2 추정, 재측정 없음)이라 50세션은 약 12일로 추정됐다(웨이브 3 계획 문서 §4·§5 인용). 대상 리포는 속도가 다르니 날짜가 아니라 세션 수로 창을 자른다.
- Observe ② 추천≠정책: 임계 없음. 2026-09-21 결정은 이 비율을 2티어 정책 적용 라벨로 확정하고 RouteBench B2 기준선으로만 쓰게 했다(§4-c 결정 (3)). 그 뒤 fable 이 휴면(2026-09-23, 백로그 GA-02 행)이라 그 라벨이 지금도 맞는지는 미확인이다 — 첫 측정 전에 리더가 라벨을 다시 정한다.
- Observe ③: 종료 정의는 writer 와 분모다(§4-c 결정 (1)). 대상 리포에서 self_report 가 생기려면 `/verify` 를 실제로 쓴다.
- SH-09 질문 빈도: 100 타이핑 프롬프트당 호출과 95% 구간(푸아송), 창 경계 = 설치 시각. 구간이 겹치면 감소 여부는 판정 불가로 적는다([evidence/sh09-question-rate-20260929.md](evidence/sh09-question-rate-20260929.md)).
- SH-03 NL 활성: 통과선 ≥90%(`ARTIBOT-5.0-DESIGN.md:256`). 실사용 n 은 미정의(미확인) — 창을 열기 전에 오너·리더가 정한다.
- CA-15 Q2-O1 플립 기준(권장안, 미결정): 착지·설치 뒤 `interpretation_present` 행 20 이상, transcript 감사에서 에이전트 작성 발화로 발화된 건 0, 분모를 붙인 done 표기(백로그 §4-k).
- SH-19 · SH-12 · SH-05 · GA-02 · OB-24: done 문언이 "표본 1 이상"이다. 1 이상은 존재 증명이지 비율이 아니다. 비율 주장이 필요하면 n 을 따로 사전에 정한다.
- Canary 오작동 · 되돌림률 임계 · SH-03 실사용 n: 정의 없음(미확인).

### 3.5 언제 재나 (제안 — 백로그에 없는 값이라 오너·리더 확정 필요)

| 시점 | 하는 일 | 이유 |
|---|---|---|
| T0 | 기준선 일괄(§2.1) | Canary "이전 대비" |
| T1 | 스위치 ON 직후. 재시작 뒤 첫 세션의 시작 시각을 적고 판독기를 한 번 더 | 창 경계 |
| T2 | 표본 창이 찰 때마다(④ 는 ended 50 단위) | 통과선 판정 |
| T3 | `/update` 직전(v4.71.0 미만 설치에서 올릴 때만) | 채택 전의 자동조종 세션 저장소는 옛 버전 디렉터리에 있다. D2 빌드 설치 뒤에는 `~/.claude/artibot/runtime/autopilot` 이라 업데이트를 넘어 남는다(§1.3 주의 1) |
| T4 | 판정 직전 최종 재측정 | 원장이 계속 늘고 있다 |

표본이 안 생기면: SH-05 · SH-06 · SH-12 · SH-19 · CA-03 은 특정 사용(auditor 검수 · `/autopilot` VERIFY · `/split` 레인 · 중첩 스폰)이 있어야 생긴다. 자연 발생을 기다릴지 의도적 프로브를 할지는 오너 결정이고, 프로브는 자연 표본과 구분해 표기한다(§1.5).

### 3.6 한 줄 census — `v51-census.mjs` (다른 리포에서 실행, 2026-09-30 추가)

§3.1 의 원장 판독기를 손으로 하나씩 돌리는 대신 이 명령 하나로 돌린다. 원장은 세션이 도는 동안 계속 늘어서(§1.3 주의 3) 판독기마다 따로 읽으면 분모가 서로 다른 순간의 것이 된다. 그래서 명령은 **원장 사본 하나**를 시작할 때 만들고 모든 원장 판독기에 그 사본을 읽힌다(`plugins/artibot/scripts/ledger/v51-census.mjs:28-39`). 판독기는 고치지 않고 자식 프로세스로 실행한다. 사본은 OS 임시 디렉터리에 실행 동안만 있고 끝나면 지운다(도중에 강제 종료하면 `artibot-census-` 로 시작하는 디렉터리가 남으니 지운다).

**돌리는 것.** 사본을 읽는 7개 — session-coverage(④) · verify-rate 와 verify-call-rate(③) · route-compare(②) · existence-audit(⑤) · usage-cost-table · `model-routing.mjs validate --live` — 와, 원장이 아니라 자동조종 세션 저장소를 읽는 recovery-journal-census 1개다. 마지막 것은 사본 대상이 아니고 `--since` 도 받지 않아 문서에 `live-store` 와 범위 `all` 로 표시된다(`plugins/artibot/scripts/ledger/v51-census.mjs:41-47`). 돌리지 않는 6개 — outcome-census · nl-activation-report · topology-agreement · question-rate · resume-report · read-order-guard — 는 입력이 원장 하나가 아니거나 원장이 아니라서 사본만 넘길 수 없다. 문서의 `notRun` 이 이유와 따로 돌리는 명령을 적는다(`plugins/artibot/scripts/ledger/v51-census-readers.mjs#NOT_RUN`). 이 6개의 지표(SH-03 · SH-04 · SH-09 · CA-05 · CA-08 · outcome 게이트)는 §3.1 대로 따로 잰다.

**스크립트 찾기.** 스크립트는 자기 플러그인 트리(판독기와 `lib/`)만 쓰고 대상 리포의 것을 쓰지 않으므로 어느 cwd 에서나 돈다. 설치본 캐시에는 이 스크립트가 든 릴리스 전까지 없다(실측 2026-09-30: 4.70.0 캐시 Glob 결과 없음). 그때까지는 이 리포 메인 체크아웃의 `plugins/artibot/scripts/ledger/v51-census.mjs` 경로로 직접 부른다. 릴리스 뒤에는 `/model-routing` 커맨드 §1 과 같은 순서(환경변수, 캐시 최신 버전, 마켓 사본)로 찾는다. 아래 한 줄은 Bash 에서 실행했다(실측 2026-09-30: 환경변수가 비어 있으면 `v51-census not found`, 이 워크트리의 플러그인 루트를 주면 그 경로를 출력).

```text
VC=""; C="$HOME/.claude/plugins/cache/artibot/artibot"; S="scripts/ledger/v51-census.mjs"; if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/$S" ]; then VC="$CLAUDE_PLUGIN_ROOT/$S"; fi; if [ -z "$VC" ]; then for v in $(ls -1 "$C" 2>/dev/null | sort -t. -k1,1nr -k2,2nr -k3,3nr); do if [ -f "$C/$v/$S" ]; then VC="$C/$v/$S"; break; fi; done; fi; if [ -z "$VC" ]; then for m in "$HOME"/.claude/plugins/marketplaces/*/plugins/artibot; do if [ -f "$m/$S" ]; then VC="$m/$S"; break; fi; done; fi; if [ -n "$VC" ]; then echo "$VC"; else echo "v51-census not found"; fi
```

**실행.** 대상 리포 루트를 `--cwd` 로 준다(생략하면 cwd). 하위 디렉터리를 주면 경로 해석기가 위로 올라가지 않아 `no-ledger` 로 끝난다(§1.2). 릴리스 전에 이 리포 체크아웃에서 돌리고 설치본을 재는 권장형(`--autopilot-dir` 는 일부러 뺐다):

```text
node "<메인 체크아웃>/plugins/artibot/scripts/ledger/v51-census.mjs" --cwd "<대상 리포 루트>" --plugin-root "<installPath>" --since <ISO 시각> --json --out "<증거>.md" > census.json
```

이 스크립트가 든 릴리스를 설치한 뒤에는 설치본 경로에서 `--plugin-root` 도 뺀 한 줄이면 된다. 스크립트가 든 플러그인이 곧 설치본이라 인벤토리와 기대 티어가 이미 설치본 기준이다. 위 찾기 한 줄은 캐시에서 **가장 높은 버전**을 고른다. 세션이 실제로 쓴 버전과 다를 수 있으니(업데이트 직후 재시작 전 등) §1.1 의 `installPath` 와 다르면 그 경로를 직접 쓴다.

```text
node "<installPath>/scripts/ledger/v51-census.mjs" --cwd "<대상 리포 루트>" --since <ISO 시각> --json --out "<증거>.md" > census.json
```

- `<installPath>` 는 §1.1 의 값이다. `--plugin-root` 를 빼면 existence-audit 는 이 체크아웃의 인벤토리를, model-routing 은 이 체크아웃의 설정과 로스터를 잰다. 대상 프로젝트가 쓴 것은 설치본이다(실측 2026-09-30: 4.70.0 캐시를 `--plugin-root` 로 주고 판독기 8건 중 error 0).
- `--autopilot-dir` 는 권장형에서 **뺀다**. 자동조종 세션 저장소를 사용자 상태 디렉터리로 옮긴 릴리스부터 recovery-journal-census 의 기본 저장소는 플러그인 루트가 아니라 사용자 상태 디렉터리 아래(기본 `~/.claude/artibot`)라서 어느 체크아웃이나 설치본에서 돌려도 같은 저장소를 읽는다. 새 저장소에 세션 파일도 채택 기록도 없을 때만 옛 위치(그 판독기가 든 플러그인 루트 아래)를 대신 읽고, 그러면 지표 행의 `detail.legacyFallback` 이 true 이고 `detail.primaryStore` 가 비어 있던 새 저장소다. 실제로 읽은 디렉터리는 `runs[].inputPath` 다. `--autopilot-dir` 를 주면 그 디렉터리만 읽고 폴백은 꺼진다. 옛 위치(`<installPath>/runtime/autopilot`)를 주면 옛 저장소를 강제하는 것이므로, 채택 전의 옛 저장소를 일부러 재거나 복사해 둔 저장소와 픽스처를 읽을 때만 쓴다.
- 위 저장소 이전 동작은 착지 전 커밋 `6b410964` 의 판독기를 가짜 홈과 가짜 플러그인 루트 아래에서 실행해 확인했다(실측 2026-09-30: 새 저장소가 비면 폴백, 세션이 있으면 새 저장소, `--dir` 이면 폴백 없음). 그 줄기의 수정 커밋과, 그 줄기를 담은 릴리스의 설치본에서의 실행은 미확인이다. v4.70.0 까지의 기본은 플러그인 루트 아래였고, 그 배치에서 설치본 4.70.0 저장소는 파일 4개에 저널 1행이었다(실측).
- `--since` 를 주면 판독기마다 창과 전체 이력을 둘 다 잰다. §2.3 6번이 창만 보고하는 것을 금지한다.
- JSON 은 크다(이 리포 원장 25MB 로 0.5~0.9MB). 파일로 받고 `metrics` 와 `consistency` 부터 읽는다. Git Bash 의 `>` 를 쓴다. PowerShell 5.1 의 `>` 는 UTF-16 이 될 수 있다(§1.2, 미확인).
- node 가 PATH 에 없으면 PowerShell 에서 `& (Get-Command node).Source <스크립트> ...` 로 부른다(실측 2026-09-30: PowerShell 에서 외부 임시 git 리포 루트에 서서 성공).

| 플래그 | 뜻 | 기본 |
|---|---|---|
| `--cwd <루트>` | 재는 프로젝트. 저장소 루트여야 한다 | 현재 디렉터리 |
| `--since <ISO 또는 epoch 밀리초>` | 창 경계. 숫자만이면 epoch 밀리초(판독기와 같은 규칙) | 없음(전체 이력) |
| `--json` | 문서를 한 줄 JSON 으로 출력 | 증거 markdown 출력 |
| `--out <경로>.md` | 증거 markdown 도 파일로 쓴다. `.md` 만 받는다(원장을 덮어쓸 수 없다) | 안 씀 |
| `--plugin-root <디렉터리>` | existence-audit 인벤토리와 model-routing 기대 티어의 기준 플러그인 | 스크립트가 든 플러그인 |
| `--autopilot-dir <디렉터리>` | recovery-journal-census 가 읽는 세션 저장소를 그 디렉터리로 고정한다(옛 위치 폴백도 꺼진다). 권장형에서는 주지 않는다 | 사용자 상태 디렉터리의 저장소. 비어 있고 채택 기록이 없으면 옛 위치 |
| `--exclude-sessions <목록 파일 또는 id 나열>` | session-coverage 한 판독기에만 적용. raw 수치가 항상 같이 나온다(§1.5) | 없음 |

**읽는 법.**

- `status`: `ok` · `partial`(판독기 오류나 누락, 또는 일관성 위반·미증명) · `no-ledger`(원장 없음 — 측정 없음, exit 0, 판독기는 하나도 돌지 않는다) · `ledger-unreadable` · `error`. exit 0 이어도 이 값을 먼저 읽는다.
- `metrics[]`: 행마다 `numerator` · `denominator` · `ratio` · `measuredAt` · `status`. 분모 0 은 `unmeasured` 이고 ratio 는 null 이다(§2.3 1번). 판독기가 시각을 내지 않으면 그 실행의 시작 시각이 들어가고 `measuredAtFrom` 이 `census-run-start` 다(판독기가 자기 시각을 냈으면 `reader`, §2.1).
- `consistency.ok`: 모든 원장 판독기가 사본을 읽었음을 **증명했는지**(입력 경로와 바이트), 각 판독기 census 의 합(§4 첫 항목), 판독기별 합계 항등식을 자동 대조한 결과다. true 는 위반이 없고 사본 증명이 전부 성립했을 때만이다. 판독기가 경로나 바이트 수를 내지 않으면 위반이 아니라 **미증명**이라 false 이고(`checks` 의 `holds: null`, 개수는 `consistency.unproven`), 대조할 것이 하나도 없으면(성공한 원장 판독기 0) null 이다. false 면 `checks` 에서 `holds: false` 와 `holds: null` 을 찾는다. §4 대로 숨기지 않고 올린다.
- `runs[].status` 가 `error` 인 판독기의 지표는 수치가 null 이고 `errors` 에 이유가 있다. 판독기가 죽으며 낸 빈 fold 는 0 으로 읽지 않는다.
- `ledger.grewDuringRun` 이 true 면 그 증가분은 어떤 수치에도 없다. 같은 시점을 다시 재려면 다시 돌린다.
- 이 명령을 돌린 세션도 훅으로 원장에 행을 남긴다(§1.5). 그 세션 id 를 적는다.
- 증거 문서로 옮길 때는 §6.2 를 따른다. 원시 JSON 은 대상 리포에 커밋하지 않고(1번), 문서와 JSON 에 든 대상 프로젝트 경로와 에이전트 id(route-compare 의 pairs, model-routing 의 rows)는 3번대로 다룬다.

**검증(실측 2026-09-30, 이 리포 원장 사본).**

- 사본(25,066,715 B, sha256 앞 12자 `22ad2cfd29dc`)을 외부 스크래치 프로젝트에 놓고 중립 cwd 에서 `--since 2026-09-28T00:00:00Z` 로 돌렸다. 15건(판독기 7개 x 창·이력 + 저장소 1) ok 14 · unmeasured 1(저장소 이전 전 배치라 체크아웃 기준 저장소가 없었다) · error 0, 일관성 55건 중 위반 0, 12.6초. 창 행 하나를 같은 사본에 `session-coverage.mjs --since` 를 직접 돌린 값과 대조했다(14/24 와 14/24).
- 같은 사본을 `git init` 한 외부 임시 리포에 놓고 그 루트에서 `--cwd` 없이 PowerShell 로 돌렸다. 이력 행 20개가 위 실행과 전부 같았고(같은 snapshot sha256) 10.6초였다.
- 테스트: `plugins/artibot/tests/ledger/v51-census-cli.test.js` 와 `v51-census-inproc.test.js` — 픽스처 원장, 원장 없음, 죽는 판독기, 돌아가는 동안 원장이 늘 때의 스냅샷 일관성, 경로나 바이트를 내지 않는 판독기(미증명), 저장소 이전 뒤 판독기 출력.
- 못 본 것: 새 플랫폼 프로젝트에서의 첫 실행, 이 리포 원장보다 큰 원장의 시간과 출력 크기(25MB 까지만 쟀다), 설치본 캐시에서의 실행(릴리스 전이라 없다), 저장소 이전이 착지한 트리에서 census 전체를 돌린 것(이전 판독기 출력은 따로 실행해 확인했고 census 는 그 출력을 흉내 낸 판독기로만 돌렸다).

## 4. 정합성 점검

관측치 3건 이상을 한 블록으로 보고할 때 "이 수치들이 서로 모순되지 않는가"를 명시 점검 항목으로 넣는다(검증 규율 §5). 개별 사실이 다 맞아도 합치면 설명되지 않는 제3의 사건이 필요할 수 있다. 점검할 항등식과 이 리포에서 관찰된 예:

- 판독기 census: 줄 수 raw = blank + nonblank, nonblank = 손실 + 선택 제외 + survivors, survivors = 읽은 이벤트 수(`plugins/artibot/lib/runtime/ledger.js:222-224`).
- ④: ended = with_receipts + skipped 이고 skipped_by_cause 의 합 = skipped(`plugins/artibot/scripts/ledger/session-coverage.mjs:107-110`). 관찰 예: receipt_sessions 36 − with_receipts 24 = receipt_only 12(백로그 §4-c 정합성).
- route.selected 행 수 = route.bound 행 수(관찰 예 381 = 381, §4-c). 항등식인지는 미확인이므로 어긋나면 원인을 설명한다.
- usage.receipt 행 수 = main + subagent(관찰 예 183 = 36 + 147, §4-c).
- verify 세션 수가 ended 세션 수보다 클 수 있다. writer 착지 시점이 달라서다(§4-c) — 모순이 아닌 예다.
- 서로 다른 시각에 잰 값은 시각 차이가 설명하는지 본다.
- 모순을 발견하면 숨기지 않고 그대로 올린다: "A 와 B 가 동시에 참이려면 C 가 있어야 하는데 C 는 미확인이다".

## 5. 첫 실행 점검 — 이 런북 자체의 검증

이 런북의 명령은 실행 검증을 거치지 않았다. 대상 리포에서 처음 실행할 때 다음을 확인한다.

1. 대상 리포 루트에서 `verify-rate.mjs` 를 실행한다. 출력의 `file` 이 대상 리포의 `.git/artibot/ledger.jsonl` 인지, `ok` 와 `census.file.present` 가 무엇인지 적는다.
2. 원장이 없으면 세션을 몇 번 진행해 훅이 쓰게 한 뒤 다시 실행한다. 그래도 없으면 플러그인 활성과 버전(§1.1)을 확인한다.
3. 판독기가 exit 2 를 내면 stderr 한 줄의 사용법을 그대로 따른다. 추측한 플래그로 재시도하지 않는다.
4. 위 결과를 §2.1 의 T0 기록에 넣는다.
5. 명령이 이 문서와 다르게 동작하면 그 사실을 이 런북의 수정 요청으로 이 리포에 올린다. 문서가 틀렸다는 보고도 정답이다.

## 6. 증거 문서로 만들어 이 리포로 되돌리기

### 6.1 증거 문서

- 위치: 이 리포 `.artibot/guides/v5-design/evidence/`. `reports/` 는 추적되지 않으므로 git 에 남겨야 하는 증거는 여기에 둔다([evidence/README.md](evidence/README.md)).
- 파일명 관례: `<행 또는 축>-<주제>-<YYYYMMDD>.md`(예: 기존 `sh09-question-rate-20260929.md` · `p0-16-i7-20260929.md`). 그리고 README 표에 행을 하나 더한다 — 파일 · 무엇인가(수치 요약과 못 보는 것) · 출처(줄기 · 측정 시각 · 호스트 버전 · 기준 커밋).
- 본문 골격(기존 증거 문서 관례):

```text
# <행 ID 또는 축> <주제> (<YYYY-MM-DD>)
- 대상 프로젝트: <별칭> · 플러그인 <버전>/<sha> · 호스트 <버전> · 측정 <UTC 시각>
- 주장 등급: 꾸밈 없는 서술 = 실측, "추론", "미확인"(6절에 모은다)
- 이 문서는 상태 전환 권한이 없다.
## 0. 판정(먼저)
## 1. 방법과 재현 명령(원문)
## 2. 결과 — 분자/분모, 창, 측정 시각
## 3. 유효성 대조
## 4. 관측치 정합성
## 5. 이 수치가 못 보는 것
## 6. 미확인
## 부록. 원시 출력과 임시 스크립트 원문
```

### 6.2 되돌리는 절차

1. 대상 리포 세션: 판독기 원시 출력(한 줄 JSON)을 원문 그대로 파일로 보존한다. 저장 위치는 대상 리포 밖 스크래치이고 대상 리포에는 커밋하지 않는다.
2. 이 리포 세션(리더 또는 doc-updater): 위 골격으로 증거 문서를 쓰고 README 행을 더한다. 커밋은 경로를 명시해 add 한다(`git add -A` 금지 — 검증 규율 §7).
3. 프라이버시: 출력의 입력 경로에는 대상 프로젝트의 경로가 들어 있다. 프로젝트 이름을 이 리포에 남기기 곤란하면 별칭으로 바꾸고 바꿨다는 사실을 문서에 적는다(오너 결정). `route-compare.mjs` 의 `pairs` 는 agent id 째로 나온다. `question-rate.mjs` 는 프롬프트·질문 본문과 세션 id 를 출력하지 않는다(`plugins/artibot/scripts/evals/question-rate.mjs:42-46`).
4. 리더: [V5-BACKLOG.md](V5-BACKLOG.md) 행의 status·evidence 를 갱신한다. 그 행 자신의 done 문언을 충족한다는 증거(증거 문서 경로 · 측정 시각 · 분모)가 있을 때만이고, 커밋 제목·본문에 행 ID 를 인용하며 백로그 §1 수치를 같은 커밋에서 재계수한다(백로그 §1 갱신 규칙, §4-i).
5. 측정 결과가 코드 수정을 요구하면 이 리포에서 새 결정으로 다룬다. 웨이브 재개는 오너 결정이다.
6. 증거 문서 커밋 전 문서 게이트: `plugins/artibot` 에서 `npm run docs:check`(추적 파일만 스캔하므로 add 뒤에 실행) · `tests/firewall/no-control-bytes.test.js` · 추가된 줄에 split 디렉터리 경로 리터럴이 없는지 확인.

### 6.3 하지 않는 것

- 증거 문서로 status 를 바꾸지 않는다. 증거 문서에는 전환 권한이 없다.
- 게이트를 완화하거나 done 조건을 넓히지 않는다(백로그 §4-j).
- 측정하지 않은 것을 추측으로 채우지 않는다. 판독기가 null 이면 null 이라고 쓴다.

## 7. 모델별 사용량 표 읽는 법 — B-3 착지 후

- 상태: 이 문서 작성 시점에 표를 만드는 코드가 없다(`plugins/artibot` 의 commands · lib · skills · scripts 에서 관련 문구 grep 0건). 표의 형식과 붙는 위치는 B-3 착지 뒤 확정되므로 이 절은 그때 채운다.
- 착지 뒤 확인할 것:
  1. 표의 분모가 어떤 원장 행인가. `usage.receipt` 는 spawn 당 1행이고 `usage.source` 는 transcript · otlp · estimate 중 하나이며 estimate 는 측정 집계에 섞지 않는다(`plugins/artibot/schemas/attempt-receipt.schema.json:41`).
  2. 비용은 `cost.total` 과 `cost.pricing_version` 으로 읽는다(`plugins/artibot/schemas/attempt-receipt.schema.json:120-131`).
  3. 표에 없는 모델은 안 쓴 것이 아니라 카탈로그에 없어 영수증이 버려진 것일 수 있다. `session-coverage.mjs` 출력의 `unresolved_models` 로 대조한다(P0-16 행의 `claude-sonnet-5-5` 사례).
  4. 표의 합계를 원장 `usage.receipt` 행 합과 대조한다(§4).
  5. 표가 원장에 쓰이는지, 화면에만 나오는지는 미확인이다.

## 8. 미확인

- §3.6 의 census 를 뺀 이 문서의 어떤 명령도 실행하지 않았다(셸 없음). 플래그와 출력 필드는 스크립트 머리 주석에서 옮겼다.
- 체감 패키지 착지 후 스위치 값 · B-1 메커니즘 · B-2 키 이름 · B-3 표 형식.
- 설정 편집이 진행 중 세션에 즉시 반영되는지, `/update` 가 설치본 설정 편집을 되돌리는지(추론 근거는 SH-11 행뿐).
- SH-03 실사용 n, Canary 오작동·되돌림률 임계, SH-12 heartbeat 를 읽는 정확한 필드 위치.
- PAUSE·재시도 횟수와 CA-01 게이트 히트를 세는 판독기.
- 대상 리포가 git 이 아니거나 워크트리인 경우의 실환경 동작(폴백 경로 규칙은 코드로만 확인).
- PowerShell 리다이렉트의 인코딩.
- §3.6 census: 어느 릴리스부터 설치본 캐시에 들어가는지, 새 플랫폼 프로젝트에서의 첫 실행, 25MB 를 넘는 원장에서의 실행 시간과 출력 크기, 측정 중 원장에 붙은 행이 사본에 반쯤 잘려 들어갔을 때 판독기 census 의 corrupt 1행으로 읽히는지(추론만 — 그 순간을 재현하지 못했다).
- 대상 리포 세션이 이 런북을 읽는 경로(오너가 그 프로젝트의 CLAUDE.md 에 이 파일 위치를 적을지는 오너 결정).
