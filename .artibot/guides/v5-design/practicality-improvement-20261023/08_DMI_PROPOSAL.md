# 08. `disable-model-invocation` 분류 제안 (2026-11-08, 제안만 — 적용은 오너 승인 뒤)

- **출처**: [07 §B-6](07_PC_HANDOFF.md) — 2026-11-08 오너 결정 "분류 제안서만 작성". 이 문서는 아무것도 바꾸지 않는다.
- **한 줄 결론**: 지금 dmi 를 늘릴 근거는 없다. census 표본이 대상 수보다 작고, 커맨드 dmi 는 Auto-invoke DNA 와 충돌한다. 이번 세션에서 관측한 목록 비용의 실체는 "항목 수"보다 **설명 잘림**이고, 그중 측정 가능한 원인 후보는 `~/.claude/commands` 의 평면 사본 중복이다 — dmi 보다 먼저 이것을 치운다(§3).

## 1. 실측 입력

| 항목 | 값 | 재현 |
|---|---|---|
| 스킬 / 그중 dmi | 114 / 9 → 모델에 보이는 것 105 | `ls plugins/artibot/skills/*/SKILL.md \| wc -l` · `grep -l '^disable-model-invocation: true' plugins/artibot/skills/*/SKILL.md \| wc -l` |
| 커맨드 / 그중 dmi | 81 / 5 → 76 | 같은 방식, `commands/*.md` |
| 06 §1 의 "스킬 105 · 커맨드 76" | 위 두 줄의 차와 일치 | — |
| existence-audit 원장 | `.git/artibot/ledger.jsonl` 이벤트 5,793 | `evidence/pc-handoff-census-20261107.md` |
| Skill 도구 행(스킬 분모) | **3** | 같은 JSON `kinds.skills.denominator` |
| 커맨드 행(커맨드 분모) | **8** | `kinds.commands.denominator` |
| 발화 > 0 | 스킬 `adversarial-review` 1 · 커맨드 `autopilot` 2 · `team` 2 · `ultraplan` 2 · `review` 1 · `ultrareview` 1 | 같은 JSON `entries[].fired` |
| 이미 dmi | 스킬 daily · hook-event-emitter · persona-distill · prompt-caching-strategy · scheduled-learning · session-worklog · setup · skill-authoring · tool-approval / 커맨드 codex · dynamic · orchestrate · spawn · swarm | grep 위와 같음 |
| `AUTO_INVOKE_NAMES` | 14 — analyze · explain · blindspot · scorecard · why · split · autopilot · watch · team · implement · plan · code-review · verify · daily | `lib/cognitive/auto-invoke.js#AUTO_INVOKE_NAMES` |

**정합성 점검**: 원장은 이 리포 하나의 것이다(다른 프로젝트의 사용은 안 잡힌다). 분모 3·8 은 대상 195개보다 두 자릿수 작다 — "모델이 실제로 부른 것" 으로 나누면 거의 전부가 "0회" 칸에 들어가고, 그 0 은 "안 쓴다" 가 아니라 "표본이 없다" 다.

## 2. 판정 — census 로는 지금 분류할 수 없다

- 07 §B-6 이 기대한 입력("모델이 실제로 부른 것")은 아직 해상도가 없다. 이 숫자로 dmi 를 정하면 근거 없는 좁히기가 된다(규율 §10.5(c)).
- **커맨드 dmi 는 DNA 와 충돌한다**: dmi 는 모델의 Skill 호출을 막는다 → 사용자가 `/name` 을 직접 쳐야 한다. 플러그인 `CLAUDE.md` 「Auto-invoke Principle」은 모든 커맨드에 대해 그것을 금지한다(사용자에 비개발자 포함). 그래서 기존 dmi 커맨드 5개는 모델이 스스로 부르면 안 되는 것(옛 별칭·위험 표면)뿐이다.

## 3. 먼저 할 것 — 평면 사본 79개 (오너 실행, 되돌릴 수 있음)

이번 세션(2026-11-08 00:57 시작, 설치본 4.71.15)의 스킬 목록에서 관측한 것:

| 관측 | 등급 |
|---|---|
| Artibot 커맨드가 **두 번** 실린다 — 접두 없는 `ad` · `adr` … 와 `artibot:ad` · `artibot:adr` … | 실측(이 세션 컨텍스트) |
| 접두 없는 쪽의 출처 = `~/.claude/commands/` 의 평면 사본 80파일. 79개가 2026-09-09 자 Artibot 커맨드, 1개(`hey.md`, 2026-02-12)는 Averify 프로젝트의 오너 소유 커맨드 | 실측 — `ls -la ~/.claude/commands` |
| 79개 중 **39개가 리포와 내용이 다르다**(CR 제거 후 비교) — 낡은 사본. 예: 접두 없는 `split` 은 "실용 상한 4", `artibot:split` 은 "상한 8". `rea` · `model-routing` 은 평면 사본에 없다 | 실측 — `cmp <(tr -d '\r' < ~/.claude/commands/<n>.md) <(tr -d '\r' < plugins/artibot/commands/<n>.md)` 를 79개에 |
| 목록 뒤쪽의 Artibot 스킬 대부분이 **이름만** 있고 설명이 없다 — 수동 계수 101개 중 설명이 붙은 것은 2개(`campaign-planning` · `image-generation`) | 실측(이 세션 컨텍스트, 수동 계수 — 재현 명령 없음) |
| 원인 = 호스트의 목록 예산 초과로 설명이 잘림, 평면 중복이 그 예산을 앞에서 먹음 | **추론** — 호스트 동작 미확인 |

설명이 잘린 스킬은 설명 매칭으로 활성화될 수 없다(플러그인 `CLAUDE.md` 가 "description 품질이 진짜 지렛대"라고 적은 그 경로). 그래서 dmi 로 항목 수를 줄이는 것보다 **낡은 중복을 치우는 것**이 싸고 효과가 직접적이다. 설치기는 네이티브 플러그인이 있으면 평면 사본을 다시 만들지 않는다(`install.sh#install_commands` 의 공유 가드, 2026-11-07 에이전트 평면 사본 31개를 옮긴 것과 같은 선).

오너 실행 명령(PowerShell, `hey.md` 는 남긴다):

```powershell
$src = "$env:USERPROFILE\.claude\commands"; $bak = "$env:USERPROFILE\.claude\commands.bak-20261108"
New-Item -ItemType Directory -Force $bak | Out-Null
Get-ChildItem $src -Filter *.md | Where-Object { $_.Name -ne 'hey.md' } | Move-Item -Destination $bak
(Get-ChildItem $src).Name   # → hey.md 만 남아야 한다
```

되돌리기: `Move-Item "$bak\*.md" $src`. **미확인**: 플러그인 커맨드를 접두 없이 `/ad` 로 쳐도 열리는지(호스트 동작) — 옮긴 뒤 재시작해서 한 번 확인한다.

## 4. 그 다음 (조건부)

1. 재시작 후 같은 관측을 다시 한다 — 이름만 남은 Artibot 스킬 수가 줄었는지. 줄었으면 §3 의 추론이 맞은 것이고 dmi 는 필요 없을 수 있다.
2. 그래도 잘리면 그때 dmi 후보를 고른다. 기준(전부 충족): `AUTO_INVOKE_NAMES` 밖 · census 발화 0(분모가 충분히 커진 뒤) · 모델이 스스로 부르면 안 되거나 사람이 결정하는 표면. 지금 기준으로 이름만 꼽으면 `assemble`(이스터에그, 전원 스폰 비용) · `export` · `sdk` · `autopilot-queue` 정도이고, 각각 "사용자가 `/name` 을 쳐야 한다"는 DNA 비용을 승인받아야 한다.
3. census 재측정 시점: 스킬 분모(Skill 도구 행)가 대상 수(105)를 넘은 뒤. 그 전의 0 은 판정 근거가 아니다.

## 5. 이 문서가 못 보는 것

- 호스트의 목록 예산 규칙(얼마에서 어떻게 자르는지) — 미확인.
- 다른 프로젝트·다른 PC 의 사용 — 원장이 리포별이라 안 잡힌다.
- 평면 사본을 옮긴 뒤 접두 없는 호출 습관이 깨지는지 — §3 끝의 미확인.
