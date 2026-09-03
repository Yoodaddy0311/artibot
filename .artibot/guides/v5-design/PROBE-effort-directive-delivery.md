# PROBE — `[artibot:effort …]` 디렉티브가 모델에 도달하는가 (측정 보고)

- 측정 시각: 2026-09-03 16:27–16:47 KST · 리포 master @ 3bcadb8e (v4.53.0) · 호스트 Claude Code 2.1.259
- 측정자: team-v5-decisions-01sa2u-effortpath (Fable) · **코드·테스트·config·설치본 변경 0** · 샌드박스는 스크래치 복사본에서만 실행
- 종류: 측정 보고. 설계안 아님. §7 은 제안만 적고 코드는 쓰지 않았다.

## 0. 판정 (한 줄)

**(나) 최상위 `user_prompt` 는 호스트가 읽지 않는다 — 실측.** 호스트는 UserPromptSubmit 훅 stdout 에서 `hookSpecificOutput.additionalContext`(+`sessionTitle`, `suppressOriginalPrompt`) 와 공통 최상위 필드(`continue/decision/reason/…`)만 취하고, 그 외 키는 **"unrecognized keys (ignored)"** 로 디버그 로그에 남기고 버린다. 디렉티브는 `user_prompt` 안에만 실리므로 **훅 경로로는 모델에 도달하지 않는다.** 공식 문서도 같은 말을 한다: "`UserPromptSubmit`: can't replace the prompt; it only injects `additionalContext` alongside it".

단, 리더의 전제 하나는 **정정**한다(§4): 이번 세션 팀원들이 받은 `[artibot:effort level=xhigh …]` 는 훅이 아니라 **리더(모델)가 `Agent` 프롬프트에 직접 써 넣은 것**이고(commands/team.md:107-120 "Auto-Effort Pre-injection" 지시), 그 경로는 살아 있다(트랜스크립트 실측 12건). 죽은 것은 **훅 → 메인 세션(리더) 프롬프트** 경로다.

## 1. 호스트 바이너리 실측 (판정 1)

바이너리: `~/.local/share/claude/versions/2.1.259` (219,715,232 B, `ls -la`). 아래 오프셋은 모두 `grep -a -o -b` 로 얻었고 `dd if=… bs=1 skip=<offset-N> count=M | tr -d '\000'` 로 직접 열어 확인했다.

| # | 오프셋 | 내용 | 의미 |
|---|---|---|---|
| B1 | 187026302 | `Xbr=m(()=>c({continue, suppressOutput, stopReason, decision, reason, systemMessage, terminalSequence, hookSpecificOutput: je([…])}))` | 훅 **출력** 최상위 스키마. `user_prompt` 없음 |
| B2 | 187027146 | `c({hookEventName:H("UserPromptSubmit"), additionalContext:i().optional(), sessionTitle:…, suppressOriginalPrompt:…})` | UPS `hookSpecificOutput` 스키마 3필드 |
| B3 | 191307256 | `function eur(e){let n=Y(e), r=YV().safeParse(n); if(r.success) return t("Successfully parsed and validated hook JSON output"), Lwe(n,r.data), {json:r.data}; return {validationError:…}}` | stdout JSON 파싱 지점. `YV = je([{async:true…}, Xbr()])` (187032380) |
| B4 | 187394114 | `function Lwe(e,n){… for(k of Object.keys(e)) if(!o.has(k)) r.push(k); … t("Hook JSON output had unrecognized keys (ignored): " + r.join(", "))}` | 스키마 밖 키는 **strip 후 디버그 로그**. 파싱은 성공 → `additionalContext` 등 나머지는 유효 |
| B5 | 191312311 | `case"UserPromptSubmit": F.additionalContext=e.hookSpecificOutput.additionalContext, F.sessionTitle=…, F.suppressOriginalPrompt=…; break;` | 정규화기. UPS 에서 읽는 필드 = 이 3개 뿐 |
| B6 | 188155794 | `iMe(...)`: `if(T.blockingError)…; if(T.preventContinuation)…; if(T.sessionTitle)…; let F=T.additionalContexts; if(F?.length) r.messages=[...r.messages, UIe(F)]; let U=VIe(T.message); …` | 프롬프트 제출 본경로. **프롬프트 치환 코드 없음** — additionalContexts 만 메시지에 추가 |
| B7 | 188151077 | `UIe=(e,n="UserPromptSubmit")=>bn({type:"hook_additional_context", content:[...e], hookName:n, hookEvent:"UserPromptSubmit"})` | 첨부 생성 |
| B8 | 191501791 | `hook_additional_context:(e)=>[He({content:Va(e.hookName + " hook additional context: " + e.content.join("\n")), isMeta:!0})]` | 모델에 들어가는 최종 형태 = **별도 meta user 메시지** "UserPromptSubmit hook additional context: …" |
| B9 | 188151906 | `function VIe(e){return e&&(e.attachment.type!=="hook_success"\|\|e.attachment.content)?e:void 0}` | 빈 `hook_success` 첨부는 트랜스크립트에 **안 남는다** → §4 의 "UPS 첨부 0건"은 훅 미실행의 증거가 아니다 |

`user_prompt` 문자열 7건 전수 분류(`grep -a -o -b -E '.{0,120}user_prompt.{0,120}'`):
- 95536012, 99758597 — 문자열 테이블 항목(`user_prompt`, `user_prompt_length`)
- 186953583 — `xG("interaction",{user_prompt:p, user_prompt_length:e.length, …})` OTel 텔레메트리(`OTEL_LOG_USER_PROMPTS` 아니면 `<REDACTED>`)
- 195294837, 199071999, 199075900 — `Do("user_prompt",{prompt_length:…, prompt:lXe(e), …})` 텔레메트리
- **훅 출력 파서에서 `user_prompt` 를 읽는 코드: 0건.** (`updatedPrompt` 도 0건)

재현:
```bash
B=~/.local/share/claude/versions/2.1.259
for s in user_prompt user_prompt_length additionalContext suppressOriginalPrompt UserPromptSubmit updatedPrompt; do printf '%s: ' $s; grep -a -o "$s" "$B" | wc -l; done
#  user_prompt: 7 / user_prompt_length: 2 / additionalContext: 183 / suppressOriginalPrompt: 21 / UserPromptSubmit: 83 / updatedPrompt: 0
grep -a -o -b -E '.{0,200}suppressOriginalPrompt.{0,200}' "$B" | head -25     # B2, B5 위치
dd if="$B" bs=1 skip=$((187394114)) count=1200 2>/dev/null | tr -d '\000'      # B4 Lwe 전문
dd if="$B" bs=1 skip=$((191307256-60)) count=300 2>/dev/null | tr -d '\000'    # B3 eur 파서
```
주의: `.{0,700}` 같은 긴 역방향 컨텍스트를 grep 에 주면 2분 타임아웃이 난다(실제 1회 발생). 앞쪽 컨텍스트는 `dd` 로 보라.

## 2. 공식 문서 대조 (판정 1 보강)

`curl -sL https://code.claude.com/docs/en/hooks.md` (317,071 B, 16:33 KST) — 스크래치 `hooks-doc.txt`:
- L1032: "`UserPromptSubmit`: can't replace the prompt; it only injects `additionalContext` alongside it"
- L1325–1345 "UserPromptSubmit decision control": 필드 표 = `decision` / `reason` / `additionalContext` / `sessionTitle` / `suppressOriginalPrompt`. "Plain text stdout" 과 "JSON with `additionalContext`" 두 채널만 컨텍스트에 들어간다. "Neither channel produces a visible transcript entry … injected as a system reminder that starts with the hook's name … To confirm delivery, check the debug log."
- L774: "a parsed object that passes schema validation takes effect" — B3/B4 와 일치(모르는 키는 strip, 나머지는 유효).
- L3757 "Debug hooks": `claude --debug-file <path>` 또는 `claude --debug` → `~/.claude/debug/<session-id>.txt`.

(WebFetch 는 페이지를 잘라서 이 절이 안 보였다. raw `.md` 를 curl 로 받아야 한다.)

## 3. 플러그인 쪽 실측 (디스패처 · runtime-prompt · 설치본)

- `plugins/artibot/scripts/hooks/_userprompt-dispatcher.js:155-186` `mergeHookResults`: `ingest()` 가 `hookSpecificOutput` 만 따로 합치고(:162-163, :178-183) **나머지 최상위 키는 전부 `out[key]=val`** (:164-170). 즉 `user_prompt`·`message` 가 그대로 stdout 최상위에 실린다(:222-225). `:206-208` 의 `payload.user_prompt = rewriterResult.user_prompt` 는 **내부 전달용**(병렬 기여자가 재작성된 프롬프트를 보게 함)으로는 유효하다 — 호스트와 무관.
- `plugins/artibot/scripts/hooks/runtime-prompt.js`(워킹트리) `composePromptOutput` :707-733: 디렉티브는 `applyPromptPrefix(basePrompt, [team, effort, taskBudget, recommendation, watch])` 로 **`user_prompt` 에만** 붙는다(:727-729). `hookSpecificOutput.additionalContext` 는 이 파일 어디서도 만들지 않는다(`grep -n additionalContext` 0건). 반환 `{ user_prompt, message }` (:732).
- 동일 파일 `handleUserPromptSubmit` :744-746: 워킹트리 = `extractUserPromptText(hookData)` (`user_prompt → prompt → content`, lib/core/hook-utils.js:285-292). **HEAD :743 = `hookData?.user_prompt || hookData?.content || ''`**.
- 설치본: `~/.claude/plugins/installed_plugins.json` → `artibot@artibot` 4.53.0, `installPath …/cache/artibot/artibot/4.53.0`, `gitCommitSha 3bcadb8e`, `lastUpdated 2026-09-03T04:38:55Z`. 그 안의 `scripts/hooks/runtime-prompt.js:743` 은 HEAD 형(`user_prompt || content`) — 리더 사실과 일치. 설치본 `runtime/current-effort.json` **부재**(`ls` ENOENT) → 설치본 훅은 한 번도 effort 를 쓴 적이 없다.
- `hooks/hooks.json:162-174`: UserPromptSubmit = `node ${CLAUDE_PLUGIN_ROOT}/scripts/hooks/_userprompt-dispatcher.js` 단일, timeout 15000.
- 리더 인용 `commands/team.md:74` 원문 확인. 같은 문서 :107-120 "Auto-Effort Pre-injection": **오케스트레이터(모델)가** `runtime/current-effort.json`·`current-task-budget.json` 을 Read 하고(없으면 xhigh/128000 기본) 팀원 프롬프트 맨 앞에 디렉티브를 쓰라는 지시. `lib/cognitive/effort-policy.js:20-26` 주석도 "runtime-prompt.js … injects the prose directive at the top of the user prompt" 라고 적어 훅 경로를 실경로로 전제한다 — **이 전제가 틀렸다**(§1).

## 4. 라이브 증거 (판정 3)

호스트 트랜스크립트 `~/.claude/projects/C--Users-HeechangLee-Desktop-AI-Artibot/9120048e-3385-4855-a35b-09c89e5dd684.jsonl` — 1,014줄 (16:31 KST `wc -l`). 타임스탬프는 UTC(+9h = KST).

| 항목 | 값 | 재현 |
|---|---|---|
| 실제 사용자 턴(비-teammate) | 4건: 04:46:09Z `/resume`, 05:19:12Z `/resume`, 06:08:45Z `/team …`, 07:11:06Z typed "작업 중이야?" | node 스크립트로 `type==="user" && !isMeta` 중 "Another Claude session" 제외 |
| 그 4건 중 `[artibot:effort` 로 시작 | **0건** | 동일 |
| `hook_additional_context` 첨부 | 7건 = SessionStart 1 + Stop 6 + **UserPromptSubmit 0** | `grep -c hook_additional_context` = 7, 첨부 hookName 분류 |
| `artibot:effort` 문자열 | 30건 — 전부 (a) 리더의 `Agent` tool_use `prompt` 파라미터 12건(06:10:45Z observe … 07:27:49Z checker-payload) (b) 그 tool_result 에코 (c) 리더/팀원 산문. **훅 주입 형태 0건** | `grep -c 'artibot:effort'` = 30 후 줄별 type/role 분류 |
| `.artibot/ledger/9120048e-*.jsonl` | 60줄(user 14 / assistant 46). `artibot:effort` 1건 = 리더 산문 | `grep -c` |
| 오늘 이전 표본 `~/.artibot/ledger/*.jsonl` | 5파일, `artibot:effort` 0파일 | `grep -l … \| wc -l` |
| `~/.claude/debug/` | 0파일 → 훅 stdout/"unrecognized keys" 로그 **없음** | `ls ~/.claude/debug \| wc -l` |

해석(등급 명시):
- **실측**: 이번 세션에서 훅이 주입한 디렉티브는 0건이다. 설치본이 프롬프트를 못 읽었으므로(§3) 이는 "생성 안 됨"이지 "무시됨"의 증거가 아니다 — 리더 구분 그대로.
- **실측**: 팀원 12명이 받은 디렉티브는 리더가 `Agent(prompt=…)` 에 쓴 것이다. 리더는 설치본에 파일이 없으므로 team.md:113 기본값(xhigh/128000)을 썼다(값이 전부 동일한 것과 정합). 즉 **팀원 경로는 살아 있되, 값은 측정된 effort 가 아니라 기본값**이다.
- **미확인**: 이번 세션에서 UserPromptSubmit 훅 프로세스가 실제로 실행됐는지. 빈 `hook_success` 첨부는 기록되지 않고(B9), 디버그 로그가 없다. `{"continue":true}` 만 나오는 HEAD 출력(§5)은 첨부를 남기지 않는다.

## 5. 샌드박스 재현 (판정 4) — 설치본·`~/.claude` 무접촉

스크래치에 두 복사본을 만들었다: `wt/` = 워킹트리 `plugins/artibot` (robocopy, node_modules 제외) · `head/x/plugins/artibot` = `git archive HEAD`. `CLAUDE_PLUGIN_ROOT` 를 각 복사본으로, cwd 는 git 이 아닌 스크래치 `run/` 으로 두고 실행(git-autopilot-save 가 무해하게 종료). 페이로드 = 호스트 입력 스키마 그대로 `{session_id, transcript_path, cwd, permission_mode, hook_event_name:"UserPromptSubmit", prompt_id, effort:{level:"high"}, prompt}`. 러너: 스크래치 `probe.mjs` / `probe2.mjs` (stdout 을 파일로 저장 후 호스트 스키마 키와 대조).

| 실행 (16:42–16:46 KST) | exit | stdout 최상위 키 | 호스트가 버리는 키 | `[artibot:effort` 위치 |
|---|---|---|---|---|
| WT 디스패처, `/team 결제 모듈 리팩터링 …` | 0 | `user_prompt, message, continue` (735 B) | `user_prompt, message` | `user_prompt` 맨 앞: `[artibot:effort level=high command=team][artibot:task-budget max_tokens=64000]` · `additionalContext` **없음** |
| WT runtime-prompt.js 단독 | 0 | `user_prompt, message` (719 B) | 둘 다 | 동일 |
| WT 디스패처, 슬래시 없는 3파일 요청 | 0 | `user_prompt, message, continue, hookSpecificOutput` (1,020 B) | `user_prompt, message` | **없음**(effortMeta 는 슬래시 커맨드에서만 생성). `hookSpecificOutput.additionalContext` = auto-team-trigger 의 `[auto-team-suggested] reason: subtasks>=3 \| files>=3 …` → 이 경로는 살아 있다 |
| HEAD 디스패처, `/team …` | 0 | `continue` (`{"continue":true}`, 17 B) | — | 없음 |
| HEAD runtime-prompt.js 단독 | 0 | (stdout 0 B) | — | 없음 |

호스트 대조: B3/B4 에 따라 첫 행의 stdout 은 파싱 성공 → `user_prompt`·`message` strip + 디버그 로그 `Hook JSON output had unrecognized keys (ignored): user_prompt, message.` → 모델에 추가되는 컨텍스트 **0**. 셋째 행은 auto-team 힌트만 도달한다.

부수 발견(실측): `user_prompt` 안에는 디렉티브뿐 아니라 런타임 봉투 전체 — "System 1 mode: …", "Original request:", "Relevant memory context: …", "⚠️ Guardrail: tools denied by policy — Agent" — 가 들어 있다. **이 봉투 전부가 같은 이유로 모델에 닿지 않는다.** (`message` 필드 `[runtime] … route=SYSTEM1 | memory=20 | skills=1 …` 도 동일.) effort 만의 문제가 아니다.

부수 발견 2(실측): WT 복사본은 `effort.level=high` 입력을 읽어 `runtime/current-effort.json` 에 `{"command":"team","effort":"high","baseline":"xhigh","shift":-1,"reason":"native-effort"}` 를 썼다 — 네이티브 effort 읽기는 동작한다. 그리고 리포 워킹트리 `plugins/artibot/runtime/current-effort.json` 에 09:12 KST `command:"implement"` 항목이 있는데 **누가 썼는지 미확인**(설치본 아님 — 설치본엔 파일이 없다; 테스트 실행 추정).

## 6. 결론 정리

1. **(나) 확정.** 최상위 `user_prompt` 는 호스트 2.1.259 가 읽지 않는다(B1–B6, 문서 L1032). 훅이 디렉티브를 모델에 전하려면 `hookSpecificOutput.additionalContext` 로 옮겨야 한다. 그 경로는 같은 디스패처에서 이미 동작한다(§5 셋째 행).
2. **"effort 정책 전체가 허상"은 절반만 맞다.** 훅→리더 경로는 죽어 있다(오늘 이전엔 생성조차 안 됐고, 수리 후에도 도달 안 함). 리더→팀원 경로는 모델이 쓰는 산문이라 살아 있다 — 다만 값의 출처가 측정치가 아닌 기본값이었다(§4).
3. 옮겨도 형태가 달라진다: additionalContext 는 프롬프트 **앞에 붙는 접두사가 아니라 별도 meta 메시지** "UserPromptSubmit hook additional context: …"(B8) 다. "프롬프트 맨 앞 디렉티브"라는 현재 문서·테스트의 표현은 호스트 계약상 성립할 수 없다.

## 7. 제안 (코드 없음 — 승인 후 별도 작업)

- **P1** `runtime-prompt.js#composePromptOutput`: 디렉티브(+필요하면 봉투)를 `hookSpecificOutput: {hookEventName:"UserPromptSubmit", additionalContext}` 로 내보내고, `user_prompt`/`message` 는 stdout 에서 제거(디스패처 내부 전달용 `payload.user_prompt` 는 그대로 두되 `mergeHookResults` 에서 stdout 직전에 strip). 판단 기준은 호스트 스키마 B1/B2 — 허용 목록으로 짜라.
- **P2** 문서 정정: `commands/team.md:74`("유일한 실경로"), `lib/cognitive/effort-policy.js:20-26`, `runtime-prompt.js` 헤더 :4-12 — "프롬프트 맨 앞 주입"을 "additionalContext meta 메시지"로. team.md:107-120 은 팀원 경로의 실제 정본이므로 유지하되 "값의 출처가 설치본 파일"임을 명시(설치본에 파일이 없으면 항상 기본값).
- **P3** 테스트 갱신 대상(`grep -rln user_prompt plugins/artibot/tests` 23파일 중 stdout 형태를 단정하는 것): `tests/hooks/runtime-prompt-effort-inject.test.js`, `runtime-prompt-team-inject.test.js`, `runtime-prompt-watch-inject.test.js`, `runtime-prompt.test.js`, `userprompt-dispatcher.test.js`, `dispatcher/dispatcher-merge-proto.test.js`, `e2e/runtime-flow.test.js` 등 — 각 파일이 무엇을 단정하는지는 **미확인**(파일명·grep 히트만 봤다).
- **P4 라이브 확인 절차**(수리 전후 공통, 코드 변경 0): `claude --debug-file <path>` 로 새 세션 → `/team …` 한 줄 입력 → (지금) `grep -n 'unrecognized keys (ignored): user_prompt' <path>` 가 1건이면 §1 판정의 라이브 확증; (수리 후) 트랜스크립트에서 `hook_additional_context` 첨부 `hookName:"UserPromptSubmit"` 1건 + 내용에 `[artibot:effort` 포함이면 도달 확증.

## 8. 리더 전제 대조

| 리더 전제 | 판정 |
|---|---|
| 호스트 2.1.259, 입력 스키마 base+`prompt` | 일치(B6 상단 `va()` 가 `effort:{level}` 포함 입력을 만든다, 오프셋 191306xxx) |
| 출력 스키마에 최상위 `user_prompt` 없음 | 일치(B1) |
| 디스패처 :206-207 이 최상위 `user_prompt` 생성 | 일치 — 정확히는 `mergeHookResults` :164-170 가 rewriter/기여자의 모든 비-`hookSpecificOutput` 키를 최상위로 올린다 |
| `preparePrompt` → `{user_prompt, message}` :708-736 | 함수는 `composePromptOutput` :707-733; `preparePrompt` 는 :408 호출. 위치 오차만 있고 내용 일치 |
| team.md:74 "유일한 실경로" | 원문 일치. 그러나 **주장 자체가 틀렸다** — 유일하지도, 실경로도 아니다(§3, §6-2) |
| 오늘 이전 설치본이 프롬프트를 못 읽음 | 일치(설치본 :743, HEAD 샌드박스 stdout 0 B) |

미확인: (1) 이번 세션에서 UPS 훅 프로세스가 실제 실행됐는지(디버그 로그 부재, 빈 hook_success 는 기록 안 됨); (2) `Lwe` 의 로그가 `--debug` 파일에만 가는지 UI 경고도 되는지(`t()` 가 디버그 로거라는 것은 추론); (3) 리포 `plugins/artibot/runtime/current-effort.json` 09:12 항목의 작성 주체; (4) P3 각 테스트 파일이 stdout 형태를 어떻게 단정하는지; (5) zod 객체가 strip 모드라는 것은 `Lwe` 의 키 차집합 로직에서 유도한 추론(파싱 성공 후 `r.data` 에 키가 없어야 `dropped` 목록이 생기므로 정황상 strip) — 실행 확증은 P4 절차로.
