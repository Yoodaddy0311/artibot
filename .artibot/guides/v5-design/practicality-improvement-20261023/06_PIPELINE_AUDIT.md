# 06. 파이프라인·토큰 점검 — 고정 컨텍스트 세, 훅 지연, 끊긴 배선, 열린 부채, 오픈소스 비교 (2026-10-23)

- **기준**: 브랜치 `claude/jolly-newton-qmi4eb` 선두 `793e9aa9`(master `6149446e` + 이 폴더의 구현 커밋). 측정은 모두 이 컨테이너(Linux, Node 22, Claude Code 2.1.309 바이너리는 있으나 중첩 실행 인증 불가)에서 **모델 API 호출 0** 으로 했다.
- **질문**: "제대로 구축됐나, 파이프라인이 끊기거나 너무 복잡해 토큰을 낭비하는 곳은 없나, 플러그인을 썼을 때와 안 썼을 때 무엇이 다른가." 이 중 **고정 비용 쪽**(플러그인이 매 요청·매 도구 호출·매 세션에 얹는 것)은 여기서 전부 잴 수 있고 §1~§2 가 그것이다. **편익 쪽**(성공률·성공당 비용·사람 개입)은 B/C 비교 실험([02](02_BASELINE_ROI_PROTOCOL.md)·[05 §4](05_REVISED_DESIGN.md))이 필요하고 여기서는 못 한다(§7).
- **등급**: `rules/verification-discipline.md` §0(실측 / 추론 / 미확인). 판정은 `skills/problem-validation/SKILL.md`(NECESSARY / PARTIAL / DEFER / REJECT). 토큰 수는 **문자 수 ÷ 4 의 추정**이다 — 실제 토크나이저로 재지 않았다.

## 0. 한눈에

| # | 발견 | 실측 | 판정 |
|---|---|---|---|
| 1 | **스킬 두 개가 활성화될 때마다 전체 테스트를 돈다** — `skills/tdd-workflow/SKILL.md:36` · `skills/quality-framework/SKILL.md:46` 의 `` !`npm test …` `` 줄. 호스트 문서(skills.md "Inject dynamic context")가 `!` 줄을 **스킬 내용이 모델에 가기 전에 실행**한다고 명시. 이 리포에서 전체 스위트는 232.8 s(여기) · 약 318 s(오너 PC, 10-04 감사) 이고 모델에는 `tail -5` 다섯 줄만 간다 | 호스트 문서 + 줄 존재 grep | **NECESSARY** — 10-04 감사 A1 이 "호스트 실행 여부 미확인" 조건부 NECESSARY 로 둔 것이 오늘 확정됐다. quality-framework 의 같은 줄은 그 감사에 없던 **신규** |
| 2 | **설명 세**: 스킬 114개 설명 37,803자 + 커맨드 81개 8,695자 + 에이전트 30개 17,229자 = **63,727자(≈15.9K 토큰)** 이 매 요청 시스템 프롬프트에 실린다(호스트는 설명으로 스킬을 고른다 — skills.md `description` 행, `when_to_use` 와 합쳐 1,536자 캡). 에이전트 30개 중 **24개가 500자 초과**(최대 744자), 스킬 7개 >500자(최대 1,149자) | §1 표·재현 명령 | **NECESSARY(다이어트)** — 캡 안이라 잘리지는 않지만 캐시 읽기로 매 요청 과금 |
| 3 | **전역 규칙 23,734자(≈5.9K 토큰)** 가 `~/.claude/rules/artibot/` 로 설치돼 모든 프로젝트·모든 세션에 상시 로드. 플러그인 자체 규칙(`plugins/artibot/CLAUDE.md` Context Efficiency: 파일당 ≤4K, 합 ≤12K)의 **2배**, `rules/verification-discipline.md` 하나가 12,910자로 **3배** | `wc -c rules/*.md` | **PARTIAL** — 소스 축약은 가치 있으나 오너 결정 2026-10-05 #2(설치된 개인 규칙 병합 안 함)와 접점. §8 |
| 4 | `skills.lazyLoading.enabled = true`: 프롬프트마다 SKILL.md 114개 **961,120 B** 를 읽어 들이고 소비처 0(10-04 감사 C5, NECESSARY → false, **미착지**) | config · 감사 | **NECESSARY** — 토큰은 아니고 I/O·지연(수십 ms) |
| 5 | **훅 프로세스 수**: Edit 1회에 node **11개**(PreToolUse 5 + PostToolUse 6), Write 10, Bash 5, Read·Grep·Glob 2. 지연 p50: PreToolUse 각 68~94 ms, PostToolUse Write 168 ms · Bash 153 ms, UserPromptSubmit 222 ms, Stop 180 ms, SessionStart 295 ms, SessionEnd 274 ms. **예산 초과 0** | 리포의 `scripts/bench/hook-latency.mjs` n=5 | **DEFER** — PreToolUse 디스패처 통합(5 → 1 spawn)은 gap review P-13 이 이미 제안, 실지연 `--debug` 측정 선행 |
| 6 | **정적 배선 감사가 재생성 불가**: `scripts/ci/triage-wiring-gaps.mjs` 는 `docs/wiring-audit-result.json` 을 읽는데 gitignore(`.gitignore:26`)이고 생성기가 리포에 없다. 마지막 보고는 `docs/WIRING-AUDIT-2026-05-30.md`(5개월 전) | 실행 → `audit input not found` | **PARTIAL** — "끊긴 배선" 을 정적으로 다시 보려면 생성 경로를 복원하거나 그 도구를 폐기해야 한다 |
| 7 | SessionStart 훅 `git-autopilot-setup.js` 가 payload 의 `cwd`(임시 프로젝트)가 아니라 **프로세스 cwd 의 리포**(`/home/user/artibot/.git/autopilot.json`)에 썼다. 운영에서는 둘이 같아 영향 없음(추론) | 격리 실행 부작용 관측 · 파일 삭제함 | **DEFER(낮음)** — 격리 실험(D-07)의 B 군 오염 벡터 후보로 05 §6 에 추가 |
| 8 | config 리프 키 427개 중 이름이 `lib/`·`scripts/` 어디에도 없는 키 **0** | 정적 스캔(약한 신호) | null-result |
| 9 | 프롬프트마다 주입되는 additionalContext 60~351자, 세션 시작 1,446자 | 격리 실행 | **KEEP** — 작다 |
| 10 | 10-04 감사의 NECESSARY 중 A1(tdd `!`) · C3(토큰 라벨) · C5(lazyLoading) **3건이 18일째 미착지** | grep | 부채 |

## 1. 고정 컨텍스트 세 — 플러그인을 켜면 매 요청에 얹히는 것

| 구성 | 크기 | 로드 시점 | 근거·재현 |
|---|---|---|---|
| 스킬 설명 114개 | 37,803자 ≈ 9.5K tok | 매 요청(시스템 프롬프트의 스킬 목록) | frontmatter `description` 합산 — §9 재현 ① |
| 커맨드 설명 81개 | 8,695자 ≈ 2.2K tok | 매 요청 | 같은 스크립트 |
| 에이전트 설명 30개 | 17,229자 ≈ 4.3K tok | 매 요청(Agent 도구의 서브에이전트 목록) | 같은 스크립트 |
| 전역 규칙 10파일 | 23,734자 ≈ 5.9K tok | 매 세션·모든 프로젝트(`install.sh:474,837` 가 `~/.claude/rules/artibot/` 에 설치) | `wc -c plugins/artibot/rules/*.md` |
| 프로젝트 `CLAUDE.md` Artibot 절 | 938자 ≈ 0.2K tok | 매 세션(`install.sh:845-857` 이 심음) | heredoc 길이 |
| `plugins/artibot/CLAUDE.md` | 11,791자 ≈ 2.9K tok | 플러그인 리포 안에서 작업할 때만 | `wc -c` |
| SessionStart 주입 | 1,446자 ≈ 0.36K tok | 세션 1회(규칙 미설치 시 digest 포함) | §9 재현 ③ |
| UserPromptSubmit 주입 | 60자(대부분) ~ 351자(팀 제안) ≈ 15~90 tok | 프롬프트마다 | §9 재현 ② |

합계(플러그인 리포 밖의 보통 프로젝트): **약 88K자 ≈ 22K 토큰이 매 요청의 고정 입력**이다. 시스템 프롬프트는 안정적이라 대부분 **캐시 읽기**로 과금된다. 리포의 가격표(`lib/core/model-catalog.js#MODELS`, 2026-10-12 공식 표 대조, `priceMeasured: true`)로 환산하면:

| 티어 | 캐시 읽기 단가 | 요청 1회 세(캐시) | 요청 200회(캐시) | 캐시 미스 1회 |
|---|---|---|---|---|
| haiku | $0.01/M | $0.0002 | $0.04 | $0.002 |
| sonnet | $0.10/M | $0.0022 | $0.44 | $0.044 |
| opus | $0.20/M | $0.0044 | $0.88 | $0.088 |
| fable | $0.25/M | $0.0055 | $1.10 | $0.220 |

읽는 법: 세션 하나가 요청 200회면 opus 기준 약 $0.9 가 **플러그인이 있다는 사실만으로** 나간다(캐시가 전부 맞을 때). 5분 넘게 쉬어 캐시가 식으면 그 요청은 20배다. 이것이 "플러그인 유무 차이" 중 지금 숫자로 말할 수 있는 **유일한** 항목이고, 편익 쪽 숫자는 없다(§7).

**못 보는 것**: 토큰은 문자 ÷ 4 추정이다(한국어 설명은 토큰당 문자가 적어 **과소**일 수 있다). 스킬 설명이 매 턴 실리는 것은 호스트 문서가 명시한다(skills.md 2026-10-23: "Every skill in the skill listing adds to your context on every turn", `description`+`when_to_use` 는 1,536자에서 잘림; `disable-model-invocation: true` 면 모델에게 지시가 가지 않는다). 커맨드·에이전트 설명의 정확한 노출 형식은 **미확인**이다. 실제 과금은 `usage.receipt` 의 `cached_input_tokens` 로 확인해야 한다 — B 군(플러그인 없음)과 짝지으면 그 차이가 곧 이 표다.

## 2. 훅 지연과 프로세스 수 — 도구 호출마다 얹히는 것

리포의 벤치(`node scripts/bench/hook-latency.mjs --slot all --n 5 --warmup 1`, 샌드박스 HOME, 실제 payload 크기·호스트 IPC 는 미포함 — 도구 자신의 NOTES) p50/p95(ms):

| 슬롯 | p50 | p95 | 자식 수 | 예산 |
|---|---|---|---|---|
| SessionStart | 295 | 314 | 11/10 선언 | 30,000 |
| UserPromptSubmit | 222 | 240 | 1(in-process 7 핸들러) | 15,000 |
| PostToolUse:Write | 168 | 183 | 5 | 30,000 |
| PostToolUse:Bash | 153 | 176 | 3 | 30,000 |
| Stop | 180 | 187 | 6 | 30,000 |
| SessionEnd | 274 | 282 | 7 | 30,000 |
| SubagentStop | 148 | 162 | 3 | 15,000 |
| PreToolUse 각(9종) | 68~94 | 79~121 | 직접 등록 | 5,000 |

도구 1회당 node 프로세스: **Edit 11**(Pre `pre-write`·`pre-write-guard`·`git-autopilot-guard`·`pre-write-checkpoint`·`intent-observe-pre` + Post 6) · **Write 10** · **Bash 5**(Pre 2 + Post 3) · Read/Grep/Glob 2 · Agent 1+1 · WebFetch 1+2(`hooks/hooks.json` · `hooks/dispatch-table.json`). 호스트가 PreToolUse 훅을 병렬로 띄우면 Edit 의 벽시계 비용은 약 0.1 s(Pre) + 0.17 s(Post) ≈ **0.3 s**, Bash 는 약 0.25 s, 프롬프트마다 0.22 s(UPS) + 0.18 s(Stop) 다. 세션에 도구 호출 300회면 훅만으로 **1.5분 안팎**의 벽시계가 쌓인다(추론 — 호스트 IPC·직렬 여부 미측정). 토큰 비용은 아니다.

벤치 NOTE 의 **SessionStart 자식 11 vs 선언 10** 드리프트는 디스패처가 표 밖 프로세스를 하나 더 띄운다는 뜻이다(어느 핸들러의 자식인지 미확인).

## 3. 스킬 활성화가 전체 테스트를 돌린다 (확정)

호스트 문서 `https://code.claude.com/docs/en/skills.md`(2026-10-23 조회) "Inject dynamic context": "The `` !`<command>` `` syntax runs shell commands **before the skill content is sent to Claude**. The command output replaces the placeholder." 이 리포의 `!` 줄 9개:

| 파일 | 줄 | 명령 | 비용 |
|---|---|---|---|
| `skills/tdd-workflow/SKILL.md` | 36 | `npm test -- --reporter=dot ... tail -5` | **전체 스위트**(여기 232.8 s · 오너 PC 약 318 s) → 모델엔 5줄 |
| `skills/quality-framework/SKILL.md` | 45~46 | `npm run lint`, `npm test ... tail -5` | lint + **전체 스위트** |
| `skills/git-unified/SKILL.md` | 100~103 | `git status`·`log`·`branch`·`rev-list` | 수십 ms, 유용 |
| `skills/systematic-debugging/SKILL.md` | 39~40 | `git log --grep=fix`, `git diff --stat` | 수십 ms, 유용 |

플러그인을 쓰는 **다른** 프로젝트에서는 그 프로젝트의 `npm test` 가 돈다(없으면 오류 5줄). 10-04 감사 A1 은 "줄만 제거하고 `## Current State` 헤딩은 유지(stage-b 기준선)" 로 적었다 — 그대로 유효하고, `quality-framework:46` 에도 같은 처분이 필요하다. `npm run lint`(45) 는 수 초라 보존 여지가 있으나 소비처가 "결과 3줄" 이라 같이 지우는 쪽이 단순하다(판단).

## 4. 열린 부채 — 10-04 감사의 NECESSARY 중 미착지

| 항목 | 감사 판정 | 2026-10-23 상태 | 비용 |
|---|---|---|---|
| A1 tdd `!` 줄 | NECESSARY(조건부) | **열림**, 조건 오늘 충족(§3) | 활성화당 전체 테스트 1회 |
| C3 토큰 라벨 | NECESSARY | **열림** — `scripts/hooks/statusline.sh:479` 'Session token usage' 그대로 | 과장 표시(토큰 0) |
| C5 `skills.lazyLoading.enabled` | NECESSARY(낮은 우선) | **열림** — `true` | 프롬프트당 961 KB 읽기, 소비처 0 |

같은 감사의 DEFER·오너 결정 항목은 결정대로 유지돼 있다(§0.1 표 대조). 즉 "구축은 계속되는데 지난 감사의 쉬운 수정이 남아 있다" 는 사용자의 감이 **맞다** — 셋 다 1~3줄 수정이다.

## 5. 끊긴 배선 — 여기서 본 것과 못 본 것

- **본 것**: [04 §5](04_VALIDATION_REPORT.md) 의 D0~D6 표가 다섯 사슬을 따라갔고, 끊겨 있던 넷(루프 이력 · 미분류 Bash · REPORT 빈 verifyResult · 설정 읽기 상태)은 이 폴더의 구현으로 닫혔다(05 §8). 훅 등록·디스패치 표·예산 정합은 방화벽 테스트가 매 커밋 지킨다(`hook-timeout-budget` · `dispatcher-cwd-sandbox-required` · `v5-config-firewall`, 전체 28,090건 그린 — 05 §8.1).
- **못 본 것 1 — 정적 전수 감사**: §0 #6. 도구는 있는데 입력이 없다.
- **못 본 것 2 — 발화·소비 계수(Existence Audit)**: `plugins/artibot/CLAUDE.md` 의 규칙("소비처 0 + 발화 0 이 2릴리스 연속이면 제거 후보")을 판정하는 `scripts/ledger/existence-audit.mjs` 는 라이브 원장(`.git/artibot/ledger.jsonl` 의 `hook.fired`·`tool.used` 행)이 입력이다. 이 체크아웃엔 원장이 없다. **오너 PC 에서 한 번 돌리면** 81 커맨드·114 스킬·훅 58종 중 무엇이 실제로 쓰이는지가 나오고, 그것이 "너무 복잡해서 낭비" 를 가르는 유일한 실측 분모다.
- **못 본 것 3 — config 키 소비처**: 이름 기준 미참조 0(§0 #8)은 약한 신호다. 경로 문자열로 동적으로 읽는 키와 이름이 겹치는 키를 구분하지 못한다.

## 6. 비슷한 오픈소스와의 비교

웹 조사(별도 에이전트, 모든 페이지 2026-10-23 열람, GitHub 페이지·releases 피드만 사용, 리포 도구 미사용). ★·이슈·커밋 수는 그 날 페이지 값이고 "n/s" 는 README 에 없음. README 가 주장한 수치는 **주장**으로 표기했다 — 어느 것도 방법·베이스라인이 공개돼 있지 않다.

| 프로젝트 | 유형 · 설치 | 공개 규모 | 완료 게이트 | 자기 효과 측정 | 컨텍스트 비용 언급 | 활동 |
|---|---|---|---|---|---|---|
| ruvnet/ruflo (구 claude-flow) | 멀티에이전트 오케스트레이터 · plugin+npm+MCP | 98~100+ agents · 60+ commands · 30 skills · 27 hooks · 314 MCP tools(README 내 불일치) | `ruflo verify` 는 공급망 서명 검증, 테스트 기반 완료 게이트 n/s | LangGraph·AutoGen·CrewAI 대비 cold start·RSS(stub LLM, "orchestration cost only"); vanilla Claude Code 비교 없음; "routing 89%" 링크 없음 | n/s | 78.5k★ · v3.59.17 2026-10-22 |
| SuperClaude_Framework | 커맨드·설정 팩 · pipx(플러그인 아님) | 30 commands · 20 agents · 8 MCP servers | 리서치용 confidence 0.6/0.8, 테스트 게이트 n/s | "2-3x faster, 30-50% fewer tokens" (주장, 방법 없음) | "Reduced framework footprint"(수치 없음) | 23.9k★ · v4.3.0 2026-03-22 |
| BMAD-METHOD | 애자일 방법론+에이전트 팩 · npx/plugin | n/s(모듈 6) | TEA 애드온: PASS/CONCERNS/FAIL 릴리스 판정 | 없음 | TEA "one step file at a time" | 54.5k★ · v6.12.4 2026-10-14 |
| obra/superpowers | 스킬 라이브러리+방법론 · 공식 마켓 plugin | 스킬 15 나열 | RED-GREEN-REFACTOR·verification-before-completion·2단계 리뷰(스킬 지시로 강제) | v6.4.2 "plans 1/4 시간·1/3 토큰"(자기 이전 버전 대비, 런 수 없음) | SKILL.md 20,000바이트 테스트(compaction 재부착 생존) | 303.8k★ · v7.0.1 2026-10-21 |
| disler/claude-code-hooks-mastery | 훅 데모 팩 · settings.json | 13 hook 이벤트(11 자동검증) · commands 5 | PreToolUse 위험 명령 차단 · lint/type 차단 | 없음 | 모든 이벤트 JSON 로그 · 60 s 한도 | 3.9k★ · 마지막 커밋 2026-02-01 |
| ccusage/ccusage | 사용량 트래커 CLI | 소스 18종 | 해당 없음 | 사용자 토큰·USD 집계(자기 효과 아님) | n/s | 19.1k★ · v20.0.41 2026-10-22 |
| oh-my-claudecode | 멀티에이전트 오케스트레이터 · plugin/npm | 19 agents · 8 modes | "tests/build/lint/typecheck 통과까지 team-verify → team-fix 루프"(지시) | "라우팅으로 30-50% 토큰 절감"(주장) | `omc session friction report`(context-bloat 진단) · Jev 2000 ms timeout | 40.2k★ · v5.7.9 2026-10-22 |
| smtg-ai/claude-squad | TUI 세션 매니저(tmux+worktree) | n/s | 수동 리뷰 | 없음 | n/s | 8.6k★ · v1.0.20 2026-08-20 |
| Anthropic 공식 plugins · claude-plugins-official | 예제 13개 + 마켓 ≈315 항목 | 예제는 commands 1~4 · agents 0~6 · skills 0~7 · 훅 단일 이벤트 | code-review confidence 필터; 마켓 "Anthropic cannot verify" | 없음 | 문서: "스킬 목록의 모든 스킬이 매 턴 컨텍스트에 더해진다" · listing 1,536자 캡 · SKILL.md 500줄 · compaction 재부착 5k/25k 토큰 · additionalContext 10,000자 캡 · "SessionStart 훅은 빠르게" | 43.9k★ · 2026-10-22 |
| affaan-m/everything-claude-code | 에이전트 하네스 · plugin/npx | 71 agents · 311 skills · 97 command shims · 훅 15 이벤트 | TDD gated RED→GREEN, fresh-context 자기 리뷰, GateGuard | "sonnet ~60% cost reduction"(주장) | on-demand skills vs always-loaded rules 구분 · SessionStart 8,000자 캡 · MCP ≤10/tools ≤80 | 286.7k★ · v2.2.3 2026-10-01 |
| wshobson/agents | 멀티 하네스 플러그인 마켓 | plugins 94 · agents 202 · skills 185 · commands 105 | 구조 validate; LLM judge 는 "experimental, not validated" | 없음 | 8 KB 참조 분할(Codex) | 41.6k★ · 2026-10-17 |

**종합**
- **규모**: Artibot(81 commands · 114 skills · 30 agents · 15+ hook 이벤트)은 공개 수치로 "중대형" 이다. commands 는 ruflo(60+)·SuperClaude(30)보다 많고 wshobson(105)·ECC(97)와 비슷하다. skills 114 는 ruflo(30)·superpowers(15)보다 훨씬 많지만 ECC(311)·wshobson(185)보다 적다. **훅 층은 공개된 것 중 가장 조밀하다**(PreToolUse 9 등록 + PostToolUse 12 핸들러 디스패처 + 세션 디스패처 4; 훅 수를 밝힌 곳은 ruflo "27" 과 hooks-mastery "13 이벤트" 뿐). 자체 테스트 수(≈28k)를 밝힌 비교 대상은 없다.
- **필드에 있고 Artibot 에 없는 것**: 멀티 하네스 배포(Codex·Cursor 등), MCP 서버 동봉, 방법론 서사(RED-GREEN·애자일 페르소나·"Mandatory workflows"), 공식 마켓플레이스 등재. **Artibot 에 있고 필드에 드문 것**: 프로젝트별 JSONL 이벤트 원장, **훅으로 완료를 결정적으로 막는 REPORT 게이트**(OMC·ECC·superpowers 의 "evidence-based completion" 은 스킬·프롬프트 지시다; Stop 훅 루프는 Anthropic 예제 ralph-wiggum 만), zero-runtime-deps 명시. 모델 라우팅은 OMC·wshobson·ECC 에도 있다.
- **vanilla Claude Code 대비 통제 비교를 공개한 프로젝트는 0개다.** 숫자가 있는 곳은 전부 다른 프레임워크 대비(ruflo, stub LLM)이거나 자기 이전 버전 대비(superpowers, 런 수 없음)이거나 방법 없는 주장(SuperClaude·OMC·ECC "30~60%")이다. 따라서 [02](02_BASELINE_ROI_PROTOCOL.md)의 B/C 짝 비교를 실제로 돌려 공개하면 **이 필드에서 첫 통제 수치**가 된다 — 그 전까지 "플러그인이 낫다" 는 어느 프로젝트도 증명하지 못한 주장이다(우리 포함).
- **컨텍스트 절약을 명시한 쪽**: Anthropic 문서(progressive disclosure, 1,536자 캡, 500줄, 5k/25k 재부착, SessionStart 빠르게), ECC(on-demand skills vs always-loaded rules, SessionStart 8,000자 캡), superpowers(20,000바이트 테스트), TEA(step 파일 하나씩), OMC(context-bloat 리포트). **훅당 지연을 수치로 공개한 곳은 없다** — §2 의 벤치와 §1 의 주입 문자수를 공개하면 사실상 유일한 데이터다. 그리고 Anthropic 문서가 확인해 준 사실 하나: `disable-model-invocation: true` 인 스킬은 모델에게 **지시가 가지 않는다**(= 매 턴 목록에서 빠진다). 이 리포는 스킬 114 중 9, 커맨드 81 중 5 만 그렇게 표시돼 있어 **스킬 105 + 커맨드 76 의 설명이 매 턴 실린다** — §1 의 세를 줄이는 가장 큰 레버다(§8 #3).

## 7. "플러그인을 썼을 때와 안 썼을 때" — 지금 말할 수 있는 것

| 축 | 지금 말할 수 있나 | 근거 |
|---|---|---|
| 고정 입력 토큰 | **예** — 요청당 ≈22K 토큰(캐시 읽기), §1 | 정적 측정 |
| 도구 호출당 지연 | **예** — Edit ≈0.3 s, Bash ≈0.25 s, 프롬프트 ≈0.4 s | 벤치, 호스트 IPC 제외 |
| 세션당 부수 I/O | **예** — 프롬프트당 961 KB 스킬 읽기(C5) 등 | 설정값 |
| 검증 성공률 · 성공당 비용 · 사람 개입 | **아니오** — B/C 짝 비교 실험이 필요(02·05 §4), 최소 6과제 × 2군 × 2회 | 이 컨테이너는 중첩 `claude -p` 인증 불가(05 §8.1) |
| 실제 사용되는 기능 비율 | **아니오** — 라이브 원장 필요(§5) | 오너 PC |

편익 없는 상태에서의 결론은 하나다: **지금 확실한 것은 비용 쪽**이고, 그 비용의 절반 이상(설명 16K 중 에이전트 4.3K + 규칙 5.9K)은 측정 없이도 줄일 수 있다(§8).

## 8. 권고 (problem-validation 4-check)

> 적용 상태(2026-10-23, 같은 날 뒤 커밋): #1 · #2 · #4 **착지**(CHANGELOG 「10-04 경제성 감사의 미착지 NECESSARY 착지」). #3(a) 는 오너 결정·Existence Audit 대기, #3(b) 는 아래 재판정으로 **DEFER**. #5~#7 은 PC·오너로 넘김([07](07_PC_HANDOFF.md)).

**NECESSARY**
1. `skills/tdd-workflow/SKILL.md:36` · `skills/quality-framework/SKILL.md:45-46` 의 `!` 줄 삭제(헤딩 유지). 근거 §3. 비용: 활성화당 전체 테스트 1회 → 0. 테스트: `tests/firewall/constitution-stage-b*.test.js` 가 헤딩 기준선을 핀 — 줄만 지우면 그린(추론, 감사 §2.2 와 동일 서술).
2. `artibot.config.json#skills.lazyLoading.enabled` → `false`(C5). `tests/runtime/middleware/skills.test.js` 에 enabled:false 케이스가 이미 있다(감사 §4.4).
3. 설명 세 축소, 두 갈래. (a) **매 턴 목록에서 빼기**: 스킬 114 중 `disable-model-invocation: true` 는 9, 커맨드 81 중 5 뿐이다(grep). Anthropic 문서는 "배포·커밋·코드 생성처럼 사람이 `/name` 으로 부르는 **작업형** 내용은 `disable-model-invocation: true`" 를 권한다 — 커맨드 76·스킬 105 를 작업형/지식형으로 분류해 작업형을 모델 목록에서 빼면 설명 세의 상당 부분이 사라진다(절감 폭은 분류 결과에 따름; 발화 분모 없이 어느 스킬이 모델 발화에 의존하는지 모르므로 **Existence Audit 선행 + 오너 결정**). (b) **줄이기**(재판정 → **DEFER**): 에이전트 설명 24개(>500자)·스킬 설명 7개(>500자)의 산문을 줄이면 매 요청 ≈1.8K 토큰(고정 세의 약 8%, opus 캐시 읽기로 200요청당 약 $0.07) 절감 추정 — 트리거 목록은 지켜야 하므로 더 못 줄인다. 절감이 작고 설명은 발화 레버라 품질 위험이 크다(problem-validation check 4). (a) 가 끝나 분모가 있을 때 함께 한다. 설명은 **발화 레버**다(`plugins/artibot/CLAUDE.md` "Auto-invoke Principle") — 트리거 어휘(`triggers`·`when_to_use`)는 지키고 산문만 줄인다. `scripts/ci/lint-skill-descriptions.js` 의 R1 trigger floor 가 하한을 지킨다.
4. C3 토큰 라벨 정정(05 D-06 (a), 감사 §4.3 범위 그대로).

**PARTIAL(오너 결정 동반)**
5. `rules/verification-discipline.md` 12,910자 축약 — 규칙 13절 중 §1~§9 의 사례 서술(2026-07-27 사고 경위)을 별도 문서로 빼고 규칙 문장만 남기면 4K 안에 든다(추론). 2026-10-05 결정 #2 는 "설치된 개인 규칙 병합 안 함" 이었고 소스 축약은 다른 결정이지만, 오너가 손본 규칙 4개(NEXT-SESSION v4.71.11 "`.artibot-new` 로 옆에 둠")와 겹치므로 **오너 결정**.

**DEFER**
6. PreToolUse 디스패처 통합(Write/Edit 5 spawn → 1) — gap review P-13 의 `--debug` 실지연 측정 뒤.
7. §0 #7 `git-autopilot-setup.js` 의 cwd 출처 — 격리 실험 전에 payload `cwd` 우선으로.

**REJECT(지금은)**
8. "스킬·커맨드 수 자체를 줄이자" — 발화 분모 없이 무엇을 지울지 고를 수 없다(Existence Audit 선행, §5).

## 9. 재현

```bash
# ① 설명 세 (chars) — plugins/artibot 에서
node -e 'const fs=require("fs");const d=f=>{const t=fs.readFileSync(f,"utf8");const b=t.slice(3,t.indexOf("\n---",3));const m=b.match(/^description:\s*([|>]-?)?\s*$([\s\S]*?)(?=^\S)/m);return m?m[2].replace(/\s+/g," ").trim():(b.match(/^description:\s*(.*)$/m)||["",""])[1]};const sum=a=>a.reduce((s,f)=>s+d(f).length,0);const sk=fs.readdirSync("skills").filter(x=>fs.existsSync(`skills/${x}/SKILL.md`)).map(x=>`skills/${x}/SKILL.md`);const cm=fs.readdirSync("commands").filter(f=>f.endsWith(".md")).map(f=>`commands/${f}`);const ag=fs.readdirSync("agents").filter(f=>f.endsWith(".md")).map(f=>`agents/${f}`);console.log({skills:sum(sk),commands:sum(cm),agents:sum(ag)})'
wc -c rules/*.md CLAUDE.md
# ② 프롬프트 주입 (격리 HOME; 작은 git 리포를 cwd 로)
printf '{"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"<repo>","prompt":"결제 모듈 리팩토링하고 API 문서 갱신하고 e2e 테스트 추가해줘"}' | env -i PATH="$PATH" HOME=<tmp> USERPROFILE=<tmp> CLAUDE_PLUGIN_ROOT=$PWD ARTIBOT_UPDATE_CHECK=0 node scripts/hooks/_userprompt-dispatcher.js
# ③ 세션 시작 주입
printf '{"hook_event_name":"SessionStart","session_id":"s2","cwd":"<repo>","source":"startup"}' | env -i PATH="$PATH" HOME=<tmp> USERPROFILE=<tmp> CLAUDE_PLUGIN_ROOT=$PWD ARTIBOT_UPDATE_CHECK=0 node scripts/hooks/_sessionstart-dispatcher.js
# ④ 훅 지연
node scripts/bench/hook-latency.mjs --slot all --n 5 --warmup 1
# ⑤ 동적 `!` 줄
grep -rn '^!' skills/*/SKILL.md commands/*.md
# ⑥ 정적 배선 감사(입력 부재 확인)
node scripts/ci/triage-wiring-gaps.mjs
```

## 10. 미확인

- 호스트가 커맨드·에이전트 설명을 시스템 프롬프트에 **어떤 형식·전량**으로 싣는지(스킬은 문서로 확인됨 — §1; 커맨드·에이전트는 미확인).
- 토큰 수(문자 ÷ 4 추정; 한국어 비율이 높아 실제는 더 클 수 있다).
- 호스트가 PreToolUse 훅 9종을 병렬로 띄우는지와 호스트 IPC 지연(gap review P-13 도 미확인).
- SessionStart 자식 11 vs 10 의 출처.
- 라이브 발화·소비 분모 전부(오너 PC 의 Existence Audit).
- Windows 에서의 지연 수치.
