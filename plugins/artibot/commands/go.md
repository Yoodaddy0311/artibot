---
description: >
  (Artibot) Project genesis — turns a single idea or repo into a complete blueprint folder in one shot.
  Use when user wants to start a new project, scaffold a project from scratch, turn an idea into a
  blueprint, generate a PRD and full design at once, or says "처음부터 설계해줘", "아이디어를 프로젝트로 만들어줘",
  "파일트리/워크플로우/데이터셋 한번에 만들어줘", "idea to blueprint", "프로젝트 청사진 만들어", "새 프로젝트 시작해줘".
  Produces 6 blueprint documents (CLAUDE.md, PRD, ARCHITECTURE, FILE-TREE, WORKFLOW, DATASETS) under
  a single output folder without touching external services or databases.
argument-hint: '<아이디어 또는 repo 경로>'
allowed-tools: [Read, Glob, Grep, Bash, Write, Task, TaskCreate, Skill, AskUserQuestion]
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

## PRD 링크
docs/PRD/<slug>-<date>.md
```

### 문서 2 — docs/PRD/`<slug>.md`

`lib/planning/artifacts.js#writePRD()` 호출 — 재구현 금지.
PRD는 반드시 **비목표(out-of-scope) 섹션**을 포함한다: CLARIFY에서 명시적으로 제외된 항목과 현 MVP 범위 밖 기능을 "하지 않을 것" 목록으로 기술한다. 이는 PM 표준이며 생략 불가.

```js
const { ok, prdPath } = await writePRD({
  projectRoot: outDir,
  slug: slugify(projectName),
  title: projectName,
  sections: {
    배경: '...domain context...',
    목표: '...goals from spec.features...',
    비목표: '...spec.nonGoals — 하지 않을 것 목록...',
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
Task(architect, prompt="<domain> 프로젝트의 고수준 아키텍처 설계. 도메인: <domain>, 스택: <stack>")
```

MVP에서는 모델이 간결한 레이어 다이어그램(텍스트)을 `Write`로 직접 생성해도 된다. 위임 여부는 복잡도 판단에 따른다.

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

- **A 선택 또는 3회 소진** → GENESIS COMPLETE 출력 후 종료.
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
- 모든 checks 통과(`ok: true`) → GENESIS COMPLETE 출력.

---

## Output Format

`--dry-run` 시:

```
GENESIS DRY-RUN
===============
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
GENESIS COMPLETE
================
Project:   <name>
Domain:    <domain>
Out:       <outDir>
Documents: 6/6 created
Scaffold:  .claude/{rules,skills,agents,hooks,commands,settings.json}
Verified:  <N> checks passed

Next: /plan "<feature>" to decompose the first implementation sprint.
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

| # | 상황 | 커맨드 | 설명 |
|---|------|--------|------|
| 1 | 구현 단계 분해 | `/plan` | 첫 스프린트 실행 계획 |
| 2 | 아키텍처 심화 | `/design` | architect agent에게 상세 설계 위임 |
| 3 | 자율 실행 | `/autopilot` | 청사진 기반 무인 구현 |
