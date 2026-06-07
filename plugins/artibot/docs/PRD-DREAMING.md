# PRD: Dreaming — Memory Consolidation Loop

> **Status**: Draft (설계 검토 대기) · **Created**: 2026-05-30 · **Owner**: Artibot core
> **성격**: 비파괴적 consolidation. 작동 중인 사용자 가시 auto-memory MD 위에 검증된 게이팅 알고리즘을 적용. 코드 미구현 — 설계 + 단계적 빌드 플랜.

## 1. 배경 (확정 사실)

**"Dreaming"은 Anthropic 공식 기능**(Managed Agents API: `platform.claude.com/docs/en/managed-agents/dreams` + `/memory`). 정의: 기존 memory store + 과거 session transcript(1~100)를 입력으로 받아 **새로운 재구성 store**를 생성 — 중복 merge / stale·모순 항목을 최신값으로 교체 / 신규 insight 발굴. **입력 store는 절대 불변**, 출력은 검토 후 채택/폐기. 비동기 job, opus-4-8 지원.

**제약**: Dreaming API는 Managed Agents(서버측 플랫폼) 전용. Artibot은 Claude Code 플러그인이라 API 직접 사용이 부적합. 따라서 **dream의 알고리즘·안전원칙을 Claude Code 네이티브 auto-memory에 복제**한다. (Managed Agents 직접 채택은 future option으로만 표기 — §9.)

**학계 검증된 consolidation 5단계** (가중치 비변경, 외부 텍스트 메모리 distill→다음 프롬프트 주입 — Artibot `.md` 시스템과 동일 패러다임): Collect → Distill → Prune → Promote → Apply.

**재사용 자산 (코드 확인 완료)**:
- `lib/learning/memory/promoter.js#createPromoter` — gated 승급 엔진. occurrences≥3 / confidence≥0.85 / distinctSessions≥2, rejection ledger(`runtime/promotion-rejections.json`), append-only transition log(`runtime/memory-transitions.log`), **archive-never-delete**. 알고리즘 코어가 사실상 완성돼 있으나 **호출자 0개(dormant)**.
- `lib/learning/memory/episodic.js#createEpisodicStore` — append-only, 중복 hash dedup, `pruneBefore`가 hard-delete 대신 `archive/YYYY-MM/`로 이동.
- `lib/learning/wakeup-scheduler.js` — marker-only(다음 세션 깨움 신호). 4-gate + rate-limit. on-demand/세션연계 트리거에 재사용.
- nightly 인프라: `scripts/setup-nightly-trainers.js`의 `TRAINERS` 배열 + `scripts/hooks/nightly-*.mjs`. 6개 작업 OS 등록(02:30~04:30). `nightly-session-rollup.mjs`(04:30)가 가장 가까운 형제(`never throws` + 구조화 status 반환 패턴).

**갭(설계가 메워야 할 것)**:
1. `createPromoter` 호출자가 없다 (dormant).
2. 내부 `episodic.json`/`semantic.json` store가 **사용자 가시 MD와 분리** — 연결 어댑터 없음.
3. 사용자 가시 auto-memory MD(`~/.claude/projects/<proj>/memory/*.md`, frontmatter `metadata.{node_type:memory, type, originSessionId}` + `MEMORY.md` 인덱스)는 **현재 Claude Code 하니스가 직접 쓰며**, 이를 읽거나 통합하는 Artibot lib이 없다.

## 2. 목표 / 비목표

**목표**: 작동 중인 사용자 가시 auto-memory MD 위에, dream의 안전원칙(비파괴 + dedup-merge/stale-replace/insight-surface)과 promoter의 검증된 게이팅을 적용하는 **비파괴적 consolidation 루프**를 구축한다. 사용자가 검토 게이트를 통과시킨 변경만 실제 MD에 반영한다.

**비목표**:
- Dreaming API(Managed Agents) 직접 사용 (§9 future option).
- 자동 요약으로 원본 MD 덮어쓰기 (consolidation drift 함정 — §6.1).
- rules/CLAUDE.md 자동 승급 (제안만, 사람 머지 — §6.6).
- 외부 데이터 송신 (DATA POLICY §10 — 전부 로컬).
- episodic.json 자동 충전 파이프라인 신설 (별도 작업; dream은 MD를 source of truth로 삼아 episodic 미충전과 무관하게 동작).

## 2.5 Goal Contract

```json
{
  "objective": "사용자 가시 memory/*.md를 입력으로 비파괴적 consolidation을 수행해 memory/.dream-staging/ 에 제안(dedup-merge / stale-replace / insight)을 생성하고, 검토 게이트 통과분만 실제 MD + MEMORY.md 에 반영한다",
  "stoppingCondition": "Stage 1~3 코드가 머지되고 npm run ci 통과. 실제 채택은 사용자 검토 게이트 뒤 — 자율 완료 범위 아님",
  "validationCommand": "npm run ci",
  "maxIterations": 4
}
```

## 3. 핵심 결정 (ADR 스타일)

### ADR-1: Source of truth = 사용자 가시 MD (JSON store 아님)

- **Context**: 두 후보. (A) 내부 JSON store(`episodic.json`→`semantic.json`, promoter) — 단 미충전 + 사용자 비가시. (B) 사용자 가시 auto-memory MD — 작동 중이고 사용자가 실제 읽고 쓰며 매 세션 `MEMORY.md`가 로드됨.
- **Decision**: **B (MD)**. dream 원칙을 MD에 적용하고, promoter의 **게이팅 로직**(occurrences/confidence/distinctSessions/archive-never-delete/rejection ledger)을 MD 대상으로 재사용한다.
- **Rationale**: (1) 미충전 store를 consolidation해봐야 출력이 빈약 — 가치 없음. (2) 사용자가 보지 못하는 곳에서 일어나는 consolidation은 검토 게이트(human-in-loop)가 의미 없다. (3) MD는 이미 `[[link]]`·`Why:`·`How to apply:`·`type` 분류를 가져 dedup/모순 판정에 쓸 구조가 있다. (4) Apply 단계가 자명 — MD는 이미 매 세션 주입되는 컨텍스트다.
- **Trade-off / 부채**: MD 파싱·재작성 어댑터를 신규로 짜야 한다(promoter는 JSON 객체 기준). frontmatter/`[[link]]`/`MEMORY.md` 인덱스 정합성을 코드가 책임져야 한다. → §5의 `memory-md-adapter`가 흡수.
- **Consequence**: promoter의 `createPromoter`는 그대로 두고(JSON 경로 보존), dream은 **promoter의 평가 함수 패턴을 MD 그룹에 적용하는 형제 엔진**으로 구현한다. promoter를 MD로 강제 개조하지 않는다(immutable 자산 보존, JSON 경로의 미래 활용 여지 유지).

### ADR-2: Dream API 직접 사용 ✗ / 알고리즘 복제 ✓

- **Decision**: Managed Agents Dreaming API를 호출하지 않고, 그 **3연산(dedup-merge / stale-replace / insight-surface) + 2원칙(비파괴 / 검토 게이트)** 을 Claude Code 네이티브로 복제한다.
- **Rationale**: Artibot은 플러그인 — Managed Agents 서버 런타임이 없다. DATA POLICY상 transcript를 외부로 보낼 수 없다(§10). 로컬 복제는 동일 가치를 외부 의존 없이 제공.
- **Trade-off**: 공식 dream의 LLM 재구성 품질을 코드만으로 100% 재현 불가 → Distill 단계는 **LLM(현재 세션의 Claude)이 staging 제안을 생성**하고 코드는 게이팅·검증·MD 입출력만 담당하는 hybrid로 한다(§4.2).

### ADR-3: nightly hook은 LLM을 돌리지 않는다 — 코드-Distill까지만, LLM-Distill은 세션으로 이연

- **Context**: nightly 훅(`.mjs`)은 순수 JS 프로세스라 **LLM 추론 컨텍스트가 없다.** 그러나 §4.2 Distill의 제안문 생성은 LLM(세션 Claude)이 필요하다. 야간에 LLM이 필요한 단계를 직접 돌릴 수 없다.
- **Decision**: Distill을 **두 경계로 분리**한다.
  1. **코드-Distill** (LLM 불필요, nightly·세션 공통): Collect + cosine 후보쌍 추림(`session-memory.js` 재사용) + 코드 레벨 dedup/모순 후보를 `.dream-staging/`에 기록. 결정론적, 외부 호출 0.
  2. **LLM-Distill** (LLM 필요, 세션 전용): 추려진 후보에 대해서만 제안문(merge/replace/insert body + evidence 인용)을 생성. **on-demand `/dreaming` 세션 또는 wakeup 후속 세션에서만 실행.**
- **nightly 동작**: nightly hook은 **코드-Distill까지만** 수행한 뒤, "검토 대기 후보 N건"을 `wakeup-scheduler.requestWakeup`로 marker 기록하고 종료한다. **LLM 호출 0, 제안문 생성 0.** 다음 세션이 marker를 보고 LLM-Distill을 이어받는다.
- **Rationale**: LLM 추론이 nightly hook에서 절대 돌지 않음을 구조적으로 보장 — 비결정적·비용 발생 단계를 사람이 있는 세션에만 가둔다. 야간은 "재료 준비 + 깨우기 신호"만. 검토 게이트도 자연히 세션으로 모인다.
- **Consequence**: §4.2가 코드-Distill / LLM-Distill 2-phase로 명시됨. §7 트리거 표에 단계 경계 반영. nightly 산출물은 후보(candidate)까지이며 proposal(제안문)은 아니다.

## 4. 아키텍처 — 5단계 매핑

비파괴 원칙: **입력 MD는 절대 수정하지 않는다.** 모든 처리 산출물은 staging 디렉터리에 쓴다.

```
입력 (불변)                     처리 (staging)                    출력 (검토 게이트 통과분만)
─────────────────────         ──────────────────────          ────────────────────────
memory/*.md            ─┐                                       memory/*.md (갱신)
MEMORY.md               │     memory/.dream-staging/            MEMORY.md (인덱스 갱신)
.artibot/handoffs/*.md  ├──▶   ├─ candidates.json (nightly)──▶   memory/.dream-archive/   (대체된 원본)
.artibot/SESSION-NOTES  │      ├─ proposals.json (세션)         runtime/dream-rejections.json
correction 파일들       ─┘      ├─ <slug>.proposed.md            runtime/dream-transitions.log
                               └─ report.md (사람용 요약)
```

### 4.1 Collect (수집) — `lib/learning/memory/dream/collector.js`
입력 소스를 **읽기 전용**으로 모은다:
- `memory/*.md` (frontmatter 파싱 → `{name, type, description, originSessionId, body, links}`)
- `MEMORY.md` 인덱스
- `.artibot/handoffs/*.md`, `.artibot/SESSION-NOTES.md` — 최근 N개
- per-agent correction 파일(있으면) — 실패/정정 신호
각 항목에 provenance(파일 경로 + 원본 hash)를 부착. **외부 신호 게이트의 입력**(테스트 결과·correction)은 별도 표기해 §6 함정 ② 완화에 사용.

### 4.2 Distill (증류) — 2-phase (코드-Distill / LLM-Distill, ADR-3)
LLM 추론이 필요한 단계와 결정론적 코드 단계를 분리한다. **nightly hook은 phase-1까지만, phase-2는 세션 전용.**

- **Phase-1 코드-Distill** (LLM 불필요, nightly·세션 공통) — `dream/distiller.js`: 제목·`description`·키워드 cosine(기존 `session-memory.js`의 `tokenize`/`cosineSimilarity` 재사용)로 (a) 중복 후보쌍 (b) stale/모순 후보 (c) insight 후보군을 **기계적으로 추림**. 결정론적, 외부 호출 0. 산출물: `.dream-staging/candidates.json`. nightly는 여기서 멈추고 wakeup marker 기록 후 종료.
- **Phase-2 LLM-Distill** (LLM 필요, 세션 전용) — `/dreaming` 또는 wakeup 후속 세션: `candidates.json`의 후보에 **대해서만** 통합/교체/신규 제안문(body)을 생성. **근거 인용 필수** — 모든 제안은 원본 파일 path + 인용 구절을 `evidence[]`에 달아야 함(§6.1·§6.5). 인용 없는 제안은 distiller가 폐기. 산출물: `proposals.json` (각 proposal = `{op: merge|replace|insert, targets[], evidence[], scope, confidence, body}`).

경계 요약: nightly = **candidates까지** (LLM 호출 0), 세션 = candidates → **proposals** (LLM 제안문 생성). proposal이 없으면 Promote/Apply는 no-op.

### 4.3 Prune (정리) — `dream/distiller.js` 내 평가 함수
promoter의 `evaluateGroup` 패턴을 MD에 적용:
- **dedup-merge**: cosine ≥ mergeThreshold(기본 0.82) AND 동일 `type` → 병합 제안. 저효용(오래됨 + 미참조 + 낮은 confidence) 항목은 archive 제안.
- 모순 항목은 삭제하지 않고 **둘 다 보존하되 scope/counterexample을 단 가설**로 표기(§6.4).

### 4.4 Promote (승급) — `dream/promote-md.js`
promoter의 게이팅을 MD에 차용:
- occurrences(동일 insight를 뒷받침한 distinct 입력 소스 수) ≥ minOccurrences
- distinctSessions(서로 다른 `originSessionId`) ≥ 2
- confidence ≥ floor(기본 0.85)
- rejection ledger(`runtime/dream-rejections.json`)에 최근 거부 없음
통과 proposal에 **scope/confidence/evidence frontmatter를 부착**해 `.dream-staging/<slug>.proposed.md`로 출력. **이 단계는 실제 MD를 건드리지 않는다.**

### 4.5 Apply (적용) — 검토 게이트 뒤에서만 — `dream/apply.js`
- **검토 게이트**: 기본 human-in-loop. `/dreaming --review`가 `report.md`(제안 diff 요약)를 사람에게 보여주고, 채택/거부를 입력받는다.
- 채택 시: 대체되는 원본을 `memory/.dream-archive/<date>/`로 이동(archive-never-delete), 새 MD 쓰기, `MEMORY.md` 인덱스 재생성(아래 어댑터 규칙), `runtime/dream-transitions.log`에 append.
- **MEMORY.md 인덱스 규칙**: `memory-md-adapter`가 채택 후 각 활성 MD에서 `{title, file, hook}`을 읽어 1줄 `- [Title](file.md) — hook` 형식으로 인덱스를 재생성(merge로 사라진 파일 줄 제거, 신규 줄 추가). 기존 1줄 형식·정렬을 보존하는 것이 어댑터 책임이다.
- 거부 시: `runtime/dream-rejections.json`에 signatureHash + 사유 기록(promoter `registerRejection` 패턴).
- **자동 채택 조건(선택, 기본 OFF)**: `dream.autoAccept.enabled` + op=`insert`(신규만, merge/replace 제외) + confidence ≥ 0.95 + 외부 신호(테스트/correction) 뒷받침 시에만. 기본 비활성(§6.6).

## 5. 5-Layer 적합성

| 컴포넌트 | 레이어 | 위치 | 비고 |
|---|---|---|---|
| consolidation 엔진(collect/distill/prune/promote) | **L3 Learning** | `lib/learning/memory/dream/` | promoter·episodic·session-memory 재사용 |
| MD 파서·재작성 어댑터 | **L3 Learning** | `lib/learning/memory/dream/memory-md-adapter.js` | frontmatter+`[[link]]` 파싱, **`MEMORY.md` 인덱스 1줄 형식 `- [Title](file.md) — hook` 보존·재생성 책임** |
| `/dreaming` 커맨드 | command | `commands/dreaming.md` | on-demand 트리거, `--review`/`--dry-run`/`--auto` |
| nightly 슬롯 | hook | `scripts/hooks/nightly-dream-consolidate.mjs` | `nightly-session-rollup.mjs` 패턴 미러 |
| 스케줄 등록 | script | `scripts/setup-nightly-trainers.js`(TRAINERS에 1항목 추가) | 7번째 슬롯, 05:00 |
| wakeup 연계(선택) | L3 | `wakeup-scheduler.js` 재사용 | dream이 후속 검토 필요 시 marker write |
| 설정 | config | `artibot.config.json#/learning/dream` | enabled/threshold/autoAccept |

**파일 분할 규약**: 각 모듈 < 800줄, 함수 < 50줄. distiller가 커지면 candidate-finder / proposal-builder로 분할. 모든 store write는 atomic(`lib/core/file.js#atomicWriteJson`) 재사용. 반환 객체 `Object.freeze`.

## 6. 안전장치 (6 함정 → 구체 메커니즘)

| # | 함정 | 완화 메커니즘 (코드 레벨) |
|---|---|---|
| 1 | **consolidation drift** (자동요약이 원본을 망침) | 입력 MD 절대 미수정(§4 비파괴). Distill은 staging에만 쓰고 **검토 게이트** 통과 필요. 자동요약 금지 — merge/replace는 사람 승인 필수(autoAccept는 insert-only). 인용 없는 proposal 폐기. |
| 2 | **experience-following 에러전파** | Selective Addition — 평가 통과(§4.4 게이팅) proposal만. add-all 금지. correction/실패-도구호출을 **반증 신호**로 수집해 모순 insight를 가설로 강등. |
| 3 | **bloat** | utility-based archive 제안(오래됨+미참조+저confidence) + dedup-merge. archive는 삭제 아닌 `.dream-archive/` 이동(복구 가능). |
| 4 | **모순** | semantic insight를 "scope·confidence·counterexample을 가진 가설"로 저장. 충돌 시 둘 다 보존 + frontmatter에 `contradicts: [[other]]` 링크. |
| 5 | **과일반화** | 교훈에 명시적 `scope`/`condition` frontmatter 유지. 추상↔원본을 `evidence[]`(파일 path + 인용)로 양방향 링크. |
| 6 | **자기강화 루프** | 외부 신호(테스트 통과/유저 피드백/correction) 게이트. **rules/CLAUDE.md 자동 승급 금지 — 제안만**(`report.md`에 "수동 머지 권장"으로 표기). human-in-loop가 기본. |

추가: rejection ledger(거부 영속), transition log(append-only 감사 추적), kill-switch(`lib/learning/kill-switch.js`) 연동으로 dream 전체 비활성 가능.

## 7. 트리거

| 트리거 | Distill 범위 (ADR-3) | LLM 호출 | 산출물 | 비고 |
|---|---|---|---|---|
| **7번째 nightly 슬롯 (05:00)** `nightly-dream-consolidate.mjs` | **Phase-1 코드-Distill만** | **0** | `candidates.json` + wakeup marker | `nightly-session-rollup`(04:30) 직후라 그날 rollup·correction 반영. never-throws, `--dry-run` 지원. 제안문 생성·MD 쓰기 없음 |
| **on-demand `/dreaming`** | Phase-1 + **Phase-2 LLM-Distill** | 세션 컨텍스트 내 | `proposals.json` + report.md | `--review`(게이트 UI), `--dry-run`(제안만 보고 미작성), `--auto`(autoAccept 임시 ON, insert-only) |
| **(선택) wakeup 후속 세션** | nightly candidates 이어받아 Phase-2 | 세션 컨텍스트 내 | proposals.json | nightly가 남긴 marker를 세션 시작 시 surface → Phase-2 수행. marker-only, 자동 실행 아님 |

핵심: **LLM 추론은 세션(Phase-2)에서만 돈다.** nightly hook은 결정론적 코드-Distill(candidates)까지만 수행하고 깨우기 신호만 남긴다.

## 8. 단계적 빌드 플랜 (저위험 — 비파괴)

| Stage | 내용 | 산출물 | 검증 기준 |
|---|---|---|---|
| **S1. MD 어댑터** | `memory-md-adapter.js` — frontmatter 파싱/직렬화, `[[link]]` 추출, `MEMORY.md` 인덱스 read/재생성. 순수 함수 + atomic write. **생성자에 `memoryDir` 주입 옵션**(episodic.js `options.storePath` 패턴) | `lib/learning/memory/dream/memory-md-adapter.js` + 단위테스트 | 라운드트립(parse→serialize) 동일성 green, `MEMORY.md` 인덱스 1줄 형식 정합. **테스트는 임시 fixture 디렉터리 주입 — 실제 `~/.claude/projects/.../memory` 절대 미접근** |
| **S2. Distill/Prune/Promote 엔진** | collector + distiller(Phase-1 코드-Distill, 후보 cosine 추림) + promote-md(게이팅). staging 출력만. promoter 패턴 미러. **전 모듈 생성자에 `memoryDir`/`stagingDir` 주입 옵션 명시** | `dream/collector.js`, `dream/distiller.js`, `dream/promote-md.js` | 합성 MD fixture로 dedup/모순/insight 후보 정확 도출, 입력 파일 unchanged assert. **테스트는 임시 fixture 디렉터리만 주입 — 실제 사용자 memory 디렉터리 미접근** |
| **S3. /dreaming 커맨드 + dry-run** | `commands/dreaming.md`. 기본 `--dry-run`(staging+report.md만). Phase-2 LLM-Distill + 검토 게이트(`--review`) | `commands/dreaming.md`, `dream/apply.js` | dry-run이 실제 MD 0개 수정 확인, report.md diff 가독성 |
| **S4. nightly 등록 + 안전장치 마감** | `nightly-dream-consolidate.mjs`(Phase-1만 실행 + wakeup marker) + TRAINERS에 05:00 추가. rejection ledger·transition log·kill-switch 연동. autoAccept(insert-only) 게이트 | hook + `setup-nightly-trainers.js` 수정 + config 블록 | never-throws status 반환, **nightly는 LLM 호출 0·proposal/MD 쓰기 0, marker만 생성**(assert), `--dry-run` nightly green, autoAccept 기본 OFF 확인 |

각 Stage 독립 머지 가능. S1·S2는 사람 검토 게이트가 없어도 staging만 만들어 위험 0. S3에서 처음으로 실제 MD 쓰기 경로가 열리며 기본값은 dry-run.

## 9. Future Option (비채택, 기록만)
Managed Agents Dreaming API 직접 사용 — 사용자가 Managed Agents 런타임을 운용하고 DATA POLICY를 완화하기로 결정할 경우에 한해. 그 경우 `dream/distiller.js`의 LLM 측을 API job 호출로 교체하고 staging 단계는 동일 유지(검토 게이트 보존). 현재는 채택하지 않음.

## 10. DATA POLICY
모든 입출력 로컬. transcript·memory·correction을 외부로 전송하지 않음. Phase-2 LLM-Distill은 **현재 세션의 Claude 컨텍스트 내**에서 수행(별도 API 송신 없음). nightly hook(Phase-1)은 LLM 자체를 호출하지 않음(ADR-3). staging/archive/ledger 전부 로컬 파일. 외부 네트워크 IO 0.

## 11. 수락 기준
1. 입력 `memory/*.md`가 어떤 경로에서도 **수정되지 않음**(S1~S4 전 단계 assert).
2. `/dreaming --dry-run`이 `.dream-staging/`에 proposals.json + report.md를 생성, 실제 MD 0개 변경.
3. 모든 proposal이 `evidence[]`(원본 path + 인용)를 가짐 — 없으면 폐기.
4. dedup-merge/stale-replace/insert 3연산 각각 합성 fixture로 검증.
5. 거부된 proposal이 rejection ledger에 남아 다음 sweep에서 재제안 안 됨.
6. 채택 시 대체 원본이 `.dream-archive/`에 보존(hard-delete 0).
7. rules/CLAUDE.md 변경은 자동 적용되지 않고 report.md에 제안으로만 표기.
8. nightly가 never-throws 구조화 status 반환, autoAccept 기본 OFF.
9. **nightly hook은 LLM 호출 0 · proposal/MD 쓰기 0 — candidates.json + wakeup marker만 생성**(ADR-3). LLM-Distill은 세션에서만.
10. dream 엔진·어댑터 전 모듈이 `memoryDir`/`stagingDir` 주입을 받아 테스트가 임시 fixture만 접근, 실제 사용자 memory 디렉터리 미접근.
11. `npm run ci` green (lint 0, 커버리지 임계 유지, 함수<50줄/파일<800줄).
