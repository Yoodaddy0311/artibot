---
description: (Artibot) 플러그인별 모델 라우팅 설정 — artibot·artibot-cowork 에이전트가 쓸 모델 티어를 사용자가 정하고 조회·검증·해석 (show/set/reset/validate/resolve)
argument-hint: '[show|set|reset|validate|resolve] ... e.g. "set agent artibot:doc-updater sonnet"'
allowed-tools: [Read, Bash]
toolset: meta
---

# /model-routing

플러그인(`artibot` · `artibot-cowork`)별로 에이전트가 쓸 모델 티어를 사용자가 정한다. **설정은 리더가 스폰할 때 넘겨야만 효과가 있다 — 강제 훅은 없다.**

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

`$ARGUMENTS` 가 비어 있으면 `show`. 첫 단어가 `show|set|reset|validate|resolve` 면 인자를 **그대로** CLI 에 넘긴다. 자연어("doc-updater 를 sonnet 으로")면 아래 형태로 옮긴 뒤 실행하고, 실행한 명령줄을 사용자에게 보여 준다.

| 서브커맨드 | 하는 일 |
|---|---|
| `show [--plugin artibot\|artibot-cowork\|all] [--role build\|review] [--json]` | 에이전트마다 frontmatter · 출하값 · 사용자 override · 실효값[출처/강등 사유] · host path 를 표로 |
| `set agent <plugin:name> <tier> [--dry-run]` | 에이전트 하나 |
| `set phase <build\|review> <tier> [--dry-run]` | artibot 전용 phase 값. 리더가 `--role` 로 해석할 때만 적용 |
| `set plugin <artibot\|artibot-cowork> <tier> [--dry-run]` | 플러그인 기본값 |
| `reset agent <plugin:name> \| phase <build\|review> \| plugin <name> \| --all [--dry-run]` | override 제거 |
| `validate [--json]` | 파일 스키마 · 미지 에이전트 · 강등되는 설정 · `needs-spawn-param` 목록 |
| `resolve <plugin:name> [--role build\|review]` | stdout 에 티어 한 단어만 — 리더가 스폰에 붙일 값 |

- `<tier>` 는 `haiku|sonnet|opus`. 별칭(`deep-async` 등)은 받지 않는다.
- 우선순위: 사용자 agent > 사용자 phase(artibot 만) > 사용자 plugin 기본값 > 출하값. 마지막에 fable 게이트와 `FABLE_DENYLIST` 가 적용돼 어떤 사용자 설정도 그것을 넘지 못한다.
- 모든 서브커맨드는 `--plugin-root <dir>` · `--cowork-root <dir>` 도 받는다(다른 설치본을 볼 때만).
- 종료 코드: `0` 성공 · `1` 거부/검증 오류(아무것도 안 씀) · `2` 사용법 오류(미지 서브커맨드·플래그·티어·에이전트; stderr 한 줄, 아무것도 안 씀). `--help` 는 없다(`unknown subcommand: --help`, exit 2) — 사용법은 이 표와 CLI 파일 머리 주석에 있다.
- 0 이 아니면 stderr 를 **그대로** 보여 준다. 추측한 인자로 재시도하지 마라.

### 예시

```
/model-routing
/model-routing show --plugin artibot-cowork
/model-routing show --role review
/model-routing set agent artibot:doc-updater sonnet
/model-routing set agent artibot-cowork:planner haiku --dry-run
/model-routing set phase review sonnet
/model-routing set plugin artibot-cowork sonnet
/model-routing reset agent artibot:doc-updater
/model-routing reset --all
/model-routing validate
/model-routing resolve artibot:code-reviewer --role review
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
- **리더가 넘기지 않으면 설정은 아무 효과가 없다.** 이를 막거나 채워 넣는 훅은 없다. 사용자에게 이 사실을 숨기지 마라.
- `show` 의 host path 열: `frontmatter` = 실효값이 frontmatter 와 같아 넘길 것이 없다. `needs-spawn-param` = 리더가 `resolve` 값을 넘길 때만 실제가 된다. `--role` 없는 `show`(와 `validate` 의 `needs-spawn-param` 목록)는 역할 없이 계산하므로, phase 설정의 효과는 `show --role build|review` 로 본다.

## 5. fable

- 출하 config 의 fable 게이트가 꺼져 있는 동안 `fable` 은 설정할 수 없다: `unknown tier: fable (expected haiku|sonnet|opus) — the fable gate is off in the shipped config` (exit 2).
- 이미 파일에 있는 fable 값(게이트가 켜져 있던 때 저장했거나 손으로 쓴 값)은 지워지지 않고 **읽을 때 opus 로 강등된다**. `show` 는 `opus [override-agent/fable-gate]`, `validate` 는 `WARN  artibot:<name>: fable demoted to opus (fable-gate)` 로 알린다.
- `FABLE_DENYLIST` 에이전트(현재 `security-reviewer`)는 게이트와 무관하게 fable 이 불가하다 — 사유 `denylist`. 게이트가 켜져도 fable 은 출하 allowlist 에 있는 artibot 에이전트만 받고, cowork 에이전트는 항상 강등된다.

## 6. 저장 위치와 쓰기

- 파일: `~/.claude/artibot/model-routing.json` (Windows `%USERPROFILE%\.claude\artibot\model-routing.json`). CLI 출력의 `overrides:` / `written:` 줄이 실제 경로다 — 그것을 믿어라.
- 플러그인의 `artibot.config.json` 은 건드리지 않는다. 그 파일은 설치·업그레이드마다 덮이므로 사용자 설정은 이 별도 파일에 있어야 살아남는다.
- `set`/`reset` 은 before→after **실효값** 차이(`effective changes (N):`)를 찍고, 기존 파일을 `.bak` 으로 복사한 뒤 원자적으로 쓴다(`written: <경로>`). 파일이 없을 때 `reset` 은 `nothing to reset` 으로 끝난다.
- `--dry-run` 은 같은 차이를 찍고 `dry-run: nothing written (<경로>)` 로 끝난다 — 파일을 만들지도 바꾸지도 않는다. 여러 에이전트가 바뀌는 `set phase`·`set plugin` 은 먼저 `--dry-run` 으로 보여 주기를 권한다.
- 파일이 손상되면(JSON 오류·스키마 위반) `show`/`resolve` 는 stderr 에 `... IGNORED, shipped values shown` 경고를 내고 출하값으로 답한다(`resolve` 는 exit 0 이므로 **경고를 꼭 전달**한다). `set`/`reset`(`--all` 포함)은 `refusing to write ... Fix or remove it by hand; nothing was changed.` 로 거부한다(exit 1). **파일을 대신 지우거나 고치지 마라** — 경로와 오류를 보여 주고 사용자가 직접 고치거나 지우게 한다(직전 쓰기 이전 내용은 `.bak` 에 있다).

## 출력

CLI stdout 을 코드블록으로 그대로 보여 준다(표를 다시 그리지 않는다). `set`/`reset` 뒤에는 한 줄을 덧붙인다: 바뀐 에이전트가 `needs-spawn-param` 이면 "리더가 스폰 때 `resolve` 값을 넘겨야 적용된다".

## Next Steps

| # | 액션 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 현재 실효값 확인 | `/model-routing show` | override 가 어느 행에 걸렸는지 |
| 2 | 설정 검증 | `/model-routing validate` | 강등·미지 에이전트·`needs-spawn-param` 목록 |
| 3 | 되돌리기 | `/model-routing reset --all` | 출하값으로 복귀 |
