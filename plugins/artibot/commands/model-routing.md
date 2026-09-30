---
description: (Artibot) 플러그인별 모델 라우팅 설정 — artibot·artibot-cowork 에이전트가 쓸 모델 티어를 작업 종류·단계·에이전트·플러그인 단위로 정한다. 인자 없이 부르면 선택 메뉴, 인자로는 조회·설정·검증·해석 (show/set/reset/validate/resolve/apply)
argument-hint: '[show|set|reset|validate|resolve|apply] ... (비우면 메뉴) e.g. "set task review sonnet"'
allowed-tools: [Read, Bash, Write, AskUserQuestion]
toolset: meta
---

# /model-routing

플러그인(`artibot` · `artibot-cowork`)별로 에이전트가 쓸 모델 티어를 사용자가 정한다. **설정은 리더가 스폰할 때 넘겨야만 효과가 있다 — 강제 훅은 없다.**

- **인자 없이** 부르면 선택 메뉴로 동작한다(§8) — 무엇을 바꿀지 고르고, 항목을 한 번에 답한 뒤, 미리 보기를 확인하고 적용한다. **현재 표만 보려면 `show` 를 명시한다.**
- 인자가 있으면 지금까지처럼 CLI 서브커맨드로 넘긴다(§2).

> 호스트 내장 `model` 슬래시 커맨드(지금 세션의 모델을 바꾼다)와는 다르다. 이 커맨드는 세션 모델을 건드리지 않고, 서브에이전트 스폰에 쓸 값만 정한다.

실제 동작은 결정적 CLI `scripts/model-routing/model-routing.mjs` 가 전부 한다. 이 문서는 그 CLI 를 Bash 로 부르고 출력을 그대로 전달하는 방법만 적는다. 판정 규칙을 여기서 다시 계산하지 마라.

## 1. CLI 경로 찾기 (한 번만)

`CLAUDE_PLUGIN_ROOT` 는 Bash 에서 빈 값일 수 있다(`commands/split.md` 2026-08-27 실측). 그래서 플러그인 캐시(최신 버전부터) → 마켓플레이스 사본 순으로 폴백한다. `~/.claude/artibot` 전역 사본은 쓰지 않는다 — 거기에는 `agents/` 가 없어 CLI 가 에이전트 목록을 못 읽는다.

```
Bash: MR=""; C="$HOME/.claude/plugins/cache/artibot/artibot"; S="scripts/model-routing/model-routing.mjs"; if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/$S" ]; then MR="$CLAUDE_PLUGIN_ROOT/$S"; fi; if [ -z "$MR" ]; then for v in $(ls -1 "$C" 2>/dev/null | sort -t. -k1,1nr -k2,2nr -k3,3nr); do if [ -f "$C/$v/$S" ]; then MR="$C/$v/$S"; break; fi; done; fi; if [ -z "$MR" ]; then for m in "$HOME"/.claude/plugins/marketplaces/*/plugins/artibot; do if [ -f "$m/$S" ]; then MR="$m/$S"; break; fi; done; fi; if [ -n "$MR" ]; then echo "$MR"; else echo "model-routing CLI not found"; fi
```

- 경로가 나오면 이후 모든 호출에 **그 경로를 그대로** 쓴다: `node "<경로>" <서브커맨드> ...`
- `model-routing CLI not found` 이면 CLI 를 찾지 못한 것이다 — 설치본이 이 커맨드보다 오래됐거나 설치 경로가 다르다. 그대로 전하고 `/update` 를 안내한 뒤 멈춘다.

## 2. 인자 해석

`$ARGUMENTS` 가 비어 있으면 §8 메뉴 모드다(`show` 가 아니다). 첫 단어가 `show|set|reset|validate|resolve|apply` 면 인자를 **그대로** CLI 에 넘긴다. 자연어("doc-updater 를 sonnet 으로")면 아래 형태로 옮긴 뒤 실행하고, 실행한 명령줄을 사용자에게 보여 준다.

| 서브커맨드 | 하는 일 |
|---|---|
| `show [--plugin artibot\|artibot-cowork\|all] [--role build\|review] [--task <class>] [--json]` | 에이전트마다 frontmatter · 출하값 · 사용자 override · 실효값[출처/강등 사유] · host path · 작업 종류(기본 작업 종류가 없으면 `-`, JSON 은 `task: null`)를 표로. `--task <class>` 는 행 필터가 아니다 — 모든 행을 "그 작업 종류로 스폰하면" 으로 계산한다(행 실효값 = `resolve <agent> --task <class>`). 한 종류의 에이전트만 보려면 `--json` 의 행별 `task` 나 `tasks[].agents` 로 거른다. `--json` 은 행별 `task` 와 최상위 `tasks[]`(종류별 에이전트 목록·플러그인별 override)를 준다 |
| `set agent <plugin:name> <tier> [--dry-run]` | 에이전트 하나 |
| `set task <class> <tier> [--plugin artibot\|artibot-cowork\|all] [--dry-run]` | 작업 종류 하나(§7). `--plugin` 기본값은 `all`(두 플러그인에 같은 값) |
| `set phase <build\|review> <tier> [--dry-run]` | artibot 전용 phase 값. 리더가 `--role` 로 해석할 때만 적용. 작업 종류 설정이 있으면 그것이 이긴다(agent > task > phase) — artibot 30종은 전부 기본 작업 종류가 있으므로, `set task` 를 준 종류의 에이전트에는 phase 값이 닿지 않는다 |
| `set plugin <artibot\|artibot-cowork> <tier> [--dry-run]` | 플러그인 기본값 |
| `reset agent <plugin:name> \| task <class> [--plugin …] \| phase <build\|review> \| plugin <name> \| --all [--dry-run]` | override 제거 |
| `apply <file.json> [--dry-run]` | 여러 변경을 한 번에(메뉴가 쓴다, 형식은 §8 ④). 전부 검증한 뒤 한 번만 쓴다 — 하나라도 틀리면 아무것도 안 쓰고 exit 1, stderr 에 틀린 change 마다 `change <i>: <why>` 한 줄 |
| `validate [--json]` | 파일 스키마 · 미지 에이전트 · 강등되는 설정 · `needs-spawn-param` 목록 |
| `validate --live [--since <epoch-ms\|ISO 시각>] [--cwd <리포 루트>] [--json]` | 설정이 실제 스폰에 쓰였는지 원장으로 관측한다(원장은 읽기만 한다). `route.bound` 와 `usage.receipt` 를 짝지어 에이전트마다 기대 티어(지금의 출하 config·override 로 계산)와 실제로 서빙된 티어를 비교해 `honored`·`unhonored`·`unmeasured` 로 센다. 텍스트 출력은 읽은 원장(`ledger:` 줄, 없으면 `ledger absent: <경로> — nothing to judge`) · 분모 · 비율 표(`n/d`, 분모 0 이면 `null (denominator 0)`) · 판정과 미측정 사유 집계 · `unhonored` 행마다 한 줄 · `caveat:` 3줄이다. `--json` 은 같은 보고를 행별 `rows[]` 까지 준다. `--since` 는 숫자만이면 epoch 밀리초, 아니면 `Z`·`±HH:MM` 이 붙은 ISO 시각만 받는다(날짜만이면 exit 2). `--cwd`(기본 현재 디렉터리)에는 리포 루트를 넘긴다. `--since`·`--cwd` 는 `--live` 전용이다(없이 쓰면 exit 2). 원장이 없거나 `unhonored` 가 있어도 exit 0 — 관측이지 검증 실패가 아니다 |
| `resolve <plugin:name> [--role build\|review] [--task <class>]` | stdout 에 티어 한 단어만 — 리더가 스폰에 붙일 값. `--task` 가 없으면 그 에이전트의 기본 작업 종류(§7)를 쓰고, 기본 작업 종류가 없는 에이전트는 task 층을 건너뛴다. 명시한 `--task` 는 기본 작업 종류가 없는 에이전트에도 적용된다. `--task classify`·`--task status` 는 사용자 설정이 없으면 출하 canary 가 opus 대신 저가 티어로 푼다 — 단 `--role review` 스폰과 기본 작업 종류가 review·architecture 인 에이전트는 opus 그대로다(§7) |

- `<tier>` 는 `haiku|sonnet|opus`. 별칭(`deep-async` 등)은 받지 않는다. `<class>` 는 §7 의 8개뿐이다 — 그 밖은 `unknown task: <x> (expected …)` (exit 2).
- `set`/`reset` 의 `--plugin` 은 `task` 스코프에서만 받는다. `set agent`·`set phase`·`set plugin`(과 같은 `reset`)에 붙이면 `unknown flag: --plugin` (exit 2). `show --plugin` 은 표 범위를 고르는 별개 플래그다.
- 우선순위: 사용자 agent > 사용자 task > 사용자 phase(artibot 만) > 사용자 plugin 기본값 > 출하 canary(`classify`·`status` 만, 검수·설계 스폰은 제외, §7) > 출하값. 작업 종류 단의 출처 이름은 `override-task`, 출하 canary 는 `canary-task`(사용자 override 가 아니라서 `override` 열이 비어 있다). 작업 종류 설정이 있으면 같은 에이전트의 단계(구현/검수) 설정은 가려진다. 마지막에 fable 게이트와 `FABLE_DENYLIST` 가 적용돼 어떤 사용자 설정도 그것을 넘지 못한다.
- `validate --live` 판정 한계: 기대 티어는 원장 행의 `action_class` 가 아니라 **에이전트의 기본 작업 종류(§7)** 로, 단계(role) 없이 계산한다 — `resolve --task` 로 다른 종류를 넘겼거나 `--role` 로 단계 설정을 받아 스폰한 행은 `unhonored` 로 읽힐 수 있다(출력의 세 번째 `caveat:` 줄).
- 모든 서브커맨드는 `--plugin-root <dir>` · `--cowork-root <dir>` 도 받는다(다른 설치본을 볼 때만).
- 종료 코드: `0` 성공 · `1` 거부/검증 오류(아무것도 안 씀) · `2` 사용법 오류(미지 서브커맨드·플래그·티어·에이전트·작업 종류; stderr 한 줄, 아무것도 안 씀). `--help` 는 없다(`unknown subcommand: --help`, exit 2) — 사용법은 이 표와 CLI 파일 머리 주석에 있다.
- 0 이 아니면 stderr 를 **그대로** 보여 준다. 추측한 인자로 재시도하지 마라.

### 예시

```
/model-routing                          ← 인자 없음 = 선택 메뉴(§8)
/model-routing show                     ← 현재 표는 show 를 명시해야 나온다
/model-routing show --plugin artibot-cowork
/model-routing show --role review
/model-routing show --task implement     ← 필터 아님: 모든 행을 implement 로 스폰할 때의 실효값
/model-routing set agent artibot:doc-updater sonnet
/model-routing set agent artibot-cowork:planner haiku --dry-run
/model-routing set task review sonnet
/model-routing set task explore haiku --plugin artibot --dry-run
/model-routing set phase review sonnet
/model-routing set plugin artibot-cowork sonnet
/model-routing reset agent artibot:doc-updater
/model-routing reset task review
/model-routing reset --all
/model-routing validate
/model-routing validate --live          ← 설정이 실제 스폰에 쓰였는지 원장으로 관측(읽기만)
/model-routing validate --live --since 2026-09-28T00:00:00+09:00 --json
/model-routing resolve artibot:code-reviewer --role review
/model-routing resolve artibot:doc-updater --task review
```

## 3. 에이전트 이름은 반드시 `<plugin:name>`

두 플러그인이 에이전트 이름을 공유한다 — cowork 12종 중 10종이 artibot 에도 같은 이름으로 있다(`case-study-writer`·`long-form-writer` 만 cowork 전용). 출하 정책 리졸버는 `artibot-cowork:` 접두사를 벗겨 **본체 에이전트의 정책으로 답하므로**, 저장 키를 플러그인별로 나누지 않으면 한쪽 설정이 다른 쪽으로 샌다. 그래서:

- 설정은 `plugins.artibot.agents` 와 `plugins["artibot-cowork"].agents` 에 따로 저장된다. `artibot-cowork:planner` 에 준 값은 `artibot:planner` 에 닿지 않는다(반대도 같다).
- CLI 는 비한정 이름을 **항상** 거부한다(exit 2). 두 플러그인에 다 있으면 `ambiguous agent name 'planner': it exists in artibot and artibot-cowork — use artibot:planner or artibot-cowork:planner`, 한쪽에만 있으면 `... — use artibot:architect` 처럼 한정 이름을 제안한다.
- 제안이 하나뿐이면 그 한정 이름으로 다시 실행해도 된다(바꾼 명령줄을 보여 줄 것). **둘이면 추측하지 말고 사용자에게 어느 플러그인인지 묻고 멈춘다.**
- cowork 행은 artibot-cowork 플러그인이 artibot 옆에 설치돼 있을 때만 나온다. 없으면 `artibot-cowork: unavailable:roster-not-found` 이고, cowork 이름에 대한 `set`/`resolve` 는 exit 2 다.

## 4. 적용 방식 — 리더가 넘긴다 (강제 훅 없음)

- 호스트는 플러그인 에이전트를 그 에이전트 frontmatter 의 `model:` 로 띄운다. 이 설정이 스폰에 닿는 경로는 **Agent 도구의 `model` 파라미터 하나뿐**이다.
- 리더는 스폰 직전 `resolve <plugin:name> [--role build|review]` 를 돌리고, 그 출력 한 단어를 Agent 도구의 `model` 파라미터로 넘긴다. `--role` 은 그 스폰의 phase(구현 = `build`, 검수 = `review`)에 맞춘다.
- `resolve` 는 에이전트의 기본 작업 종류(§7)를 자동으로 반영한다. 그 스폰의 실제 작업이 기본과 다르면(예: `doc-updater` 에게 검수를 맡김) `--task <class>` 를 붙인다.
- **의도 판별·라우팅(`classify`)이나 이미 있는 상태를 읽어 보고하는(`status`) 스폰은 `--task classify` / `--task status` 를 붙인다.** 어느 에이전트도 이 두 종류가 기본이 아니라서, 붙이지 않으면 출하 canary(저가 티어)가 닿지 않고 opus 그대로다(§7). 붙여도 **검수·설계 스폰에는 canary 가 닿지 않는다**: `--role review` 를 함께 준 스폰, 그리고 기본 작업 종류가 review·architecture 인 에이전트(code-reviewer · architect · planner …)는 `--task` 가 무엇이든 opus 그대로다(§7).
- **리더가 넘기지 않으면 설정은 아무 효과가 없다.** 이를 막거나 채워 넣는 훅은 없다. 사용자에게 이 사실을 숨기지 마라.
- `show` 의 host path 열: `frontmatter` = 실효값이 frontmatter 와 같아 넘길 것이 없다. `needs-spawn-param` = 리더가 `resolve` 값을 넘길 때만 실제가 된다. `--role` 없는 `show`(와 `validate` 의 `needs-spawn-param` 목록)는 역할 없이 계산하므로, phase 설정의 효과는 `show --role build|review` 로 본다.

## 5. fable

- 출하 config 의 fable 게이트가 꺼져 있는 동안 `fable` 은 설정할 수 없다: `unknown tier: fable (expected haiku|sonnet|opus) — the fable gate is off in the shipped config` (exit 2). `set task … fable` 도 같은 문구·같은 exit 로 거부된다.
- 이미 파일에 있는 fable 값(게이트가 켜져 있던 때 저장했거나 손으로 쓴 값)은 지워지지 않고 **읽을 때 opus 로 강등된다**. `show` 는 `opus [override-agent/fable-gate]`, `validate` 는 `WARN  artibot:<name>: fable demoted to opus (fable-gate)` 로 알린다.
- `FABLE_DENYLIST` 에이전트(현재 `security-reviewer`)는 게이트와 무관하게 fable 이 불가하다 — 사유 `denylist`. 게이트가 켜져도 fable 은 출하 allowlist 에 있는 artibot 에이전트만 받고, cowork 에이전트는 항상 강등된다.

## 6. 저장 위치와 쓰기

- 파일: `~/.claude/artibot/model-routing.json` (Windows `%USERPROFILE%\.claude\artibot\model-routing.json`). CLI 출력의 `overrides:` / `written:` 줄이 실제 경로다 — 그것을 믿어라. 작업 종류 값은 `plugins.<plugin>.tasks` 에 저장된다(이 키가 없는 기존 파일도 그대로 읽힌다).
- 플러그인의 `artibot.config.json` 은 건드리지 않는다. 그 파일은 설치·업그레이드마다 덮이므로 사용자 설정은 이 별도 파일에 있어야 살아남는다.
- `set`/`reset`/`apply` 는 before→after **실효값** 차이(`effective changes (N):`)를 찍는다. 줄은 에이전트마다 `  <plugin:agent>: <전> → <후>`(역할마다 다르면 `[role=<none|build|review>]`)이고, 저장된 작업 종류 값이 바뀐 종류에는 `  <plugin> [task=<class>]: <전> → <후> for <n> of <m> agent(s) not defaulting to <class>` 가 붙는다 — 그 종류가 기본이 아닌 에이전트 m명을 `resolve --task <class>` 로 풀었을 때의 변화이며(역할마다 다르면 `[task=<class> role=<none|build|review>]`), 기본인 에이전트가 없는 `status`·`classify` 설정은 이 줄로만 보인다. 출하 canary 가 거는 `classify`·`status`(§7)는 저장값이 안 바뀌어도 실효값이 바뀌면 같은 줄로 보인다(예: `set plugin artibot opus`, `set agent artibot:doc-updater opus` — 기본 작업 종류 줄은 opus → opus 라 없어도 `[task=classify role=none]: sonnet → opus …` 와 `role=build` 줄이 나온다. canary 는 검수 단계에 닿지 않으므로 `role=review` 줄은 opus → opus 라 없고, 기본 종류가 review·architecture 인 에이전트는 어느 단계든 opus 라 세지 않는다). 그다음 기존 파일을 `.bak` 으로 복사한 뒤 원자적으로 쓴다(`written: <경로>`). `apply` 는 변경이 여러 개여도 `.bak` 과 쓰기가 한 번이다. 파일이 없을 때 `reset` 은 `nothing to reset` 으로 끝난다.
- `--dry-run` 은 같은 차이를 찍고 `dry-run: nothing written (<경로>)` 로 끝난다 — 파일을 만들지도 바꾸지도 않는다. 여러 에이전트가 바뀌는 `set task`·`set phase`·`set plugin` 은 먼저 `--dry-run` 으로 보여 주기를 권한다.
- 파일이 손상되면(JSON 오류·스키마 위반) `show`/`resolve` 는 stderr 에 `... IGNORED, shipped values shown` 경고를 내고 출하값으로 답한다(`resolve` 는 exit 0 이므로 **경고를 꼭 전달**한다). `set`/`reset`(`--all` 포함)은 `refusing to write ... Fix or remove it by hand; nothing was changed.` 로 거부한다(exit 1). **파일을 대신 지우거나 고치지 마라** — 경로와 오류를 보여 주고 사용자가 직접 고치거나 지우게 한다(직전 쓰기 이전 내용은 `.bak` 에 있다).

## 7. 작업 종류 (task)

정본은 `lib/routing/action-classifier.js` 의 `ACTION_CLASSES`(8개)와 `AGENT_ACTION_CLASS`(에이전트 → 기본 작업 종류)다. 아래 표는 사람이 읽기 위한 사본이다 — 어긋나면 `show --json` 의 `tasks[].agents` 가 맞다.

| 작업 종류 | 뜻 | 이 종류가 기본인 에이전트 (`AGENT_ACTION_CLASS`) |
|---|---|---|
| `classify` | 의도 판별·라우팅, 산출물 없음 | 없음 — `resolve --task classify` 를 명시할 때만 적용(출하 canary 가 저가 티어로 푼다) |
| `status` | 이미 있는 상태를 읽어 보고 | 없음 — `resolve --task status` 를 명시할 때만 적용(출하 canary 가 저가 티어로 푼다) |
| `explore` | 범위가 불확실한 조사·측정(읽기 위주) | repo-benchmarker · investigator · data-analyst |
| `edit-routine` | 기계적이고 범위가 정해진 쓰기 | doc-updater · refactor-cleaner |
| `implement` | 여러 파일에 걸친 코드·산출물 생산 | backend-developer · frontend-developer · typescript-pro · tdd-guide · mcp-developer · devops-engineer · e2e-runner · ad-specialist · content-marketer · presentation-designer |
| `complex-debug` | 고치기 전에 원인부터 진단 | build-error-resolver · performance-engineer |
| `architecture` | 코드 전에 내리는 설계·계획 결정 | architect · planner · llm-architect · orchestrator · marketing-strategist |
| `review` | 이미 있는 작업을 판정 | code-reviewer · spec-reviewer · quality-reviewer · security-reviewer · database-reviewer · auditor · cro-specialist · seo-specialist |

- artibot 30종은 전부 매핑돼 있다. cowork 는 같은 이름 10종이 같은 종류를 따르고, `case-study-writer`·`long-form-writer` 는 매핑이 없어 기본 작업 종류가 없다(`show` 의 task 열 `-`, JSON `task: null`, `tasks[].agents` 에서 빠짐). 그 둘에는 `resolve --task <class>` 를 명시할 때만 작업 종류 설정이 닿는다 — 메뉴에서는 "종류 없음" 후보나 플러그인 기본값으로 설정한다.
- 작업 종류 → 티어의 출하값은 **`classify`·`status` 둘뿐**이다(CA-02): 출하 canary(`artibot.config.json` 의 `routing.canary` — `actionClasses: [classify, status]`, `tier: sonnet`)가 `resolve --task classify|status` 를 opus 대신 저가 티어로 푼다. 사용자 설정(agent·task·phase·plugin 기본값 중 어느 것이든)이 있으면 그것이 이기고, canary 는 자리를 **낮출 때만** 답한다 — 이미 그 티어 이하인 cowork 에이전트는 그대로 두고, 검수·설계 스폰은 건드리지 않는다(오너 규칙: 설계·검수 = opus, 구현 = sonnet): `--role review` 를 준 스폰, 기본 작업 종류가 `review`·`architecture` 인 에이전트(위 표), canary 자신의 보호 목록(`CANARY_PROTECTED_AGENTS`, 지금은 `security-reviewer` — `FABLE_DENYLIST` 와 별개 목록이다)는 opus 그대로다. 이 제외는 canary 만 막는다 — 사용자 설정은 이 스폰들에도 닿는다. `show --task classify` 행의 `source` 가 `canary-task` 이면 이 경로다. 끄려면 `routing.canary.actionClasses` 를 `[]` 로 되돌린다(1키 롤백). 스폰에 닿으려면 리더가 `--task classify|status` 를 붙이고 그 출력을 Agent 의 `model` 로 넘겨야 한다(§4).
- 나머지 여섯 종류는 출하값이 따로 없다(`ACTION_CLASS_TIERS` 는 관측용 권고표로 라우팅에 적용되지 않는다). 작업 종류 설정이 없으면 그 아래 층(phase → plugin → 출하값)으로 내려간다.

## 8. 메뉴 모드 (`$ARGUMENTS` 가 비었을 때)

호스트 내장 `mcp` 슬래시 커맨드의 목록 패널 같은 TUI 는 플러그인이 만들 수 없다. 그래서 `AskUserQuestion` 선택 메뉴를 단계별로 띄운다. 제약: **호출당 질문 ≤4 · 질문당 옵션 2~4 · 사용자는 언제나 "Other" 로 자유 입력할 수 있다.** 메뉴는 답을 모아 `apply` 한 번으로 넘길 뿐이고, 판정은 여전히 CLI 가 한다.

**① 현재 값 읽기** — §1 경로로 `show --json` 을 돌린다. 이후 모든 "현재" 표시는 이 출력에서 읽는다(행 `agent`·`task`·`shipped`·`effective`·`source`, 최상위 `tasks[]`·`phases[]`). exit 가 0 이 아니거나 stderr 에 경고가 있으면 그대로 보여 주고 멈춘다(손상 파일이면 쓰기도 거부된다, §6).

**② 범위 고르기** — 질문 1개. 네 범위는 동등한 선택이라 권장 표기가 없다.

```
AskUserQuestion(
  question="무엇을 설정할까요?",
  options=[
    "작업 종류별 — 8개 종류(§7)마다 티어",
    "단계별 — artibot 구현(build) · 검수(review)",
    "에이전트별 — 작업 종류를 고른 뒤 그 종류 에이전트만",
    "플러그인 기본값 — artibot · artibot-cowork"
  ]
)
```

Other 입력: "현재 보기"·"show" → `show` 출력을 보여 주고 끝. "초기화"·"reset" → `reset --all --dry-run` 을 보여 주고 ④의 확인 질문을 거쳐 `reset --all`. overrides 파일이 없어 dry-run 이 `nothing to reset` 으로 끝나면 확인 질문 없이 끝낸다. 그 밖의 문장은 §2 자연어 규칙으로 옮긴다.

**③ 항목을 한 번에 묻기** — 각 질문의 옵션은 `haiku` · `sonnet` · `opus` · `유지 (현재 <값>)` 4개다. 질문 문구에 **현재 실효값과 출처**를 적는다(예: `artibot:doc-updater — 현재 opus [shipped]`). 권장: 그 항목에 걸린 행들의 `shipped` 가 한 값일 때만 — 현재 값이 출하값과 같으면 `유지` 를, 다르면 그 출하 티어를 첫 옵션으로 올리고 label 끝에 ` (권장)` 을 붙인다. 출하값이 없거나 행마다 다르면 권장 표기를 하지 않는다. 작업 종류 스코프에서 비교하는 "현재 값" 은 그 종류 행들의 `effective` 다. 현재 값이 task override 때문에 출하값과 다르면 출하 티어를 권장으로 두지 말고 Other "초기화" 를 안내한다(출하 티어를 고르면 초기화가 아니라 새 override 가 생긴다). Other 로 "초기화" 를 받으면 그 항목은 reset(`tier: null`)이다. Other 입력이 티어 단어(`haiku|sonnet|opus`)도 "초기화" 도 아니면(예: `fable`) 그 항목은 유지로 두고 그렇게 했다고 알린다.

- **작업 종류별**: 질문 4개씩 2회 — ① `classify` · `status` · `explore` · `edit-routine`, ② `implement` · `complex-debug` · `architecture` · `review`. 현재 값 = `tasks[]` 의 플러그인별 override(없으면 "미설정") + 그 종류 에이전트들의 실효값 요약(예: `opus×10`). 매핑된 에이전트가 없는 종류는 문구에 그 사실을 적는다. `classify`·`status` 는 "미설정" 이어도 opus 가 아니다 — 출하 canary(§7)가 저가 티어로 푼다. 이 두 종류는 그 사실을 문구에 적고, 실효값은 `show --json --task <class>` 행의 `effective`(`source: canary-task`)에서 읽는다. 플러그인은 `all`(`set task` 기본값과 같다) — 한 플러그인만 바꾸려면 인자 모드 `set task <class> <tier> --plugin <name>` 을 안내한다.
- **단계별**: 1회, 질문 2개(`build` · `review`). 현재 값 = `phases[].override`(없으면 "미설정"), 권장 근거 = `phases[].shipped`. artibot 전용이고 리더가 `--role` 로 해석할 때만 적용된다는 것, 그리고 작업 종류 설정이 있는 에이전트에는 phase 값이 닿지 않는다는 것(agent > task > phase — artibot 30종은 전부 기본 작업 종류가 있다)을 문구에 적는다.
- **에이전트별**: 30명은 한 화면에 들어가지 않는다. (a) 플러그인 질문(artibot / artibot-cowork — cowork 가 `unavailable` 이면 묻지 않고 artibot). (b) 작업 종류 질문 — 좁히기는 ①의 행별 `task` 필드로 한다(`show --task` 는 필터가 아니다, §2). 후보는 그 플러그인 행 중 `task` 가 그 종류인 행이 있는 종류(§7 순서)이고, `task: null` 인 행이 있으면(cowork 의 `case-study-writer`·`long-form-writer`) "종류 없음" 도 후보다. 옵션 설명에 에이전트 수를 적는다. 후보가 4개를 넘으면 2단으로 나눈다: 앞 3개 + "다른 종류 보기" → 다음 호출에서 나머지(또 넘치면 같은 식으로). Other 로 종류 이름이나 `<plugin:name>` 을 직접 받으면 그 종류·그 에이전트로 바로 간다. "종류 없음" 에이전트는 플러그인 기본값 범위로도 설정된다는 것을 옵션 설명에 적는다. (c) 고른 종류의 에이전트를 질문 4개씩 한 호출에 묻는다(10명이면 4 · 4 · 2 로 3회). 권장 근거는 각 행의 `shipped`.
- **플러그인 기본값**: 1회, 질문 2개(artibot · artibot-cowork; cowork 가 `unavailable` 이면 1개). 현재 값 = `source` 가 `override-plugin` 인 행의 `effective`. 그런 행이 0개면 `overridesStatus` 가 `absent`(파일 없음)일 때만 "미설정" 이고, 아니면 `show --json` 의 `file` 경로를 Read 해 `plugins.<plugin>.default` 를 보여 준다. 읽을 수 없으면 "확인 불가(상위 층에 가려짐)" 로 표시한다.

**④ 미리 보기와 확인** — `유지` 답은 빼고 `apply` 입력을 임시 파일(세션 스크래치 디렉터리, 없으면 OS 임시 디렉터리 — 리포 안이나 사용자 설정 파일 옆에 두지 않는다)에 Write 로 쓴다. 바뀐 것이 0개면 `apply` 를 부르지 않고 "바뀐 것 없음" 으로 끝낸다.

```json
{ "changes": [
  { "scope": "task",  "plugin": "all",     "key": "review",      "tier": "sonnet" },
  { "scope": "phase", "plugin": "artibot", "key": "build",       "tier": "opus" },
  { "scope": "agent", "key": "artibot:doc-updater", "tier": null },
  { "scope": "plugin", "plugin": "artibot-cowork", "tier": "sonnet" }
] }
```

- `scope: agent` — `key` = `<plugin:name>`(필수, 행의 `plugin` 과 `agent` 를 `:` 로 잇는다). `plugin` 은 생략하거나 key 의 플러그인과 같아야 한다.
- `scope: task` — `key` = 작업 종류(필수). `plugin` ∈ `artibot|artibot-cowork|all`, 생략하면 `all`.
- `scope: phase` — `key` = `build|review`(필수). `plugin` 은 생략하거나 `artibot` 만.
- `scope: plugin` — `key` 는 생략(값이 있으면 거부). `plugin` ∈ `artibot|artibot-cowork`(필수, `all` 불가).
- `tier` = `haiku|sonnet|opus`, `null` 은 reset. 에이전트별에서 두 플러그인을 다 바꾸면 한정 이름이 다르므로 change 가 자연히 둘로 나뉜다(§3).

`apply <파일> --dry-run` 을 돌려 stdout(`effective changes (N):` …)을 그대로 보여 준다. exit 가 0 이 아니면 stderr 를 그대로 보여 주고 멈춘다 — exit 1 이면 `change <i>: <why>` 줄들(틀린 change 마다 한 줄, 아무것도 쓰지 않음)이다. 추측으로 고쳐 다시 돌리지 마라. `apply <파일>` 본실행이 exit 1 이어도 같다. dry-run 결과가 `effective changes (none):` 이면(에이전트 줄도 `[task=…]` 줄도 없다 — 같은 값을 다시 골랐거나, 지금 실효값과 같은 티어를 골랐거나, 에이전트별 설정이 해당 에이전트를 전부 가렸다 — 각 에이전트의 기본 작업 종류 문맥과 저장값이 바뀐 작업 종류 문맥에서 실효값이 바뀌지 않는다) 확인 질문 없이 "실효값 변화 없음" 으로 끝낸다. `[task=…]` 줄도 N 에 들어가므로 `status`·`classify` 선택은 확인 질문으로 간다(예: `  artibot [task=status]: sonnet → haiku for 29 of 30 agent(s) not defaulting to status` — 출하 canary 가 시작값이다). 그 밖이면 확인을 묻는다:

```
AskUserQuestion(
  question="위 변경을 적용할까요?",
  options=[
    "적용 (권장) — apply 를 한 번 실행해 전부 쓴다",
    "취소 — 아무것도 쓰지 않는다"
  ]
)
```

**⑤ 적용** — "적용" 이면 `apply <파일>` 을 돌리고 stdout 을 그대로 보여 준 뒤, 아래 "출력" 의 `needs-spawn-param` 안내 한 줄을 붙인다. "취소" 면 아무것도 실행하지 않는다.

## 출력

CLI stdout 을 코드블록으로 그대로 보여 준다(표를 다시 그리지 않는다). `set`/`reset`/`apply` 뒤에는 한 줄을 덧붙인다: 바뀐 에이전트가 `needs-spawn-param` 이면 "리더가 스폰 때 `resolve` 값을 넘겨야 적용된다".

## Next Steps

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 현재 실효값 확인 | `/model-routing show` | override 가 어느 행에 걸렸는지 |
| 2 | 설정 검증 | `/model-routing validate` | 강등·미지 에이전트·`needs-spawn-param` 목록 |
| 3 | 되돌리기 | `/model-routing reset --all` | 출하값으로 복귀 |
