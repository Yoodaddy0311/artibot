# 훅 실패 가시성 설계안 (HOOK-VISIBILITY) — 통합 정본

> **오너 승인 전 구현 금지.** 이 문서는 설계안이다. 코드·테스트·config 변경 없음. 커밋 없음.

**작성**: incident 팀원(fable, 설계 담당), 2026-09-03 16:0x 초안 → 16:4x 통합. 리포 `master @ 3bcadb8e`(v4.53.0). 라인 인용은 HEAD 기준.
**통합 이력**: `DESIGN-HOOK-FAILURE-VISIBILITY.md`(payload 팀원, 16:13)의 독자 기여를 흡수했다(§9 에 출처표). 그 파일은 첫머리 리다이렉트 한 줄만 붙이고 보존한다. 상충 2건은 §2.1·§2.2 에서 근거와 함께 확정.
**선행 문서**: `INCIDENT-2026-09-03-hook-payload-contract.md` — 이 설계는 그 사고의 "왜 안 보였나"에 답한다.

---

## 0. 문제 정의 — 세 종류의 침묵

| 계층 | 성질 | 오늘의 경로 | 이번 사고에서 |
|---|---|---|---|
| **S1 크래시** (throw / non-zero exit) | 예외 | `plugins/artibot/lib/core/hook-utils.js:88-93 logHookError` → `process.stderr.write` 뿐. 호스트는 exit 0 훅의 stderr 를 **사용자·모델 어디에도 보여주지 않음**(공식 문서 2026-09-03: "debug log only") | **발생하지 않았다** |
| **S2 사유 있는 스킵** (정상 반환, 목적 미달) | 산출물 | `subagent-handler.js:377-416 observeRoute` 가 `skipped:<reason>` 을 스폰 원장 컬럼에 씀 — **읽는 소비처 0**(`grep -rl route_ledger lib commands scripts`: writer 컬럼 허용목록 `spawn-ledger.js:120` 외 0건) | **여기서 났다.** 14/14 가 원장에 있었다. UserPromptSubmit 5훅은 `return null` 만 하고 **사유를 어디에도 안 남긴다**(더 나쁜 형태) |
| **S3 발화 카운트** (훅이 몇 번 돌았나) | 분모 | 없음 | 09-02 상태("Observe 훅 3종 한 번도 실행 안 됨")가 이 계층. **범위 밖** — `plugins/artibot/CLAUDE.md` §Existence Audit 소유(분모 미측정으로 이미 등재). 중복 설계하지 않는다 |

**핵심 교훈(양 문서 독립 도출 → 신뢰도 높음)**: 훅은 대개 실패하지 않고 **조용히 no-op 한다.** 예외만 남기는 로그였다면 이번 사고를 못 잡았다. 결함을 드러낸 것은 로그가 아니라 **사유가 붙은 산출물**이었다 — 사유를 남기는 스킵은 가시성 장치 그 자체이므로 성능·소음을 이유로 지우지 마라.

따라서 이 설계는 **S1 파일 싱크 + S2 판독 표면** 두 가지이고, **S2 가 우선순위가 높다**(H-2). S1 만 하면 이번 사고는 여전히 안 보인다.

---

## 1. 현재 상태 실측 (2026-09-03 16:0x, HEAD)

| 항목 | 값 | 재현 |
|---|---|---|
| 훅 스크립트 수 | **63** | `ls plugins/artibot/scripts/hooks/*.js \| wc -l` |
| `createErrorHandler` 사용 훅 | **49/63**(내부에서 `logHookError`, `hook-utils.js:105-116`) | `grep -l createErrorHandler scripts/hooks/*.js \| wc -l` |
| `logHookError` 직접 호출 | **40곳/13파일**(부록 A) | 전역 grep |
| `process.stderr.write` 직접 호출 | **34파일/84줄** — 디스패처 6종 포함 | `grep -c process.stderr.write scripts/hooks/*.js` |
| 파일 기반 훅 오류 로그 | **0** | grep `hook-errors\|hooks\.log\|errors\.ndjson` |
| 메시지에 오류 본문·경로를 **보간**하는 호출 | **10곳**(`dev-verify-gate:82 ${cmd}` · `instructions-loaded:73 ${missing}` · `session-end:345,349,393,408,416 ${err.message}` · `swarm-download:35 ${filePath}` · `git-autopilot-setup:236`·`image-cleanup:203` 은 `err.message` 를 message 인자로) | `grep "logHookError(" scripts/hooks/*.js \| grep '\${\|err\.message'` |
| UserPromptSubmit 기여자 중 프롬프트를 못 읽던 수 | **5/6**(`ambiguity-guard` 만 정상), 에러 로그 **0건** — `if (!prompt) return null` | INCIDENT F9·F11 |
| "절대 throw 안 함" 선례 | `lib/runtime/event-writer.js:654-663 appendLine` `{ok:false, reason}` · `:750-765 writeEvent` catch-all · `:673-676` 거부 행의 자기 거부 금지 | 파일 열람 |
| 기존 레닥션 | `lib/runtime/ledger-redaction.js`(L5) → `lib/learning/ledger/redact.js#redactSecrets`(L3) → `lib/privacy/pii-scrubber.js`(L2). 범주 `credentials/auth/secrets/env`, 경로·이메일·IP 는 **보존** | `redact.js:6-10` |
| 층 규칙 | `hook-utils.js` 는 **L1**. `eslint.config.js:79-81` 이 `lib/core/**` 에 `no-restricted-imports: error` 로 상위 import 를 실제로 막는다 | `plugins/artibot/CLAUDE.md`, `eslint.config.js:70-89` |
| 회전 선례 | `lib/learning/ledger/store.js:152-175 rotateLedger`(파일 수 기준, best-effort) | 파일 열람 |
| 보존 config 선례 | `artibot.config.json:1198 decisionTrail.retentionDays:30`, `:1239 retention.*MaxDays` | 파일 열람 |
| `/doctor` Check 8·9 구현 | `lib/project-state/doctor-checks.js`(L2) | grep `checkArtifactHealth` |

---

## 2. S1 — 크래시를 어디에, 어떻게 남길 것인가

### 2.1 위치 — **확정: 홈 스코프 `~/.claude/artibot/runtime/hook-errors.ndjson`**

payload 문서는 `<projectRoot>/.artibot/ledger/hook-errors.ndjson`(`hookData.cwd` → `resolveProjectRoot`, cwd 없으면 안 씀, `~/.claude` 금지)을 제안했다. 홈 스코프로 확정하는 근거:

1. **호출 시그니처가 payload 를 모른다.** `logHookError(hookName, message, cause)` 는 63개 훅·49개 `createErrorHandler` 에서 payload 없이 불린다. 프로젝트 스코프는 시그니처 변경 또는 전역 상태 주입 = **호출부 63곳 변경**. 홈 스코프는 `getArtibotDataDir()`(`hook-utils.js:144`, 같은 L1 파일) 하나로 경로가 선다 — 변경 2함수.
2. **cwd 해석 실패가 곧 오류 케이스다.** payload 문서 §7-4 가 스스로 "cwd 없는 payload 의 실패를 못 잡는다"를 사각지대로 적었다. 홈 스코프는 그 사각지대가 **없다.**
3. **"전역 위치는 리포 경계를 넘어 프롬프트 파편을 섞는다"는 §3 허용목록 하에서 성립하지 않는다.** 파편을 쓰지 않으면 섞일 파편이 없다. 리포 식별은 `ctx.session_id`(§2.2)로 한다.
4. **커밋 노출 위험이 구조적으로 0.** `~/.claude/artibot/` 는 어느 리포 안에도 없다. payload 문서 §8-1("`.gitignore` 가장 먼저")은 홈 스코프에서는 불필요해지지만, **불변식 "로그는 어떤 git 워킹트리 안에도 두지 않는다"** 는 그대로 채택한다.
5. `/doctor` 가 볼 파일이 **하나**다(프로젝트 스코프는 리포마다 흩어진다).

대가: 어느 리포의 오류인지는 `session_id` 로만 구분된다 — `ctx` 없는 호출은 리포 불명(§6-6). 2단계에서 "프로젝트별 미러"는 검토 가능하나 1단계 범위 밖.

### 2.2 한 줄의 형태 — 필드 **허용목록** (여기 없는 것은 쓰지 않는다)

```json
{"ts":"2026-09-03T07:05:10.573Z","hook":"subagent-handler","event":"SubagentStart","kind":"throw","session_id":"9120048e-3385-4855-a35b-09c89e5dd684","error_class":"Error","code":"EPERM","frame":"hook-utils.js:92","msg":"failed to save state","pid":43268,"plugin":"4.53.0"}
```

| 필드 | 출처 | 규칙 |
|---|---|---|
| `ts` | ISO | — |
| `hook` | 1번째 인자(리터럴) | — |
| `event` | `ctx.event`(`hook_event_name`), 선택 | 코드 상수 |
| `kind` | `throw` \| `timeout` \| `nonzero-exit` | 코드 상수(payload 문서 어휘 채택). `timeout` 은 디스패처가 자식을 죽일 때만(§4 2단계) |
| `session_id` | `ctx.session_id`, 선택 — **전체 값**으로 확정 | 상충 2 해소: 다른 원장(`spawns.ndjson`·`decisions/`)이 전체 id 를 쓰므로 조인 편의가 우선. UUID 라 사용자 정보 없음. 홈 파일이 리포를 넘어 살아남는 것은 §2.1-3 논거로 무해 |
| `error_class` | `cause.name` | — |
| `code` | `cause.code`(+`errno`·`syscall` 있으면) | — |
| `frame` | stack 최상단 프레임의 **`basename:line` 만** | payload 문서 규칙 채택. stack 전문·절대경로 금지 |
| `msg` | 2번째 인자 → §2.3 레닥션 → **200자 절단** | — |
| `pid` | `process.pid` | 동시 훅 구분 |
| `plugin` | `package.json` version, 모듈 로드 시 1회 캐시, 실패 시 `null` | "어느 설치본이 낸 오류인가" — 이번 사고의 핵심 쟁점 |

**절대 기록 금지(허용목록의 반대면, 예외 없음)**: 프롬프트 본문·요약·앞 N자·해시·**길이**(짧은 프롬프트에서 길이는 식별자) / `transcript_path`·`cwd`·절대경로(경로가 필요하면 `basename`) / 토큰·비밀값·환경변수 전체 / stack 전문 / payload 통째 / `cause.message`(fs 오류는 절대경로를, 네트워크 오류는 URL·토큰을 싣는다).
**한 줄 상한 1,024B**(초과 시 `msg` 절단 → 그래도 초과면 `{"ts","hook","kind","msg":"[oversized]"}`). **1프로세스당 최대 1줄**(payload 문서 채택 — 루프 폭주가 앞선 증거를 회전으로 밀어내는 것을 막는다; 두 번째 호출부터는 stderr 만).

### 2.3 `msg` 레닥션 — 층 규칙 안에서

**기존 스크러버 재사용 불가(판정 유지)**: L1 → L2/L3/L5 import 는 `eslint.config.js:79-81` 이 막고, 패턴 복사는 정본 포크(Hardening §46, `ledger-redaction.js:10-15` 선례).
**대체 = 구조적 허용목록(§2.2) + `msg` 한정 위생 규칙(payload 문서 §3 채택, 순서 고정)**:
```
1) 절대경로 제거   /[A-Za-z]:\\[^\s"']+/ , /\/(?:home|Users)\/[^\s"']+/   → "<path>"
2) 긴 토큰형 제거  /[A-Za-z0-9_\-]{24,}/                                   → "<redacted>"
3) 200자 절단
```
순서가 중요하다 — 2 를 먼저 돌리면 경로 조각이 토큰으로 오인돼 부분만 지워진다. 이 두 정규식은 **비밀 스크러버가 아니라 `msg` 위생**이며(범주 검출 없음), 그렇게 문서화한다 — 비밀 차단의 정본은 아래 파이어월이다. `lib/privacy` 가 L1 로 내려오는 날 이 두 줄은 삭제한다(그 조건을 코드 주석에 적는다).
**보간 파이어월**: `logHookError(` 호출부의 message 인자에 `${` 또는 `err.message` 가 있으면 `tests/firewall/fixtures/hook-error-interpolation.allowlist.json` 에 사유와 함께 있어야 통과. 초기 허용목록 = 오늘의 10곳. 새 보간은 허용목록 커밋이 먼저.
**레닥터 자기검증 테스트**(payload 문서 채택): `tests/firewall/` vitest, 픽스처는 **실제 길이**의 Windows/POSIX 경로·24자+ 토큰(짧은 픽스처는 아무것도 증명하지 않는다 — rules §9). 그리고 **과잉 레닥션 표시**: 결과가 `<redacted>`/`<path>` 만 남으면 `msg:"[redacted-only]"` 로 바꿔 진단 가치 0 임을 드러낸다(payload §7-6 사각지대 해소).

### 2.4 보존·회전·크기 상한 (양 문서 일치)

| 항목 | 값 | 근거 |
|---|---|---|
| 파일 상한 | **1 MiB** | 줄당 ≤1KB → ≥1,000줄 |
| 회전 | `hook-errors.ndjson` → `hook-errors.1.ndjson` **1세대만**, 쓰기 **직전** `statSync` 로 판정 | 쓴 뒤 확인은 항상 상한 초과 뒤에 자른다. 2세대 이상은 사고 조사에 기여한 선례 없음 |
| 보존 | 현재본+회전본. **시간 기반 만료 없음** | cron 청소는 그 자체가 감시 대상(무한 회귀). L1 에서 config 읽기도 불필요해짐 |
| 동시성 | `appendFileSync(flag:'a')`, 락 없음 | `event-writer.js:654-663` 동일 |
| 끄기 | `ARTIBOT_HOOK_ERROR_LOG=0` → stderr 만(오늘 동작) | §4 되돌리기 |

### 2.5 절대 throw 하지 않는다 — 그리고 무음도 아니다

```
logHookError(hookName, message, cause, ctx?):
  stderr 쓰기                       ← 오늘 그대로, 먼저, 항상
  try { 파일 append (§2.2~2.4) }
  catch { stderr 한 줄 "[artibot:hook-log] append failed: <code>" }   ← 파일에는 절대 안 씀
```
- 파일 쓰기는 stderr **뒤**. 파일이 실패해도 오늘의 관측면 손실 0.
- **실패를 삼키되 무음은 아니다**(payload §5-2 채택): 쓰기 실패는 stderr 한 줄. 재귀 금지 — 로그 쓰기 실패는 절대 로그 파일에 쓰지 않는다(`event-writer.js:673-676` 규칙과 동형).
- **`writeStdout` 보다 뒤**(payload §5-4 채택): `createErrorHandler` 의 block 응답이 있는 경로(`hook-utils.js:109-111`)에서는 `writeStdout` 후에 append 하도록 순서를 바꾼다. 훅 응답이 먼저 나가야 로그 I/O 가 프롬프트 지연이 되지 않는다.
- `createErrorHandler` 자체는 시그니처 무변경 — 49개 훅이 자동 적용.
- 정상 경로 비용 0. 오류 경로 추가 비용 = stat+append 1회, **미측정**.

---

## 3. S2 — 사유 있는 스킵을 사람 앞에 올리기 (H-2, 우선)

이번 사고의 신호는 원장에 있었다. 필요한 것은 **읽는 곳**과, UserPromptSubmit 쪽의 **없는 사유**다.

### 3.1 원칙: 사유는 **산출물 옆에**, 로그 파일이 아니라 (payload §1-L2 채택)
`route_ledger:"skipped:<reason>"` 처럼 해당 도메인 산출물 안에 둔다. 별도 로그로 옮기지 마라 — 산출물 옆에 있어야 읽힌다.

### 3.2 UserPromptSubmit 5기여자 — 스킵 사유 **카운터**(원장 행 아님)
`return null` 만 하던 5훅(`runtime-prompt`·`user-prompt-handler`·`auto-team-trigger`·`autopilot-nlu-trigger`·`auto-command-suggest`)에 사유를 도입한다. 프롬프트마다 5줄이 쌓이면 소음이므로 **원장이 아니라 카운터**(payload H-2 채택): `<pluginRoot>/runtime/hook-skips.json` 에 `{hook → {reason → count, last_ts}}` 누적. 사유 어휘는 **허용목록**(`no-prompt`·`opted-out`·`disabled`·`no-match`·`no-session`), 열거 밖은 `other`. 작성은 `_userprompt-dispatcher.js` 한 곳에서(각 훅의 null 반환에 사유를 붙이는 반환형 확장은 2단계 — 1단계는 디스패처가 "null 을 낸 훅 수"만 센다).
**게이트 옆에 적는 것**: 카운터는 "몇 번 스킵했나"를 주지 분모(발화 수)는 S3 소유. 카운터가 0 인 것은 "정상" 이 아니라 "안 돌았다" 일 수 있다.

### 3.3 `skipped:<reason>` 어휘 허용목록 (subagent-handler)
`observeRoute` 의 `skip(err?.message)` 경로(`:415`)는 오류 메시지를 그대로 원장에 넣는다 — **경로·비밀이 append-only 원장에 들어갈 수 있는 자리**(`REASON_MAX` 절단만). 제안: `reason` 을 열거형(`no-epoch`·`no-session`·`no-mission`·`no-action-text`·`no-phase`·`no-complexity`·`no-cwd`·`append-failed`·`route-failed`)으로 고정하고 열거 밖은 `route-failed` 로 접어 원문은 S1 채널로. `payload`/`observe` 팀원 소관, 여기선 제안만. (`no-action-text` 의 처분은 `ROUTE-RECEIPT-PRETOOLUSE-DESIGN.md` §5.)

### 3.4 `/doctor` Check 10 "훅 건강" (읽기 전용, `--fix` 대상 아님 — Check 8·9 규약)
입력: (a) `~/.claude/artibot/runtime/hook-errors.ndjson` 최근 24h `hook`·`kind` 별 건수 (b) `<projectRoot>/.artibot/ledger/spawns.ndjson` 설치 시각(`~/.claude/plugins/installed_plugins.json` `artibot@artibot[0].lastUpdated`) 이후 start 의 `route_ledger` 분포 (c) `runtime/hook-skips.json` (d) `decisions/*.events.ndjson` `recorder-stats` 합.
판정 규칙(허용목록): start ≥10 에서 `ok` 0 → **WARN** + 사유 분포표(분모·측정 시각·설치 시각 병기); n<10 → "표본 부족(n=…)" 판정 보류; hook-errors 24h ≥1 → 건수·최다 `hook` 1줄. 거짓 그린·거짓 경보 모두 금지.
**이게 없으면 이 설계는 절반짜리다**(payload §5-3): 아무도 안 읽는 파일은 감시가 아니다.

---

## 4. 변경 지점 · 순서 · 되돌리기 (승인 후)

| 순서 | 파일 | 변경 | 층 | 크기 |
|---|---|---|---|---|
| 1 | `tests/firewall/hook-error-redaction.test.js` + 실제 길이 픽스처 | §2.3 레닥터 자기검증 + 보간 허용목록 게이트 — **쓰기 함수보다 먼저**(payload §8 순서 채택: 레닥션이 조용히 깨지면 그때부터 유출 채널) | — | ~100줄 |
| 2 | `plugins/artibot/lib/core/hook-utils.js:88-93` | `logHookError` 에 파일 append + `hookErrorLogPath()` export. 시그니처 유지 + 선택 4번째 인자 `ctx{session_id?, event?}` | L1 | ~60줄 |
| 3 | `tests/core/hook-utils.test.js:165-195` | 허용목록 필드만 / `cause.message` 없음 / 1,024B / 1프로세스 1줄 / 쓰기 불가에서 throw 0 + stderr 1줄 / env 토글 / 회전 | — | ~120줄 |
| 4 | `scripts/hooks/_userprompt-dispatcher.js` | §3.2 카운터(null 반환 수) | scripts | ~30줄 |
| 5 | `commands/doctor.md` + `lib/project-state/doctor-checks.js` | Check 10 | L2 | 미정 |
| 6 | `plugins/artibot/CLAUDE.md` Existence Audit / `.artibot/project.md` | 새 산출물 2개 등재 | 문서 | 3줄 |
| 2단계 | `_dispatcher-utils.js:142-146` | 타임아웃 시 `logHookError(dispatcherName,'timeout',null,{kind:'timeout'})` — 자식은 죽어 아무것도 못 남긴다 | scripts | 1줄 |
| 2단계 | 5훅 반환형 | `null` → `{skip:<reason>}` 사유 어휘 | scripts | ~5×10줄 |

**변경하지 않는 것**: 63개 훅 본문, 디스패처의 직접 `process.stderr.write` 84줄(자식 stderr 중계·통지이며 자식의 `logHookError` 가 파일에 남으므로 이중 기록 아님), `event-writer.js`, `ledger-redaction.js`, config 키(1단계는 env 토글만). **stderr 를 파일로 대체하지 않는다 — 추가한다.**

**되돌리기**: (a) `ARTIBOT_HOOK_ERROR_LOG=0` — 재배포 없이 즉시; (b) 코드 revert = #2 한 함수 + #4 — 호출부 무변경이라 단일 커밋 revert; (c) 파일 삭제는 홈 아래 1~2개 + `runtime/hook-skips.json`.

---

## 5. 오너 결정 요청

| ID | 질문 | 확정/추천 |
|---|---|---|
| H-1 | S1 크래시 로그를 만들 것인가 | **예** — 단 이번 사고는 S1 이 잡지 못했을 사고(§6-1). 기대치를 정확히 |
| H-2 | UserPromptSubmit 5훅에 스킵 사유(카운터)를 도입할 것인가 | **예, H-1 보다 우선**(§3.2) |
| H-3 | `/doctor` Check 10 을 같은 작업에 포함 | **예**(§3.4 — 없으면 절반짜리) |
| H-4 | 위치 | **홈 스코프 확정**(§2.1, 근거 5) — 오너가 프로젝트 스코프를 택하면 #2 가 "63 호출부"로 바뀐다 |
| H-5 | `session_id` | **전체 값 확정**(§2.2) |
| H-6 | 회전 1세대 | 충분(양 문서 일치). 반대 근거 있으면 그쪽 |

---

## 6. 이 설계가 여전히 못 보는 것 (게이트 옆에 적는다 — rules §9)

**"`hook-errors.ndjson` 이 비었다" ≠ "훅이 정상이다."**

1. **S1 은 이번 사고 유형을 못 잡는다** — `return null` 은 throw 가 아니다. 실효는 H-2·Check 10 과 함께 갈 때만.
2. **훅이 아예 호출되지 않은 경우** — 등록 누락·매처 불일치·`${CLAUDE_PLUGIN_ROOT}` 가 다른 설치본·플러그인 미설치. 프로세스가 안 뜨니 아무것도 없다. S3(발화 카운트, Existence Audit)의 영역. 최소 보완으로 SessionStart heartbeat 1줄(설치본 버전+세션 id) + Check 10 "이 세션 heartbeat 없음" 은 별도 제안.
3. **호스트가 디스패처를 SIGTERM 으로 끊는 타임아웃** — `kind:"timeout"` 은 디스패처가 자식을 죽일 때만. 호스트가 디스패처를 죽이면 아무것도 안 남는다.
4. **호스트가 출력을 무시하는 경우** — 훅은 성공이다. 예: 호스트 UserPromptSubmit 출력 스키마(2.1.259 바이너리 실측, 리더·본 문서 일치)는 `hookSpecificOutput{additionalContext, sessionTitle, suppressOriginalPrompt}` 뿐이고 최상위 `user_prompt` 가 없다. 디스패처 `:206-208, :222-225` 의 `user_prompt` 출력이 무시되는지는 **미확인**. 출력 계약 프로브는 INCIDENT §7 D2.
5. **설치본과 리포의 괴리** — 로그는 실행된 코드를 반영한다. 리포를 고쳐도 릴리스+`plugin update` 전에는 라이브가 구코드(이번 세션이 정확히 그 상태).
6. **리포 불명 줄** — `ctx` 없는 호출은 어느 리포에서 났는지 모른다(홈 스코프의 대가).
7. **`msg` 안의 비밀** — 위생 규칙·파이어월로 확률을 줄일 뿐. 리터럴에 토큰을 넣으면 못 막는다. 과잉 레닥션은 `[redacted-only]` 로 표시되지만 부족 레닥션은 표시되지 않는다.
8. **로그 파일 손상·삭제, 1~2 MiB 이전 이력 없음.**
9. **성능** — 오류 폭주 훅의 회전 빈도. 1프로세스 1줄 규칙이 프로세스 내 폭주는 막지만 프로세스 폭주(매 도구 호출마다 새 프로세스가 실패)는 못 막는다. 회전 최소 간격은 미결.

---

## 7. 통합 출처표 (payload 문서에서 흡수한 항목)

| 항목 | 출처 절 | 처리 |
|---|---|---|
| S1/S2/S3 3계층, S3 = Existence Audit 소유 | §1 | 채택(§0) |
| "1프로세스당 최대 1줄" | §4 | 채택(§2.2) |
| `kind` 어휘, `error_class`, `frame = basename:line` | §2 | 채택(§2.2) |
| 프롬프트 **길이**도 금지, `basename` 만 | §3 | 채택(§2.2) |
| 레닥션 순서(경로→토큰→절단), 실제 길이 픽스처 자기검증 | §3 | 채택(§2.3), 단 "위생 규칙"으로 격하하고 비밀 차단 정본은 파이어월 |
| 쓰기 실패 시 stderr 1줄(무음 아님), `writeStdout` 뒤에 쓰기 | §5 | 채택(§2.5) |
| 판독 표면 없으면 절반짜리 | §5-3 | 채택(§3.4) |
| H-2 스킵 사유 카운터 우선 | §6 | 채택(§3.2, §5) |
| 못 보는 것 4(cwd 없음)·5(설치본 괴리)·6(과잉 레닥션) | §7 | 4 는 홈 스코프로 해소, 5 채택(§6-5), 6 은 `[redacted-only]` 로 해소 |
| `.gitignore` 최우선 | §8-1 | 홈 스코프에서 불필요 → 불변식 "워킹트리 안에 두지 않는다"로 대체(§2.1-4) |
| 위치 프로젝트 스코프 | §2 | **불채택**(§2.1 근거 5) |
| `session_id` 전체 | §2 | **채택**(§2.2) — 본 문서 초안의 8자 안 철회 |

## 부록 A. `logHookError` 소비처 전수 (전역 grep, 16:0x, `node_modules` 제외)

정의 1: `plugins/artibot/lib/core/hook-utils.js:88`. 내부 호출 1: `:108`(createErrorHandler).
훅 호출 40곳/13파일: `agent-evaluator.js:286` · `context-tracker.js:197` · `dev-verify-gate.js:82,179` · `git-autopilot-setup.js:207,236` · `image-cleanup.js:203` · `instructions-loaded.js:73` · `memory-tracker.js:301` · `post-compact-rehydrate.js:195,203,215` · `pre-compact.js:402` · `session-end.js:98,127,164,228,288,345,349,393,408,416` · `swarm-download.js:35,57,84,98,110,130,139,151,189,205,212` · `swarm-sync.js:125,128` · `tool-tracker.js:297`.
테스트 참조 18파일(mock 15 + `hook-utils.test.js` + `silent-fail-stderr.test.js` + `swarm-download.test.js`). 문서 참조 3(`.artibot/archive/2026-06/stage-b-side-diagnosis.md:109,137` · `docs/PRD/학습-파이프라인-…md:664` · `plugins/artibot/docs/wiring-audit-result.json:1977`).
`createErrorHandler` 사용 훅 49/63 — 코드 변경 없이 새 싱크를 받는다.

## 부록 B. 미확인
- 호스트 debug log 의 디스크 잔존 여부·경로.
- 오류 경로 추가 비용(stat+append) 실측치.
- `eslint.config.js:81` 제한 목록에 `lib/privacy`·`lib/learning`·`lib/runtime` 이 실제로 들어 있는지(규칙 존재는 확인, 목록 전문 미열람).
- 디스패처 최상위 `user_prompt` 출력이 호스트에 무시되는지(스키마는 실측).
