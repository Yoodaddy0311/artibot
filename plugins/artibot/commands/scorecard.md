---
description: (Artibot) 기능 완성도 스코어카드 — 기능 영역을 도출해 file:line 증거와 함께 0~100 채점하고 스냅샷 저장, 작업 전후를 "작업 전·작업 후·상승폭·남은 갭" 표로 비교. 트리거 "기능 완성도", "얼마나 남았", "진행률 스코어카드", "작업 전후 비교", "기능별 점수", "완성도 평가", "feature scorecard"
argument-hint: '[--baseline|--diff|--areas <n>|--session [id]|--routing|--compare|--mission <id>]'
allowed-tools: [Read, Bash, Grep, Glob]
---

# /scorecard

기능/프로젝트를 **영역별로 file:line 증거와 함께 0~100 채점**하고 스냅샷으로 남긴다. 작업 후 다시 채점하면 **작업 전 → 작업 후 → 상승폭 → 남은 갭**을 표로 보여준다. 핵심 원칙: **증거 없는 점수 금지** — 근거(구현 위치·테스트 수·통과 여부)가 없으면 그 영역은 `unverified`로 정직하게 표기된다(점수를 숨기지 않되 미검증임을 드러냄).

엔진: `lib/planning/scorecard.js` (순수/불변, 단일 `.artibot/scorecard.json`에 스냅샷 append). 외부 전송 없음 — 로컬 파일만.

## Arguments

`$ARGUMENTS` 파싱:
- (없음) 또는 `--baseline` → 기능 영역 채점 후 새 스냅샷 저장(첫 실행은 baseline).
- `--diff` → 최신 두 스냅샷을 작업 전후 표로 비교.
- `--areas <n>` → 도출할 영역 개수 힌트(기본 3~8 자동).
- `--session [id]` → **원장 fold** 세션 카드(§35). id 생략 시 현재 세션. 위 세 경로와 엔진·저장소가 다르다 — 아래 "세션/라우팅 카드" 절.
- `--routing` → **원장 fold** 라우팅 카드(§34 ROUTING). 스냅샷을 저장하지 않는다.
- `--compare` → **원장 fold** 스폰 비교 카드 — 라우터가 추천한 모델(`route.bound`) 대 실제 서빙 모델(`usage.receipt`). 스냅샷을 저장하지 않는다.
- `--mission <id>` → **원장 fold** 최종 미션 카드(§34). id 필수. **해당 미션의 `outcome.md` 가 실재할 때만** 렌더된다 — 아래 "미션 카드" 절.

## 워크플로우 (커맨드가 수행)

### 채점 (기본 / `--baseline`)
1. **영역 도출** — PRD/docs/라우트/모듈 구조에서 기능 영역을 3~8개 추출한다(예: 자막 추출·프레임 캡처·요약·에러 처리). 코드 대상이면 Grep/Glob/Read로 실제 구조를 먼저 파악한다. (분해 철학은 `/blindspot`과 동일 — 큰 덩어리를 쪼개 빠뜨림을 줄인다.)
2. **증거 채점** — 각 영역마다 **file:line 하드 증거를 수집**해 0~100 부여:
   - 구현 존재 여부(모듈/함수 위치), 테스트 수·통과 여부, TODO 밀도, 실제 검증 여부.
   - 예: `자막 추출 = 90 (watch-ingest.js:120 vtt 파싱 + 테스트 6개 통과)`.
   - **증거를 못 찾으면 evidence를 빈 배열로 두라** — 엔진이 `unverified`로 표기한다(거짓 점수보다 정직 표기).
3. **스냅샷 저장** — `{label, areas}` JSON을 **stdin으로** 엔진 CLI `add`에 넘긴다:
```
Bash: ENGINE="$HOME/.claude/artibot/lib/planning/scorecard.js"; [ -f "$ENGINE" ] || ENGINE="${CLAUDE_PLUGIN_ROOT:-}/lib/planning/scorecard.js"; if [ -f "$ENGINE" ]; then echo '<payload-json>' | node "$ENGINE" add; else echo "scorecard engine not found — run the full install (bash install.sh)"; fi
```
   `<payload-json>` = `{"label":"작업 전","areas":[{"name":"자막 추출","score":90,"evidence":[{"file":"watch-ingest.js:120","note":"vtt 파싱"}]},{"name":"프레임","score":0,"evidence":[]}]}` (한 줄 JSON). 엔진이 표를 렌더한다(첫 실행=baseline, 이후=직전 스냅샷과 diff).
4. 렌더된 표를 사용자에게 보여주고, "작업 후 다시 `/scorecard`로 채점하면 상승폭을 볼 수 있어요" 안내.

### 전후 비교 (`--diff`)
엔진 CLI `diff`가 **최신 2개** 스냅샷을 `diffSnapshots`→`renderScorecard`로 표 렌더한다. 특정 두 스냅샷을 지정하려면 `--from <label> --to <label>`. 스냅샷이 2개 미만이면 안내 메시지("비교하려면 스냅샷 2개가 필요합니다 — 현재 N개.").
```
Bash: ENGINE="$HOME/.claude/artibot/lib/planning/scorecard.js"; [ -f "$ENGINE" ] || ENGINE="${CLAUDE_PLUGIN_ROOT:-}/lib/planning/scorecard.js"; if [ -f "$ENGINE" ]; then node "$ENGINE" diff; else echo "scorecard engine not found — run the full install (bash install.sh)"; fi
```
특정 쌍 비교: `node "$ENGINE" diff --from "작업 전" --to "작업 후"`.
출력 표: `| 평가 항목 | 작업 전 | 작업 후 | 상승폭 | 남은 갭 |` — 남은 갭 열은 `▰▱` 게이지(작업 후 점수 기준 채움) + 남은 점수. 신규 영역은 작업 전 `—`, `unverified` 영역은 항목명에 `*` + 각주.

### 목록 (`list`)
```
Bash: ENGINE="$HOME/.claude/artibot/lib/planning/scorecard.js"; [ -f "$ENGINE" ] || ENGINE="${CLAUDE_PLUGIN_ROOT:-}/lib/planning/scorecard.js"; if [ -f "$ENGINE" ]; then node "$ENGINE" list; else echo "scorecard engine not found — run the full install (bash install.sh)"; fi
```

### 세션/라우팅 카드 (`--session` / `--routing`)

**위 세 경로(`--baseline`·`--diff`·`list`)와는 다른 엔진이고, 그 경로들은 이 절이 생겨도 한 바이트도 바뀌지 않는다.** 기존 경로는 사람이 매긴 기능 완성도 점수를 `.artibot/scorecard.json`에 append 한다. 이 절은 **원장(`.artibot/runtime/ledger.jsonl`)을 fold** 해서 §34/§35 카드를 만들고 **아무것도 저장하지 않는다** — 카드는 언제든 재생성 가능한 투영이고 정본은 원장 하나다(설계 §8.3-2).

엔진: `lib/scorecard/`(순수 — 파일·시계·난수 0). 원장을 읽는 것은 **호출자의 일**이고, 포트를 두 번 넘긴다: `lib/runtime/ledger.js#readAllEvents` → `lib/replay#loadReplay` → `lib/scorecard`. `lib/replay`·`lib/scorecard` 는 L2 라 L5 인 `lib/runtime` 을 직접 import 할 수 없다(`eslint.config.js` L2 블록).

```
Bash: node --input-type=module -e "
const { pathToFileURL } = await import('node:url');
const path = (await import('node:path')).default;
const root = process.env.CLAUDE_PLUGIN_ROOT;
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { readAllEvents } = await load('lib/runtime/ledger.js');
const { loadReplay } = await load('lib/replay/index.js');
const sc = await load('lib/scorecard/index.js');
const args = process.argv.slice(1);
const sid = args.find((a) => !a.startsWith('-')) ?? process.env.CLAUDE_SESSION_ID;
const replay = loadReplay(process.cwd(), { readEvents: readAllEvents });
const card = args.includes('--routing')
  ? sc.buildRoutingScorecard(replay)
  : sc.buildSessionScorecard(replay, { session_id: sid });
process.stdout.write(sc.renderScorecardMarkdown(card));
" -- $ARGUMENTS
```

- `readEvents` 포트를 빠뜨리면 `loadReplay` 가 **던진다**. 빈 배열로 기본값을 주면 배선 오류가 "아무 일도 없던 실행"과 같은 출력이 되므로 일부러 fail-closed 다.
- `--session` 은 `session_id` 가 **필수**다. 범위 없이 만들면 원장의 모든 세션이 한 스냅샷에 접혀 한 세션인 것처럼 라벨링된다(§32: Session Scorecard ≠ Mission Scorecard).
- `CLAUDE_SESSION_ID` 는 **폴백이지 보장이 아니다**(`commands/team.md` — 훅 payload 가 1순위, env 는 폴백). 비어 있으면 `buildSessionScorecard` 가 이유를 적어 던지므로, 그때는 `--session <id>` 로 id 를 직접 준다. 조용히 전 세션을 접는 대신 멈추는 쪽이 맞다.
- 경로 해석은 `node:url` 의 `pathToFileURL` 을 쓴다 — 손으로 만든 `file://` 문자열은 셸 인용 단계에서 백슬래시가 먹히고 **한글 경로를 퍼센트 인코딩하지 못한다**(위 `## 제약 / 안전` 의 Korean-path 주의가 이 경로에도 그대로 적용된다). 두 플래그 모두 이 스니펫 그대로 실행해 확인했다.
- 출력은 아래 `## 출력` 절의 TTY 테마 렌더가 **아니다**. 이 경로는 GFM 표 마크다운 **한 형태뿐**이며 TTY 여부로 분기하지 않는다 — 프로세스를 읽는 것은 효과이고 이 엔진은 순수(L2)다.
- **분모 0 인 지표는 `unmeasured` 로 렌더된다. `0%` 로 쓰지 않는다.** 훅 배선은 착지했으나(`lib/runtime/human-asked-record.js#recordHumanAsked` `human.asked`, `scripts/hooks/subagent-handler.js#observeRoute` `route.selected`, `lib/runtime/middleware/tasks.js#createTasksMiddleware` Mission Contract) **설치본에 반영되기 전까지 원장이 비어 전 지표가 `unmeasured`** 다. 훅은 `${CLAUDE_PLUGIN_ROOT}` 로 등록되므로(`hooks/hooks.json:38·182`) 마켓플레이스 설치본을 쓰는 경우 `npm run sync:local` 전까지 옛 사본이 돈다. 반영 후 스폰·차단·프롬프트부터 채워진다.
- 카드가 **못 보는 것**(Progress·Status·Elapsed·토큰/비용·Useful/Wasteful Switch·Switch Efficiency·Transition Cost/Time)은 각 모듈 헤더에 이유와 함께 적혀 있다. 지출 합산은 `lib/economics` 의 단일 답이고, 원장 gap 판정은 `/doctor` Check 8 의 일이다 — 여기서 두 번째 답을 만들지 않는다.

#### 스폰 비교 카드 (`--compare`)

`--compare` 는 **라우터가 추천한 모델(`route.bound`) 대 실제 서빙 모델(`usage.receipt`)** 을 접는다. 위 두 카드와 달리 replay 인덱스를 받지 않고 `lib/replay/spawn-outcome.js#joinSpawnOutcomes` 의 출력을 접는다 — 이 비교의 산술은 그 파일 한 곳에 있고, `scripts/ledger/route-compare.mjs` 가 쓰는 fold 와 **같은 것**이라 두 번째 답이 아니다. 이 경로도 **아무것도 저장하지 않는다**.

```
Bash: node --input-type=module -e "
const { pathToFileURL } = await import('node:url');
const path = (await import('node:path')).default;
const root = process.env.CLAUDE_PLUGIN_ROOT;
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { readAllEvents } = await load('lib/runtime/ledger.js');
const { joinSpawnOutcomes } = await load('lib/replay/index.js');
const { labelReplay } = await load('lib/replay/index.js');
const sc = await load('lib/scorecard/index.js');
const args = process.argv.slice(1);
const at = args.indexOf('--since');
let sinceMs = null;
if (at !== -1) {
  const text = String(args[at + 1] ?? '').trim();
  const numeric = /^-?[0-9]+$/.test(text);
  if (text === '' || (text.startsWith('-') && !numeric)) throw new Error('--since needs a value: ISO timestamp or epoch ms');
  sinceMs = numeric ? Number(text) : Date.parse(text);
  if (!Number.isFinite(sinceMs)) throw new Error('--since must be an ISO timestamp or epoch ms, got: ' + text);
}
const events = readAllEvents(process.cwd(), sinceMs === null ? {} : { since: sinceMs });
const since = sinceMs === null ? null : new Date(sinceMs).toISOString();
const card = sc.buildCompareScorecard(joinSpawnOutcomes(events), { since, replay: labelReplay(events) });
process.stdout.write(sc.renderScorecardMarkdown(card));
" -- $ARGUMENTS
```

- `--since <ISO|epoch ms>` 는 **리더 필터에 epoch ms 로** 걸고(`readAllEvents` 의 `filter.since`) 카드 라벨에는 ISO 로 넘긴다. 파싱할 수 없는 값도, **값이 아예 없는 `--since` 도** 조용히 무시하지 않고 메시지와 함께 중단한다 — 범위를 못 건 실행이 전 기간 실행과 같은 출력이 되면 안 된다. 그래서 분기가 `--since` **플래그의 존재**를 보고 값의 존재를 보지 않는다: 값으로 분기하면 `--compare --since` 가 조용히 전 기간 카드를 내는 fail-open 이 된다(실측 확인 후 수정). 스니펫이 `Date` 를 쓰는 것은 **호출자 쪽**이라 허용된다(순수성은 `lib/scorecard/` 의 계약이다).
- **비교 가능한 쌍이 0 이면 `unmeasured`** 다. `0%` 로 쓰지 않는다. 가격이 없는 쌍은 0 으로 합산하지 않는다 — `compare.cost` 의 **분모(비교된 쌍)에는 남고**, 분자(priced)와 버킷 합계에서만 빠져 `unpriced` 로 세어진다. 0 원으로 세면 측정된 바닥이 실제보다 낮아진다.
- `score` 행은 **항상 `unmeasured`**(source 가 null)다 — 원장에 **스폰 키로 점수를 쓰는 기록자가 없다**. 그리고 추천과 서빙이 일치한다는 것은 그 선택이 옳았다는 뜻이 아니다: 일치는 품질이 아니다.
- `fifo` 처럼 confidence allowlist **밖**에서 묶인 쌍은 비교에서 제외되고 `excluded_fifo` 로 보인다 — 제외는 선택이지 측정이 아니다.
- `compare.replay_label` 행은 `lib/replay/replay-label.js#labelReplay` 의 §46 충실도 라벨 분포(EXACT·PARTIAL·SIMULATED)다. 분모는 `actions`(PreToolUse `route.selected` 의 distinct `tool_use_id`)라 짝 모집단과 다르고, fold 와 **같은 `events`** 에서 접어 `replay:` 로 넘긴다 — 빠뜨리면 `buildCompareScorecard` 가 **던진다**(빠진 포트가 "라우팅된 Action 0" 과 같은 출력이 되면 안 된다). **EXACT 는 측정값이 아니라 구조적 0** 이다: `exact_reachable:false`, 사유 `one-action-one-run` — Action 하나는 런 하나에만 묶인다. `actions` 가 0 이면 `unmeasured` 다. 라벨은 생산자의 **대문자** 어휘이고 RouteBench 시나리오 `replay_mode` 의 소문자와 다른 필드다(EXACT↔exact · PARTIAL↔partial · SIMULATED↔simulation). `--since` 로 창을 좁히면 라벨 자체가 바뀐다 — 창 밖 바인드·영수증은 없는 것으로 읽혀 SIMULATED 가 된다(`replay-label.js` CANNOT SEE #3).
- 이 카드가 **못 보는 것**은 `lib/replay/spawn-outcome.js` 헤더의 CANNOT SEE 목록이 정본이다(고장인지 정책인지 · fifo 쌍의 정당성 · 멀티모델 런 · 중복 영수증 · 가격 없는 쌍의 비용). 여기에 복제하지 않는다 — 복제하면 두 목록이 갈린다.

#### 미션 카드 (`--mission <id>`)

`--mission` 은 **한 미션의 최종 카드(§34)** 를 접는다. 세션 카드(§35)와 축이 다르다 — 한 미션이 여러 세션에 걸칠 수 있고 그 역도 성립한다(§32). 이 경로도 **아무것도 저장하지 않는다**.

**`outcome.md` 가 없으면 카드도 없다.** 설계 §32~§35 가 "Final Scorecard 는 `outcome.md` 생성과 같은 트리거에서 렌더 — 파일이 없으면 스코어카드도 없다" 로 못박는다. `lib/scorecard/` 는 L2 순수라 파일을 볼 수 없으므로 **존재 확인은 호출부의 일**이고, 결과를 `outcome_present` 로 넘긴다. `buildMissionScorecard` 는 **리터럴 `true` 만** 받는다 — 옵션을 빠뜨린 호출은 통과가 아니라 거부다(빠뜨림이 통과가 되면 미완 미션마다 최종 카드가 서는 fail-open 이 된다).

```
Bash: node --input-type=module -e "
const { pathToFileURL } = await import('node:url');
const path = (await import('node:path')).default;
const { existsSync } = await import('node:fs');
const root = process.env.CLAUDE_PLUGIN_ROOT;
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { readAllEvents } = await load('lib/runtime/ledger.js');
const { loadReplay } = await load('lib/replay/index.js');
const { outcomeArtifactPath } = await load('lib/mission/index.js');
const sc = await load('lib/scorecard/index.js');
const args = process.argv.slice(1);
const at = args.indexOf('--mission');
const id = at === -1 ? '' : String(args[at + 1] ?? '').trim();
if (id === '' || id.startsWith('-')) throw new Error('--mission needs a mission id');
const outcome = outcomeArtifactPath(process.cwd(), id);
if (!existsSync(outcome)) throw new Error('no outcome.md at ' + outcome + ' — 파일이 없으면 스코어카드도 없다');
const replay = loadReplay(process.cwd(), { readEvents: readAllEvents });
const card = sc.buildMissionScorecard(replay, { mission_id: id, outcome_present: true });
process.stdout.write(sc.renderScorecardMarkdown(card));
" -- $ARGUMENTS
```

- **분모 0 인 지표는 `unmeasured`** 다. `0%` 로 쓰지 않는다. 그리고 `outcome.md` 생성은 **킬스위치 뒤**에 있다(`runtime.artifactLifecycle.enabled` 가 false 로 출하) — 그래서 지금 라이브에서 이 카드가 서는 횟수가 **0 인 것이 정답**이다. 이 경로가 착지했다는 것과 SH-20 이 done 이라는 것은 다른 진술이다.
- `--session`/`--routing` 과 달리 id 를 env 에서 폴백하지 않는다. 미션 id 는 `outcome.md` 경로의 일부라 틀린 id 는 조용한 빈 카드가 아니라 **존재 확인에서 멈춘다**.
- 카드가 **못 보는 것**(Result=`accepted` · Duration · Useful/Wasteful Switch · Switch Efficiency · Transition Cost/Time · Total Cost · Success@1 · CONTEXT 4행)은 `lib/scorecard/mission-scorecard.js` 헤더의 CANNOT SEE 목록이 정본이다. 여기에 복제하지 않는다 — 복제하면 두 목록이 갈린다. 다섯 행은 **카드에서 빠지지 않고** 영구 `unmeasured` 로 남는다: 부재가 "해당 없음"으로 읽히면 안 된다.
- 존재 확인은 파일이 **있다**는 것만 말한다. 내용이 미션과 맞는지, 비어 있지 않은지는 보지 않는다 — `outcome.md` 판독은 `lib/mission/outcome-artifact.js` 의 일이고 둘을 대조하는 주체는 아직 없다.

## 출력

- **터미널(TTY)**: 활성 테마 팔레트로 NEON THEMED 렌더 — 고정폭 정렬 + primary→accent truecolor 그라데이션 게이지 + ▲그린/▼레드 델타 + `평균` 요약. 테마는 `current-theme.json`(부재 시 neon-city).
- **파이프/리다이렉트(비-TTY)**: Claude가 파싱하는 GFM 파이프 표를 그대로 유지 — 자동 감지(`process.stdout.isTTY`).

## 제약 / 안전

- **증거 우선**: evidence 배열이 비면 그 영역은 `unverified`로 표기된다(점수는 저장하되 근거 없음을 드러냄 — claim-honesty).
- 점수는 0~100으로 clamp. 스냅샷은 단일 `.artibot/scorecard.json`에 **append**(비파괴 — 기존 스냅샷 보존).
- 모든 산출물은 로컬 `.artibot/`에만 저장. 외부 API·업로드 없음.
- 동적 import 시 Korean-path 주의(`plan.md`의 toFileUrl/pluginRoot 패턴 참조) — 위 스니펫은 `node <path>` 직접 실행이라 해당 없음.

## Next Steps

| # | 액션 | 설명 |
|---|------|------|
| 1 | `/scorecard --diff` | 이전 스냅샷과 상승폭 비교 |
| 2 | `/scorecard` | 개선 작업 후 재채점 |
