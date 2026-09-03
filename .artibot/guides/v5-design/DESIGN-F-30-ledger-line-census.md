# 설계안 F-30 — 원장 원본 줄수·손실 카운터 (Ledger Line Census)

> **오너 승인 전 구현 금지.** 설계안이다. 코드·테스트·게이트·config 무변경.
> 작성 2026-09-03 15:4x KST · master @ `3bcadb8e` · 경로는 `plugins/artibot/` 기준(브리프의 `lib/runtime/ledger.js` 는 `plugins/artibot/lib/runtime/ledger.js` 다).

---

## 0. 결론 먼저

- **`readAllEvents` 의 반환형은 바꾸지 않는다.** 배열을 기대하는 소비자가 11 테스트 파일 + `load.js` 포트 계약 + `doctor.md`·`scorecard.md` 산문 2곳이다. 대신 **같은 구현 위에** `readLedgerCensus(projectRoot, filter) → { events, census }` 를 신설하고 `readAllEvents` 는 그 `.events` 를 돌려주는 얇은 래퍼로 바꾼다 — 리더 한 개, 답 한 개.
- **`event-writer.js` 는 한 글자도 건드리지 않는다.** 필요한 것(`ledgerFilePath`, `getLedgerSettings`)은 이미 export 돼 있다(`event-writer.js:217, :238`). 798/800 줄 문제는 이 설계와 무관하게 남는다.
- 카운터 이름은 **생존자(`survivors`)와 원본 줄(`lines.*`)과 탈락(`dropped.*`)을 이름으로 구분**하고, 다섯 탈락 경로를 **손상(loss)** 3종과 **선별(selection)** 2종으로 나눠 부른다. 발화율·재현율의 분모 후보는 `lines.nonblank - dropped.selection.*` 이지 `survivors` 가 아니다.
- 결과 객체가 바뀌는 곳은 `replay.totals`(`census` 키 추가)·`existence-audit.summary`(`census` 키 추가)·`/doctor` Check 8 findings(1 코드 추가). **기존 필드는 전부 그대로**라 하위호환. RED 는 `toEqual` 전체 고정 2건 + 산문 게이트 1건(§6).
- 카운터를 넣어도 **못 보는 손실 6종**이 남는다(§7). 특히 "발화율의 진짜 분모(시도 횟수)" 는 여전히 미측정 — 이 카운터는 `eventsReceived` 의 **과대 계상 방향의 착시만** 없앤다.

---

## 1. 실측 — 다섯 탈락 경로 (`lib/runtime/ledger.js:157-180`, 직접 읽음)

```js
169  for (const line of raw.split('\n')) {
170    const e = parseLine(line);
171    if (!e || typeof e.event !== 'string') continue;              // ① ②
172    if (!filter.includeRejected && META_EVENTS.has(e.event)) continue; // ③
173    if (filter.mission_id && e.mission_id !== filter.mission_id) continue; // ④
174    if (filter.session_id && e.session_id !== filter.session_id) continue; // ④
175    if (filter.event && e.event !== filter.event) continue;         // ④
176    if (Number.isFinite(sinceMs) && !(Date.parse(e.ts) >= sinceMs)) continue; // ④
177    out.push(e);
178  }
179  return dedupeEvents(out);                                          // ⑤
```

브리프는 "5경로"라 했고 맞다 — 단 `:171` 한 줄이 **두 가지**(파싱 실패 / envelope `event` 비문자열)를 합쳐 버리고, `parseLine :92-101` 이 **빈 줄**도 null 로 돌려준다. `raw.split('\n')` 은 파일이 `\n` 으로 끝나면 마지막에 `''` 를 하나 만든다(정상 파일에서 항상 1개). 빈 줄을 "손실" 로 세면 모든 정상 원장이 손실 1 을 보고한다. 그래서 카운터는 **빈 줄을 먼저 분리**해야 한다.

| # | 줄 | 탈락 사유 | 분류 | 카운터 |
|---|---|---|---|---|
| 0 | `:93-94` | 공백/빈 줄 | 줄 아님(정상) | `lines.blank` |
| ① | `:96-99` | `JSON.parse` 실패 또는 비객체(배열·스칼라) | **손상** | `dropped.loss.corrupt` |
| ② | `:171` | 객체지만 `event` 가 문자열 아님 | **손상**(봉투 위반) | `dropped.loss.malformed_envelope` |
| ③ | `:172` | `ledger.rejected` 이고 `includeRejected` 아님 | **선별**(의도적) | `dropped.selection.rejected_excluded` |
| ④ | `:173-176` | mission/session/event/since 필터 | **선별**(의도적) | `dropped.selection.filtered_out` |
| ⑤ | `:179` `dedupeEvents :135-145` | `(session_id, source, pid, seq)` 중복 | **손상**(원칙상 발생하면 안 됨 — `:23-27` 헤더) | `dropped.loss.duplicate` |
| — | `:177` | 생존 | — | `survivors` |

`:162-165` 의 파일 부재/읽기 실패는 `[]` 반환 — 이것도 지금은 "빈 원장" 과 구분이 안 된다. census 에 `file.present`·`file.readable` 을 둔다.

## 2. 카운터 정의

```js
/**
 * @typedef {object} LedgerCensus
 * @property {{present: boolean, readable: boolean, bytes: number|null, path: string}} file
 * @property {{raw: number, blank: number, nonblank: number}} lines
 *   raw = split('\n') 조각 수. nonblank = raw - blank = 이 리더가 "줄" 로 취급한 수.
 * @property {{loss: {corrupt: number, malformed_envelope: number, duplicate: number},
 *             selection: {rejected_excluded: number, filtered_out: number}}} dropped
 * @property {number} survivors  — readAllEvents 가 돌려주는 배열의 길이와 항상 같다.
 * @property {{loss: number, selection: number}} dropped_total  — 파생 합계(소비자 편의).
 */
```

**불변식(자기검증 테스트의 단언)**:
```
lines.raw      === lines.blank + lines.nonblank
lines.nonblank === dropped.loss.corrupt + dropped.loss.malformed_envelope + dropped.loss.duplicate
                 + dropped.selection.rejected_excluded + dropped.selection.filtered_out
                 + survivors
survivors      === events.length
```
세 식이 동시에 성립하지 않으면 리더가 세지 않은 여섯 번째 경로가 생긴 것이다 — 그 자체가 게이트.

**이름 규율**: `received`(replay)·`eventsReceived`(existence-audit) 는 **그대로 둔다**(뜻 = "이 함수가 건네받은 수" — 이미 정확하게 정의돼 있다 `replay.js:592-609`, `existence-audit.js:340-347`). 새 이름은 전부 `census.*` 아래에만 두어 "received 가 원본이 됐다" 는 오독을 막는다. `ledgerLines` 라는 이름은 이미 폐기됐고 테스트가 부활을 막는다(`existence-audit.test.js:171-175`) — 쓰지 않는다.

## 3. 변경 지점

### 3.1 `lib/runtime/ledger.js` (L5, fs 소유 — 카운터가 살 유일한 층)

- `readAllEvents :157-180` 본문을 `readLedgerCensus` 로 옮기고 각 `continue` 앞에 카운터 증가. `dedupeEvents :135-145` 는 순수 함수로 유지하되, 중복 수는 `out.length - deduped.length` 로 계산(dedupe 함수 시그니처 무변경).
- `readAllEvents(projectRoot, filter)` → `return readLedgerCensus(projectRoot, filter).events;` (1줄). `foldMissions :295`·`currentMission :335` 무변경.
- 신규 export 1: `readLedgerCensus`. 파일 350 → 약 400줄(상한 800 여유).
- **`event-writer.js` 무변경** — 경로는 기존 `ledgerFilePath(projectRoot, filter)` (`:159` 에서 이미 호출), 바이트 수는 `statSync` 를 ledger.js 에서 직접(`node:fs` 는 이미 import `:51`).

### 3.2 `lib/replay/load.js` (L2 — fs 금지, 포트로만)

- `loadReplay(root, { readEvents, readLedger?, filter, includeEvents })`: `readLedger` 포트(신규, 선택)가 오면 `{events, census}` 를 쓰고, 없으면 기존 `readEvents` 배열 + `census: null`. `readEvents` 없고 `readLedger` 도 없으면 지금처럼 **throw**(`:67-72` fail-closed 유지).
- `buildReplay` (`replay.js:571`) 는 순수·무변경. `loadReplay` 가 반환 직전에 `index.totals.census = census ?? null` 을 붙인다. `buildReplay` 직접 호출자는 `totals.census` 를 **못 본다**(키 자체 없음)가 아니라 — 일관성을 위해 `buildReplay` 도 `totals.census: null` 을 항상 넣는 쪽을 권고("every field present on every call" `:578-580` 원칙). 그러면 `null` = 미측정, 객체 = 측정.
- `tests/replay/no-second-source.test.js:55-70` 은 `lib/replay/` 에 fs·clock 호출이 없음을 grep 한다 — 포트 방식이므로 GREEN 유지.

### 3.3 `lib/replay/existence-audit.js` (L2)

- `buildExistenceAudit(events, { inventory, census? })` → `summary.census = census ?? null`. `eventsReceived` 유지. 헤더 `:62-67` "LOSS ABOVE THE READER IS INVISIBLE" 문단을 "…INVISIBLE **unless the caller passes `census`**" 로 갱신. 이 모듈은 여전히 파일을 열지 않는다(`:67`).

### 3.4 `/doctor` Check 8

- `commands/doctor.md:304` "`readAllEvents(projectRoot)`" (Check 8 절 `:291` 하위; **이 파일은 다른 팀원이 편집 중 — 줄번호는 15:50 재측정값**) → "`readLedgerCensus(projectRoot)` — `events` 는 parity 로, `census` 는 아래 손실 행으로". Check 8 상태표(`| Condition | Status |` 표) 에 행 1 추가: "`census.dropped_total.loss > 0` → **warn**" (fail 아님 — 손상 줄은 parity 판정을 바꾸지 않고, 원장이 진실원이므로 자동 복구 대상도 아님. Check 8 은 `--fix` 대상이 아니다 `:293, :409`).
- `lib/project-state/doctor-checks.js#checkLedgerStateParity :246` 입력에 `census` 선택 추가. 반환에 별도 키 `census` 를 싣고(§4 표 — `findings` 에 넣으면 `:270` `worstOf` 가 기존 호출을 강등시킨다), `census.dropped_total.loss > 0` 일 때만 finding `{ code: 'ledger-lines-dropped', status: WARN, loss: {...}, selection: {...} }` 을 추가한다. **`census` 부재는 조용히 넘기지 않는다**: `census: { status: 'unmeasured', reason: 'census not supplied — line loss was not counted, not counted and found zero' }` 로 반환에 남긴다. `/doctor` 산문은 이 필드를 Check 8 보고에 그대로 찍는다(`:240-256` 이 세 입력에 두는 규율과 같은 결).
- 주의: `tests/commands/doctor-checks-8-9.test.js:594-602` 가 Check 1-7 절을 SHA 로 동결한다. **Check 8 절만** 편집하면 GREEN. `:543, :548` 의 `### Check 8: Ledger / State Parity` 헤딩과 `` - `state`: Check 8 only `` 줄은 문자 그대로 유지할 것.

### 3.5 산문 소비처 (코드 스캔에 안 잡히는 곳 — 전수)

| 파일:줄 | 내용 | 처치 |
|---|---|---|
| `commands/doctor.md:304` | `readAllEvents(projectRoot)` | §3.4 |
| `commands/scorecard.md:54, :62, :67` | 포트 배선 설명 + 스니펫 `loadReplay(process.cwd(), { readEvents: readAllEvents })` | `readLedger: readLedgerCensus` 로 갱신(선택 — 스코어카드는 `totals.indexed` 만 쓴다 `routing-scorecard.js:169`, 지금은 안 바꿔도 동작) |
| `commands/scorecard.md:81` | "원장 gap 판정은 `/doctor` Check 8 의 일" | 무변경(여전히 참) |
| `lib/replay/replay.js:592-609` `totals.received` 주석 | "Counting the ledger's actual lines is the reader's job (T-20)" | "…and it now does: see `totals.census`" |
| `lib/replay/existence-audit.js:62-67, :340-347, :358-360` | "loss above the reader is invisible" ×3 | §3.3 |
| `lib/runtime/ledger.js:23-29` 헤더 | dedupe 설명 | "duplicates are COUNTED in census.dropped.loss.duplicate; judging them is still Check 8's" |
| `tests/replay/load.test.js:134-165`, `existence-audit.test.js:178-219` | "counts SURVIVORS" 테스트의 **주석** | 단언은 유지(§5), 주석에 "census 로 손실이 보인다" 추가 |
| `CHANGELOG.md` | — | 릴리스 시 |
| `README.md`·`AGENTS.md`·`docs/` | `readAllEvents`·`totals.received`·`eventsReceived` **0건**(grep) | 없음 |

### 3.6 스코어카드
`lib/scorecard/routing-scorecard.js:169` 는 `totals.indexed` 만 읽는다 → 무변경. 분모를 census 로 바꾸는 것은 별개 결정(§7 마지막 항).

## 4. 하위호환

| 소비자 | 기대하는 것 | 변경 후 |
|---|---|---|
| `readAllEvents` 호출 11 테스트 파일 + `load.js` 포트 | `object[]` | 동일(래퍼) |
| `loadReplay(root, {readEvents})` 기존 호출 | 동작 | 동일 + `totals.census: null` |
| `buildExistenceAudit(events, {inventory})` | `summary.{entries,measured,unmeasured,exempt,eventsReceived}` | 동일 + `census: null` |
| `checkLedgerStateParity({events,journal,projection})` | verdict | 동일. **실측**(`doctor-checks.js:270`): `status: worstOf(findings.map(f => f.status))` — findings 에 UNMEASURED 를 하나라도 넣으면 census 를 안 넘긴 **기존 호출 전부가 unmeasured 로 강등**된다(`doctor.md:400` "unmeasured outranks pass"). 따라서 census 결과는 `findings` 가 아니라 반환 객체의 **별도 키** `census: { status: 'unmeasured'\|'pass'\|'warn', loss, selection, path } \| null` 로 싣는다. `findings` 에는 **loss > 0 일 때만** `{code:'ledger-lines-dropped', status: WARN}` 을 추가(§3.4) — 그때만 전체 status 가 warn 으로 움직인다. |

## 5. RED 가 되는 기존 테스트 (직접 읽음)

| 파일:줄 | 왜 | 처치 |
|---|---|---|
| `tests/replay/load.test.js:169` `expect(index.totals).toEqual({received:0, indexed:0, events:{}})` | `census` 키 추가 | `census: null` 을 기대값에 추가(빈 파일이면 readLedger 포트를 준 경우 `{file:{present:false…}}` 객체) |
| `tests/replay/replay.test.js:455` 동일 형태 | 동일 | 동일 |
| `tests/replay/load.test.js:134-165` "counts SURVIVORS" | **GREEN 유지** — `received` 는 여전히 2 | 단언 추가: `index.totals.census.lines.nonblank === 3`, `dropped.loss.corrupt === 1` — 이 테스트가 드디어 손실을 **보게** 된다 |
| `tests/replay/existence-audit.test.js:195-219` | GREEN 유지 | 동일하게 census 단언 추가 |
| `tests/runtime/ledger.test.js:191-276` | GREEN(반환 배열 동일) | `readLedgerCensus` 신규 describe: 빈 줄 0 손실 / 찢긴 꼬리 corrupt 1 / `ledger.rejected` 는 selection / 중복 1 / 불변식 3식 |
| `tests/commands/doctor-checks-8-9.test.js` | Check 8 절 편집은 허용, `:543/:548` 정규식·Check 1-7 SHA 유지 시 GREEN | 신규 케이스 `ledger-lines-dropped` |
| `tests/firewall/ledger-append-survival.test.js:166` `readAllEvents(root).toHaveLength(EXPECTED)` | GREEN | 추가 단언 `census.dropped_total.loss === 0` — 60/60 동시 append 게이트가 "손실 0" 을 **직접** 말하게 된다(지금은 생존자 수 == 기대치로 간접 증명) |

RED 예상 **2건**(전체 `toEqual` 2곳). 실행하지 않았다.

## 6. `event-writer.js` 를 건드리지 않는 근거

- 읽기 측 카운터에 필요한 것: 파일 경로(`ledgerFilePath` export `:238`), 설정(`getLedgerSettings` export `:217`), `REJECTED_EVENT` 상수(`:152` export; ledger.js 는 `META_EVENTS :57` 로 별도 보유 — 두 상수의 동일성은 `tests/firewall/ledger-vocab-allowlist` 계열이 볼 일이지 이 설계 범위 아님). 전부 이미 밖으로 나와 있다.
- 쓰기 측 refusal 카운터(`ledger.rejected` 를 **쓰는** 순간 세기)는 writer 에 넣어야 하지만 **불필요**: 거부는 이미 `ledger.rejected` 줄로 원장에 남고(`:667-670` "rejection path can never reject itself"), 읽기 측이 `includeRejected:true` 로 세면 같은 수를 얻는다 — census 의 `selection.rejected_excluded` 가 그 수다. 두 번째 카운터를 만들면 두 답이 생긴다.

## 7. 이 카운터가 못 보는 것 (게이트 옆에 적는다)

1. **시도되지 않은 이벤트.** 훅이 안 돌았거나(설치본 정지 — `scorecard.md:78` 실측: 마켓플레이스 사본 stale → 원장 공백) emitter 코드 경로에 도달하지 않은 이벤트는 줄이 없다. 발화율의 진짜 분모(시도 수)는 **여전히 미측정** — T-42 `CARRIERS` all-null(`existence-audit.js:132-137`) 상태 그대로. census 는 "받은 것 대비 잃은 것" 만 보인다.
2. **줄 경계에서 정확히 잘린 append.** N 바이트 쓰기가 0 바이트로 끝나면 아무 흔적이 없다. 찢긴 꼬리(부분 JSON)는 `corrupt` 로 보이지만, 통째로 사라진 줄은 `seq` 구멍으로만 드러나고 그 판정은 replay `findSeqGaps`/Check 8 소관 — census 가 아니다.
3. **다른 파일에 쓰인 줄.** `ledgerPath` 옵션/config(`getLedgerSettings :217-231`) 이 갈리거나 worktree 별 `.artibot/`(`doctor.md` Check 8 "What this check cannot see" — "Anything about a second worktree" 항) 이면 census 는 자기 파일만 센다. `census.file.path` 를 반드시 같이 보고할 것 — 빈 census 와 잘못된 트리는 경로로만 구분된다.
4. **중복으로 오분류된 진짜 손실.** 같은 `session_id` 안에서 pid 가 재사용되고 seq 가 0 부터 다시 시작하면(프로세스 재시작) 다른 이벤트가 같은 키로 충돌해 `duplicate` 로 세진다. 카운터는 "중복 1" 이라 하지만 실은 "손실 1". `ledger.test.js:236-253` 이 세션이 다른 경우만 보호한다.
5. **`ledger.rejected` 가 대신하는 원래 이벤트의 내용.** selection 카운터는 거부된 줄 수를 세지만, 거부된 이벤트가 무엇이었는지(`data.raw_event`)는 집계하지 않는다 — 그것은 replay `gaps[type:'rejected']` 의 일.
6. **읽기 시점.** census 는 스냅샷이다. 동시 append 중 읽으면 `lines.raw` 가 다음 순간 다르다. 재현율 계산에는 census 와 replay 를 **같은 읽기**에서 얻어야 한다(`readLedgerCensus` 한 번 호출 → 둘 다 그 결과에서) — 두 번 읽으면 분자·분모의 시각이 어긋난다.

그리고 **스코어카드 분모 교체는 하지 않는다**(`routing-scorecard.js:169` `totals.indexed` 유지). census 를 분모로 쓰는 순간 selection(필터로 뺀 줄)이 분모에 들어가 비율이 **과소** 계상된다 — 과대를 없애려다 반대 착시를 만든다. 분모 후보는 `nonblank - selection` 이고 그 채택은 별도 결정.

## 8. 되돌리기
`readLedgerCensus` 삭제 + `readAllEvents` 본문 원복 + `loadReplay`/`buildExistenceAudit`/`checkLedgerStateParity` 의 선택 인자 제거 + `toEqual` 2곳 원복. 원장 파일 형식 무변경이므로 데이터 마이그레이션 없음.

## 해소된 확인 항목 (15:47 재실측)
- findings → status 집계: `doctor-checks.js:270` `worstOf(findings…)` 확인 → §3.4·§4 를 "별도 `census` 키, loss>0 일 때만 WARN finding" 으로 확정.
- 원장 회전: `lib/runtime`·`lib/replay` 에 `rotat` 은 `lib/runtime/dashboard/server.mjs:386, :401`(대시보드 자체 로그 파일) 뿐. **원장 파일 회전은 없다.** `tests/replay/load.test.js:12`·`replay.test.js:11` 의 "rotated/rotation" 은 주석상의 가정이며 구현 0. census 의 "단일 파일" 전제는 현재 옳다 — 회전이 도입되면 §7-3 에 "이전 세그먼트 미집계" 를 추가해야 한다.

## 미확인
- 없음 (위 두 항목 해소). 단, 인용한 `route-hysteresis.js`·`escalation-controller.js`·`doctor.md`·`decision-events.js` 는 다른 팀원이 동시 편집 중(git status `M`, 15:4x) — 인용 줄번호는 15:3x-15:4x 워킹트리 스냅샷이다.
