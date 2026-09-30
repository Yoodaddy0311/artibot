# SH-02 Shadow 플립 리허설 — 이 문서는 D3 를 뒤집지 않는다 (조건 c·e·f 증거 전용)

**리허설 브랜치는 착지하지 않았고, D3(Shadow 진입 플립)는 보류다 — a-④ 미충족: 원장 raw 78.0% / 제외 후 86.8%, n=59/53.** 이 수치는 리더 지시문과 웨이브 2 계획서의 인용이며 이 줄기에서 재측정하지 않았다. 이 문서가 착지시키는 것은 이 파일 하나뿐이다. 플립(config·마커·핀)은 로컬 브랜치 `rehearsal/sh01-flip-20260929` 에만 있고 푸시 0 · 병합 0 이다.

| 항목 | 값 |
|---|---|
| 대상 | V5-BACKLOG **SH-02**(artifact-lifecycle 이벤트 → intent/plan/review/outcome.md) · §4-b `runtime.artifactLifecycle.enabled`(SH-01, Shadow 진입 릴리스) 행의 플립 조건 **c · e · f** |
| 위임 | 웨이브 2 W2-5 `sh01-flip-rehearsal` · 결정 R2-7 "리허설 브랜치는 절대 착지하지 않는다, D3 는 a-④ 전까지 보류" |
| 기준 | master 스냅샷 `d13470d220a21e4c28113fac1b05f8b943b76aba`(W1-2 EC-01 · W1-4 포함) + CA-08 팁 `5203dec423967cc89fa966da25c916f3f4992133`(W1-4 `245fc47c` 위에 선 브랜치 `worktree-agent-ad549a863a4e6f7a7` — `git branch --contains 5203dec4` 가 그 브랜치와 이 리허설 브랜치만 낸다: 로컬 master 에는 아직 없다. 반대로 `d13470d2` 는 로컬 master 의 조상이다(`git merge-base --is-ancestor`)) |
| 리허설 커밋 | `ae341393`(CA-08 병합) → `f1c21d58`(플립 1/2: config + 마커) → `1ff09844`(플립 2/2: 핀 4파일). 전부 `Split-Limb: wip`. 전체 SHA: `ae34139380d9b90277191a293364a45ab3ddd0ca` · `f1c21d58d665992123a13613b7a50dd58eced428` · `1ff09844ad4c8761998c453063756a95b702f139` |
| 증거 브랜치 | `w2-5-evidence`(와 같은 커밋을 가리키는 worktree 자신의 브랜치 `worktree-agent-a8d22639c241078a6`) = `d13470d2` 위에 **이 문서만** 얹은 커밋. 리허설 커밋 0, CA-08 병합 0 |
| 측정 창 | 2026-09-29 15:59–17:00 KST(06:59–08:00Z) · win32 · node v24.15.0 · npm 11.12.1 · git 2.54.0.windows.1. 아래 수치는 전부 §1·§3 의 명령과 §4 의 드라이버가 낸 출력이다 |
| 경로 표기 | 랜딩 게이트(금지 인용)가 절대 사용자 경로를 거부하므로 `<WT>` = 이 줄기의 worktree, `<S>` = 작성자 스크래치, `<user-path>` = 스크럽된 사용자 경로. 스크래치 원출력은 세션 종료 시 사라질 수 있으니 인용 수치는 이 문서가 정본이다 |

## 0. 판정 (먼저)

| 조건 | 판정 | 등급 |
|---|---|---|
| **e** 핀 + config 주석 동반 수정 | **리허설 브랜치에서 실증(본번 미충족) — 플립 발자국은 정확히 6 파일 +49/−26. 핀 파일은 백로그가 적은 3곳이 아니라 4곳이다**(CA-08 이 4번째를 들여왔다). 핀만 안 고친 상태(커밋 `f1c21d58`)에서 표적 4파일이 7 테스트 RED, 고친 뒤 200/200 GREEN | 실측 |
| **f** 같은 릴리스의 배치 CI green | **플립이 원인인 실패는 0. 그러나 전체가 그린이었다고는 말하지 않는다** — `npm run ci` 1회차는 23,231 테스트 중 1건 RED(로드 타임아웃), 단독 재실행은 통과. 체인이 그 RED 에서 멈춰 마지막 단계 `eval:runtime:check` 는 별도 실행으로 통과 | 실측 + 추론(플레이크 판정, §3.3) |
| **c** 미추적 missions 가 clean-tree 게이트를 견디는가 | **요청 범위(split land · autopilot preflight)는 충족** — land 7행이 미션 유무와 무관하게 동일 PASS, preflight `gitClean` 은 warn(차단 아님)·전체 `ok:true`. 그러나 **추가 소비처 3곳에서 플립이 실제로 걸린다**: cowork 릴리스 `--dry-run` exit 1, autopilot reaper `preserved: missions-present`, `git worktree remove` 거부. 그리고 autopilot Stop 훅은 허용 리포에서 미션 4파일을 커밋으로 쓸어 담는다 | 실측 |
| **D3** | **보류 유지.** 이 리허설이 바꾸는 것은 e·f·c 의 증거 상태뿐이다. 이 문서는 e·c 의 리허설 증거와 f 의 사전 증거를 더할 뿐이다. e·f 는 플립 본번 커밋과 그 배치 CI 에서 다시 충족돼야 하고, c 는 요청 밖 소비처 X1–X4 가 남는다. a-④ 는 86.8% < 95% 로 미달이다. | — |

### 계획서·백로그와 다른 점 (교정)

1. **핀은 3곳이 아니라 4곳** — §4-b e 는 `artifact-lifecycle-apply` · `artifact-lifecycle-dryrun` · `subagent-handler-review-writer` 3곳을 적었다. CA-08(`5203dec4`)의 `tests/commands/resume-read-order-guard-doc.test.js` 가 `artifactLifecycle.enabled` 를 `false` 로 핀하는 4번째다. CA-08 이 착지하면 실제 플립 커밋은 4곳을 고쳐야 한다.
2. **config 주석 "only production caller" 조항은 이미 소멸했다** — 그 문구는 커밋 `05be7948`(B4)이 "네 훅"으로 교정하면서 지웠다(`git log -S"only production caller" -- plugins/artibot/artibot.config.json` 이 `0f4b9a1e`(추가) · `05be7948`(제거) 두 커밋만 낸다. 리포 전역 `grep -rni "only production caller"`(node_modules·.git 제외)는 3곳만 낸다 — V5-BACKLOG 자기 자신, 무관한 workflow 결과 JSON, topology 테스트 주석 — config 에는 0건). 그래서 이 줄기가 config 주석에 한 일은 그 문구 수정이 아니라 **출하 상태 문장 2개 추가**다(§2).
3. **백로그의 핀 줄번호는 썩었다** — §4-c 가 적은 `apply:521-523` · `dryrun:808-809` · `review-writer:784` 는 `d13470d2` 에서 핀이 아닌 줄을 가리킨다(각각 `const result = runPlan(…)` · `'createWriteStream',` · `mkdirSync(…)`). 실제 핀은 apply 616·641(+행동 pin 645-649·813-819) · dryrun 888 · review-writer 881 · resume-read-order-guard-doc 267 이다(`git show d13470d2:<path>` 로 확인).

## 1. 방법과 재현

```
# 준비: worktree 안에서, 부모 경로는 --parent 로 (메인 루트로 cd 하지 않는다)
node plugins/artibot/scripts/split/worktree-setup.mjs <WT> --parent <REPO> --limb sh01-flip-rehearsal --json
#   → link plugins/artibot/node_modules = junction (fs.symlinkSync), ok:true

git merge --ff-only d13470d2                  # "Already up to date." (HEAD 가 이미 d13470d2)
git switch -c rehearsal/sh01-flip-20260929    # 병합 전에 브랜치를 먼저 만든다 (아래 주)
git merge --no-ff 5203dec4 -F <msg>           # 제목 "rehearsal: CA-08 onto d13470d2" → ae341393

# 핀 grep (플랜 §6): 첫 편집 전 출력 저장 → 마지막 편집 뒤 다시 → diff
grep -rn "cited_line" plugins/artibot/schemas/
grep -rnE "['\"`][a-zA-Z0-9_./-]+\.(m?js|md|json):[0-9]+" plugins/artibot/tests/firewall
```

**순서 주(의도적 편차)**: 지시문은 "병합한 뒤 그 지점에 브랜치"였다. 브랜치를 먼저 만들고 그 위에서 병합해 **worktree 자신의 브랜치(`worktree-agent-a8d22639c241078a6`)가 CA-08 병합을 갖지 않게** 했다 — 그 브랜치를 배치 fold 가 집으면 리허설 병합이 딸려 들어갈 수 있다. 결과 그래프는 같다. 문서 커밋 직전 `git branch -vv` 확인: `worktree-agent-a8d22639c241078a6` = `d13470d2`(리허설 커밋 0), `rehearsal/sh01-flip-20260929` = `1ff09844`, 업스트림 없음. 문서 커밋은 `git switch -c w2-5-evidence d13470d2` 위에 만들었고(`reset --hard` 없이), 그 뒤 worktree 자신의 브랜치를 `git merge --ff-only w2-5-evidence` 로 같은 커밋에 맞췄다.

- 플립 1/2(`f1c21d58`): `plugins/artibot/artibot.config.json` `enabled` false→true + `comment` 끝 2문장, 루트 `.artibot/artifact-lifecycle.optin`(추적 마커) 신규.
- **핀은 일부러 뒤로 미뤘다**: 플립 1/2 만 커밋한 상태에서 표적 4파일을 돌려 RED 목록을 뽑고(§2), 그다음 플립 2/2(`1ff09844`)에서 핀을 고쳤다.
- 각 커밋 전 `git diff --cached --stat` · `git status --porcelain` 확인, `git add` 는 경로 명시(`-A` 0), 메시지는 `git commit -F <파일>`, 트레일러는 `git log -1 "--format=%(trailers:key=Split-Limb,valueonly)"` 로 `wip` 확인.
- 테스트는 플러그인 config 서브셸에서만: `(cd <WT>/plugins/artibot && npx vitest run <files>)`. 호스트 세션 env 를 비운다: `env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID`(라이브 세션 id 로 원장 행이 써지는 것을 막는다).
- 핀 grep 결과: 첫 명령 6줄 · 둘째 명령 73줄. **첫 편집 전(`d13470d2`)과 마지막 편집 뒤(리허설 팁) 출력이 같다**(`diff` 무출력, exit 0). 이 줄기가 소유 밖 줄번호 핀을 움직이지 않았다.

## 2. 조건 e — 플립 발자국 (실측)

**리허설 팁 `1ff09844` vs CA-08 병합 `ae341393`**(`git diff --numstat`): 6 파일, +49 / −26.

| 파일 | 변경 | +/− |
|---|---|---|
| `plugins/artibot/artibot.config.json` | `runtime.artifactLifecycle.enabled` false → true · `comment` 끝에 "Ships true from the Shadow-entry release … one-key rollback" 2문장 추가. 블록 키는 여전히 `comment · enabled · projectMarker` 3개, 최상위 키 32개 불변, `runtime.resume.staleGuard` 는 false 그대로 | +2/−2 |
| `.artibot/artifact-lifecycle.optin` | 신규 추적 마커(내용 무시, regular file 이면 된다 — `lib/runtime/artifact-lifecycle.js#resolveArtifactGate`) | +4/−0 |
| `plugins/artibot/tests/runtime/artifact-lifecycle-apply.test.js` | 핀 4개 뒤집기(아래) + "마커 없는 프로젝트는 LIVE config 에서도 닫혀 있다" 음성 대조 1개 신규 | +26/−10 |
| `plugins/artibot/tests/runtime/artifact-lifecycle-dryrun.test.js` | 핀 1개 + 주석 | +5/−4 |
| `plugins/artibot/tests/hooks/subagent-handler-review-writer.test.js` | 핀 1개 + 주석 2곳 | +7/−6 |
| `plugins/artibot/tests/commands/resume-read-order-guard-doc.test.js` | 핀 1개(CA-08 신규 파일) | +5/−4 |

**RED → GREEN.** 플립 1/2 만 얹은 상태(핀 미수정)의 표적 4파일: `Test Files 4 failed (4)` · `Tests 7 failed | 192 passed (199)`. 실패 7건 전체:

| 파일 | 테스트 | 뒤집은 방향 |
|---|---|---|
| apply | "ships runtime.artifactLifecycle.enabled false in 4.61.0 (Observe)" | `toBe(false)` → `toBe(true)` |
| apply | "is reachable at the exact dotted path apply() reads" | `toBe(false)` → `toBe(true)` |
| apply | "keeps the LIVE config closed at gate 2, so apply() throws" | LIVE config 는 이제 gate 2 전역 절반이 열린다 → throw 대신 dry-run 리포트 + `written: []` + 디스크 파일 0 |
| apply | "closes on the LIVE shipped config, because enabled ships false" | 마커가 있는 프로젝트는 `{open:true, reason:'open'}`; 마커 없는 프로젝트는 `project-off`(신규 음성 대조 1개 추가) |
| dryrun | "pins the shipped artibot.config.json gate value as a real boolean false" | `toBe(true)` |
| review-writer | "RECORDS the shipped kill-switch value: 4.61.0 creates zero review.md" | `toBe(true)` |
| resume-read-order-guard-doc (CA-08) | "leaves the write-side gate untouched: … enabled false (rules §10)" | `toBe(true)` |

핀 갱신 뒤: `Test Files 4 passed (4)` · `Tests 200 passed (200)`(199 + 신규 1). `npx eslint --max-warnings=0` 4파일 종료 코드 0. 게이트를 느슨하게 한 곳은 없다 — 각 핀은 옛 값 대신 뒤집힌 값을 단언하고, 뒤집기로 잃는 "LIVE 가 닫혀 있다" 단언은 "마커 없는 프로젝트는 여전히 닫혀 있다"(`project-off`)로 대체됐다. 이 대체가 플립의 실제 안전 성질(전역 ON 이어도 마커 없는 프로젝트는 쓰기 0)을 LIVE config 로 측정한다.

**플립 뒤 거짓이 되는 산문(편집하지 않음 — e 의 서술 범위 밖, 전수 아님):** `plugins/artibot/commands/scorecard.md` 156행 부근("`runtime.artifactLifecycle.enabled` 가 false 로 출하 — 라이브 0 이 정답"), `plugins/artibot/lib/runtime/artifact-lifecycle.js#resolveArtifactGate` JSDoc("`enabled` ships `false`"), `plugins/artibot/scripts/hooks/_review-stop-record.js` 헤더 주석("global half … ships FALSE"), `plugins/artibot/tests/hooks/intent-observe-pre.test.js` 주석("4.61.0 ships … false"). README 의 릴리스 항목들은 그 날짜의 사실이라 그대로 참이다. 이 산문 때문에 실패한 `npm run ci` 항목은 없다 — 어떤 게이트도 이 산문을 잡지 않는다.

## 3. 조건 f — 리허설 브랜치 `npm run ci` (실측)

명령(worktree 루트, 리허설 팁, 시작 16:20:25 KST): `env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID NO_COLOR=1 npm run ci` — 루트 `ci` 는 `npm --prefix plugins/artibot run ci` 이고, 그 체인은 `validate.js && validate-bin.js && validate-install.js && skill:check && docs:check && lint && npm test && eval:runtime:check` 다.

### 3.1 단계별 결과

| 단계 | 결과 |
|---|---|
| `node scripts/validate.js` | `Validation passed.` |
| `node scripts/validate-bin.js` | `OK — 3 bin entries verified` |
| `node scripts/ci/validate-install.js` | `23 checks passed` |
| `skill:check` | `160 skills · 0 errors · 15 warnings · 150 fully compliant` · `PASS: no new violations, no stale baseline entries` |
| `docs:check` | `PASS: 585 documentation file(s) checked … 0 broken references.` |
| `lint` (`eslint . --max-warnings=0`) | 출력 없이 통과(다음 단계가 시작됨) |
| `npm test` (vitest) | **`Test Files 1 failed | 791 passed (792)` · `Tests 1 failed | 23217 passed | 13 skipped (23231)`** · Duration 468.57s · 검산 1+791=792, 1+23217+13=23231 |
| `eval:runtime:check` | 체인이 `npm test` 실패로 멈춰 **실행되지 않았다** → 별도 `npm --prefix plugins/artibot run eval:runtime:check` 실행: `PASS averageScore actual=1 expected=>= 0.9` · `failedScenarios 0` · `passedEqualsTotal 8/8` · `All runtime eval thresholds passed.` |

### 3.2 실패 1건

`tests/hooks/intent-observe-pre.test.js` › "intent-observe-pre — spawn budget (informational)" › "runs the latched path N=20 times under a 3000 ms headroom" — `Error: Test timed out in 30000ms.`(테스트 파일 줄 1085 부근).

### 3.3 플립 인과 vs 로드 (rerun 1회 — 요청된 절차)

| 근거 | 값 | 등급 |
|---|---|---|
| 같은 파일 전체 런 소요 | 97,317 ms(`❯ … intent-observe-pre.test.js (37 tests | 1 failed) 97317ms`) | 실측 |
| **단독 재실행, 플립된 리허설 팁** | `Test Files 1 passed (1)` · `Tests 37 passed (37)` · Duration 23.10s · 그 테스트 6,217 ms | 실측 |
| 그 테스트가 플립 값을 볼 수 있는가 | 없다 — 그 파일의 `beforeEach` 는 자기 플러그인 루트 config 를 만들어 `liveConfig.runtime.artifactLifecycle.enabled = true` 를 스스로 쓴다(소스 대조). 출하 값이 뒤집혀도 이 테스트의 입력은 같다 | 추론(소스 대조) |
| 결론 | 그 테스트는 단독에서 6.2 s 인데 전체 런에서는 30 s 를 넘겼고(파일 전체로는 단독 23.1 s vs 전체 런 97.3 s), 그 차이는 8분짜리 전체 런의 부하로 설명된다. **플립이 원인인 실패는 관측되지 않았다.** 다만 이 1회 런은 RED 로 끝났으므로 "CI 그린"은 주장하지 않는다 | 실측 + 추론 |

### 3.4 부작용 점검 (플립 ON + 루트 마커 상태로 전체 스위트를 돌린 뒤)

`git status --porcelain` 출력 없음 · `.artibot/missions/` 디렉터리 생성 0(`ls` 로 부재 확인) · `git log` 의 리허설 팁 불변. 어떤 테스트도 리포 루트에 미션 파일을 쓰지 않았다(전체 스위트가 플립 ON 상태의 루트 마커를 본 채로 돌았는데도).

### 3.5 f 가 보지 못하는 것

로컬 `npm run ci` 1회다. GitHub check-runs 는 브랜치를 푸시하지 않았으므로 미실행이다(플립 커밋 본번의 f 는 그 배치 CI 다). 전체 런 1회에서 RED 1건이 났으므로 전체 그린 총계는 이 문서에 없다.

## 4. 조건 c — 플립 ON 미션 생애주기와 clean-tree 소비처 (실측)

### 4.1 방법

일회용 `git init` 리포를 `<S>` 아래 만들고, **리허설 팁의 실제 훅 스크립트**를 호스트 모양 payload 로 자식 프로세스에 태웠다(`CLAUDE_PLUGIN_ROOT` = 리허설 팁 config 의 바이트 복사본 — 즉 출하 config `enabled:true`; HOME/USERPROFILE 은 스크래치로 리다이렉트, 호스트 세션 id env 제거). 리포는 루트 `.gitignore` 를 바이트 그대로 복사하고 추적 파일 `.artibot/project.md` 와 추적 마커 `.artibot/artifact-lifecycle.optin` 을 가진 `init` 커밋 1개로 시작한다.

생애주기(드라이버 `<S>/c-sim.mjs`, 호출 `node <S>/c-sim.mjs <WT> <S>/c-sim-run6`). 드라이버는 리포에 커밋하지 않았다(지시: 착지분은 이 문서 하나) — 아래 6단계를 그대로 다시 짜면 재현되고, 스크래치 원본은 세션 동안만 남는다:

| 단계 | 실제로 한 것 |
|---|---|
| S1 | `mission.candidate_deferred` 행을 원장에 시드(stage ① 대용 — 훅 테스트가 하는 방식) |
| S2 | PreToolUse `Write src/parser.js` → `scripts/hooks/intent-observe-pre.js` (`mission.created` + 스토어 행 + `intent.md`) |
| S3 | PreToolUse `Write .artibot/missions/<M>/plan.md` → 같은 훅의 plan 관측기 (`plan.revised` → 스토어 plan.revision 1→2 → `plan.md`) |
| S4 | 실제 writer `buildVerifyCompletedEvents` 로 `verify.completed` 4행(PASS ×3 레이어 + 종합) 시드 |
| S5 | SubagentStop(`code-reviewer`, v2 PASS verdict) → `scripts/hooks/subagent-handler.js stop` (`review.completed` + `review.md`) |
| S6 | SessionEnd → `scripts/hooks/mission-complete-record.js` (`mission.completed{accepted:null}` + `outcome.md`) |

시나리오 A–G 는 시나리오마다 **별도 리포**(원장·스토어가 공통 git dir 에 있어 같은 SID 가 섞이지 않게)다. 같은 드라이버의 이전 실행(run 4, G 추가 전)과 run 6 의 A–F 출력은 무작위 id(커밋 SHA · 리포 해시 · 브랜치 접미사)만 다르고 같았다 — 재현된다. 드라이버는 시작 시 리허설 플립이 체크아웃되어 있는지(config `enabled === true` · 루트 마커 존재) 검사하고 아니면 거부한다 — 첫 실행 중 하나가 플립 안 된 증거 브랜치를 보고 마커 부재로 실패해서 넣었다.

### 4.2 생애주기 결과와 대조군

| 시나리오 | 설정 | 결과 |
|---|---|---|
| **A** 대조 | flip OFF(`enabled:false`, 그 외 동일), 마커 추적 | S2·S3·S5 후 파일 0. S6 stderr `[artibot:mission-complete-record] mission=M-20260929-Ssessflip declared=new block=ARTIFACT_ABSENT write=blocked`. `git status --porcelain` = `""` |
| **B** 대조 | flip ON, 프로젝트에 마커 **없음** | 파일 0, S6 `block=ARTIFACT_ABSENT write=blocked`, status `""` — 전역 ON 이어도 마커 없는 프로젝트는 쓰기 0 |
| **C** (P1) | flip ON + 추적 마커, **메인 체크아웃** | 파일 4개: `intent.md` 715 B · `outcome.md` 1,629 B · `plan.md` 759 B · `review.md` 578 B(합 3,681 B). S6 `block=none write=written`. 4파일 모두 자기 파서 통과(`plan/review/outcome` → `ok:true, errors:0`; `intent` → frontmatter 있음, warnings 0), land 인용 게이트의 금지 패턴 2종(Windows 사용자 절대 경로 · split 상태 디렉터리 리터럴) 0건, 제어 바이트 0 |
| **D** (P2) | flip ON + 마커, **`/split` 레인 worktree**(cwd = 레인) | C 와 같은 4파일이 **레인 worktree 안에** 생기고 메인 체크아웃 status 는 `""` |

A·B 는 "이 드라이버가 플립·마커 없이도 파일을 만드는" 위양성을 배제하는 음성 대조다. 원장 행(`mission.created` · `plan.revised` · `verify.completed` · `review.completed`)은 A·B 에서도 남는다 — config 주석의 "enabled=false 면 파일 0, 훅은 원장 이벤트를 계속 기록한다" 와 일치.

`outcome.md` 는 S4 에서 시드한 PASS verify 행 덕분에 써졌다. 라이브 `verify.completed` 는 대부분 `unmeasured` 라 라이브에서 outcome.md 는 게이트에서 막히는 것이 정상이다 — SH-02 행 비고(2026-09-29 batch-1)가 "미션 80 중 새로 열림 2 · 새로 닫힘 0, 두 미션 모두 `REVIEW_VERDICT_NOT_PASS` 로 막힘"이라 적은 대로이며, 이 문서는 그 라이브 분포를 재측정하지 않았다.

### 4.3 요청된 게이트 — split land · autopilot preflight (실측)

**미션이 미추적일 때 `git status --porcelain`**(C 메인 체크아웃 / D 레인): `?? .artibot/missions/`(1항목 — `.artibot/` 에 추적 파일이 있어 git 이 미션 디렉터리까지만 접는다). `-uall` 로는 4파일.

| 소비처 | 입력 | 출력 | 판정 |
|---|---|---|---|
| **autopilot preflight `gitClean`** (`plugins/artibot/lib/autopilot/preflight.js#runIndividualCheck`) | C 메인 체크아웃 | 미션 전 `pass` → 미션 후 `{"name":"gitClean","status":"warn","detail":"1 dirty path(s)"}` | **warn, fail 아님** |
| **autopilot `runPreflight` 전체 배터리** | 같은 리포 | `ok:true`, `errors:[]`, warnings 2건 = `gitClean`(위) + `diskSpace`(`disk-check-unavailable` — 이 머신의 디스크 조회 도구 부재, 미션과 무관) | **ok:true** |
| **split land** (`node plugins/artibot/scripts/split/land.mjs lane-b --base main --plan <파일> --json`, 리포 cwd) | D: 레인 브랜치 `limb-b`(`notes/note.md` 1개 변경, `Split-Limb: done`) — 레인 worktree 에 미션 4파일 미추적 | 미션 **전**과 **후** 모두 `status:"PASS"`, exit 0, 7행: `trailer` ok · `ownership` "1 file(s), all inside allowlist" · `binary` "no binary rows" · `citations` "no forbidden citations in added lines" · `merge-dry-run` "clean (tree …)" · `behind-base` "0 commit(s) behind main" · `lint` "SKIP — 변경된 .js/.mjs 0건". **전/후 행(id·ok·detail)과 status 가 완전히 같다(비교 결과 `true`)** | **7/7 동일 PASS** |

land 의 6행(trailer · ownership · binary · citations · merge-dry-run · behind-base)은 커밋 트레일러 · `git diff <base>...<branch>` · merge-tree · rev-list 에서만 나오고 land 의 lint 행은 `--untracked-files=no` 로 status 를 부르므로(`plugins/artibot/tests/firewall/missions-clean-tree.test.js` 가 소스 핀으로 고정), 작업트리의 미추적 파일이 행에 들어올 통로가 구조적으로 없다. 이 리허설은 그 구조적 주장을 **실제 생애주기가 만든 4파일**로 확인한 것이다(기존 방화벽 테스트의 픽스처는 손으로 쓴 파일 1개).

**게이트가 미션 파일을 볼 수 있는가 — 음성 대조 E**(레인이 금지된 `git add -A` 로 미션까지 커밋): land `status:"FAIL"`, exit 1, `ownership` = `"4 outside allowlist: .artibot/missions/M-20260929-Ssesselan/intent.md, …/outcome.md, …/plan.md, …/review.md"`. 같은 실행에서 `citations` 행은 ok(미션 파일 자체는 금지 패턴을 담지 않는다) — 미션이 커밋으로 새면 막는 것은 `ownership` 하나다. 그래서 "전/후 동일"이 게이트의 눈멂이 아니다.

### 4.4 요청 밖 소비처 — 플립이 실제로 걸리는 곳 (실측)

| # | 소비처 | 실행한 것 | 결과 |
|---|---|---|---|
| X1 | `plugins/artibot-cowork/scripts/release.js` `validateGitState`(`--dry-run` 하드코딩 — 그 뒤엔 아무것도 건드리지 않는다) | C 메인 체크아웃, 미션 전/후 | 미션 전 exit 0(`OK git state clean (or staged-only)` · `DRY RUN complete`); **미션 후 exit 1** — stderr `[release] Working tree has unstaged changes:` / `  ?? .artibot/missions/` / `[release] ERROR: commit or stash unstaged changes before releasing`. 방화벽 테스트가 "소스 대조, 실행 미확인"으로 남긴 유일한 차단 후보를 **실행으로 확인** |
| X2 | `plugins/artibot/lib/autopilot/worktree-manager.js#reapWorktree` (실제 `createWorktree`로 만든 autopilot 세션 worktree 2개, `integrationTarget: main`) | 미션 없는 대조 vs 미션 있는 쪽 | 대조 `{action:"removed", reason:"integrated"}` · **미션 있음 `{action:"preserved", reason:"missions-present"}`**. `describeWorktreeHead` = `dirty:true, missionsPresent:true`. 설계된 안전 동작이지만, 플립 ON 이면 쓰기 훅이 한 번이라도 돈 autopilot worktree 는 자동 정리되지 않는다 |
| X3 | `git worktree remove <레인 worktree>` (`--force` 없음) — `/split` 창 닫기 순서(`plugins/artibot/skills/split/references/operations.md`)의 `git worktree remove` 단계, 그리고 autopilot `removeWorktree` 의 기본 호출(`force` 없으면 `--force` 미부착)과 같은 명령 | D 레인 worktree, 대조는 미션 없는 새 worktree | 대조 exit 0 · **미션 있음 exit 128** `fatal: '<user-path>' contains modified or untracked files, use --force to delete it`. `--force` 는 미추적 미션을 지운다(reaper 소스 주석이 "their loss is silent whether or not git tracks them" 라 적은 그 손실) |
| X4 | `plugins/artibot/scripts/hooks/git-autopilot-close.js` (Stop 자식, 출하 `commitStrategy: "semantic"`) — 리포가 autopilot 허용 목록에 있고 `phase` 전이(PLAN→EXECUTE)가 전달될 때 | G: 허용 리포(샌드박스 allowlist + `.invalid` 원격 + `autoPushOnStop:false` — **네트워크 0, 실제 원격명 0**) | **`Semantic commit: PLAN phase complete` — HEAD 이동, 제목 `docs(autopilot): 4 file(s): .artibot/missions/…/intent.md, …/outcome.md, …/plan.md [PLAN complete]`, 커밋에 미션 4파일 전부, 이후 status `""`.** 원격이 없는 리포(허용 목록 밖)는 같은 payload 열에서 HEAD 불변 · status `?? .artibot/missions/` 그대로 |
| X5 | `plugins/artibot/scripts/hooks/git-autopilot-save.js` (출하 semantic) | G 허용 리포 | `stash checkpoint skipped — no changes or git error`, status·HEAD 불변 — 쓸어 담지 않는다(`git stash create` 는 추적 변경만) |

**X4 의 도달성**: 이 리포는 기본 allowlist 로 허용이다 — `isAutopilotAllowed(<이 체크아웃>)` 를 실행하면 `remote: https://github.com/Yoodaddy0311/artibot.git`, `normalized: Yoodaddy0311/artibot`, 온디스크 override 파일(`~/.claude/artibot/autopilot-allowlist.json`) 부재, `DEFAULT_ALLOWLIST.repos` 에 포함 → **`true`**(실측). 남은 미확인은 Stop 훅이 라이브에서 `phase` 를 받는가(autopilot 런타임이 넣는 값이다)다. 레인(`/split`) 세션은 autopilot 엔진이 아니라 `phase` 가 없어 이 경로를 타지 않는다고 **추론**한다 — 미측정.

**소스만 읽고 실행하지 않은 `git add -A` 소비처**(전수 grep, `plugins/artibot/{lib,scripts,hooks}` + `plugins/artibot-cowork/scripts`): `git-autopilot-save.js`(`commitStrategy: "interval"` 일 때만), `git-autopilot-close.js` `interval` 경로(`closeOnStop: true` 일 때만 — 같은 파일의 semantic 경로 `commitSemantic` 안 258행의 `git add -A` 는 X4 로 실행했으므로 이 소스-전용 목록에 없다), `scripts/cron/auto-commit-runner.js`(`cwd` 가 플러그인 루트, 위험 분류·첫 N회 관측 전용 게이트 뒤), `scripts/swarm-init.js`·`lib/swarm/git-backend.js`(스웜 클론 디렉터리). 그 밖의 status 파서: `scripts/update-git.js`(`stash push --include-untracked`, 플러그인 업데이트 흐름), `scripts/split/watch.mjs`, `lib/handoff/*`. 이들의 라이브 활성 여부는 미확인이다.

## 5. 관측치 간 정합성 점검 (규율 §5)

| 나란히 놓인 관측 | 동시에 참인가 | 판정 |
|---|---|---|
| 백로그 §4-b: 핀 3곳 vs 실측 4곳 | 4번째는 CA-08(`5203dec4`)이 도입한 파일이고 §4-b 는 CA-08 이전(2026-09-21, `845cab37`) 기준 | 모순 아님 — 기준 시점 차이 |
| §4-b "config 주석 ‘only production caller’ 수정 필요" vs 실측 "그 문구 config 에 0건" | `05be7948`(B4, 같은 날 뒤)이 이미 교정 | 모순 아님 — 조항이 소멸(`05be7948` 은 2026-09-21 18:28 KST, §4-b 의 추적 기준 `845cab37` 은 같은 날 15:06 KST — `git log -1 --format=%ci`) |
| f: 전체 런 RED 1 vs 단독 재실행 37/37 | 같은 테스트가 부하에서만 30 s 를 넘긴다(97 s vs 23 s) | 일관 |
| c: land 행 전/후 동일 vs cowork 릴리스 exit 1 vs reaper preserved | 서로 다른 소비처가 서로 다른 입력을 본다 — land 는 커밋 diff, 나머지는 `git status`/디렉터리 존재 | 일관(같은 파일, 다른 정책) |
| c: G 의 커밋 스윕 vs 레인 worktree 가 깨끗하게 남는 D | G 는 허용 리포 + `phase` 전이, D 는 훅이 없는 경로 | 일관 — 도달 조건이 다르다 |

## 6. 이 증거가 못 보는 것 (게이트 옆에 적는다)

- **호스트가 이 훅들을 라이브에서 실제로 발화하는가** — 훅을 직접 spawn 했다. payload 모양은 기존 훅 테스트의 fixture 모양을 그대로 따랐고(SubagentStop 은 그 테스트가 호스트 실측 키 집합이라 적은 것), 이 문서는 라이브 세션에서 파일이 생기는 것을 관찰하지 않았다. "플립 뒤 라이브 미션 파일 존재"는 릴리스 뒤 관측 사항이다.
- **stage ① 은 시드, verify 는 시드** — `mission.candidate_deferred`(UserPromptSubmit 산출) 와 `verify.completed` PASS 4행은 훅 테스트가 하는 대로 직접 넣었다. 라이브에서 verify 는 대부분 `unmeasured` 다.
- **규모** — 미션 1개·파일 4개·3.7 KB. git 은 미추적 디렉터리를 1항목으로 접으므로 clean-tree 소비처는 개수에 둔감하지만, 라이브 미션 수·크기 분포는 측정하지 않았다.
- **land 의 lint 행은 JS 변경이 없는 레인**으로만 쟀다(`SKIP`). JS 를 바꾸는 레인의 lint 행은 `--untracked-files=no` 소스 핀에 의존하며 이 문서가 다시 재지 않았다.
- **ExitWorktree/EnterWorktree(하네스)의 미추적 파일 처리**는 실행하지 않았다.
- **GitHub check-runs** — 리허설 브랜치는 푸시하지 않았다.
- `update-git.js` stash, `watch.mjs`, `lib/handoff/*`, `auto-commit-runner.js` 는 실행하지 않았다(§4.4 마지막 단락).
- **X2 의 경로 우회와 잔여물** — 스크래치 경로가 길어 `git worktree add` 가 `fatal: '$GIT_DIR' too big` 으로 실패했다(run 3 에서 실측). 그래서 X2 의 autopilot 저장소만 짧은 임시 경로에 두었다(문서화된 env seam `ARTIBOT_AUTOPILOT_STORE_DIR` + `ARTIBOT_AUTOPILOT_STORE_DIR_ROOT`). `reapWorktree` 가 미션 있는 쪽을 보존했으므로 그 worktree 디렉터리 2개(run 4·run 6 각 1개)가 시스템 임시 디렉터리의 `w25ap/worktrees/` 아래 남아 있다 — 일회용 리포에만 등록된 무해한 잔여물이며, 재귀 삭제 가드 때문에 이 줄기가 지우지 않았다.
- 시계: 이 문서의 시각은 콘솔 시계(`date` = +0900)를 UTC 로 환산한 것이다.

## 7. 리더가 이 증거로 할 수 있는 결정 (권고이며 확정 아님)

1. **플립 커밋의 실제 발자국은 위 6파일(CA-08 미착지 시 5파일)이다.** 착지 시점에 CA-08 이 master 에 있는지에 따라 `resume-read-order-guard-doc` 핀이 포함/제외된다.
2. **추적 유지(오너 결정 (3), 2026-09-22) 전제에서, 훅이 만든 미추적 미션을 누가·언제 커밋/보존하는가. 설계 §161 B4(autopilot 자동 생성 mission)의 미결 항목에 해당.** 근거 두 곳. 백로그(`.artibot/guides/v5-design/V5-BACKLOG.md` §4-d "오너 결정 7건 — 2026-09-22" 의 (3)): "missions — 추적 유지(현 .gitignore:118-120 정본 그대로, 규칙 추가 0)" — 코디네이터가 전달한 줄번호는 318, `d13470d2` 트리에서는 317이다(줄번호는 편집에 취약하니 § 와 문구로 찾을 것). 설계(`.artibot/guides/v5-design/ARTIBOT-5.0-DESIGN.md` 161행): "결정 필요 = autopilot 자동 생성 mission(B4)". 같은 설계 문서 284행의 B4 행은 질문을 "autopilot/split 자동 생성 mission 추적 여부"로, 권장을 "사람 mission 추적, 자동 생성은 로컬 + outcome 만 승격"으로 적는데, 오너 결정 (3) 의 "규칙 추가 0" 과 문언이 같지 않다 — 어느 쪽이 B4 를 닫는지는 이 문서가 판정하지 않는다(미확인). 이 리허설이 더한 것은 그 미결 항목의 결과다: 미션이 미추적으로 놓이면 X1–X3 이 걸리고, X4(허용 리포 + `phase` 전이)는 미션을 autopilot 커밋에 쓸어 담는다 — 추적을 정본으로 삼는 정책에서는 그것이 의도된 경로일 수 있으나 레인 `ownership` 검사와는 충돌한다(E). 리더가 이를 권장안으로 기록했다(코디네이터 전달, 2026-09-29 — `d13470d2` 트리의 백로그에는 아직 없다): 추적을 유지하고 커밋 주체를 하나로 정한다 — 메인 체크아웃이 명시 경로로 missions 를 커밋하고, 레인의 미션은 worktree 제거 전에 밖으로 복사하며, 릴리스는 `release.js`(X1) 전에 missions 를 커밋한다 — 그리고 이를 플립 전 선행 줄기로 둔다. 이 문서는 그 권장안을 재현하거나 검증하지 않았다.
3. 플립 본번의 CI(f)는 그 배치의 GitHub check-runs 로 다시 판정해야 한다. 이 리허설은 "플립이 만드는 새 RED 가 없다"까지만 사전 증명한다.

## 8. 미확인

- 라이브 호스트에서 플립 뒤 실제 미션 파일 생성·분포(§6 첫 항목).
- `git-autopilot-close` 가 라이브 Stop payload 에서 `phase` 를 받는지(X4).
- 하네스 ExitWorktree/EnterWorktree 가 미추적 미션 worktree 를 어떻게 다루는지.
- 전체 `npm test` 의 그린 총계(1회차 RED 1건, 재실행은 단독 파일만).
- GitHub check-runs 결과(브랜치 미푸시).
- a-④ 수치(78.0% raw / 86.8% 제외 후, n=59/53)의 재현 — 지시문 인용이며 미재측정.
- `update-git.js`·`watch.mjs`·`handoff`·`auto-commit-runner` 의 실제 동작.
- 오너 결정 (3) "규칙 추가 0" 과 설계 284행 B4 권장("자동 생성은 로컬 + outcome 만 승격")의 관계 — 어느 쪽이 B4 를 닫는지(§7-2).
- 리더의 커밋 주체 권장안(§7-2)의 원문 — 코디네이터 전달이며 `d13470d2` 트리의 백로그에는 없다.

SH-02 는 이 문서로 status 가 바뀌지 않는다 — 플립 전까지 in-progress 유지(웨이브 2 계획서 §6, "D3 조건 d·c·e·f 는 조건 증거이지 행 전환이 아니다").
