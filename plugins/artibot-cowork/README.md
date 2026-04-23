# Artibot for Cowork — v3.1

[![Version](https://img.shields.io/badge/version-3.1.0-blue?style=flat-square)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](../../LICENSE)
[![Skills](https://img.shields.io/badge/skills-46-7C3AED?style=flat-square)](./skills/)
[![Agents](https://img.shields.io/badge/agents-12-7C3AED?style=flat-square)](./agents/)
[![Cowork](https://img.shields.io/badge/Claude_Cowork-Plugin-orange?style=flat-square)](https://claude.com/cowork)
[![Tests](https://img.shields.io/badge/smoke--tests-passing-brightgreen?style=flat-square)](./tests/)

> **Marketing & long-form writing pipeline for Claude Cowork** — 6-skill writing pack, AEO/GEO citation patterns, voice calibration, AI-slop detection, Claude Design, Routines, Ultraplan, and swarm intelligence.
>
> **Claude Cowork용 마케팅 & 장문 콘텐츠 파이프라인** — 6개 작문 스킬, AEO/GEO 인용 패턴, 보이스 캘리브레이션, AI-슬롭 검출, Claude Design, Routines, Ultraplan, 집단지성.

A slim, Cowork-optimized variant of the [Artibot](https://github.com/Yoodaddy0311/artibot) plugin, designed for knowledge workers using **Claude Cowork** (the Claude desktop app) rather than developers using Claude Code.

---

## Why artibot-cowork? (vs vanilla Cowork / generic skill packs)

| # | Differentiator | What it gives you |
|---|---|---|
| 1 | **End-to-end writing pipeline** | `content-pipeline` skill orchestrates 5 stages (persona → brief → outline → draft → review → publish) with explicit handoff contracts |
| 2 | **AEO / GEO ready** | `aeo-geo-citation-patterns.md` reference + `schema-generator` skill emits JSON-LD (`Article`/`FAQPage`/`HowTo`/`QAPage`) and citable 120-180 word passages |
| 3 | **Voice calibration** | `voice-reference` skill anchors tone across long-form / case-study / column / thought-leadership / interview outputs |
| 4 | **AI-slop detection** | `ai-slop-reviewer` runs after every text output — pattern detection + quality scoring with `long-form-quality-rubric.md` (90+ gate for publish) |
| 5 | **Korean market depth** | `kr-marketing` skill (Naver C-Rank/DIA SEO, Kakao Moment, PIPA compliance) — rare in English-first plugins |
| 6 | **Compliance built-in** | `ad-compliance` covers 표시광고법, PIPA, FTC, GDPR; reduces legal review iterations |
| 7 | **Claude Design** | Marketing asset creation workflows — landing pages, email templates, social cards, slide decks |
| 8 | **Routines** | Marketing automation specs — nightly reports, weekly calendars, competitor monitoring via schedule/API/GitHub triggers |
| 9 | **Sandbox-safe** | No hooks, no external scripts, no `lib/`, no `server/`, no background processes — runs cleanly in any Cowork sandbox |

---

## Quick Demo (30초 안에 결과 보기 / 30-Second First Win)

```text
# 1. Install — drag artibot-cowork.plugin into Cowork chat (or use marketplace)

# 2. Run the long-form writing pipeline on a fresh topic
"Write a 1,800-word case study on how we reduced onboarding friction"
#  → content-pipeline orchestrates: persona → brief → outline → draft → review → publish
#  → ai-slop-reviewer auto-runs against long-form-quality-rubric (90+ gate)
#  → schema-generator emits JSON-LD + citable passages

# 3. Voice-calibrate against past samples
"Use my brand voice from /voice-reference samples for the next draft"

# 4. Deep strategy planning
/ultraplan deep Q3 B2B growth campaign
#  → WebSearch + market analysis + channel strategy + KPI framework + roadmap
```

That's it. No config. Skills auto-activate by trigger words.

---

## Quickstart Installation

### Option 1: Drag-and-drop (recommended for Cowork)

In Cowork, drag the `artibot-cowork.plugin` file into the chat and accept the install prompt.

### Option 2: Marketplace

```text
/plugin marketplace add Yoodaddy0311/artibot
/plugin install artibot-cowork@artibot
```

That triggers the bundled `kr-marketing` and `content-pipeline` skills to auto-register.

---

## What's different from the full Artibot plugin

The full `artibot` plugin is a 122-skill, 28-agent orchestration framework built around developer workflows (TDD, code review, git automation, build pipelines). It depends on Node.js hooks and external scripts not designed for the Cowork sandbox.

`artibot-cowork` is a curated subset focused on tasks Cowork users actually do:

- **No hooks, no external scripts.** No `hooks.json`, no `scripts/`, no `lib/`, no `server/`, no `runtime/`. Nothing runs in the background.
- **No developer-only components.** Removed: all `lang-*`, `persona-*`, `git-*`, `ddd-*`, `tdd-*`, `fp-refactor`, `coding-standards`, `testing-standards`, `ci-cd-pipelines`, `production-code-audit`, etc.
- **Marketing, content, data, design, and CRO/SEO only.**
- **Claude Design** — 마케팅 에셋 제작 워크플로우 (랜딩페이지, 이메일, 소셜 카드, 슬라이드).
- **Routines** — 마케팅 자동화 루틴 설계 (스케줄/API/GitHub 트리거).
- **Ultraplan** — 심층 마케팅 전략 기획 (Simple/Visual/Deep 변형).
- **Monitor** — 캠페인 성과 실시간 모니터링 워크플로우.
- **Swarm & evolution loop** as guide/reference — participate in collective learning via opt-in.
- **SDK for Cowork** — create custom skills and agents with `/sdk`.
- **One MCP server**: `context7` (library documentation lookup).

---

## Contents

### Skills (46)

**Marketing & Content**: `advertising`, `campaign-planning`, `competitive-intelligence`, `content-seo`, `copywriting`, `email-marketing`, `lead-management`, `marketing-analytics`, `marketing-strategy`, `segmentation`, `social-media`

**Long-form Writing**: `long-form-writing`, `case-study`, `column-editorial`, `thought-leadership`, `interview-storytelling`, `voice-reference`

**Korean Market**: `kr-marketing` (Naver C-Rank/DIA SEO, Kakao Moment, PIPA compliance, Korean platform guide)

**Research & Compliance**: `market-research` (TAM/SAM/SOM, survey design, trend analysis), `ad-compliance` (표시광고법, PIPA, FTC, GDPR)

**Quality**: `ai-slop-reviewer` (AI pattern detection, text quality scoring — run after any text output)

**Data & Reporting**: `ab-testing`, `data-analysis`, `data-visualization`, `report-generation`

**Design & Creative** *(v3.1 new: claude-design)*: `brand-guidelines`, `claude-design`, `design-system-reference`, `image-generation`, `library-mermaid`, `presentation-design`

**CRO & SEO**: `cro-forms`, `cro-funnel`, `cro-page`, `customer-journey`, `seo-strategy`, `technical-seo`

**Automation & Pipeline** *(v3.1 new: routines)*: `content-pipeline`, `routines`, `schema-generator`

**Collective Intelligence** *(v3.0 new)*: `swarm-intelligence`, `evolution-loop`

**General utilities**: `clarify`, `daily`, `delegation`, `principles`

### Agents (12)

| Agent | Model | Role |
|-------|-------|------|
| `orchestrator` | Opus 4.7 | CTO-level team coordinator (marketing playbooks) |
| `planner` | Opus 4.7 | Campaign & project planning specialist |
| `marketing-strategist` | Opus 4.7 | Market analysis, GTM, growth strategy |
| `content-marketer` | Sonnet | Blog, social, email, brand voice |
| `long-form-writer` | Sonnet | Pipeline stages 3-4 — deep-dive drafts, self-scores via quality rubric |
| `case-study-writer` | Sonnet | 5-block case studies with quote-approval workflow |
| `data-analyst` | Sonnet | Marketing metrics, reports, dashboards |
| `presentation-designer` | Sonnet | Slide decks, pitch decks, visual narrative |
| `seo-specialist` | Sonnet | Technical SEO, keyword strategy, rankings |
| `cro-specialist` | Sonnet | Conversion rate optimization, funnel analysis |
| `ad-specialist` | Sonnet | Paid media copy, campaign structure, A/B variants |
| `doc-updater` | Sonnet | Documentation, README, guides |

### Commands (21)

**Marketing & Strategy**: `/ad`, `/analytics`, `/analyze`, `/content`, `/crm`, `/cro`, `/mkt`, `/seo`, `/social`

**Content & Design**: `/design`, `/document`, `/email`, `/excel`, `/ppt`, `/playbook`

**Utilities**: `/daily`, `/explain`

**v3.0 New**: `/sdk`, `/swarm`

**v3.1 New**: `/ultraplan`, `/monitor`

### MCP servers

- **context7** — on-demand library/framework documentation lookup via `npx`

---

## v3.1 Highlights (2026-04 Claude Feature Integration)

### Claude Design 연동

마케팅 에셋 제작 전용 워크플로우 (`skills/claude-design/`):

| 에셋 타입 | 스킬 체인 |
|----------|---------|
| 랜딩페이지 프로토타입 | `campaign-planning` → `brand-guidelines` → **claude-design** → `cro-page` |
| 이메일 템플릿 | `email-marketing` → `brand-guidelines` → **claude-design** → `copywriting` |
| 소셜 카드 | `social-media` → `image-generation` → **claude-design** |
| 프레젠테이션 | `presentation-design` → `data-visualization` → **claude-design** |

디자인 시스템 추출 + Claude Code 핸드오프 번들 생성 지원.

### Routines 마케팅 자동화

반복 마케팅 워크플로우 자동화 가이드 (`skills/routines/`):

| 루틴 | 트리거 | 연계 스킬 |
|------|--------|---------|
| 야간 캠페인 리포트 | 매일 23:00 | `marketing-analytics` |
| 주간 콘텐츠 캘린더 | 매주 월 09:00 | `campaign-planning` |
| PR 머지 문서 업데이트 | GitHub PR 머지 | `data-analysis` |
| 경쟁사 모니터링 | 매주 수 09:00 | `competitive-intelligence` |

템플릿 전체 목록: `skills/routines/references/marketing-routine-templates.md`

### Ultraplan 전략 기획

심층 마케팅 전략 기획 모드 (`/ultraplan`):

| 변형 | Effort | 출력 |
|------|--------|------|
| `simple` | medium | 1-페이지 브리프 + 다음 3가지 액션 |
| `visual` | high | Mermaid 플로우 + 타임라인 + RACI |
| `deep` | **xhigh** | 시장분석 + 포지셔닝 + 채널전략 + KPI + 로드맵 |

```
/ultraplan Q3 B2B SaaS growth campaign
/ultraplan deep 경쟁사 대응 전략 --budget scale
```

### Monitor 캠페인 감시

캠페인 성과 모니터링 워크플로우 설계 (`/monitor`):
- 이상 감지 패턴 정의 (CTR 급락, CPC 급등, 순위 하락 등)
- 3단계 알림 체계 (Warning / Alert / Critical)
- `routines` 스킬과 연동하여 자동화

```
/monitor Q3 Google Ads performance --threshold "CTR<2%"
/monitor SEO keyword rankings --interval daily
```

### Opus 4.7 모델 정책 업데이트

| 역할 | 모델 | Effort |
|------|------|--------|
| Orchestrator | Opus 4.7 | xhigh (팀 오케스트레이션) |
| Planner, Marketing-Strategist | Opus 4.7 | high |
| 나머지 9개 에이전트 | Sonnet | medium |

### Auto Mode 안전 가이드

`principles` 스킬에 Auto Mode 허용/차단 기준 추가:
- **허용**: 리서치, 초안 생성, 데이터 집계, 스킬 체인
- **차단**: 외부 발행, 예산 집행, 계정 설정 변경, 법적 문서

### 신규 오케스트레이터 플레이북

| 플레이북 | 에이전트 | 용도 |
|---------|---------|------|
| `design-asset-creation` | planner + strategist + designer + cro + ads | Claude Design 에셋 제작 |
| `campaign-automation` | planner + strategist + analyst + content | Routines 기반 자동화 설계 |

---

## v0.4.0 Highlights — Content Pipeline

The 0.3.0 writing skills wired into an end-to-end content pipeline with specialist agents, AEO/GEO tooling, and executable quality rubrics.

| Addition | Purpose |
|----------|---------|
| `content-pipeline` skill | 5-stage orchestration (persona → brief → outline → draft → review → publish) with explicit handoff contracts |
| `schema-generator` skill | Emits JSON-LD (`Article`/`FAQPage`/`HowTo`/`QAPage`), `<meta>` tags, and citable-passage markers from finished drafts |
| `long-form-writer` agent (Sonnet) | Specialist owning pipeline stages 3-4; self-scores via long-form-quality rubric, maxTurns=30 |
| `case-study-writer` agent (Sonnet) | Specialist for 5-block case studies with quote-approval workflow |
| Smoke test suite | 3 fictional briefs + writing-pack.test.md covering frontmatter, triggers, dependency graph, allow-lists |

---

## v3.0 Highlights

### Agent Team Orchestration (Marketing Playbooks)

The orchestrator includes four marketing-specific playbooks:

| Playbook | Agents | Output |
|----------|--------|--------|
| `marketing-campaign` | planner + strategist + content + data + seo/cro | Full campaign brief + KPI framework |
| `marketing-audit` | planner + strategist + analyst + seo + cro | Prioritized audit report |
| `content-launch` | planner + content + seo + cro | SEO-optimized content ready for publish |
| `competitive-analysis` | planner + strategist + seo + analyst | Competitive intelligence report |

### Swarm Intelligence (Guide Mode)

Participate in collective learning via the swarm network. In Cowork, the `/swarm` command provides a guide-based interface:

```
/swarm status    — check participation state
/swarm opt-in    — guide to enable collective learning
/swarm opt-out   — disable swarm participation
/swarm health    — check server availability
/swarm stats     — view contribution summary
```

Privacy guarantees: SHA-256 anonymization + PII stripping + Laplacian differential privacy (ε=1.0). Opt-in only.

### Evolution Loop (Reference)

The `evolution-loop` skill explains Artibot's GRPO-based self-improvement cycle:
- **GRPO**: Group Relative Policy Optimization — preference training over response variants
- **Pattern scoring**: Frequency (30%) + Success Rate (40%) + Novelty (15%) + Confidence (15%), threshold ≥ 0.75
- **Cowork role**: passive participant via swarm opt-in + manual skill encoding via `/sdk`

Full algorithm: `skills/evolution-loop/references/collective-hub-scoring.md`

### SDK for Cowork

Create custom skills and agents without leaving Cowork:

```
/sdk create-skill competitor-tracker
/sdk create-agent brand-analyst --model opus
/sdk validate
```

Cowork SDK supports `create-skill` and `create-agent`. Hook and middleware creation require the full CLI plugin.

---

## Compatibility

| Environment | Status | Notes |
|-------------|--------|-------|
| **Cowork** | ✅ Primary target | Full feature support |
| **Claude Code** | ✅ Works | Strict subset of upstream plugin |
| **Hooks** | ✅ None | Safe in any sandbox |
| **External binaries** | ✅ Only `npx` | For `context7` MCP server |
| **Agent Teams** | ✅ Supported | Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in Claude Code |

---

## Versioning

| Version | Notes |
|---------|-------|
| **v3.1.0** | 2026-04 Claude features — Claude Design, Routines, Ultraplan, Monitor, Opus 4.7 policy, Auto Mode guide |
| **v3.0.0** | CLI v3.0 parity — swarm intelligence, evolution loop, SDK for Cowork, team model policy, marketing playbooks |
| **v0.4.0** | Content pipeline — content-pipeline, schema-generator, long-form-writer + case-study-writer agents, AEO/GEO tooling |
| **v0.3.0** | Long-form writing pack — blog, case-study, column, thought-leadership, interview, voice-reference |
| **v0.2.0** | ai-slop-reviewer, kr-marketing, market-research, ad-compliance |
| **v0.1.0** | Initial release |

This package tracks the upstream `artibot` content but with its own release cadence. When upstream skills/agents change, this package pulls updates selectively (marketing/content domains only).

---

## License

MIT (matches upstream `artibot`).
