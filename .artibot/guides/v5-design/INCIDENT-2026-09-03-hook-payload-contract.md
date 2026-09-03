# INCIDENT 2026-09-03 — 훅 payload 계약 불일치 (라우팅 shadow receipt 0건)

**상태**: 사고 분석 문서. 코드·테스트·config 변경 없음. 커밋 없음.
**작성**: incident 팀원(읽기 전용), 2026-09-03 16:0x KST. 리포 `master @ 3bcadb8e`(v4.53.0).
**동반 문서**: `HOOK-VISIBILITY-DESIGN.md`(같은 디렉터리) — 훅 실패 가시성 설계안.

주장 등급은 리포 규칙(`verification-discipline.md` §0)을 따른다: **실측**(재현 명령 병기) /
**추론**("~로 보인다") / **미확인**. 라인 인용은 전부 **HEAD(3bcadb8e)** 기준이다 — 워킹트리는
16:0x 현재 `payload` 팀원이 같은 파일 8개를 편집 중이라(§8) 줄 번호가 움직인다.

---

## 0. 요약 (5줄)

1. **결함**: SubagentStart 훅이 "스폰 프롬프트 텍스트"를 payload 에서 찾아 라우팅 receipt 를 쓰려 했는데, 호스트(Claude Code 2.1.259)의 SubagentStart payload 에는 **그런 키가 애초에 없다.** 4.53.0 설치 후 start 14/14 가 `skipped:no-action-text`, 전 기간 `route_ledger:"ok"` 0/871.
2. **사건은 둘이고 성격이 다르다**: (a) UserPromptSubmit 5개 훅은 **진짜 키 이름 오류**(`user_prompt`·`content` 를 읽음, 호스트 키는 `prompt`) — **2026-02-13 최초 커밋부터**이며 5개 버전 캐시 어디에도 그 훅들의 산출물이 없다. 키 교정으로 닫힌다(payload 팀원 수리 중). (b) SubagentStart 는 **호스트 계약을 측정하지 않고 텍스트가 있다고 가정한 설계 결함** — 키 교정으로 못 닫고 설계 결정(§6.2 A/B/C, 오너)이 남는다.
3. **왜 못 봤나**: (a) 테스트 픽스처 73건이 전부 코드가 가정한 키로 작성됐고, (b) 훅 오류는 stderr 전용이며 호스트는 exit 0 훅의 stderr 를 사용자에게 보여주지 않고, (c) 이번 사고는 "오류"조차 아니라 `skipped:` 라는 **정상 반환값** — 원장 컬럼에 14/14 로 찍혀 있었지만 읽는 사람이 없었다.
4. **절차 구멍**: 보고서·테스트 파일·CHANGELOG 모두 "라이브 payload 미확인"을 정직하게 적었다. 적힌 미확인을 **읽고 릴리스를 막는 단계가 없다.** `npm run release` 는 버전 lockstep·CHANGELOG 존재·CI 그린만 본다.
5. **재발 방지 핵심**: payload 계약을 **호스트 바이너리에서 추출한 동결 픽스처(허용목록)** 로 고정하고, 훅 테스트가 그 픽스처만 입력으로 쓰게 강제한다. 그리고 "완료"는 코드 변경이 아니라 **릴리스+plugin update 후 라이브 원장에 `ok` 가 쌓이는 것**으로 판정한다.

---

## 1. 사실 기록 (전부 실측, 측정 시각 병기)

| # | 사실 | 값 | 재현 |
|---|---|---|---|
| F1 | 스폰 원장 총행 | **871** (16:0x KST) | `wc -l .artibot/ledger/spawns.ndjson` |
| F2 | 4.53.0 설치 시각 | **2026-09-03T04:38:55.948Z**, sha `3bcadb8e`, 경로 `~/.claude/plugins/cache/artibot/artibot/4.53.0` | `~/.claude/plugins/installed_plugins.json` → `artibot@artibot[0].lastUpdated` |
| F3 | 설치 이후 행 | **26**(start 14 · stop 12) | `awk` ts ≥ `2026-09-03T04:38:02Z` |
| F4 | 그 start 의 `route_ledger` | **`skipped:no-action-text` 14/14** | 같은 필터 + `grep -o '"route_ledger":"[^"]*"'` |
| F5 | 전 기간 `route_ledger:"ok"` | **0/871** (`route_ledger` 필드 있는 행 16... 이후 증가) | `grep -c '"route_ledger":"ok"'` |
| F6 | 전 기간 `requestedModel:null` | **871/871** | `grep -c '"requestedModel":null'` |
| F7 | 전 기간 `agentName:null` | **871/871**, `agentName:"…"` 0 | `grep -c '"agentName":null'` |
| F8 | 라이브 훅 실행 루트 | 캐시 경로(F2). `runtime/current-teammates.json` 16:04:00 KST, `last-main-agent-edit.timestamp` 16:05:10 KST 로 **지금 쓰이는 중** | `ls --time-style=full-iso ~/.claude/plugins/cache/artibot/artibot/4.53.0/runtime/` |
| F9 | 그 `runtime/` 에 **없는** 파일 | `current-effort.json`·`current-task-budget.json`·`token-usage-session.json`·`user-profile.json`·`decisions/` — 4.53.0 뿐 아니라 **캐시 5버전(4.47.0·4.49.0·4.50.0·4.51.0·4.53.0, 2026-08-19~09-03) 전부 없음**. 반면 `current-teammates.json`·`last-dev-verify-sha.txt` 는 5버전 전부 있음 | 같은 `ls` 를 5개 디렉터리에 |
| F10 | 호스트 SubagentStart 입력 스키마(2.1.259 바이너리) | `ve().and({hook_event_name:"SubagentStart", agent_id, agent_type})`, 공통 `ve` = `{session_id, transcript_path, cwd, prompt_id?, permission_mode?, …}`. **`prompt`·`description`·`tool_input`·`name`·`agent_name`·`model` 없음** | `grep -a -o -E 'hook_event_name:H\("SubagentStart"\).{0,120}' ~/.local/share/claude/versions/2.1.259` |
| F11 | 호스트 UserPromptSubmit 입력 스키마 | `{hook_event_name:"UserPromptSubmit", prompt, source?}` + 공통. **`user_prompt`·`content` 없음**(바이너리 내 `user_prompt` 5회는 전부 OTel 속성명) | 같은 grep, `"UserPromptSubmit"` |
| F12 | 공식 문서 UserPromptSubmit 예시 | `"prompt": "Write a function to calculate fibonacci"` | `code.claude.com/docs/en/hooks` 2026-09-03 조회 |
| F13 | 호스트의 stderr 처리(문서) | exit 0 훅의 stderr → **debug log only, 사용자·모델 어디에도 표시 안 함** | 같은 문서 |
| F14 | 호스트 UserPromptSubmit **출력** 스키마 | `hookSpecificOutput{hookEventName, additionalContext?, sessionTitle?, suppressOriginalPrompt?}` — 최상위 `user_prompt` 출력 키 없음 | 같은 바이너리 grep `hookEventName:H("UserPromptSubmit")` |
| F15 | 훅 코드 HEAD | `subagent-handler.js:200-209 extractActionText` 4키, `:337-338` 스킵; `runtime-prompt.js:743`·`user-prompt-handler.js:74`·`auto-team-trigger.js:372`·`autopilot-nlu-trigger.js:110`·`auto-command-suggest.js:228` 이 `user_prompt \|\| content`; `lib/runtime/create-artibot-agent.js:40` 동일; `ambiguity-guard.js:41-45` 는 `prompt→user_prompt→userPrompt→message→text` 5키 | `git show HEAD:plugins/artibot/scripts/hooks/<f>` |
| F16 | 오류 싱크 | `plugins/artibot/lib/core/hook-utils.js:88-93 logHookError` = `process.stderr.write` 전용 | 파일 열람 |
| F17 | 릴리스 게이트 | `package.json:46 release = sync:local && release:check && ci`; `scripts/release-check.js` 는 버전 lockstep·CHANGELOG 항목·설치본 drift 3종만 | 파일 열람 |
| F18 | 릴리스 커밋 | `64f99bec` 2026-09-03 13:08 KST, 본문 "vitest 616 files / 14,468 pass / 12 skip / 0 fail" | `git show 64f99bec -s` |

**정합성 점검(규칙 §5)**: F4(14/14 skipped)·F10(키 없음)·F7(agentName 전건 null)·F9(runtime-prompt 산출물 5버전 부재)·F11(`user_prompt` 없음)은 서로 모순 없이 한 설명으로 닫힌다 — *호스트는 그 키들을 보낸 적이 없다.* 이 설명과 어긋나는 관측치는 없다. 단 F9 는 "훅이 안 돌았다"와 "돌았지만 안 썼다"를 구분 못 한다 → §3.3 에서 다룬다.

**리더 전제와 다른 점**(§8 에 모음): 리더 브리프의 `lib/core/hook-utils.js` 경로는 `plugins/artibot/lib/core/hook-utils.js` 다. `runtime-prompt.js:749` 는 HEAD 에서 `:743`. 설치 시각 "04:46Z"는 `installed_plugins.json` 기준 **04:38:55Z**. "16행·10/10" 은 리더 측정 시각(15:5x) 값이고 내 시각(16:0x)엔 26행·14/14 — 같은 결론.

---

## 2. 타임라인

| 시각(KST) | 사건 | 근거 등급 |
|---|---|---|
| 2026-02-13 | `d956c7d5` v1.1 최초 커밋. `user-prompt-handler.js:49` 에 `hookData?.user_prompt \|\| hookData?.content \|\| ''` 등장 — **2키 가정의 기원** | 실측 `git show d956c7d5:…` |
| 2026-03-18 / 04-27 / 05-16 | `87d1a3aa`·`ecb1c25c`·`b5aec3db` — 같은 2키 문자열이 runtime-prompt·auto-team-trigger·autopilot-nlu·auto-command-suggest 로 복제됨(`git log -S` 정확 문자열 최초 출현) | 실측 |
| 2026-04-28 | `dff840e7` `ambiguity-guard.js` 신설. 헤더: "Adoption AD-38 (TRANSFORM of phd-skills UserPromptSubmit type:prompt block, ported to ESM)". 외부 원본이 호스트 정식 키 `prompt` 를 읽었고, 이식하며 `prompt` 를 **첫 순위로 유지**한 채 4키를 덧붙임 | 실측(헤더·커밋) — 원본 phd-skills 코드는 미확인 |
| 2026-08-19~09-03 | 캐시 4.47.0→4.53.0 5버전. 어느 버전 `runtime/` 에도 UserPromptSubmit 5훅 산출물 없음(F9) | 실측 |
| 2026-09-02 06:29 | autopilot `ap-20260902-062936-tyc5j4` 착수 | 보고서 |
| 2026-09-02 (T-31) | `extractActionText` 4키 작성. 같은 파일 `:214-217` 의 `extractDepth` 주석은 "MEASURED 2026-09-02 (`grep -rn depth scripts/hooks/*.js`)" — **자기 코드를 grep 한 것을 MEASURED 라 표기**. 라이브 payload 측정 아님 | 실측(주석) |
| 2026-09-02 17:2x~09-03 11:38 | 크로스체크 4패스(§3.4 표: T-51 APPROVE, T-50 APPROVE, T-49 REQUEST_CHANGES 경미). 검수 4명 중 누구도 라이브 payload 키를 재검 항목으로 열지 않음 — 보고서에 그 항목 없음 | 실측(보고서 §3.1~3.4) |
| 2026-09-03 09:3x | 보고서 `:42` "라이브 훅 payload 키(`cwd`·`session_id`·action text) 실재 미확인" 명기 | 실측 |
| 2026-09-03 12:57 | `8710e3f1` 코드 커밋(subagent-handler +516/-73, 라우팅 테스트 +371) | 실측 |
| 2026-09-03 13:08 | `64f99bec` release v4.53.0 — 게이트: release:check ✓ · ci exit 0 · 14,468 pass | 실측 |
| 2026-09-03 13:38:02 | 캐시 4.53.0 파일 착지(`subagent-handler.js` mtime), 13:38:55Z 설치 기록 | 실측 |
| 2026-09-03 13:46~16:05 | 스폰 14건 전부 `skipped:no-action-text` | 실측 F3·F4 |
| 2026-09-03 15:5x | 리더 재현·사고 인지 | 리더 브리프 |
| 2026-09-03 16:0x | `payload` 팀원이 2.1.259 바이너리에서 스키마 실측(워킹트리 `subagent-handler.js` 주석) — 본 문서가 독립 재실측(F10·F11) | 실측 |

**결함이 "언제 생겼나"** — **사건은 둘이고 성격이 다르다.**

| | (a) UserPromptSubmit | (b) SubagentStart |
|---|---|---|
| 무엇 | 호스트 키 `prompt` 를 `user_prompt \|\| content` 로 읽음 — **진짜 키 이름 오류** | 호스트가 보내지 않는 "액션 텍스트"가 있다고 가정하고 receipt 를 설계 — **설계 단계의 계약 미확인** |
| 언제부터 | 2026-02-13 `d956c7d5`(v1.1). 그 커밋의 `hooks/hooks.json:69-75` 가 `user-prompt-handler.js` 를 호스트 UserPromptSubmit 에 **직접** 등록했으므로 첫날부터 호스트와 맞닿아 있었다 | 2026-09-02(T-31), `8710e3f1` 로 커밋 |
| 수리 | `hook-utils.js#extractUserPromptText`(payload 팀원, 워킹트리, 소비처 7곳) — 키 이름 교정으로 닫힘 | **키를 늘려서는 못 닫는다.** `skipped:no-action-text` 14/14 는 결함이 아니라 정확한 동작. 남는 것은 설계 선택(§6.2) |
| 자기 고백 | 없음 | 보고서 `:42` "action text 실재 미확인" — 정확히 이것 |

---

## 3. 왜 4차 크로스체크와 14,468 pass 를 통과했나

### 3.1 픽스처가 코드의 가정을 그대로 베꼈다

`tests/hooks/subagent-handler-routing-fields.test.js:86-96 basePayload`:
```
session_id, agent_id, agent_type, name, cwd, tool_input: { prompt: 'Implement the ledger byte cap …' }
```
라이브(F10)와 대조:

| 키 | 픽스처 | 라이브 2.1.259 | 결과 |
|---|---|---|---|
| `session_id`·`cwd`·`agent_id`·`agent_type` | 있음 | 있음 | 일치 — 그래서 mission_id·epoch·spawn 행은 정상 |
| `name` | 있음(`lane-f`) | **없음** | `agentName` 871/871 null (F7) — **이미 7개월간 보이던 신호** |
| `tool_input.prompt` | 있음 | **없음** | 14/14 `skipped:no-action-text` |
| `transcript_path`·`prompt_id`·`permission_mode` | 없음 | 있음 | 코드가 읽지 않으니 무해 — 단 유일한 텍스트 출처(`transcript_path`)를 픽스처가 아예 모른다 |

이 파일의 18 케이스 전부 같은 `basePayload` 위에서 돈다. 한 케이스(`:296-306`)는 `tool_input:{}` 로 **정확히 라이브 형태를 재현하고 `skipped:no-action-text` 를 기대값으로 핀**한다 — 즉 테스트는 "라이브에서 이렇게 될 것"을 **알고 있었고 그것을 통과 조건으로 삼았다.** 그리고 `:25-32` 헤더에 그 사실을 적어 두었다:

> That Claude Code's LIVE SubagentStart payload carries `tool_input.prompt` … If the live payload names none of them, production records `route_ledger: 'skipped:no-action-text'` on every spawn and the run ledger stays empty — a green run of this file says nothing about that.

리포 규칙 §9 "게이트 옆에 못 보는 것을 적어라"는 **지켜졌다.** 문제는 그 다음이 없다는 것이다(§5).

**존재하지 않는 키를 핀한 테스트 — `tests/hooks/ambiguity-guard.test.js:102-107`(HEAD).** `extractPrompt({ userPrompt:'y' })`·`({ message:'m' })`·`({ text:'t' })` 세 단언은 호스트 스키마(F11)에 없는 키를 **정답으로 고정**하고 있었다. 이 키들은 어느 호스트 버전에서도 온 적이 없으므로(바이너리 실측, 과거 버전은 미확인) 이 테스트는 코드가 자기 자신과 일치하는지만 확인했다 — 그래서 그린이었다. payload 팀원이 측정 근거를 붙여 이 3키 핀을 제거했다(리더 승인, 워킹트리). 교훈은 §6.1 ③(b): **읽는 키의 허용목록은 테스트 픽스처가 아니라 호스트 스키마에서 온다.**

**같은 방식으로 발견되는 세 번째 관측(라우팅 컬럼에 영향).** 설치 이후 start 19/19(16:2x) 의 `agentId` 는 `a<name>-<hex16>`, `agentType` 은 **Agent 도구의 `name` 입력과 동일**(`team-v5-decisions-01sa2u-record` 등), 이름 없는 스폰은 `teammate`. 즉 호스트의 `agent_type` 은 `subagent_type`(`artibot:devops-engineer`)이 아니다. `getActionClassForAgent(agentType)`(`subagent-handler.js:380`)는 에이전트 표를 실명으로 찾으므로 명명된 팀원에서는 항상 실패 → `actionClass:null` **19/19**. 이것도 픽스처(`agent_type:'tdd-guide'`)가 라이브 형태와 달라 보이지 않던 것이다. `subagent_type` 은 PreToolUse 의 `tool_input` 에만 있다(§6.2 B 의 논거).

### 3.2 UserPromptSubmit 쪽도 같은 구조

`user_prompt:` 픽스처 **73건 / 16 파일**(`grep -c "user_prompt:" tests/hooks/{runtime-prompt*,user-prompt-handler,auto-team-trigger*,autopilot-nlu-trigger,auto-command-suggest,userprompt-dispatcher*}.test.js tests/e2e/runtime-flow.test.js`, 16:0x). 호스트 키 `prompt:` 픽스처는 13건이고 대부분 ambiguity-guard 테스트다. `tests/e2e/runtime-flow.test.js:33` 은 `{ user_prompt, event:'UserPromptSubmit', cwd }` 라는 **플러그인이 스스로 정의한 봉투**를 "e2e"라 부른다. `userprompt-dispatcher.test.js:132` 주석 "runtime-prompt always contributes user_prompt for non-empty input" 은 라이브에서 한 번도 참이었던 적이 없는 문장을 핀한다(F9·F11).

### 3.3 크로스체크 4패스가 본 것과 안 본 것

보고서 §3.1~3.4 의 검수 항목은 전부 **코드↔설계↔테스트의 내부 정합**(동결 이동, 앵커, allowlist, stdout 바이트 불변, 4096 근거…)이다. "라이브 payload 에 그 키가 있는가"는 4패스 어디에도 검수 항목으로 없다. 검수관 3인 모두 같은 입력(코드·픽스처·설계문서)을 봤으니 같은 결론에 수렴했다 — 규칙 §3 "수렴은 검증이 아니다"의 정확한 사례. 측정에 필요한 것은 바이너리 grep 한 줄(F10) 또는 공식 문서 한 페이지(F12)였고, 둘 다 릴리스 전에 가능했다.

### 3.4 그린 테스트가 구조적으로 못 잡는 이유(요약)

훅은 **호스트가 주는 입력**에 의존하는데, 테스트는 입력을 **플러그인이 만든다.** 계약의 한쪽 당사자가 양쪽 역할을 다 하면 어떤 키 이름이든 통과한다. `grep -rl hook_event_name tests/`(16:1x) → **9 파일**: 그중 payload 형태 픽스처는 `tests/fixtures/tool-tracker-hook-payloads.jsonl`·`zero-result-guard-hook-payloads.jsonl` 2개(PreToolUse/PostToolUse 계열 — 라이브 캡처인지 손작성인지 **미확인**)이고, UserPromptSubmit/SubagentStart 계열은 `tests/dispatcher/dispatcher-payload-utf8.test.js:67` 한 곳이 **호스트 정식 키 `prompt`** 로 payload 를 만든다. 즉 정답 키를 쓴 테스트가 리포 안에 있었으나 그 테스트의 관심사는 UTF-8 디코딩이라 훅이 그 키를 읽는지는 단언하지 않았다.

---

## 4. 왜 같은 리포에 두 가지 키 가정이 공존했나

| 계보 | 파일 | 도입 | 키 가정의 출처 |
|---|---|---|---|
| A. 자생 | user-prompt-handler(02-13) → runtime-prompt·auto-team·nlu·command-suggest(03~05월) → create-artibot-agent | `d956c7d5` v1.1 | **미확인.** 커밋·주석에 근거 없음. 2026-02 당시 호스트가 `user_prompt` 를 보냈는지는 문서 이력을 못 봐 단정 불가. 다만 5개 캐시 버전(8/19~)에서 산출물 0 이므로 **최소 8월 이후로는** 호스트 키가 아니었다(실측). **리더 가설("디스패처 내부 계약 키를 호스트 키로 오인") 은 순서가 반대다**: `_userprompt-dispatcher.js` 는 `553f5157` **2026-05-14** 에 추가됐고(`git log --diff-filter=A`), `user_prompt` 는 그보다 3개월 앞선 02-13 훅에 있었다. 디스패처가 훅의 키를 물려받아 내부 계약(`:206-208`)으로 굳힌 것이지, 그 역이 아니다 |
| B. 이식 | ambiguity-guard | `dff840e7` 2026-04-28, AD-38 | 외부(phd-skills) 원본이 호스트 정식 키 `prompt` 를 읽었고, 이식자가 그것을 1순위로 두고 자생 계보의 `user_prompt` 등을 폴백으로 덧붙임(헤더 실측, 원본 미확인) |
| C. T-31 | subagent-handler `extractActionText` | `8710e3f1` 09-03 | `tool_input.prompt` 는 **PreToolUse(Agent 도구)** payload 의 형태다. SubagentStart 에 그것이 있으리라 가정한 것으로 보인다(추론 — 코드에 근거 주석 없음) |

두 가정이 **한 디스패처 안에서** 나란히 돌았다(`_userprompt-dispatcher.js:37-42`): 계보 B 는 라이브에서 작동했고 계보 A 는 침묵했는데, 디스패처가 `Promise.allSettled` 로 null 을 정상으로 흡수하니(`:68-75 safeRun`, `:211-218`) 아무 차이가 겉으로 나지 않았다. **같은 프로세스 안에 정답이 있었는데 비교하는 코드가 없었다.**

워킹트리(16:0x, 미커밋)에서 `payload` 팀원이 `hook-utils.js#extractUserPromptText` 로 통일 중이다 — 키 순서 `user_prompt → prompt → content`. 호스트 키가 `prompt` 뿐이므로(F11) 이 통일은 작동하지만, **`user_prompt` 를 1순위로 남기는 것은 "호스트가 보낸 적 없는 키"를 계속 허용목록에 두는 것**이다. 남기려면 근거(디스패처 내부 재기록 `:206-208` 용도)를 주석에 못박아야 한다 — 그 용도는 실재하므로 제거 대상은 아니다. 판단은 `payload` 팀원 몫.

---

## 5. "미확인"이 왜 릴리스 게이트가 되지 못했나

**자기 고백은 세 군데에 있었다.**
1. `reports/AUTOPILOT/ap-20260902-062936-tyc5j4.md:42` — "라이브 훅 payload 키(`cwd`·`session_id`·action text) 실재 미확인"
2. `tests/hooks/subagent-handler-routing-fields.test.js:25-32` — 위 인용
3. 같은 보고서 §1 "라이브 도달률 미측정", §5 G1 "라이브 원장 실측(현 0건)"

**릴리스는 그것을 읽지 않는다.** `npm run release`(F17) 의 세 단계 중 사람이 쓴 산문을 읽는 단계는 없다. `release-check.js` 는 CHANGELOG 에 **버전 항목이 있는지**만 보지, 그 안에 "미확인"이 있는지는 보지 않는다(4.53.0 절에는 payload 관련 미확인 문구 자체가 없다 — `grep -n "미확인" CHANGELOG.md` 4.53.0 구간 0건, "UNMEASURED" 는 다른 항목). `.artibot/project.md` HG-01~13 에도 "릴리스" 게이트는 없다(HG-08 은 프로덕션 배포이고 plugin 릴리스를 가리키는지 **미확인**).

**절차상 구멍 3개**
- **G-A. 미확인 목록의 소비처 0.** 규칙 §9 는 "게이트 옆에 적어라"까지만 요구하고, 적힌 것을 **누가 언제 닫는지**는 정하지 않는다. 적는 순간 의무가 끝난다.
- **G-B. 릴리스 판단 근거가 "게이트 그린"이다.** 릴리스 커밋 본문(F18)이 그렇다. 규칙 §9 첫 줄 "전건 그린 상태에서 결함 6건"을 아는 리포가 다시 그린을 근거로 썼다.
- **G-C. 측정 가능한 것을 릴리스 뒤로 미뤘다.** 보고서 선행조건 절은 "Observe 종료 조건 측정은 (릴리스+update) 그 뒤부터 유효"라 적었다. 라이브 원장 **발화율**은 그렇지만, **payload 키 존재**는 그 전에 잴 수 있었다(F10·F12). "릴리스 후에만 가능"이 "릴리스 전 측정 전부"로 확대됐다 — 규칙 §8 "원칙의 적용 도메인을 못박아라"의 반례.

---

## 6. 재발 방지 — 허용목록으로

부정 목록("이 키가 없으면 스킵")은 미래 키에 fail-open 이다. 대신 **"호스트가 보내는 키만 읽을 수 있다"** 를 고정한다.

### 6.1 계약 고정 방식 (권장안 = ①+②+③ 조합, 각각 다른 구멍을 막는다)

| 안 | 무엇 | 어디 | 막는 것 | 못 막는 것 |
|---|---|---|---|---|
| ① 동결 픽스처 | 호스트 바이너리 스키마에서 **추출**한 이벤트별 키 목록 + 예시 JSON. 파일에 `host_version`, 바이너리 sha256, 추출 명령, 추출 시각을 프론트에 기록 | `tests/hooks/fixtures/host-payloads/<Event>.json` (이 리포의 `runtime-prompt.pre-wiring.js.txt` 동결 픽스처 선례를 따름) | 코드가 가정한 키로 테스트하는 것 | 호스트가 버전업으로 키를 바꾸는 것(픽스처는 그 시점의 사실). `de()`(임의 객체)로 선언된 필드의 **내용**(예: PreToolUse `tool_input`) — 스키마는 껍데기만 준다 |

**① 의 추출 절차를 재현 가능하게 (바이트 오프셋은 버전마다 움직인다 → 오프셋이 아니라 앵커 문자열로 찾는다):**
1. 호스트 버전 확정: 세션 전사 `.jsonl` 의 `"version":"<v>"` → 바이너리 `~/.local/share/claude/versions/<v>`(Windows Git Bash 경로 기준; 다른 OS 경로는 **미확인**). `sha256sum` 을 픽스처에 기록.
2. 이벤트별 앵커: `grep -a -o -E 'hook_event_name:H\("<Event>"\)[^}]{0,600}\}'` — 리더 16:2x 재현 형식과 동일. 공통 base 는 앵커 `session_id:i\(\),transcript_path:i\(\),cwd:i\(\)`.
3. 매치 원문을 픽스처의 `raw` 필드에 그대로 저장(파싱 실패 시에도 사람이 읽을 수 있게), 키 목록은 `[a-z_]+:` 토큰만 추출해 `keys` 에.
4. `keys` 가 비거나 앵커 0건이면 **fail-closed**: 픽스처를 갱신하지 않고 "스키마 표기 변경 — 사람 확인" 으로 종료. 민화(minification) 이름(`i()`,`de()`,`H()`)은 버전마다 바뀔 수 있으니 앵커는 `hook_event_name` 리터럴에만 의존한다.
5. 스크립트 위치 제안: `scripts/dev/extract-hook-schema.mjs`(CI 에서는 돌지 않음 — 바이너리가 없다; 릴리스 절차 ④에서만). 출력이 기존 픽스처와 다르면 diff 를 커밋 메시지에 남긴다.
6. 2.1.259 기준 확정값(리더·payload·본 문서 3자 일치): base `{session_id, transcript_path, cwd, prompt_id?, permission_mode?, agent_id?, agent_type?, effort?}` · UserPromptSubmit `+{prompt, source?, session_title?}` · SubagentStart `+{agent_id, agent_type}` · SubagentStop `+{stop_hook_active, agent_id, agent_transcript_path, agent_type}` · PreToolUse `+{tool_name, tool_input: de(), tool_use_id}`.
| ② 스키마(허용목록) | 이벤트별 **읽어도 되는 키** 목록. `additionalProperties:false` 가 아니라 반대 방향 — **코드가 읽는 키 ⊆ 스키마 키** 를 검사 | `schemas/host-hook-input.<Event>.schema.json` (기존 `schemas/` 15종 옆) | 코드에 새 키 가정이 들어오는 것 | 스키마 자체가 틀리는 것(→ ①로 교차) |
| ③ 계약 테스트(파이어월) | (a) 훅 테스트가 ① 픽스처 이외의 payload 로 `handle*` 을 호출하면 red; (b) `scripts/hooks/*.js` 의 `hookData?.<key>` 정적 스캔 → ② 허용목록 밖 키가 있으면 red, 예외는 명시 허용목록 파일; (c) 스캐너 자기검증(가짜 키 심은 픽스처로 red 나는지) | `tests/firewall/host-payload-contract.test.js` | ①②를 사람이 안 지키는 것 | 스캐너가 못 읽는 동적 접근(`hookData[k]`), 구조분해 |
| ④ 릴리스 전 라이브 프로브 | 릴리스 전에 **워킹트리 훅을 실제 호스트에 한 번 태우는** 절차: `claude --settings <임시 hooks.json>` 로 `scripts/hooks/_payload-probe.js`(stdin 키 이름만 파일로 기록, 값은 기록 안 함) 등록 → 스폰 1회 → 키 집합을 ① 픽스처와 diff | `docs/RELEASE.md` 절차 + `release-check.js` 경고(파일 없거나 오래되면 exit 2) | ① 이 낡는 것(호스트 버전업) | 절차를 건너뛰는 사람. 프로브 실행 자체가 라이브 payload 를 필요로 하므로 CI 에서는 못 돈다 |

**허용목록의 방향을 분명히**: ②는 "이 키가 있어야 한다"가 아니라 "**이 키 밖의 것을 읽지 마라**"다. 새 키를 읽고 싶으면 ①을 재추출하고 ②에 추가하는 커밋이 먼저다. 그 커밋 diff 가 곧 "호스트 계약이 바뀌었다"는 기록이 된다.

### 6.2 SubagentStart shadow receipt 를 어디서 얻나 — 오너 결정표

호스트 payload 에 텍스트가 없으므로(F10) 키를 넓히는 수리는 없다. 세 선택지의 **실측 전제**부터:

- **Agent tool_use 의 입력(부모 전사에서 실측, 이 세션)**: `{description, subagent_type, name, model, prompt}`. PreToolUse 의 `tool_input` 이 이 객체와 같은지는 스키마가 `de()` 라 바이너리로 확정 불가 — **라이브 PreToolUse 1회 캡처 필요(미확인)**. `tool-tracker.js:353` 이 이미 `input.subagent_type` 을 읽고 있어 리포는 그렇게 가정해 왔다.
- **직접 상관 키는 없다**: PreToolUse 는 `tool_use_id`, SubagentStart 는 `agent_id`. 부모 전사에 `agent_id`(`…incident-74f0f8c2464e226b`) 는 **0회** 등장(이 세션 전사 1.6MB grep, 16:2x) — 전사 역추적으로도 `agent_id` 를 tool_use 에 못 잇는다.
- **간접 상관 키 2개**: (i) `agent_id = a<name>-<hex16>`, `agent_type = <name>`(명명 스폰, 19/19 실측) → Agent 입력의 `name` 과 **문자열로 이어진다**. 이름 없는 스폰(`agent_type:"teammate"`, `agent_id:a<hex16>`)은 이 경로가 없다. (ii) `prompt_id`(base, optional) — 한 프롬프트 안의 모든 이벤트가 공유(스키마 describe 실측). 라이브 payload 에 실제로 실리는지는 **미확인**.

| | **(A) 전사 역추적** — SubagentStart 에서 `transcript_path` 를 읽어 Agent tool_use 를 찾음 | **(B) PreToolUse(Agent) 에서 기록** + `prompt_id`/`name` 브릿지로 SubagentStart 와 결합 | **(C) SubagentStart receipt 포기**, `skipped:no-action-text` 를 정상 상태로 문서화, KPI 분모 제외 |
|---|---|---|---|
| 텍스트 출처 | 부모 전사의 tool_use `input.prompt/description` | `tool_input.prompt/description`(캡처 전제) | 없음 |
| 상관 방법 | `name` 문자열 매칭(명명 스폰) + 시간 근접(최근 N개 tool_use 중 미매칭 최신) | 1차 `prompt_id` 동일, 2차 `name`(명명) / `subagent_type`+순서(무명) | 불필요 |
| 상관 오판 위험 | 같은 `name` 재사용(이 세션 `record` 가 3회 스폰됨 — start 행 3개) 시 **최신 것으로 오매칭**. 무명 스폰은 시간 근접뿐 → 병렬 6개면 확률적 | 같은 `prompt_id` 안 병렬 스폰 6개: 명명이면 `name` 으로 닫힘, 무명이면 `subagent_type`+순서 — 호스트가 스폰 순서를 tool_use 순서대로 보장하는지 **미확인** | 없음 |
| Phase 0 "행동 변화 0" | 유지 가능하나 **스폰마다 부모 전사(수 MB) 읽기** — 훅 5s 타임아웃 안에서 비용 미측정. 전사 파싱 실패는 skip 으로 흡수 | PreToolUse 는 이미 `tool-tracker` 등이 붙어 있는 이벤트. 기록만 추가하면 행동 변화 0. **단 spawn 전이라 `models.selected`(실제 모델)를 모른다** → SubagentStart 에서 `agent_id` 로 2단계 보정 필요(receipt 1줄이 2줄 또는 갱신 이벤트 1줄) | 0 |
| 되돌리기 | 훅 1파일 revert. 원장에 남은 receipt 의 `shadow_of` 가 추정 기반이었음을 사후 구분 못 함 → receipt 에 `correlation:"inferred"` 필드 필수 | 훅 2파일(PreToolUse 기록 + SubagentStart 보정) revert. 원장 어휘 추가(`route.selected` 의 `source` 또는 새 `route.observed_pre`) 는 allowlist 커밋이 먼저 | 문서 1줄 + `/scorecard --routing` 분모 정의 변경 |
| 못 보는 것 | 전사 포맷 변경(비공개 형식) · `agent_transcript_path` 는 SubagentStop 에만 있어 자식 쪽 확인 불가 · 부모 전사에 없는 스폰(SDK/schedule 경로, `source` 필드) | `prompt_id` 부재 시 fallback 이 시간 근접으로 강등 · `tool_input` 실제 키(캡처 전) · PreToolUse 가 팀 스폰에도 발화하는지(**미확인** — `daily-experiences.json`·`learning-log.json` 에 `Agent` 도구 기록 0건) | 라우팅 관측 자체. Observe 종료 조건(라이브 receipt 실측)이 **영구 미충족** — G1 재결정 조건이 닫히지 않음 |
| 부수 이득 | — | `subagent_type` 실명을 얻어 **`actionClass:null` 19/19 도 함께 닫힌다**(§3.1 세 번째 관측) | 코드 0 |

**추천: (B), 2단계 기록.** 근거는 두 가지 실측 — 텍스트와 `subagent_type` 이 실재하는 유일한 payload 가 PreToolUse 이고(전사의 tool_use 입력 형태), (A) 의 상관 키는 전사에 없다(0회). 다만 (B) 의 전제 두 개(`tool_input` 키 캡처, 팀 스폰에서 PreToolUse 발화)는 **미확인**이므로 이 추천은 **판단**이다. 전제 중 하나라도 깨지면 (C) 로 간다 — (A) 는 어느 경우에도 (B) 보다 나은 점이 없다(비용·오판 위험·되돌리기 전부 열세). (C) 를 택하면 "Observe 는 라우팅을 관측하지 못했다"를 v4.53.0 CHANGELOG 에 정정 문구로 넣어야 한다.

**(B) 의 2단계 형태(제안)**: PreToolUse(Agent) 에서 `route.selected{source:'shadow', correlation:{prompt_id, tool_use_id, name}}` 를 쓰고, SubagentStart 에서 `agent_id` 와 `name`/`prompt_id` 가 맞는 최근 receipt 를 찾아 `route.selected.bound{agent_id, models.selected}` 1줄을 덧붙인다. 매칭 실패는 `route_ledger:'skipped:unbound'` 로 남긴다(허용목록 어휘 추가). receipt 를 갱신하지 않는 이유는 append-only 원장이기 때문.

### 6.3 이 게이트들이 못 보는 것

- 호스트가 **같은 키에 다른 의미**를 실을 때(키 존재 ≠ 의미 동일).
- payload 는 맞는데 **출력**을 호스트가 안 받는 경우 — F14: 호스트 UserPromptSubmit 출력 스키마에 최상위 `user_prompt` 는 없다. 디스패처가 내는 `{user_prompt: …}`(`_userprompt-dispatcher.js:206-208, :222-225`) 가 호스트에 **무시될 가능성**이 있다. 이것은 별건 결함 후보이며 **미확인**(스키마는 실측, 무시 동작은 추론). 입력 키를 고쳐도 출력이 버려지면 effort 디렉티브는 여전히 모델에 닿지 않는다 — `commands/team.md:74` 가 "유일한 실경로"라 부른 그 경로다. 입력 계약과 **출력 계약을 같은 방식으로** 고정해야 한다.
- 픽스처가 호스트 버전에 묶이므로, 사용자가 다른 Claude Code 버전을 쓰면 계약이 다를 수 있다. 픽스처의 `host_version` 과 라이브 `version`(전사 `.jsonl` 의 `"version":"2.1.259"`)을 `/doctor` 가 비교하는 것은 별도 제안.
- 정적 스캔은 `hookData` 라는 이름을 안 쓰는 접근(`payload.x`, 구조분해)을 놓친다 — (b)의 대상 식별자를 허용목록으로 두고 그 밖의 stdin 소비를 금지하는 규칙이 같이 필요.

---

## 7. "완료" 판정 기준 제안

코드 변경 ≠ 수리 완료. 다음 4단을 **전부** 통과해야 "완료"다.

| 단계 | 판정 | 확인 방법 | 제약 |
|---|---|---|---|
| D1 코드 | §6.1 ①②③ 착지 + 훅 테스트가 동결 픽스처만 사용 | `npx vitest run tests/firewall/host-payload-contract.test.js tests/hooks/` | 그린은 D1 의 필요조건일 뿐 |
| D2 워킹트리 라이브 프로브 | §6.1 ④ 로 워킹트리 훅을 실제 호스트에 1회 태워 **입력 키 집합 diff 0** — 그리고 **출력 계약 프로브**: UserPromptSubmit 훅이 `{user_prompt:"<마커>"}` 최상위 출력과 `hookSpecificOutput.additionalContext:"<마커2>"` 를 함께 내고, 다음 모델 턴에 어느 마커가 도달했는지 확인. 호스트 출력 스키마(2.1.259 실측, 리더·본 문서 일치)에 최상위 `user_prompt` 는 없으므로, 마커1 이 도달하지 않으면 **effort 디렉티브 전달 경로(`commands/team.md:74` "유일한 실경로")가 죽어 있는 것**이고 이번 세션 팀원 전원이 받은 `[artibot:effort level=xhigh …]` 도 훅이 아니라 리더가 손으로 붙인 것이 된다 | 프로브 산출 파일 vs 픽스처 / 마커 도달 여부 | 릴리스 없이 가능. 다만 `${CLAUDE_PLUGIN_ROOT}` 를 워킹트리로 돌리는 임시 settings 가 필요 — 방법은 **미확인**(`claude --plugin-dir` 류 옵션 존재 여부 확인 필요) |
| D3 릴리스+업데이트 | `npm run release` → 마켓플레이스 태그 → `claude plugin marketplace update artibot && claude plugin update artibot` → `installed_plugins.json.lastUpdated` 가 릴리스 시각 이후 | 파일 열람 | **여기서부터만** 라이브 원장이 유효 |
| D4 라이브 원장 | 설치 시각 이후 start 행 **N≥10** 에서 `route_ledger:"ok"` 비율을 보고, `skipped:*` 사유 분포를 표로 | `awk ts ≥ 설치시각 spawns.ndjson \| grep -o route_ledger…\| sort \| uniq -c` | `ok` 가 0 이면 미완. `skipped:no-phase` 등 **정당한 스킵**은 사유별로 따로 세고 "정당" 판정 근거를 적는다 |

D4 의 **분모**를 반드시 적는다("ok 7/10, skipped:no-phase 3/10, 설치 13:38Z 이후, 측정 16:05Z").

**사건별로 완료 기준이 다르다:**
- **(a) UserPromptSubmit** — 완료 기준 **있음**: 릴리스+update 후 첫 프롬프트에서 캐시 `runtime/current-effort.json`·`token-usage-session.json` 이 생기고, `<projectRoot>/.artibot/runtime/decisions/<session_id>.events.ndjson` 이 라이브 세션 id 로 적재되는 것(F9 의 역). 분모 = 설치 이후 프롬프트 수.
- **(b) SubagentStart** — §6.2 의 A/B/C 가 결정되기 전에는 **완료 기준 자체가 없다.** (C) 면 "D4 에서 `skipped:no-action-text` 가 100% 인 것이 정상" 으로 기준이 뒤집히고, (B) 면 D4 의 `ok` 는 PreToolUse receipt + SubagentStart bound 의 **쌍** 비율로 다시 정의해야 한다. 지금 D4 를 (b) 에 적용하면 어떤 결정 하에서도 잘못된 판정을 낸다.

---

## 8. 리더 전제 정정 (규칙: 틀린 인용은 그대로 따르지 않는다)

| 리더 브리프 | 실측 |
|---|---|
| "`lib/core/hook-utils.js:88-93`" | 경로는 `plugins/artibot/lib/core/hook-utils.js:88-93`(리포 루트에 `lib/` 없음). 줄 번호는 맞음 |
| "`scripts/hooks/runtime-prompt.js:749`" | HEAD 기준 `:743`. 워킹트리는 편집 중이라 다름 |
| "4.53.0 설치(04:46Z)" | `installed_plugins.json` `lastUpdated` **04:38:55Z**, 캐시 파일 mtime 04:38:02Z. 04:46 의 출처 미확인 |
| "16행, 10/10 skipped" | 16:0x 기준 26행, start 14/14 skipped. 결론 동일 |
| "키 불일치" / "같은 클래스 결함(추론)" | SubagentStart 쪽은 **키 불일치가 아니라 키 부재**(F10). UserPromptSubmit 쪽은 리더 추론이 **실측으로 승격**됨(F9·F11) — 5훅 산출물이 5개 버전 전부 0 |
| "`runtime/decisions/`·`user-profile.json`·`token-usage-session.json` 라이브 전무" | 캐시 5버전 기준 **참**. 단 워킹트리 `plugins/artibot/runtime/` 에는 셋 다 있음(09:12·13:05 mtime) — 테스트/수동 실행 산출물로 보이며 프로덕션 증거 아님(메모리 규칙 "검수 산출물은 프로덕션 증거가 아니다"). 리포 루트 `.artibot/runtime/decisions/` 의 `sess-wiring-*` 도 테스트 픽스처 세션명 |
| "훅 실행 루트 = 마켓플레이스 미러"(09-02 보고서) | 지금은 캐시 경로(F8). 09-02 시점 사실은 미확인 |
| "14,468 pass" | 릴리스 커밋 본문 값. 보고서 §1 은 14,470(다른 시각 실행). 둘 다 실재 |

---

## 9. 미확인

- 2026-02 시점 Claude Code 가 `user_prompt` 키를 보냈는지(계보 A 의 기원). 문서 이력 미조회.
- phd-skills 원본(AD-38)의 실제 코드.
- 워킹트리 훅을 실제 호스트에 태우는 공식 방법(D2).
- `.artibot/project.md` HG-08 이 플러그인 릴리스를 포함하는지.
- 디스패처 최상위 `user_prompt` 출력이 호스트에 **무시되는지 / 별도 경로로 읽히는지**. 출력 **스키마**는 실측 확정(F14, 리더 16:2x 재현 일치: `hookEventName:H("UserPromptSubmit"),additionalContext,sessionTitle,suppressOriginalPrompt`) — 바이너리의 `user_prompt`·`user_prompt_length` 문자열 5건은 OTel 텔레메트리 속성으로 보이나 단정 불가. 확정은 D2 출력 프로브로.
- 리더의 "04:46Z" 출처.
- `tests/fixtures/*-hook-payloads.jsonl` 2개가 라이브 캡처인지 손작성인지(`tool_name` 은 `Bash` 5건뿐 — Agent 없음).
- 호스트 debug log 가 디스크에 남는지(stderr 의 최종 행선지).
- (§6.2 전제) 라이브 PreToolUse `tool_input` 의 실제 키(스키마는 `de()`), `prompt_id` 가 라이브 payload 에 실리는지, PreToolUse 가 팀 스폰(Agent 도구)에도 발화하는지, 병렬 스폰의 SubagentStart 순서가 tool_use 순서를 따르는지.
- 2.1.259 이전 호스트 버전의 `agent_type` 의미(지금은 Agent `name`) — 과거 원장 행의 `agentType` 해석에 영향.
