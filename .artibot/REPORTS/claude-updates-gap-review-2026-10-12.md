# Claude 공식 업데이트(2026-10-02~2026-10-12) 대비 Artibot 4.71.6 갭 리뷰

작성: 2026-10-12 13:08 KST. 기준 HEAD: `93d82b4e` (v4.71.6). 수집 창: 2026-10-02~2026-10-12 (2026-10-01 은 경계로 표기).

이 문서는 검토 결과다. 실행 상태·미션 계획의 새 정본이 아니다. 제품 코드, 설정, 활성 규칙은 변경하지 않았다.

**방법**: 수집 6 에이전트(Claude Code changelog 3구간 · 플랫폼/SDK · 앱/뉴스 · 플러그인 인벤토리) → 7 렌즈(효율성 · 경제성 · 속도 · 전문성 · 워크플로우 확장성 · 미래지향성 · AGI 방식, 각 artibot:architect) → 병합 → 적대적 검증 2축(호스트 근거 = 수집 원문 대조, 오프라인 / 플러그인 갭 = artibot:auditor 가 리포 재확인) → 합성. 모델은 전부 opus(라우팅 CLI 판정), effort high.

**리더 보정**: 2.1.290~2.1.293 구간은 웹 수집기가 3시간 동안 끝나지 않아(WebFetch 50회) 리더가 raw CHANGELOG 를 curl 로 받아 결정적으로 파싱해 대체했다(340 bullet 중 227 유지, 날짜는 code.claude.com 헤딩). 누락 출처 점검도 리더가 수행했다: Anthropic 엔지니어링 블로그 · Claude Desktop/Chrome 릴리스 노트는 기간 내 항목을 찾지 못해 미확인. 상위 제안(P-1~P-5 · P-7)의 file:line 인용과 카탈로그 가격(haiku 4.5 행, sonnet cacheRead 0.2)은 리더가 2026-10-12 에 다시 열어 일치를 확인했다. 호스트 쪽 검증은 수집 원문 기준이며 라이브 호스트 동작(effort 파라미터의 실제 효과, 팀원 신원 페이로드 등)은 실측하지 않았다.

워크플로우: `wf_93747b2c-f2d`(수집, 중단) · `wf_304e8615-8cb`(분석~합성: 에이전트 15, 도구 호출 233, 19분). 입력 파일은 세션 scratchpad `gap-review/` 에 있다(updates-claude-code.md · updates-platform-sdk.md · updates-apps-news.md · inventory.md · sources.md).

---


## 1. 요약

이번 기간에 나온 호스트 변경 중 Artibot 에 가장 크게 걸리는 것은 세 가지입니다.

- **Agent `effort` 파라미터 추가**: 2.1.292 부터 생겼습니다(cc-2.1.292-2).
- **Haiku 5.5 출시와 기본 Haiku 교체**: cc-2.1.293-1, pf-2026-10-07-2.
- **Sonnet 5.5 캐시 읽기 가격 인하**: $0.20 에서 $0.10 으로 내려갔습니다(pf-2026-10-07-1).

플러그인은 이 세 가지를 모두 반영하지 못했습니다. 그 결과는 다음과 같습니다.

- `/team` 문서와 firewall 테스트가 "Agent 에는 effort 파라미터가 없다"를 사실로 고정하고 있습니다.
- 가격표가 sonnet 캐시 읽기를 2배로 기록하고 있습니다.
- `claude-haiku-5-5` 사용량은 영수증에서 빠집니다.

제안 19건 중 반증된 것은 없습니다. 플러그인 쪽 갭은 19건 모두 확인됐습니다(gap confirmed). 호스트 쪽 근거는 18건이 확인됐고 1건(P-6)은 검증 결과가 없어 unverified 입니다. 검수자는 8건의 우선순위를 낮췄습니다.

**핵심 권고 (우선순위순)**

1. **P-1 (P0)**: effort 관련 낡은 사실을 정정합니다. 대상은 team.md:79·:67, effort-policy.js:4·:17-18, firewall 핀이고 한 커밋에서 고칩니다.
2. **P-2 (P0)**: Sonnet 5.5 캐시 읽기를 $0.10 으로 바꿉니다. PRICING_VERSION 을 올리고 과거 가격은 동결합니다.
3. **P-3 (제안 P0, 검수 P1)**: haiku 티어를 `claude-haiku-5-5` 로 옮기고 100K 구간 가격 스키마를 만듭니다. P-2 와 같은 커밋으로 묶습니다. **보류 — 오너 결정 2026-10-12, route-scorer 비용항 설계 선행.**
4. **P-4 (P1)**: model-routing resolve 가 effort 도 출력하게 하고, 스폰 시 실제로 적용합니다. 실측 프로브와 오너 승인이 먼저 필요합니다.
5. **P-5·P-7 (P1, verify-only)**: `/team` 라이프사이클을 재측정하고, `agent.spawn` mod 로 라우팅을 강제할 수 있는지 프로브합니다. `/assemble` 의 sonnet 하드코딩은 프로브와 별개로 바로 고칠 수 있습니다.

## 2. 수집 범위·출처

- **기간**: 2026-10-02~2026-10-12 이 범위 안(in)입니다. 2026-10-01 은 경계(boundary)로 표기했습니다. 작성일은 2026-10-12 입니다.
- **수집 항목 수 (counts 그대로)**:

| 제품 | 수치 |
|---|---|
| Claude Code changelog | 552건 유지 / 669건 검토 (Added·Changed 는 전부, Fixed·Improved 는 키워드로 필터) |
| Platform·API·SDK·Managed Agents | 44건 |
| Claude 앱·Anthropic 뉴스 | 41건 |
| Artibot 인벤토리 | 실측 사실 40, 로드맵 항목 17, 미확인 10 |
| 읽은 출처 | 39 |

- **읽은 공식 출처**:
  - code.claude.com changelog 와 raw CHANGELOG.md(offset 0·100000). 2.1.290~2.1.293 은 리더가 curl 로 직접 파싱했습니다.
  - platform.claude.com: release-notes, pricing, effort, api-credits-for-subscribers, Haiku 5.5 overview·whats-new·migration-guide, browser-use-sdk, managed-agents workflow-runs·multiagent-orchestration, agent-sdk overview.
  - Agent SDK Python·TypeScript GitHub releases.
  - claude.com: blog 와 하위 글(mods, Google Docs, dashboards-and-motion, Block, startups), cowork changelog.
  - support.claude.com release-notes 등.
  - anthropic.com: news, claude-haiku-5-5, usage-policy, Barclays 외.
- **읽지 못한 것 (미확인)**:
  - platform release-notes 의 100000자 이후 부분. 9/30 이전 항목만 있다고 판단했습니다.
  - Agent SDK TS·Python releases 는 1페이지만 읽었습니다(Python 은 18페이지 중 1페이지).
  - SDK 쪽 CHANGELOG.md 두 개.
  - prompting-claude-haiku-5-5, computer-use·browser-use tool 페이지, Compliance API, Dreams 페이지, Managed Agents environments·web 제한 페이지, quickstarts browser-toolset, Haiku 5.5 system card.
  - 블로그 "a-harness-for-every-task-dynamic-workflows-in-claude-code".
  - Claude in Chrome release notes 는 HTTP 404 였습니다.
  - Cowork changelog 의 100000자 이후 부분.
  - 열지 않은 글: Comcast·Booz Allen, Cresta, claude.dev 글 4편.
- **수집 방식의 한계**:
  - WebFetch 는 한 번에 125자까지만 인용합니다. 그래서 긴 bullet 은 조각을 이어 붙였고, 바이트 단위로 대조하지 않았습니다.
  - cc-2.1.288 bullet 29~34·36 은 원문이 아니라 요약입니다. 본문 앞에 "[요약·원문 아님]" 표기가 있습니다.
  - 2.1.295 의 긴 Fixed bullet 일부는 앞 120자만 확보했습니다.
  - 2.1.290~2.1.293 웹 수집기는 끝나지 않았습니다(3시간 동안 WebFetch 50회). 결정적 파싱으로 대체했고 340건 중 227건을 남겼습니다.

## 3. 검증 통과 제안

판정 표기: **H** = 호스트 쪽 근거 검증(host_claim), **G** = 플러그인 쪽 갭 검증(plugin_gap / already_planned / 교정 우선순위).

| ID | 우선순위(제안→검수) | 종류 | 제목 | 렌즈 | 호스트 근거 id | 플러그인 근거 file:line | 노력 | 등급 |
|---|---|---|---|---|---|---|---|---|
| P-1 | P0→P0 | change | 낡은 effort 사실 정정 | speed·agi·efficiency·future | cc-2.1.292-2, pf-doc-8, pf-doc-7, pf-doc-6, cc-2.1.288-39 | commands/team.md:79, :67; tests/firewall/constitution-stage-a-commands.test.js:223-225; lib/cognitive/effort-policy.js:4, :17-18 | M | 실측 |
| P-2 | P0→P0 | change | Sonnet 5.5 캐시 읽기 $0.10 + PRICING_VERSION | economy·future·efficiency | pf-2026-10-07-1, pf-doc-28, cc-2.1.296-9 | lib/core/model-catalog.js:284, :141, :164-166, :293-298; lib/core/pricing-history.js:50 | S | 실측 |
| P-3 | P0→**P1** | change | haiku → claude-haiku-5-5 + 100K 구간 가격 (**보류** — 오너 결정 2026-10-12, route-scorer 비용항 설계 선행) | economy·future·efficiency | cc-2.1.293-1, pf-doc-1~5, pf-doc-12, pf-doc-18, pf-doc-27, cc-2.1.295-36 외 | lib/core/model-catalog.js:233-260, :525-531; lib/economics/usage-receipt.js:635-639; docs/CLAUDE-MODEL-CATALOG.md:20 | M | 실측 |
| P-4 | P1→P1 | change | Agent effort 파라미터로 실제 적용 | efficiency·economy·speed·expertise·extensibility·future·agi | cc-2.1.292-2, cc-2.1.288-39, pf-doc-6~8, cc-2.1.295-106, cc-2.1.296-3 | scripts/model-routing/model-routing.mjs:735; commands/team.md:136-142, :176-180; lib/cognitive/effort-policy.js:42-43; lib/cognitive/workflow-plan.js:269 | M | 실측 |
| P-5 | P1→P1 | verify-only | /team 라이프사이클 라이브 재측정 | speed·expertise·extensibility·agi | cc-2.1.288-39, cc-2.1.288-53, cc-2.1.289-1, cc-2.1.290-15, cc-2.1.290-154, cc-2.1.292-68, cc-2.1.295-63, cc-2.1.295-73 | commands/team.md:200, :229, :176; .claude-plugin/plugin.json:19; lib/core/hook-utils.js:367-375 | S | 추론 |
| P-6 | P1→**P2** | change | llm-architect·llm.csv 를 Haiku 5.5 기준으로 갱신 | expertise | pf-2026-10-07-2·3·4, pf-doc-1·5·6·10~13·15·17·18·24, cc-2.1.293-1, app-2026-10-07-1 | agents/llm-architect.md:59-66; rules/csv/llm.csv:3; skills/ai-security-standards/SKILL.md:90 | M | 실측 |
| P-7 | P1→P1 | verify-only | mod agent.spawn 으로 라우팅 강제 프로브 | extensibility | cc-2.1.287-1, cc-2.1.289-1, cc-2.1.292-6, cc-2.1.292-50, cc-2.1.296-36, (app-2026-10-01-1: 오기) | scripts/hooks/route-observe-pre.js:18-31, :49-52; commands/assemble.md:89,94,99,104,109 | M | 추론 |
| P-8 | P1→**P2** | extend | 미지 id 를 모델 계열(line)로 폴백 + 드리프트 점검 | future | pf-2026-10-01-1, pf-2026-10-05-1, pf-2026-10-06-1, cc-2.1.293-1 | lib/core/model-catalog.js:525-531, :262-267, :146-151; lib/runtime/middleware/cache-roi.js:105-112 | M | 실측 |
| P-9 | P2→P2 | change | Workflow 에이전트에 모델 라우팅 + 용어집 | extensibility·efficiency·economy·agi | cc-2.1.296-3, cc-2.1.292-6, cc-2.1.296-50, cc-2.1.295-41, pf-2026-10-09-1, pf-doc-21 | commands/dynamic.md:67-68, :54-58; commands/autopilot.md:50; docs/ORCHESTRATION-GLOSSARY.md:27 | S | 미확인 |
| P-10 | P2→**P3** | extend | 장기 에이전트 autoCompactWindow (SH-16 실측 뒤) | agi·efficiency·speed·expertise | cc-2.1.296-2, cc-2.1.288-12, cc-2.1.293-4, cc-2.1.296-19 | agents/orchestrator.md:1-22; hooks/hooks.json:144-171 | S | 미확인 |
| P-11 | P2→**P3** | extend | CA-02 canary 를 Haiku 5.5 로 재평가 | efficiency·economy·speed | pf-2026-10-07-2, app-2026-10-07-1, pf-doc-1·6·7·27·28, cc-2.1.293-1 | artibot.config.json:870-874; lib/routing/action-classifier.js:99-100; lib/core/model-canary.js:99 | M | 추론 |
| P-12 | P2→**P3** | change | 번들 MCP @latest 고정 + alwaysLoad:false | efficiency·speed | cc-2.1.296-11, cc-2.1.287-15, cc-2.1.288-60, cc-2.1.295-18, cc-2.1.292-60, cc-2.1.292-71 | .mcp.json:2-15 | S | 미확인 |
| P-13 | P2→**P3** | verify-only | PreToolUse 훅 지연 --debug 실측 | efficiency·speed | cc-2.1.296-21, cc-2.1.287-1, cc-2.1.295-1, cc-2.1.295-82, (app-2026-10-01-1: 무관) | hooks/hooks.json:21-116, :130-143, :172-199; hooks/dispatch-table.json:29-33 | M | 추론 |
| P-14 | P2→**P3** | change | compatibility.claudeCode 하한 | extensibility·future | cc-2.1.288-39, cc-2.1.292-2, cc-2.1.289-1 | .claude-plugin/plugin.json:18-21; tests/firewall/host-payload-contract.test.js:305 | S | 미확인 |
| P-15 | P2→P2 | verify-only | 30개 에이전트 frontmatter --debug 검증 | expertise·extensibility | cc-2.1.296-19, cc-2.1.292-76 | agents/llm-architect.md:35-36; agents/orchestrator.md:3-5,21 | S | 미확인 |
| P-16 | P2→P2 | change | PRD-DREAMING 의 낡은 상태·모델 정정 | agi | pf-2026-10-01-2, pf-2026-10-07-5, pf-doc-19 | docs/PRD-DREAMING.md:3-4, :8, :10; commands/dreaming.md:44-47 | S | 실측 |
| P-17 | P2→P2 | extend | 안전 PreToolUse 가드에 onFailure:"block" | agi | cc-2.1.295-1, cc-2.1.288-54 | hooks/hooks.json (PreToolUse 9항목, onFailure 0건) | S | 추론 |
| P-18 | P3→P3 | verify-only | 재작성 안 함, `claude agents` 백그라운드만 관찰 | extensibility | pf-2026-10-09-1, pf-doc-21, pf-doc-22, cc-2.1.290-7, cc-2.1.296-50, cc-2.1.295-41 | commands/autopilot.md:50; commands/split.md:10; commands/dynamic.md:54-58 | S | 추론 |
| P-19 | P3→P3 | verify-only | 내장 "You should know" 와 공존 관찰 | agi | cc-2.1.287-2, cc-2.1.288-61 | output-styles/artibot-narrative.md:74 (무관 문구뿐) | S | 실측 |

플러그인 근거 경로는 모두 `plugins/artibot/` 기준입니다.

### 제안별 상세

**P-1 낡은 effort 사실 정정 (P0, 실측)**
- 무엇을: team.md:79 의 "Agent 에는 effort 파라미터가 없다"와 :67·effort-policy.js:17 의 "기본 high", effort-policy.js:4 의 "Opus 4.8" 머리말을 고칩니다. firewall 핀도 같은 커밋에서 바꾸고 "2.1.292+" 조건을 명시합니다.
- 왜: 2.1.292 부터 Agent 에 effort 가 있습니다(cc-2.1.292-2). Opus 5.5 와 Haiku 5.5 의 기본값은 medium 입니다(pf-doc-8, pf-doc-6). agents/llm-architect.md:62 는 이미 medium 이라고 적고 있어 플러그인 안에서 말이 엇갈립니다.
- 위험: 2.1.292 미만 호스트에서의 동작은 미확인입니다. 그래서 디렉티브 폴백은 남겨야 합니다. 핀을 같이 바꾸지 않으면 테스트가 RED 가 됩니다.
- 판정: H=confirmed. "medium 기본" 근거로 pf-doc-7 을 든 것은 잘못이고 pf-doc-6·pf-doc-8 이 맞습니다. 2.1.292 미만 동작은 unverified 입니다. G=confirmed, already_planned=no, P0 유지입니다. 설치된 호스트 버전은 측정하지 않았습니다.
- 측정(2026-10-12, 리더 메인 세션): 호스트 2.1.296(`claude --version`, 리뷰어 측정)의 메인 세션에서 `Agent` 도구 스키마의 파라미터는 description·isolation·mode·model·name·prompt·subagent_type·team_name 이었고 effort 는 없었습니다. changelog 2.1.292 항목과 어긋나므로 노출 조건은 알려지지 않았습니다. 서브에이전트 세션은 같은 방식으로 재지 않았고 그쪽 진술은 관측 보고(근거 미기록)입니다. 위 판정의 "호스트 버전 미측정"은 이 측정으로 갱신됩니다.

**P-2 Sonnet 5.5 캐시 읽기 $0.10 (P0, 실측)**
- 무엇을: model-catalog.js:284 의 0.2 를 0.1 로 바꿉니다. PRICING_VERSION 을 2026-10-07 로 올리고 2026-09-28 행은 pricing-history 에 동결합니다. :164-166 주석을 고치고 priceSource 를 official-table 로 올립니다.
- 왜: 호스트 `/cost` 는 이미 $0.10 입니다(cc-2.1.296-9). 그래서 플러그인 영수증은 같은 세션의 캐시 읽기를 2배로 기록합니다. 오너 라우팅상 implement 가 sonnet 이라 지금도 과다 기록이 쌓이고 있습니다.
- 위험: 10-07 이후 이미 쓰인 영수증은 소급 정정되지 않습니다. 과다 기록 규모는 미측정입니다. 효력일은 release-note 날짜로 추정한 것입니다.
- 판정: H=confirmed. G=confirmed, already_planned=no, P0 입니다. 제안의 "catalog-pricing-sync 코드 0건"은 틀렸습니다. 이 작업은 249607af 로 착지했고 완료 상태입니다(V5-BACKLOG.md:111). 다만 판정은 바뀌지 않습니다.

**P-3 haiku → claude-haiku-5-5 (P0→P1, 실측)**
- 상태: **보류 — 오너 결정 2026-10-12, route-scorer 비용항 설계 선행.** 카탈로그 haiku 티어는 `claude-haiku-4-5` 로 남겨 두었습니다. 이전을 시도했을 때 `getCostFactor('haiku')` 가 0.25 에서 0.025 로 떨어져 `tests/routing/route-scorer.test.js` 2건(explore · edit-routine 순위가 haiku 로 뒤집힘)이 RED 였습니다(2026-10-12 실측).
- 무엇을: haiku 행을 Haiku 5.5 로 바꿉니다. 값은 $0.10/$0.50, 프롬프트 100K 초과 시 $0.50/$2.50, 1M/128K, adaptive 입니다. 100K 구간 가격 스키마를 만들고, claude-haiku-4-5 는 legacyIds 에 남깁니다. P-2 와 같은 커밋으로 묶습니다.
- 왜: 정확 일치로만 id 를 해석해서(model-catalog.js:525-531) 5.5 행은 영수증에서 빠집니다(usage-receipt.js:635-639). Sonnet 5.5 때와 같은 구조입니다.
- 위험: 스키마 변경이 getPricing·usage-receipt·cache-roi 에 닿습니다. 서브에이전트 haiku 서빙값과 누락액은 미측정입니다. route-scorer 순위가 바뀔 수 있습니다.
- 판정: H=confirmed. cc-2.1.295-36 은 게이트웨이 구성에만 해당합니다. G=confirmed, already_planned=no, **P1 로 하향**입니다. 이유는 플러그인의 haiku 사용이 거의 0 이기 때문입니다. route-scorer.js:401 은 resolveCostFactor 이고 값 0.25 는 실행하지 않았습니다.

**P-4 Agent effort 파라미터 실제 적용 (P1, 실측)**
- 무엇을: model-routing.mjs resolve 가 `--task` 축으로 effort 도 출력하게 합니다. /team·/autopilot·/orchestrate 스폰 템플릿이 그 값을 그대로 넘깁니다.
- 왜: 지금 effort 는 권고 텍스트일 뿐입니다(effort-policy.js:42-43). resolve 는 모델 한 단어만 출력합니다(:735, "ffort" 0건).
- 위험: 2026-09-29 오너 결정(Opus=high, Sonnet=max)과 충돌할 수 있어 하향 옵트인 + 오너 승인이 필요합니다. maxEffortLevel 이 Agent 파라미터를 상한하는지는 미확인입니다. 2.1.292 미만 호스트 동작도 미확인입니다.
- 판정: H=confirmed. cc-2.1.295-106 은 xhigh/max 에서의 버그 수정이라 "높은 effort 의 일반적 지연 비용" 근거로는 과장입니다. `/tasks` 에 서브에이전트 effort 가 표시된다는 기록이 있습니다(범위 밖 CHANGELOG, id 없음). G=confirmed, already_planned=no, P1 입니다.

**P-5 /team 라이프사이클 재측정 (P1, 추론)**
- 무엇을: 현 호스트에서 다음을 1회 라이브로 잽니다.
  - 팀원 transcript 의 system prompt·도구 목록
  - TeammateIdle·SubagentStart 키
  - 유휴 중 완료 알림이 리더를 깨우는지
- 왜: 정지 회피 규칙(최장 818분, team.md:200·:229)은 2.1.288~2.1.295 수정 이전 호스트에서 잰 것입니다.
- 위험: judge 티어는 프로브를 실행할 수 없습니다. 실행은 process 팀원, 판정은 judge 팀원으로 나눠야 합니다. 과거 /team 이 기본 프롬프트로 돌았는지는 추론입니다.
- 판정: H=confirmed. 818분 정지 자체를 고쳤다는 항목은 없어 unverified 입니다. G=confirmed, already_planned=**yes** (NS-team-probe 가 일부만 덮음), P1 입니다.

**P-6 llm-architect·llm.csv 를 Haiku 5.5 로 갱신 (P1→P2, 실측)**
- 무엇을: 모델표에 Haiku 5.5 행을 넣습니다. llm.csv:3 규칙을 모델 id 허용 목록으로 바꿉니다. SKILL.md:90 의 legacy id 를 고칩니다.
- 왜: 분류·대량 작업에 sonnet 만 권하고 있습니다. sampling-params 규칙은 Opus 4.7+/4.8 에만 적용됩니다.
- 위험: 규칙을 "모든 5.x"로 넓히면 오탐이 납니다. P-3 에 의존합니다.
- 판정: H=**unverified** (verifier 가 아무것도 반환하지 않음). G=confirmed, already_planned=no, **P2 로 하향**입니다(런타임이 아닌 권고 지식). temperature·prefill·budget_tokens 400 주장은 검증하지 않았습니다.

**P-7 agent.spawn mod 강제 프로브 (P1, 추론)**
- 무엇을: agent.spawn 이 model·effort 를 다시 쓸 수 있는지, 아니면 거부만 하는지 프로브합니다.
- 왜: route-observe-pre.js 는 관찰만 합니다. 이제 agent.spawn 이 팀원과 workflow 에이전트까지 봅니다(cc-2.1.289-1, cc-2.1.292-6).
- 위험: 거부형 가드가 잘못되면 모든 스폰이 막힙니다. TypeScript mods 와 zero-deps 원칙이 맞는지는 미확인입니다.
- 판정: H=confirmed. 호스트 기록상 확인된 것은 "refuse" 뿐이고 rewrite 는 unverified 입니다. app-2026-10-01-1(Barclays)은 오기이며 app-2026-10-01-2 가 맞습니다. G=confirmed, already_planned=no, P1 입니다. 별도 지적: /assemble 이 architect·code-reviewer·security-reviewer 등 5개에 `model="sonnet"` 을 하드코딩한 것은 설계·검수=opus 규칙 위반입니다. 프로브 없이 바로 고칠 수 있습니다.

**P-8 모델 계열 폴백 + 드리프트 점검 (P1→P2, 실측)**
- 무엇을: MODELS 에 `line` 을 둡니다. 해석되지 않는 id 는 계열로 폴백해 measured:false 로 fold 합니다. 옵트인 GET /v1/models diff 스크립트를 lib 밖에 둡니다.
- 왜: 새 id 를 사람이 고칠 때까지 사용량이 조용히 사라지는 일이 반복됐습니다(Sonnet 5.5 선례, V5-BACKLOG.md:67).
- 위험: API 키·네트워크가 필요해 CI 게이트로는 못 씁니다. line 이 null 인 경우를 처리해야 합니다.
- 판정: H=confirmed. "3주에 두 번"은 Sonnet 5.5 날짜가 없어 unverified 입니다. G=confirmed, already_planned=no, **P2** 입니다. bareModelId 가 날짜 접미사를 제거하는지는 unverified 입니다.

**P-9 Workflow 에이전트 라우팅 (P2, 미확인)**
- 무엇을: dynamic.md:67-68 의 "model 생략(세션 상속)"을 agent() 마다 model-routing CLI 결과를 넣도록 바꿉니다. 용어집에 일곱 번째 지시 대상을 추가합니다.
- 왜: /dynamic·`--runner dynamic` 의 구현 에이전트가 오너 라우팅과 무관하게 세션 모델로 돕니다.
- 위험: `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` 은 judge·verify 까지 낮춥니다. agent() 옵션 이름과 env 와의 우선순위는 미확인입니다.
- 판정: H=confirmed. cc-2.1.296-50 은 "재개 수정"이 아니라 CRLF 스크립트 파일 거부 수정입니다. G=confirmed, already_planned=no, P2 입니다.

**P-10 autoCompactWindow (P2→P3, 미확인)**
- 무엇을: SH-16 실측 뒤 장기 에이전트에 한해 값을 정합니다.
- 왜: 2.1.296 에 서브에이전트 조기 압축 기능이 생겼습니다(cc-2.1.296-2).
- 위험: frontmatter 는 배포 사용자 전원에게 번집니다. `--agents` 정의 경로로 우회할 수 있습니다. 서브에이전트 안에서 PreCompact/PostCompact 가 발화하는지는 미확인입니다.
- 판정: H=confirmed. G=confirmed, already_planned=no, **P3** 입니다(이득 미측정).

**P-11 CA-02 canary Haiku 5.5 재평가 (P2→P3, 추론)**
- 무엇을: P-3 이후 classify/status 표본을 haiku 5.5 와 sonnet 5.5 로 나눠 SH-05 로 비교합니다.
- 왜: Haiku 5.5 입력가는 100K 이하에서 sonnet 의 1/20($0.10 vs $2)입니다.
- 위험: 오너 결정 사항입니다. P-3 이전에 하면 비용 기록이 틀립니다. low effort 에서 검색을 건너뛸 위험이 있습니다(pf-doc-6).
- 판정: H=confirmed. 100K 초과 시 Haiku 는 $0.50 으로 sonnet 기본가의 1/4 입니다. sonnet 장문 가격은 unverified 입니다. G=confirmed, already_planned=**yes** (CA-02), **P3** 입니다. config 주석은 Haiku 4.5 품질 판단이 아니라 modelPolicy 와 오분류 안전을 이유로 듭니다. "Haiku 4.5 시절 판단"이라는 프레이밍은 제안의 추론입니다.

**P-12 번들 MCP 고정·지연 로드 (P2→P3, 미확인)**
- 무엇을: 먼저 /mcp·/context 로 실측합니다. 의미가 있으면 브라우저 2종에 alwaysLoad:false 를 주고 버전을 고정합니다.
- 왜: 3종 모두 `npx -y …@latest` 이고 alwaysLoad 가 없습니다(.mcp.json:2-15).
- 위험: 지연 로드는 첫 호출에 왕복을 더합니다. `@latest` 가 매 세션 레지스트리를 조회한다는 주장은 unverified 입니다.
- 판정: H=confirmed. G=confirmed, already_planned=no, **P3** 입니다. "config-safety 의 :latest 금지와 일치"는 **틀렸습니다**(그 규칙은 Dockerfile 기준). cowork 사례를 보면 루트 .mcp.json 이 자동 로드되는 것으로 보여 "로드 여부 미확인" 위험은 약해졌습니다(추론).

**P-13 PreToolUse 훅 지연 실측 (P2→P3, 추론)**
- 무엇을: 2.1.296 `--debug` 의 훅별 소요 시간으로 Write/Edit 당 node 5개를 잽니다. 유의하면 dispatcher 에 PreToolUse 슬롯을 추가합니다.
- 위험: 훅을 한 프로세스로 묶으면 한 훅의 예외가 다른 가드를 건너뛸 수 있습니다. 호스트가 병렬로 실행하는지는 미확인입니다.
- 판정: H=confirmed. app-2026-10-01-1 은 무관한 참조라 제거해야 합니다. G=confirmed, already_planned=no, **P3** 입니다. "측정된 적 없다"는 일부 틀렸습니다. hook-latency bench 가 있고 완료됐습니다(V5-BACKLOG.md:198, 예산 초과 0). 다만 PreToolUse 슬롯은 없습니다.

**P-14 compatibility 하한 (P2→P3, 미확인)**
- 무엇을: 호스트가 이 필드를 강제하는지 먼저 확인합니다. 강제하면 하한을 올리고, 아니면 advisory 로 문서화합니다. doctor 경고부터 시작합니다.
- 위험: 강제한다면 구버전 사용자의 설치가 막힙니다.
- 판정: H=confirmed. 강제 여부는 unverified 입니다. G=confirmed, already_planned=no, **P3** 입니다.

**P-15 frontmatter --debug 검증 (P2, 미확인)**
- 무엇을: 30개 에이전트의 `memory: {scope: project}` 맵 형식과 비표준 키를 `--debug` 로 1회 확인합니다.
- 위험: 낮습니다. 플러그인 안에 memory.scope 를 읽는 곳이 0건입니다.
- 판정: H=confirmed. 호스트가 맵 형식을 받는지, `--debug` 가 값 형태 오류를 보고하는지는 unverified 입니다. cc-2.1.292-76 은 약한 참조입니다. G=confirmed, already_planned=no, P2 입니다.

**P-16 PRD-DREAMING 정정 (P2, 실측)**
- 무엇을: "코드 미구현"과 "opus-4-8"을 고칩니다. API 크레딧은 재평가 트리거로만 기록합니다.
- 왜: dream 모듈 5개가 실재하고 nightly 훅이 이를 사용합니다.
- 위험: 문서만 바뀝니다. Dreams API 와 PRD 알고리즘이 맞는지는 미확인입니다.
- 판정: H=confirmed. 크레딧은 Max 5x/20x·Team 만 해당하고 Claude Code 는 제외됩니다. G=confirmed, already_planned=no, P2 입니다.

**P-17 가드 훅 onFailure:"block" (P2, 추론)**
- 무엇을: 안전 계약 PreToolUse 가드에만 onFailure:"block" 을 적용합니다.
- 왜: PreToolUse 9항목 모두 timeout 5에 onFailure 가 없습니다. 이는 2026-10-12 에 실측했습니다.
- 위험: 이 Windows 머신은 부하나 최신 대기 모드에서 가짜 타임아웃이 난 전례가 있습니다. dispatcher 에 붙이면 권고형 자식 훅의 타임아웃도 동작을 막습니다. 그래서 dispatch-table 분리가 먼저 필요할 수 있습니다(추론).
- 판정: H=confirmed. plugin hooks.json 이 onFailure 를 존중하는지는 unverified 입니다. G=confirmed, already_planned=no, P2 입니다. 설치 호스트가 2.1.295 이상인지는 unverified 입니다.

**P-18 재작성 안 함 (P3, 추론)**
- 판단: Workflow 는 한 세션 안의 도구라 교차 세션인 /split 을 대신할 수 없습니다. 관찰 대상은 `claude agents` 백그라운드와 attach/logs(cc-2.1.290-7) 하나뿐입니다.
- 판정: H=confirmed. Windows 에서 백그라운드 서비스의 동작은 unverified 입니다. 세션 이름 40자 잘림의 호스트 근거도 unverified 입니다. G=confirmed, already_planned=**yes** (vnext-design 10_ROADMAP.md:71 P6), P3 입니다. /ultraplan 은 미확인입니다.

**P-19 "You should know" 공존 관찰 (P3, 실측)**
- 판단: 호스트 내장 감시 사이드 에이전트(cc-2.1.287-2, boundary)와 플러그인은 통합도 언급도 없습니다. 프로브로만 판단합니다.
- 판정: H=confirmed. "플랜 설정" 의존은 원문에 없어 unverified 입니다. G=confirmed, already_planned=no, P3 입니다. ledger 매치 3건 중 1건만 확인했습니다.

## 4. 기각·보류

**반증된 제안**: 없습니다(refuted 0건).

**미확인으로 남은 제안·주장**
- P-6: 호스트 쪽 검증이 결과를 반환하지 않아 host_claim=**unverified** 입니다.
- 등급이 "미확인"인 제안은 P-9, P-10, P-12, P-14, P-15 입니다. 실행 전에 실측 단계가 필요합니다.
- 이미 계획돼 있어 중복 착수하면 안 되는 제안:
  - P-5: NS-team-probe 가 일부를 덮습니다.
  - P-11: CA-02 가 덮습니다.
  - P-18: vnext-design P6 가 덮습니다.

**검수자가 근거를 정정한 주장 (제안 본문에서 수정 필요)**

| 제안 | 정정 내용 |
|---|---|
| P-1 | "medium 기본"의 근거는 pf-doc-7 이 아니라 pf-doc-6·pf-doc-8 입니다 |
| P-2 | "catalog-pricing-sync 코드 0건"은 오류입니다. 249607af 로 착지했고 완료됐습니다 |
| P-3 | route-scorer.js:401 은 resolveCostFactor 이고, 0.25 는 실행하지 않았습니다 |
| P-4 | cc-2.1.295-106 을 지연 비용 근거로 쓴 것은 과장입니다 |
| P-7 | app-2026-10-01-1 은 오기이며 app-2026-10-01-2 가 맞습니다 |
| P-9 | cc-2.1.296-50 은 재개 수정이 아니라 CRLF 스크립트 거부 수정입니다 |
| P-11 | "Haiku 4.5 시절 품질 판단"이라는 프레이밍은 추론입니다 |
| P-12 | config-safety 의 ":latest 금지"는 Dockerfile 규칙입니다 |
| P-13 | hook-latency bench 가 이미 있습니다(PreToolUse 슬롯만 없음). app-2026-10-01-1 은 무관합니다 |
| P-15 | cc-2.1.292-76 은 약한 참조입니다 |

## 5. 7개 렌즈 매트릭스

| 렌즈 | 결론 |
|---|---|
| 효율성 | 가장 큰 변화는 Agent `effort` 파라미터(cc-2.1.292-2)입니다. 플러그인은 아직 "파라미터 없음", "기본 high"를 전제로 권고 텍스트만 넘깁니다(P-1, P-4). 가격 신호가 낡아 영수증이 `/cost` 와 어긋납니다(P-2, P-3). MCP 선행 로딩과 PreToolUse node 5개는 실측이 먼저입니다(P-12, P-13). |
| 경제성 | 가격표가 공식 가격 변경 두 건을 놓쳤습니다. sonnet 캐시 읽기는 과다 기록되고 claude-haiku-5-5 는 영수증에서 빠집니다(P-2, P-3). effort 실제 적용(P-4)과 Haiku 5.5 canary(P-11)는 측정 뒤 오너 결정과 맞춰 넣어야 합니다. |
| 속도 | 팀원 지연을 줄일 가장 직접적인 수단인 effort 가 쓰이지 않고 있습니다(P-1, P-4). 훅 지연, `npx @latest` 시작 지연, /team 유휴 정지는 지연 수치가 미확인이라 verify-only 또는 P2 입니다(P-13, P-12, P-5). |
| 전문성 | llm-architect·llm.csv 가 Haiku 5.5 이전 지식에 머물러 있습니다(P-6). 이름 스폰 정의 적용(2.1.288)과 effort 파라미터가 생겼는데 호스트 하한이 ">=1.0"입니다(P-5, P-14). frontmatter memory 맵 형식은 1회 점검이 필요합니다(P-15). |
| 워크플로우 확장성 | 재작성할 것은 없습니다(P-18). 남은 갭은 스폰 파라미터입니다. effort 는 텍스트로만 전달되고(P-4), 라우팅은 규율에만 맡겨져 있으며(P-7), workflow 에이전트에는 라우팅이 없습니다(P-9). |
| 미래지향성 | 카탈로그는 정확 일치 + 수기 갱신 구조라 신모델이 나올 때마다 누락이 반복됩니다. 가격 2건 정정(P-2, P-3)에 더해 계열 폴백과 드리프트 점검을 권합니다(P-8). Sonnet 4.5 은퇴(2026-11-30)는 수집 파일에 없어 **미확인**입니다. |
| AGI 방식 | 자율 팀과 autopilot 이 실제 effort 를 통제하지 못합니다(P-4). 팀 라이프사이클·압축·onFailure 같은 새 기본 기능은 가정하지 말고 재프로브해야 합니다(P-5, P-10, P-17). Dreams 와 "You should know"는 문서 정정과 관찰로 충분합니다(P-16, P-19). |

## 6. 검토했으나 불필요

**Claude Code**
- cc-2.1.296-1: 게이트웨이 managed.policies 키입니다. 플러그인과 무관합니다.
- cc-2.1.296-2: 이 렌즈들에서는 간접적입니다. P-10 에서 다룹니다.
- cc-2.1.296-3: 라우팅 사안이라 P-9 에서 다룹니다.
- cc-2.1.296-4: 529 재시도 env 입니다. 사용자 설정입니다.
- cc-2.1.296-5: 동명 플러그인 훅 안내입니다. 이름이 달라 해당 없습니다.
- cc-2.1.296-6: Read allow_large 입니다. 이를 전제한 지침이 없습니다.
- cc-2.1.296-7: 클라우드 세션 UI 입니다.
- cc-2.1.296-8: Claude Tag 메모리입니다.
- cc-2.1.296-9: 가격 사안이라 P-2 에서 다룹니다.
- cc-2.1.296-10: dataviz 색상입니다.
- cc-2.1.296-11: MCP 설명 4,096자입니다. P-12 실측에서 함께 확인합니다.
- cc-2.1.296-12: 백그라운드 전환 UI 입니다.
- cc-2.1.296-13: VSCode Chrome 입니다.
- cc-2.1.296-14: Slack footer 입니다.
- cc-2.1.296-22: transcript GC, 호스트 내부입니다.
- cc-2.1.296-29: Haiku 5.5 토큰 카운트 수정입니다. 영수증은 transcript usage 를 읽습니다.
- cc-2.1.296-34: Workflow 깊은 중첩 잘림입니다. /dynamic 결과는 깊게 중첩되지 않습니다.
- cc-2.1.295-1: P-17 에서 다룹니다.
- cc-2.1.295-2·3·7·16·23·25: 터미널·UI 입니다.
- cc-2.1.295-4: plugin install 설정 경고입니다. 사용자 CLI UX 입니다.
- cc-2.1.295-5: claude -p stderr 입니다.
- cc-2.1.295-6·8·9·11·15·29: 게이트웨이(엔터프라이즈)입니다.
- cc-2.1.295-10: validate README 조언입니다. 설치 줄이 이미 있습니다(README.md:132-133, :548-549).
- cc-2.1.295-12·13·24·28: mod UI 입니다. 플러그인에 mods 가 없습니다.
- cc-2.1.295-14: retry watchdog env 입니다. 사용자 설정입니다.
- cc-2.1.295-17·31: Claude Tag 입니다.
- cc-2.1.295-18: tool search MCP 설명 16,384자입니다. P-12 에서 함께 확인합니다.
- cc-2.1.295-19: skills 프리로드 32개 상한입니다. 3개 수준이라 걸리지 않습니다(전수 계수는 미실시).
- cc-2.1.295-20: /loop 를 쓰지 않습니다.
- cc-2.1.295-21: `claude agents` 서비스입니다. /split·/team 은 이를 구동하지 않습니다.
- cc-2.1.295-22: 커넥터 MCP 협상입니다.
- cc-2.1.295-26: Artifact 권한입니다.
- cc-2.1.295-27: routine 을 쓰지 않습니다.
- cc-2.1.295-30: ws MCP 입니다. 번들 서버는 stdio 입니다.
- cc-2.1.295-32: Slack Grid 입니다.
- cc-2.1.295-36: P-3 에서 legacy 근거로만 씁니다.
- cc-2.1.295-62: Workflow forked skill, 호스트 수정입니다.
- cc-2.1.295-82: async SessionStart 수정입니다. 자동으로 이득을 보며 P-13 에서 확인합니다.
- cc-2.1.294-1·2: prompt/agent 훅입니다. Artibot 은 command 훅만 씁니다.
- cc-2.1.293-1: P-3 에서 다룹니다.
- cc-2.1.293-2: 상태줄 UI 입니다.
- cc-2.1.293-3: mod isDeferred 입니다. mod 도구가 없습니다.
- cc-2.1.293-39: /loop·예약을 쓰지 않습니다.
- cc-2.1.293-45: 스킬 동기화입니다.
- cc-2.1.293-46: 목록 정렬입니다. 에이전트 이름이 ASCII 입니다.
- cc-2.1.293-47: OTel 입니다.
- cc-2.1.292-1: install --marketplace 입니다. 현재 두 줄 안내로 동작합니다.
- cc-2.1.292-3: 529 env 입니다.
- cc-2.1.292-4: mod autocomplete 입니다.
- cc-2.1.292-5: mod model.complete 입니다. API 호출자가 없습니다.
- cc-2.1.292-6: P-7 근거로만 인용합니다.
- cc-2.1.292-21: /loop 입니다.
- cc-2.1.292-72: stdio MCP 협상입니다. 조치가 필요 없습니다.
- cc-2.1.292-73: plugin test 입니다.
- cc-2.1.292-74: UI 입니다.
- cc-2.1.292-75: routine 입니다.
- cc-2.1.292-76: 이름 256자 상한입니다. 이름이 짧습니다.
- cc-2.1.290-1·3·5·144: mod 입니다. mods 를 채택하지 않았습니다.
- cc-2.1.290-2: tool.check agentId 입니다. command 훅에 영향이 없습니다.
- cc-2.1.290-4: 테마 타이핑입니다.
- cc-2.1.290-6·157: 게이트웨이입니다.
- cc-2.1.290-7: UI 이며 P-18 에서만 인용합니다.
- cc-2.1.290-8·9·162: Managed Agents 입니다. 호출하지 않습니다.
- cc-2.1.290-10·11·141·142·143·145·147·148·151·152·159·160·161: 무관 또는 UI 입니다.
- cc-2.1.290-19·20·155: /loop 입니다.
- cc-2.1.290-39·99: 압축 호스트 수정입니다. 변경이 필요 없습니다.
- cc-2.1.290-87: Workflow 재시작, 호스트 수정입니다.
- cc-2.1.290-146: 커맨드·정합성 렌즈 몫입니다.
- cc-2.1.290-149: 훅 출력 개선입니다.
- cc-2.1.290-150: 예약 작업을 쓰지 않습니다.
- cc-2.1.290-153: 호스트 /code-review 입니다.
- cc-2.1.290-154: P-5 재측정 항목입니다.
- cc-2.1.290-156: claude agents /model 입니다.
- cc-2.1.290-158: WebSearch 예산입니다.
- cc-2.1.289-1: P-7 근거로만 인용합니다.
- cc-2.1.288-1: mod 입니다.
- cc-2.1.288-2·3·4·5·6·7·10·11·13: 무관 또는 UI 입니다.
- cc-2.1.288-8: 무인 세션 한정입니다.
- cc-2.1.288-9: 분류기 모델 핀입니다. 해당 env 를 설정하지 않습니다.
- cc-2.1.288-12: /autocompact 입니다. P-10 에 참고합니다.
- cc-2.1.288-15·16·55: 압축 호스트 수정입니다.
- cc-2.1.287-1: mods 도입(boundary)이며 P-7 근거입니다.
- cc-2.1.287-2: P-19 입니다.
- cc-2.1.287-3·4·5·6·7·8·9·10·12·14·16·18·19: 무관 또는 UI 입니다.
- cc-2.1.287-11: 1M 기본(boundary)입니다. 카탈로그가 이미 1M 입니다.
- cc-2.1.287-13: 보안 렌즈 몫입니다.
- cc-2.1.287-15: P-12 입니다.
- cc-2.1.287-17: effort 유지, 호스트 내부입니다.
- cc-2.1.287-29: 압축 수정입니다.

**Platform·API·SDK**
- pf-doc-1·2·3·27: Haiku 5.5 사양·가격입니다. P-3·P-6 에서 다룹니다.
- pf-doc-4: 토크나이저 계수입니다. P-3 에서 결정합니다(렌즈 간 판단 상이).
- pf-doc-5·9·10·11·12·13·17·25: API 요청 전용입니다. 플러그인은 Messages API 를 호출하지 않습니다.
- pf-doc-6: P-1·P-4 근거입니다.
- pf-doc-14: thinking 입력 토큰은 transcript usage 에 실립니다.
- pf-doc-15: 캐시 최소 512, 호스트 사안입니다.
- pf-doc-16: Priority Tier 입니다.
- pf-doc-18: P-3·P-6 입니다.
- pf-doc-19·20: 크레딧입니다. Claude Code 는 제외됩니다.
- pf-doc-21·22·23: Managed Agents 전용입니다.
- pf-doc-24: SDK 를 쓰지 않습니다(지식 갱신은 P-6).
- pf-doc-26: 날짜 있는 변경이 없습니다.
- pf-doc-28: P-2 입니다.
- pf-doc-29: Opus 5.5 가 model-catalog.js:320-325 와 일치합니다.
- pf-2026-10-01-1: 런타임은 Models API 를 호출하지 않습니다(P-8).
- pf-2026-10-01-2: /dreaming 은 로컬 구현입니다(P-16).
- pf-2026-10-05-1·10-06-1: Models API capability 입니다. 조회 경로가 없습니다.
- pf-2026-10-07-1: P-2 입니다.
- pf-2026-10-07-2: P-3 입니다.
- pf-2026-10-07-3: API 파괴적 변경입니다(P-6).
- pf-2026-10-07-4: SDK 툴셋입니다.
- pf-2026-10-07-5: 크레딧입니다(P-16 트리거).
- pf-2026-10-07-6·7·8: Managed Agents 네트워킹입니다.
- pf-2026-10-08-1·2: Compliance API 입니다.
- pf-2026-10-09-1: 서버 API 입니다(P-18).

**Claude 앱·뉴스**
- app-2026-10-01-1~7: boundary 앱 변경과 프로모션입니다. 무관합니다. 10-01-4(Cowork 예약 자동 승인)와 10-01-5(Cowork 1M)는 범위 밖입니다.
- app-2026-10-02-1: 정책·사업 발표입니다.
- app-2026-10-05-1: 앱 변경입니다.
- app-2026-10-05-2: Slack 레거시 봇입니다. 플러그인에 Slack 연동이 없습니다.
- app-2026-10-06-1·2·6~9: Cowork/Desktop 변경입니다.
- app-2026-10-06-3: Startups 크레딧입니다.
- app-2026-10-06-4: 정책 발표입니다.
- app-2026-10-06-5: 게이트웨이 SSO 입니다.
- app-2026-10-06-10: Cowork 클라우드 기본값입니다.
- app-2026-10-07-1: P-3 에서 다룹니다.
- app-2026-10-07-2·3: 크레딧·프로모션입니다.
- app-2026-10-08-1: Dashboards/Motion 입니다.
- app-2026-10-08-2·3·9·12~15: 앱 변경입니다.
- app-2026-10-08-4: 사용 정책입니다(11/12 시행). 관찰만 합니다.
- app-2026-10-08-5·6: 사업 발표입니다.
- app-2026-10-08-7: Block 사례입니다. 오너 라우팅과 같은 방향이라 새 갭이 없습니다.
- app-2026-10-08-8: 통합 desktop 토글입니다.
- app-2026-10-08-10·11: Cowork 플러그인·예약입니다.
- app-2026-10-08-16: 3P import 입니다.
- app-2026-10-09-1·2: 앱 변경입니다.

## 7. 미확인 목록

**제안 등급이 미확인인 것**: P-9, P-10, P-12, P-14, P-15

**호스트 판정 unverified**: P-6 전체(verifier 가 결과를 반환하지 않음)

**제안 안의 개별 미확인 사항**

| 제안 | 미확인 사항 |
|---|---|
| P-1·P-4 | 2.1.292 미만 호스트에서 Agent effort 파라미터 처리. 설치 호스트 버전 |
| P-2 | 효력일 2026-10-07 의 정확한 시각. 과다 기록 규모 |
| P-3 | 서브에이전트 haiku 서빙값(2.1.293 이후). 누락액. 영수증 fold 단위. route-scorer 실값 |
| P-4 | maxEffortLevel 이 Agent 파라미터를 상한하는지. transcript 에 effort 가 기록되는지(`/tasks` 표시는 범위 밖 기록) |
| P-5 | 818분 유휴 기상 정지가 고쳐졌는지. 과거 /team 실행의 호스트 버전 이력 |
| P-6 | Haiku 5.5 의 temperature·prefill·budget_tokens 400 주장 |
| P-7 | agent.spawn 의 model·effort 재작성 가능 여부. mods TS 와 zero-deps 정합. sec-default 상호작용 |
| P-8 | Sonnet 5.5 추가 날짜. bareModelId 의 날짜 접미사 제거. `line` 필드 실측 |
| P-9 | agent() model 옵션 이름. env 와 단계별 model 의 우선순위 |
| P-10 | 서브에이전트 내부의 PreCompact/PostCompact 발화. 구버전의 키 처리 |
| P-11 | Sonnet 5.5 장문 가격. 실제 절감 총액. 저지연 수치 |
| P-12 | `@latest` 의 매 세션 레지스트리 조회. artibot context7 이 따로 보이지 않는 원인 |
| P-13 | 호스트의 PreToolUse 병렬 실행 여부. PreToolUse 실지연 |
| P-14 | 호스트가 compatibility.claudeCode 를 강제하는지 |
| P-15 | 호스트가 memory 맵 형식을 받는지. `--debug` 가 값 형태 오류를 보고하는지 |
| P-16 | Dreams API 와 PRD 알고리즘의 정합 |
| P-17 | plugin hooks.json 의 onFailure 존중 여부. 설치 호스트 2.1.295 이상 여부. 각 가드의 내부 fail-closed 여부 |
| P-18 | Windows 에서의 `claude agents` 서비스 동작. 세션 이름 40자 잘림의 호스트 근거. /ultraplan |
| P-19 | 플랜 의존 여부. 감시 2중의 토큰·소음 비용. ledger 매치 나머지 2건 |
| 미래지향성 렌즈 | Sonnet 4.5 은퇴(2026-11-30). 수집 파일에 없습니다 |

**인벤토리 unverified (10건)**
1. 설치된 Claude Code 호스트 버전(`claude --version` 미실행, 측정된 참조는 픽스처 2.1.260 뿐).
2. dream collector.js·distiller.js 존재 여부. P-16 검수가 존재를 실측했습니다(ls, nightly-dream-consolidate.mjs:32,194).
3. plugin.json 에 mcpServers 가 없는데도 호스트가 .mcp.json 을 로드하는지. P-12 검수의 cowork 사례로 약화됐지만 여전히 추론입니다.
4. docs/CLAUDE-MODEL-CATALOG.md 가 생성물인지 수기인지.
5. V5-BACKLOG 전체 행. 키워드 필터를 거친 미완료 행만 봤습니다.
6. ROADMAP-CLAUDE-TAG-CONVERGENCE.md §3~§5 내용과 recon 항목의 착지 상태.
7. catalog-pricing-sync 의 코드 밖 상태. P-2 검수가 249607af 착지와 완료를 확인했습니다(V5-BACKLOG.md:111).
8. capabilities·lifecycle·rules 키가 YAML 맵인지 스칼라인지.
9. ledger.jsonl 줄 수 70,969. 계속 늘어나는 값입니다.
10. effort 매치 수. 관련성을 개별로 검토하지 않았습니다.

**수집 측 미확인**: 2절의 "읽지 못한 것"과 "수집 방식의 한계"를 그대로 적용합니다. 요약된 cc-2.1.288 bullet, 앞 120자만 확보한 2.1.295 bullet, 필터에서 빠졌을 수 있는 Fixed bullet 이 여기에 해당합니다.

## 8. 권장 실행 순서

**릴리스 A: 사실 정정 (패치, 즉시)**
1. P-2 와 P-3 를 한 커밋으로 묶습니다. 카탈로그, PRICING_VERSION, pricing-history 동결, 구간 가격 스키마, 문서 재생성이 들어갑니다. 함께 움직여야 하는 핀 테스트는 pricing-history.test.js 와 model-catalog.test.js 입니다.
2. P-1: team.md, effort-policy.js, firewall 핀을 한 커밋에서 고칩니다.
3. /assemble 의 `model="sonnet"` 하드코딩 5곳을 model-routing CLI 해석으로 바꿉니다. P-7 검수가 지적한 S 크기 수정입니다.
4. P-16 은 PRD 문서만 고칩니다. P-6 은 **P-3 이후**에 진행합니다.

**릴리스 B: 실측 프로브 (verify-only, 한 세션)**
- process 팀원이 실행하고 judge 팀원이 판정합니다.
- 측정 항목:
  - P-5: /team 라이프사이클 재측정. NS-team-probe·NS-sessionend·NS-report-fallback 과 같이 진행합니다.
  - P-15: frontmatter `--debug` 검증.
  - P-13: PreToolUse `--debug` 실측.
  - P-12: /mcp·/context 실측.
  - P-7: agent.spawn 이 model·effort 를 다시 쓸 수 있는지.
  - P-4 사전 프로브: maxEffortLevel 이 Agent 파라미터를 상한하는지, `/tasks` 에 effort 가 표시되는지.
  - 설치 호스트 버전.
- 결과물은 P-14 호스트 하한의 근거가 됩니다.

**릴리스 C: 기능 변경 (오너 승인 필요)**
- P-4: effort 하향 옵트인. 선행 조건은 P-1, 릴리스 B 의 프로브, 오너 승인입니다.
- P-14: 하한 또는 advisory 문서화. 선행 조건은 P-5 결과와 강제 여부 확인입니다.
- P-17: 가드 부분집합에만 적용합니다. dispatch-table 분리가 필요한지 먼저 판단하고 timeout 상향을 검토합니다.
- P-9: /dynamic 라우팅. 판정 단계는 opus 를 유지합니다.
- P-8: 계열 폴백 + 옵트인 드리프트 스크립트. 선행 조건은 P-3 입니다.
- P-12·P-13: 릴리스 B 에서 유의한 결과가 나온 경우에만 진행합니다.

**이후 (조건부·관찰)**
- P-11: P-3 이후, CA-02 안에서 SH-05 비교를 거쳐 오너가 결정합니다.
- P-10: SH-16 실측 이후. frontmatter 대신 `--agents` 경로를 우선 검토합니다.
- P-18·P-19: 관찰만 합니다. P-18 은 vnext-design P6 에 합류합니다.

**의존관계 요약**
- P-3 이 먼저 끝나야 P-6, P-8, P-11 을 진행할 수 있습니다.
- P-1 과 릴리스 B 프로브가 먼저 끝나야 P-4 를 진행할 수 있습니다.
- P-5 가 먼저 끝나야 P-14 를 진행할 수 있습니다.
- P-2 와 P-3 는 같은 커밋으로 묶습니다.
