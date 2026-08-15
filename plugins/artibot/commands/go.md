---
description: >
  (Artibot) Project genesis — turns a single idea or repo into a complete blueprint folder in one shot.
  Use when user wants to start a new project, scaffold a project from scratch, turn an idea into a
  blueprint, generate a PRD and full design at once, or says "처음부터 설계해줘", "아이디어를 프로젝트로 만들어줘",
  "파일트리/워크플로우/데이터셋 한번에 만들어줘", "idea to blueprint", "프로젝트 청사진 만들어", "새 프로젝트 시작해줘".
  Produces 6 blueprint documents (CLAUDE.md, PRD, ARCHITECTURE, FILE-TREE, WORKFLOW, DATASETS) under
  a single output folder without touching external services or databases.
argument-hint: '<아이디어 또는 repo 경로>'
allowed-tools: [Read, Glob, Grep, Bash, Write, Agent, TaskCreate, Skill, AskUserQuestion]
lifecycle: genesis
---

# /go

> **/go vs /plan vs /ultraplan — 원샷 청사진 vs 단계분해 vs 철저한 계획**
> - **/go** (여기) — "아이디어 → 전체 청사진" 원샷. 도메인 추론 → 질의응답 스펙 확정 → 6종 문서 동시 생성. 프로젝트 첫 세션에.
> - **/plan** — 할 일이 정해진 뒤 구현 단계를 분해. 빠른 실행 계획.
> - **/ultraplan** — 근거수집 + 다관점 의회 + 적대적 검증. 마이그레이션·아키텍처 큰 결정에.
> 정리: **청사진=/go, 실행계획=/plan, 철저한 결정=/ultraplan.**

아이디어 또는 기존 repo 하나를 받아 **스펙 확정(CLARIFY)** 후 한 폴더에 **블루프린트 문서 6종**을 생성하고, **`.claude/` 스캐폴딩(Phase 6)** 및 **검증(Phase 7)**까지 한 흐름으로 완료한다.

**DATA POLICY**: 외부 서비스 0·로컬 파일시스템만. DATASETS는 스키마만(실데이터 X).
hooks는 `.mjs` 확장자(Windows 호환). `.mcp.json` 외부 MCP 자동배선 금지 — warnings 표시 후 수동 검수.

**출력 표기 규칙**: 사용자 노출 헤더·배너·진행 표시는 커맨드명 **`/go`**로 표기한다. 내부 lifecycle id(`genesis`)와 `lib/genesis/*` 모듈명은 코드 내부용이며 사용자 출력에 "GENESIS" 단어로 노출하지 않는다 (예: 페이즈 헤더는 `GENESIS // PHASE 1`이 아니라 `/go // PHASE 1` 또는 `Phase 1 — INTAKE`).

## Arguments

Parse $ARGUMENTS:
- `idea-or-path`: 아이디어 문장, 프로젝트 이름, 또는 기존 repo 절대경로
- `--out <dir>`: 출력 폴더 (기본: `./docs/genesis/<slug>-<YYYY-MM-DD>`)
- `--lang <ko|en>`: 생성 문서 언어 (기본: 입력 언어 자동 감지)
- `--dry-run`: 생성할 파일 목록만 미리보기 (파일 쓰기 없음)
- `--skip <docs>`: 생략할 문서 쉼표 구분 (예: `--skip architecture,datasets`)
- `--yes` / `--defaults`: CLARIFY 단계를 건너뛰고 권장값 일괄 적용 (빠른 모드)

## Phase 1 — INTAKE: 아이디어/Repo 분석

`$ARGUMENTS`가 파일시스템 경로인지 먼저 판별한다.

**경로인 경우(repo 델타 모드)** (`commands/load.md:27-40` 패턴) — 구조와 프레임워크를 감지한 뒤 **"추가/변경"에 해당하는 델타 스펙**만 추출한다:

```
1. 디렉토리 스캔: package.json, tsconfig.json, .env.example, Dockerfile, src/, lib/, tests/
2. 프레임워크 감지: 의존성 + 설정 파일 기반
   - Frontend: React, Vue, Angular, Next.js, Nuxt
   - Backend: Express, Fastify, NestJS, Hono
   - Language: TypeScript, JavaScript, Python, Go
3. 핵심 모듈 샘플링: src/index.*, lib/core/* (최대 10파일)
4. 델타 스펙 추출: 이미 구현된 기능은 기록하되 nonGoals 후보로,
   사용자가 "추가/변경"을 원한다고 한 것만 features 후보로.
```

**아이디어 문장인 경우(greenfield 모드)** — 텍스트에서 직접 추론한다:

```
1. 도메인: 전자상거래 / SaaS / CLI 툴 / 데이터 파이프라인 / 기타
2. 핵심 개념: 주요 엔티티 3~7개 (예: User, Order, Product)
3. 제약: 예산/팀/기술 스택 언급 있으면 수집
```

INTAKE 결과 → `{ domain, concepts[], stack, constraints, features[], nonGoals[] }` 구조화 객체 생성.
`features`와 `nonGoals`는 이후 CLARIFY에서 채워지므로 INTAKE 시점엔 추론값으로 초기화한다.

---

## Phase 2 — CLARIFY: 스펙 확정 (INTAKE 직후)

> `--yes` / `--defaults` 플래그가 있으면 이 단계를 건너뛰고 추론값(권장값)을 그대로 적용한다.

`clarify` 스킬(Skill 도구)을 호출해 hypothesis-based MCQ 모드로 진입한다.
목적: **아이디어만으로는 메울 수 없는 설계 갭**을 최소한의 왕복으로 확정하는 것.

### 9-카테고리 모호성 스캔

아래 9개 카테고리를 INTAKE 결과와 대조해 각 항목을 **Clear / Partial / Missing**으로 마킹한다.
Missing 또는 Partial 중 Impact×Uncertainty가 가장 높은 **상위 5개**만 질문 후보로 올린다.

| # | 카테고리 | 예시 판단 기준 |
|---|---------|-------------|
| ① | Functional Scope | 핵심 기능 목록이 명확한가 |
| ② | Domain & Data Model | 주요 엔티티와 관계가 정의됐는가 |
| ③ | UX / Interaction Flow | 사용자 흐름(주요 화면·단계)이 명시됐는가 |
| ④ | Non-Functional | 성능·보안·확장성 요건이 언급됐는가 |
| ⑤ | Integration / 외부의존 | 외부 API·서비스 연동이 명확한가 |
| ⑥ | Edge / Failure | 실패 시나리오·에러 처리가 정의됐는가 |
| ⑦ | Constraints / Tradeoffs | 기술 스택·팀 규모·일정 제약이 있는가 |
| ⑧ | Terminology | 도메인 용어가 공유됐는가 |
| ⑨ | Completion Signals | 완료 기준(수락 기준)이 있는가 |

합리적 default로 채울 수 있는 항목은 **묻지 않는다**. 질문 상한 = **5개**.

### 가설 우선 접근

후보 청사진 2~3개를 먼저 세우고 **청사진 간 갈리는 지점**만 질문한다.
질문 형식: "제 추측은 [X]인데 맞나요?"

### MCQ via AskUserQuestion

```
- 호출당 1~4개 질문
- 질문당 2~4개 선택지
- 권장 선택지를 첫 번째에 두고 라벨 끝에 (Recommended) 표기
- 항상 마지막 선택지는 "권장값으로 모두 진행" 또는 "Other (직접 입력)"
```

**과명세 방지(arXiv 2505.13360)**: 질문을 5개 초과하지 않는다. 사용자가 "충분해요" / "그냥 진행해줘"라고 하면 즉시 CLARIFY를 종료한다. 최대 2라운드 후 가정으로 진행한다.

### 제안형 라운드: 도메인 기반 후보 기능 제시

도메인을 분석해 후보 기능 3~5개를 제시하고, `AskUserQuestion` multiSelect로 사용자가 선택하게 한다.
**각 후보는 problem-validation 게이트 적용**: 이 도메인에서 실제로 필요한지 판단하며, 임의 나열 금지.

예시:
```
이 도메인에서 보통 필요한 기능들입니다. 포함할 것을 선택해주세요:
[ ] 사용자 인증 (JWT 기반)        ← 추천
[ ] 역할 기반 권한 관리 (RBAC)
[ ] 이메일 알림
[ ] 대시보드 / 통계 뷰
[ ] CSV/Excel 내보내기
```

### 스펙 write-back

사용자 답변을 받는 즉시 INTAKE 스펙 객체에 반영한다:

```js
spec.features   = [...사용자가 선택한 기능들];
spec.nonGoals   = [...명시적으로 제외된 항목들];
spec.stack      = spec.stack ?? 답변에서 추출한 스택;
spec.constraints = { ...spec.constraints, ...답변에서 추출한 제약 };
```

---

## Phase 3 — BLUEPRINT: 6종 문서 생성 (MVP 핵심)

CLARIFY에서 확정된 스펙 객체(`{ domain, concepts, stack, constraints, features, nonGoals }`)를 바탕으로 각 렌더러를 호출한다.

### 동적 import 규약 (한글 경로 안전)

`commands/autopilot.md:159-182` 패턴을 그대로 사용한다. cwd 상대경로 금지 — `CLAUDE_PLUGIN_ROOT` 기준 절대경로:

```js
import path from 'node:path';
import fs from 'node:fs';
// toFileUrl: 한글 경로 안전 (pathToFileURL percent-encoding 회피)
const toFileUrl = (p) => {
  const f = p.replace(/\\/g, '/');
  return /^[A-Z]:/i.test(f) ? `file:///${f}` : `file://${f}`;
};
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const candidates = [process.env.CLAUDE_PLUGIN_ROOT].filter(Boolean);
const mpDir = path.join(home, '.claude', 'plugins', 'marketplaces');
if (fs.existsSync(mpDir)) {
  for (const mp of fs.readdirSync(mpDir)) {
    candidates.push(path.join(mpDir, mp, 'plugins', 'artibot'));
  }
}
// genesis 렌더러가 있는 pluginRoot 탐색
const pluginRoot = candidates.find((c) => fs.existsSync(path.join(c, 'lib/genesis/tree-gen.js')));
if (!pluginRoot) throw new Error('Artibot genesis layer not found. Set CLAUDE_PLUGIN_ROOT or install via marketplace.');

const { writePRD } = await import(toFileUrl(path.join(pluginRoot, 'lib/planning/artifacts.js')));
const { writeFileTree } = await import(toFileUrl(path.join(pluginRoot, 'lib/genesis/tree-gen.js')));
const { writeWorkflow } = await import(toFileUrl(path.join(pluginRoot, 'lib/genesis/flow-gen.js')));
const { writeDatasets } = await import(toFileUrl(path.join(pluginRoot, 'lib/genesis/dataset-gen.js')));
```

### 문서 1 — CLAUDE.md (도메인 컨텍스트)

`commands/sdk.md:262-268` 규약을 따른다. 모델이 직접 `Write` 툴로 생성한다:

```
<outDir>/CLAUDE.md
─────────────────
# <ProjectName> — Plugin Development Context
생성일: <YYYY-MM-DD>   도메인: <domain>

## 스택
<stack 감지 결과 또는 추론>

## 핵심 개념
<concepts[] 목록>

## 관련 커맨드
/go (blueprint), /plan (실행계획), /implement (구현)

## 문서맵
<생성된 모든 문서를 빠짐없이 열거 — 아래 전수 규칙 참조>
docs/PRD/<slug>-<date>.md
docs/ARCHITECTURE.md
docs/FILE-TREE.md
docs/WORKFLOW.md
docs/DATASETS.md
docs/DECISIONS.md        ← 생성된 경우
docs/ROADMAP.md          ← 생성된 경우
docs/API-SPEC.md         ← 생성된 경우
... <그 외 생성된 확장 문서 전부>
```

**문서맵 전수 규칙(누락 금지)**: 문서맵/PRD 링크 섹션은 이번 `/go` 실행에서 **실제로 생성한 모든 문서**를 열거한다 — 코어 6종(CLAUDE.md 제외, PRD/ARCHITECTURE/FILE-TREE/WORKFLOW/DATASETS) + 생성된 확장 문서(DECISIONS/ROADMAP/API-SPEC 등) 전부. 일부만 추려 적지 말 것. 생성하지 않은 문서는 적지 않는다(존재하지 않는 링크 금지). Phase 3 BLUEPRINT 마지막에 `docs[]` 메타(아래 DOCS-INDEX 호출부)와 **동일한 목록**을 사용해 일치시킨다.

### 문서 2 — docs/PRD/`<slug>.md`

`lib/planning/artifacts.js#writePRD()` 호출 — 재구현 금지.
PRD는 반드시 **비목표(out-of-scope) 섹션**을 포함한다: CLARIFY에서 명시적으로 제외된 항목과 현 MVP 범위 밖 기능을 "하지 않을 것" 목록으로 기술한다. 이는 PM 표준이며 생략 불가.

**기능별 상세 요구사항 + Acceptance Criteria 강제 (한 줄 테이블 금지)**: PRD의 기능 섹션(`기능요구사항`)은 F-ID 한 줄 요약 테이블로 끝내지 않는다. P0/핵심 기능마다 **개별 sub-section**으로 전개하며, 각 기능은 (1) 세부 요구사항 목록(무엇을·어떻게)과 (2) Acceptance Criteria를 포함한다. AC는 EARS(`WHEN <트리거> THE SYSTEM SHALL <동작>`) 또는 GIVEN/WHEN/THEN 형식으로 검증 가능하게 작성한다. 이 깊이가 없으면 개발자가 "어떻게 구현하는가"를 직접 추측해야 하므로 생략 불가. (출처 기준선: 기존 설계의 `03_Feature_Requirements.md` 수준 — 기능당 다수 요구사항 + 복수 AC.) 문서 폭증 방지를 위해 P1 이하 기능은 요약 테이블로 두되, 적어도 P0 기능 전부는 sub-section으로 전개한다.

```
## 기능 요구사항

### F-01 — <기능명>  (P0)
**세부 요구사항**
- R1. <무엇을 — 입력/처리/출력>
- R2. <엣지/예외 처리 요건>
- ...
**Acceptance Criteria**
- AC1. WHEN <사용자가 X를 한다> THE SYSTEM SHALL <Y를 한다>
- AC2. GIVEN <상태> WHEN <행동> THEN <기대 결과>

### F-02 — <기능명>  (P0)
...

## 기능 요약 (P1 이하)
| ID | 기능 | 우선순위 |
|----|------|---------|
| F-09 | ... | P1 |
```

**핵심 플로우 시나리오 서술**: PRD(또는 UX 문서)에는 핵심 사용 플로우 2~3개를 **구체 예시로 서술**한다 — bullet 요약만으로 끝내지 말고 실제 대화 예시·화면/카드 목업·단계별 사용자 행동을 묘사해 흐름을 생생하게 전달한다.

```js
const { ok, prdPath } = await writePRD({
  projectRoot: outDir,
  slug: slugify(projectName),
  title: projectName,
  sections: {
    배경: '...domain context...',
    목표: '...goals from spec.features...',
    비목표: '...spec.nonGoals — 하지 않을 것 목록...',
    기능요구사항: '...P0 기능마다 F-ID sub-section: 세부 요구사항 + AC(EARS/GWT). 한 줄 테이블 금지...',
    시나리오: '...핵심 플로우 2~3개를 대화 예시·화면 목업으로 구체 서술...',
    설계: '...high-level design...',
    산출물: '6종 blueprint documents',
    실행계획: 'Session 1: blueprint / Session 2: scaffold / Session 3: verify',
    위험: '...domain-specific risks...',
    수락기준: '6종 문서 생성 완료, dry-run 통과',
  },
  linkedAdrs: [],
  now: new Date(),
});
// writePRD 시그니처: writePRD({ projectRoot, slug, title, sections, linkedAdrs, now }) → { ok, prdPath }
```

### 문서 3 — docs/ARCHITECTURE.md

규모·복잡도가 크거나 아키텍처 결정이 필요한 경우 `/design`(architect agent) 위임:

```
Agent(architect, prompt="<domain> 프로젝트의 고수준 아키텍처 설계. 도메인: <domain>, 스택: <stack>")
```

MVP에서는 모델이 간결한 레이어 다이어그램(텍스트)을 `Write`로 직접 생성해도 된다. 위임 여부는 복잡도 판단에 따른다.

**NFR 수치 강제** — ARCHITECTURE.md의 비기능 요구사항(NFR) 섹션은 제약을 **구체 수치/기본값**으로 명시한다. "제한 있음" 같은 모호한 서술 금지. 최소한 다음을 수치로 적는다:
- 파일 업로드 크기 상한 (예: `이미지 ≤ 5 MB, 문서 ≤ 20 MB`)
- 허용 MIME 타입 allowlist (예: `image/png, image/jpeg, application/pdf`)
- 응답시간·동시접속·요청율 등 해당되는 성능 한계 (예: `p95 API 응답 < 300 ms`, `rate limit 100 req/min/IP`)

값이 CLARIFY에서 확정되지 않았으면 **권장 기본값을 제시**하되, 그 항목을 DECISIONS.md의 "미확정 항목" 표로 연결해 결정 주체가 추후 확정하도록 한다(추론값을 사실처럼 단정하지 말 것).

### 문서 4 — docs/FILE-TREE.md

`lib/genesis/tree-gen.js#writeFileTree()` 호출:

```js
const tree = inferFileTree({ domain, concepts, stack });
// tree: { dirs: [{ path, purpose }], files: [{ path, purpose }] }

const { ok, treePath } = await writeFileTree({
  projectRoot: outDir,
  tree,
  now: new Date(),
});
// writeFileTree 시그니처: writeFileTree({ projectRoot, tree, now }) → { ok, treePath }
```

`inferFileTree`는 모델이 도메인·스택·개념을 토대로 인라인 추론한다(별도 lib 없음).

### 문서 5 — docs/WORKFLOW.md

`lib/genesis/flow-gen.js#writeWorkflow()` 호출:

```js
const flows = inferWorkflows({ domain, concepts });
// flows: [{ name, steps: [string], actors: [string] }]

const { ok, workflowPath } = await writeWorkflow({
  projectRoot: outDir,
  flows,
  now: new Date(),
});
// writeWorkflow 시그니처: writeWorkflow({ projectRoot, flows, now }) → { ok, workflowPath }
```

### 문서 6 — docs/DATASETS.md (스키마만 — 실데이터 X)

`lib/genesis/dataset-gen.js#writeDatasets()` 호출. DATA POLICY: 외부 DB 접근 금지, 스키마 정의만:

```js
const schemas = inferSchemas({ domain, concepts });
// schemas: [{ name, fields: [{ name, type, required }], description }]

const { ok, datasetsPath } = await writeDatasets({
  projectRoot: outDir,
  schemas,
  now: new Date(),
});
// writeDatasets 시그니처: writeDatasets({ projectRoot, schemas, now }) → { ok, datasetsPath }
```

### 확장 문서 (조건부 생성 — 모델이 `Write`로 직접 작성)

코어 6종 외에, 프로젝트가 요구하면 아래 확장 문서를 생성한다. **확장 문서도 즉흥 작성 금지 — 아래 렌더 스펙을 따른다.** 생성한 확장 문서는 반드시 문서맵(문서 1)과 DOCS-INDEX(`docs[]`)에 함께 등록한다.

#### docs/DECISIONS.md (ADR 후보 — 풀 ADR 구조 강제)

기술 선택·아키텍처 결정이 하나라도 있으면 생성한다. **각 ADR 후보는 결정값만 적지 말고 반드시 다음 풀 구조로 작성한다** (표준 예시: `temp-repos/Ontology/docs/adr/ADR-DEVCENTER-CONCEPTS.md` — Context / Decision Drivers / Considered Options 각 Pros·Cons·비용 / Decision / Risks 표 / Acceptance 체크리스트 / Next Actions):

```
## ADR-NNN — <결정 제목>
> Status: Proposed   Date: <YYYY-MM-DD>

### Context
<왜 이 결정이 필요한가 — 배경·제약>

### Decision Drivers
1. <가중치 높은 순으로 — 비용/성능/팀역량/일정/보안 등>
2. ...

### Considered Options
#### Option A — <이름>
- What: <무엇인가>
- Pros: <장점>
- Cons: <단점>
- 비용: <러닝커브·번들·운영비·라이선스 등 숨은 비용>
#### Option B — <이름>
- What / Pros / Cons / 비용
<선택지는 최소 2개 — 단일안이면 "대안 없음" 사유를 명시>

### Decision
**채택: Option X** — <근거를 Decision Drivers와 연결>

### Risks & Mitigations
| 위험 | 영향 | Mitigation |
|------|------|-----------|
| ... | ... | ... |

### Acceptance Criteria
- [ ] <검증 가능한 완료 조건>
- [ ] ...

### Next Actions
1. <담당자/역할> — <할 일> — 목표시점 <날짜 또는 Phase>
```

**미확정 항목**은 나열로 끝내지 말고 표로 — 각 항목에 **블로커 영향**과 **결정 주체**를 명시한다:

```
## 미확정 항목 (Open Decisions)
| 항목 | 블로커 영향 | 결정 주체 |
|------|------------|----------|
| 인증 방식 (JWT vs 세션) | 백엔드 API 설계 차단 | 백엔드 리드 |
| 파일 저장소 (S3 vs 로컬) | DATASETS 스키마 미확정 | 아키텍트 |
```

**다음 액션**은 담당자(역할)와 목표시점(날짜 또는 Phase) 없이 적지 않는다.

#### docs/ROADMAP.md (Phase별 기간 강제)

생성 시 각 Phase에 **예상 기간(주차 또는 스프린트 수)**을 명시한다. 기간 없는 Phase 나열 금지. 의존성이 있으면 의존성 맵(어느 Phase가 무엇을 선행으로 요구하는지)과 Phase별 수락 기준도 함께 적는다(참고 패턴: `temp-repos/Ontology/archive/deprecated-plans/PLAN_DEVELOPER_CENTER.md`의 Wave별 수락기준·의존성 맵·파일 소유권표).

```
## Phase 1 — <이름>  (예상: 1주 / Sprint 1)
- 목표: ...
- 수락 기준: ...
## Phase 2 — <이름>  (예상: 2주 / Sprint 2-3)
- 선행: Phase 1 완료
- ...
```

#### docs/API-SPEC.md · 기타 확장 문서

API 표면이 있으면 엔드포인트·요청/응답 스키마·에러 코드를 표로 명시한다. 그 외 확장 문서도 "값만 나열"이 아니라 근거·대안·검증 기준을 포함하는 동일 원칙을 따른다.

### DOCS-INDEX 생성 (BLUEPRINT 마지막 — 모든 문서 등록)

코어 + 확장 문서를 모두 생성한 뒤, 마지막에 문서 인덱스를 생성한다. `docs`는 이번 실행에서 생성한 **모든** 문서의 메타 배열이며, 문서 1의 문서맵과 동일한 목록이어야 한다:

```js
const { writeDocsIndex } = await import(toFileUrl(path.join(pluginRoot, 'lib/genesis/index-gen.js')));

// docs: 이번 /go 실행에서 생성한 모든 문서 메타 (코어 6종 + 생성된 확장 문서 전부)
const docs = [
  { name: 'CLAUDE.md',      path: 'CLAUDE.md',            status: 'created', description: '도메인 컨텍스트' },
  { name: 'PRD',            path: 'docs/PRD/<slug>.md',   status: 'created', description: '제품 요구사항' },
  { name: 'ARCHITECTURE',   path: 'docs/ARCHITECTURE.md', status: 'created', description: '고수준 아키텍처' },
  { name: 'FILE-TREE',      path: 'docs/FILE-TREE.md',    status: 'created', description: '파일트리 설계' },
  { name: 'WORKFLOW',       path: 'docs/WORKFLOW.md',     status: 'created', description: '핵심 워크플로우' },
  { name: 'DATASETS',       path: 'docs/DATASETS.md',     status: 'created', description: '데이터 스키마' },
  // ...생성된 경우에만 추가: DECISIONS / ROADMAP / API-SPEC 등
];

await writeDocsIndex({ projectRoot: outDir, docs, now: new Date() });
// writeDocsIndex 시그니처: writeDocsIndex({ projectRoot, docs, now }) → { ok, indexPath }
// (index-gen.js는 T2/backend-wire11이 구현 중 — 위 계약 시그니처에 맞춰 호출부만 작성한다)
```

---

## Phase 4 — COHERENCE: 교차정합 검사 (BLUEPRINT 후)

BLUEPRINT에서 생성된 구조화 객체들을 `lib/genesis/coherence.js#checkCoherence()`로 교차정합 검사한다.

```js
const { checkCoherence } = await import(toFileUrl(path.join(pluginRoot, 'lib/genesis/coherence.js')));

const coherenceResult = await checkCoherence({
  tree,      // FILE-TREE 추론 결과
  flows,     // WORKFLOW 추론 결과
  schemas,   // DATASETS 추론 결과
  prdFeatures: spec.features,  // CLARIFY에서 확정된 기능 목록
});
// checkCoherence 시그니처:
// checkCoherence({ tree, flows, schemas, prdFeatures }) → { ok, issues: [{ severity, kind, detail }] }
```

**검사 항목:**
- **cross-requirement 모순 탐지** (Kiro 방식): PRD 기능 간 충돌(예: "인증 없음"이면서 "사용자별 데이터 격리") 탐지
- **수락 기준 형식 검사**: 수락 기준은 EARS 형식(`WHEN <트리거> THE SYSTEM SHALL <동작>`)을 따르는지 확인
- **트리-플로우 정합**: FILE-TREE의 모듈이 WORKFLOW 단계에서 참조되는지 확인
- **스키마-기능 정합**: features에 언급된 엔티티가 DATASETS 스키마에 정의됐는지 확인

**결과 처리:**
- `ok: true` — 이상 없음, REVISE로 진행
- `ok: false` — issues를 GFM 테이블로 사용자에게 보고:

```
| 심각도 | 종류 | 상세 |
|--------|------|------|
| ERROR  | cross-req | "인증 없음"과 "사용자별 데이터 격리"가 충돌 |
| WARN   | schema-gap | 기능 'Order'에 대한 스키마 정의 없음 |
```

`severity: 'ERROR'` 이슈 존재 시 → REVISE 진행 또는 자동 보정 여부를 `AskUserQuestion`으로 확인.
`severity: 'WARN'` 이슈만 존재 시 → 사용자에게 보고 후 REVISE로 자동 진행.

---

## Phase 5 — REVISE: 청사진 검토 및 수정 (최대 3회 루프)

블루프린트 요약을 제시하고 `AskUserQuestion`으로 수정 여부를 확인한다.
**루프 상한 3회** — 무한 루프 방지. 3회 소진 후에도 미결이면 현 상태로 완료 처리하고 경고 출력.

```
REVISE 라운드 <N>/3
====================
생성된 청사진 요약:
  도메인: <domain>
  기능: <features 목록>
  비목표: <nonGoals 목록>
  문서: 6종 완료

어디를 수정할까요?
  A) 만족 — 이대로 완료 (Recommended)
  B) 파일트리 구조 변경
  C) 기능 추가 또는 제거
  D) 데이터 스키마 수정
  E) 전체 재생성 (스펙부터 다시)
```

- **A 선택 또는 3회 소진** → GO COMPLETE 출력 후 종료.
- **B/C/D 선택** → 해당 문서만 재생성 후 다음 REVISE 라운드.
- **E 선택** → Phase 1(INTAKE)부터 재시작.

---

## Phase 6 — SCAFFOLD: `.claude/` 디렉토리 생성

CLARIFY에서 채운 enriched spec을 구성해 `lib/genesis/scaffold-gen.js#writeClaudeScaffold()`를 호출한다.

**enriched spec 구성:**

```js
const spec = {
  projectName,                        // INTAKE에서 추론한 프로젝트명
  domain:      spec.domain,           // INTAKE 결과
  rules:       spec.rules ?? [],      // CLARIFY에서 확정된 rules 목록
  skills:      spec.skills ?? [],     // CLARIFY에서 확정된 skills 목록
  agents:      spec.agents ?? [],     // CLARIFY에서 확정된 agents 목록
  hooks:       spec.hooks ?? [],      // CLARIFY에서 확정된 hooks 목록
  commands:    spec.commands ?? [],   // CLARIFY에서 확정된 commands 목록
  settings:    spec.settings ?? {},   // CLARIFY에서 확정된 settings
};
```

**호출 (Phase 3 동적 import 규약 재사용):**

```js
const { writeClaudeScaffold } = await import(
  toFileUrl(path.join(pluginRoot, 'lib/genesis/scaffold-gen.js'))
);

const scaffoldResult = await writeClaudeScaffold({
  projectRoot: outDir,
  spec,
  now: new Date(),
});
// writeClaudeScaffold 시그니처:
// writeClaudeScaffold({ projectRoot, spec, now }) → { ok, written, warnings }
```

**생성물:**

```
<outDir>/
  CLAUDE.md                     ← 이미 Phase 3에서 생성; scaffold-gen은 덮어쓰지 않음
  .claude/
    rules/                      ← spec.rules 기반
    skills/                     ← spec.skills 기반
    agents/                     ← spec.agents 기반
    hooks/                      ← spec.hooks 기반 (.mjs 확장자 — Windows 호환)
    commands/                   ← spec.commands 기반
    settings.json               ← spec.settings 기반
```

**DATA POLICY 적용:**
- hooks는 반드시 `.mjs` 확장자. 외부 네트워크 호출 없는 로컬 전용 스크립트만 생성.
- `.mcp.json`이 포함되는 경우 외부 MCP 서버 자동배선 **금지** — `warnings`에 해당 항목을 기록하고 사용자에게 수동 검수를 요청한다.
- 외부 서비스·DB 호출 코드 생성 금지.

**결과 처리:**

```
scaffoldResult.ok === true  → 생성된 파일 목록(written)을 GFM 테이블로 출력 후 Phase 7로 진행.
scaffoldResult.warnings.length > 0 → warnings를 사용자에게 표시 후 진행.
scaffoldResult.ok === false → 오류 내용 보고 후 AskUserQuestion으로 재시도 여부 확인.
```

---

## Phase 7 — VERIFY: 생성 파일 검증

> Phase 4 COHERENCE는 SPEC 객체 정합(문서 간 논리 충돌)을 검사하고, Phase 7 VERIFY는 **실제로 쓰여진 파일**의 구조·링크·스키마를 검증한다.

SCAFFOLD에서 생성된 파일을 `lib/genesis/verify-gen.js#verifyGenerated()`로 검증한다.

```js
const { verifyGenerated } = await import(
  toFileUrl(path.join(pluginRoot, 'lib/genesis/verify-gen.js'))
);

const verifyResult = await verifyGenerated({ projectRoot: outDir });
// verifyGenerated 시그니처:
// verifyGenerated({ projectRoot }) → { ok, checks: [{ name, pass, severity, detail }] }
```

**결과를 GFM 테이블로 출력:**

```
| 검증 항목 | 통과 | 심각도 | 상세 |
|-----------|------|--------|------|
| claude-md-exists | ✓ | info | CLAUDE.md 확인 |
| hooks-ext-mjs    | ✓ | info | 모든 hooks .mjs 확장자 |
| settings-schema  | ✗ | error | settings.json 필수 키 누락: model |
```

**결과 처리:**

- `severity: 'error'` 항목 존재 시 → 해당 항목을 사용자에게 보고하고, `AskUserQuestion`으로 **자동 보정** 또는 **Phase 5(REVISE) 회귀** 여부를 확인한다.
- `severity: 'warn'` 항목만 존재 시 → 표로 보고 후 자동 진행.
- 모든 checks 통과(`ok: true`) → GO COMPLETE 출력.

---

## Output Format

`--dry-run` 시:

```
/go DRY-RUN
===========
Project: <name>    Domain: <domain>    Out: <outDir>

WILL CREATE:
  <outDir>/CLAUDE.md
  <outDir>/docs/PRD/<slug>-<date>.md
  <outDir>/docs/ARCHITECTURE.md
  <outDir>/docs/FILE-TREE.md
  <outDir>/docs/WORKFLOW.md
  <outDir>/docs/DATASETS.md

실제 생성: /go "<idea>" --out <outDir> (--dry-run 제거)
```

실행 완료 시 GFM 테이블:

| 문서 | 경로 | 상태 |
|------|------|------|
| CLAUDE.md | `<outDir>/CLAUDE.md` | CREATED |
| PRD | `<outDir>/docs/PRD/<slug>-<date>.md` | CREATED |
| ARCHITECTURE | `<outDir>/docs/ARCHITECTURE.md` | CREATED |
| FILE-TREE | `<outDir>/docs/FILE-TREE.md` | CREATED |
| WORKFLOW | `<outDir>/docs/WORKFLOW.md` | CREATED |
| DATASETS | `<outDir>/docs/DATASETS.md` | CREATED |

```
/go COMPLETE
============
Project:   <name>
Domain:    <domain>
Out:       <outDir>
Documents: 6/6 created
Scaffold:  .claude/{rules,skills,agents,hooks,commands,settings.json}
Verified:  <N> checks passed

Next: /orchestrate feature  — 청사진대로 구현 묶음 발동 (plan→design→구현→review→merge).
      또는 /plan "<feature>" 로 단일 단계만 분해, /autopilot 로 무인 실행.
```

**생성 트리 요약 (100% 완료):**

```
<outDir>/
  CLAUDE.md                          ← 도메인 컨텍스트
  docs/
    PRD/<slug>-<date>.md             ← 제품 요구사항
    ARCHITECTURE.md                  ← 고수준 아키텍처
    FILE-TREE.md                     ← 파일트리 설계
    WORKFLOW.md                      ← 핵심 워크플로우
    DATASETS.md                      ← 데이터 스키마 정의
  .claude/
    rules/                           ← 프로젝트 rules
    skills/                          ← 프로젝트 skills
    agents/                          ← 프로젝트 agents
    hooks/                           ← 이벤트 hooks (.mjs)
    commands/                        ← 슬래시 커맨드
    settings.json                    ← 모델/팀 설정
```

**진행률: 7/7 phases — 100%**

## Next Steps

청사진이 준비되면 **상황별 묶음 커맨드**로 다음 단계를 한 번에 발동한다. 각 묶음은 `artibot.config.json#team.playbooks`에 단계 DAG로 정의돼 있고 `/orchestrate <name>`로 실행된다 (`commands/orchestrate.md`).

| # | 상황 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 청사진대로 구현 (권장) | `/orchestrate feature` | plan→design→구현(fe∥be)→review→merge 묶음 자동 발동 |
| 2 | 자율 실행 (무인) | `/autopilot "<feature>"` | 청사진 기반 Phase 0~6 무인 구현 + Goal 루프 |
| 3 | 구현 단계 분해 (단일) | `/plan` | 첫 스프린트 실행 계획만 분해 |
| 4 | 아키텍처 심화 | `/design` | architect agent에게 상세 설계 위임 |

> **상황별 묶음 매핑**: 신규 빌딩 후 구현=`/orchestrate feature` · 버그 수정=`/orchestrate bugfix` · 구조 개선=`/orchestrate refactor`.
>
> **구현 후 PRD 대조 검증**: MVP를 구축한 뒤 PRD대로 됐는지 확인하려면 `/code-review`(또는 `/review`) — `code-reviewer`가 **spec-reviewer**(PRD의 F-ID·Acceptance Criteria 대조: 과잉구현·누락기능·스펙이탈 탐지)와 quality-reviewer를 순차 실행한다. 기계적 통과(lint/typecheck/test/build)는 `/verify`. PRD의 `F-01… AC(EARS/GWT)`를 검증 입력으로 넘긴다.
