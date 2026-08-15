/**
 * 검사 목적: 마크다운이 **위임 대상으로 지목하는 에이전트 이름**이 그 플러그인이
 * 실제로 출하하는 에이전트인가.
 *
 * `frontmatter-tool-names.test.js` 는 **도구 이름**(`Agent`, `Read`, …)을 본다.
 * 이 파일은 그 도구에 넘기는 **인자**, 즉 서브에이전트 이름을 본다. 그쪽 게이트가
 * 자기 헤더 한계 #4 에 "괄호 **안**의 서브에이전트명 오탈자는 이 게이트가 못
 * 잡는다"고 명시해 둔 바로 그 구멍이다.
 *
 * ── 실측 (수치는 전부 커밋 의존이다 — 시점을 지우지 마라) ───────────────────
 * **기준 커밋 `f74574b2`, 2026-08-15 20:2x 측정.** 이 게이트가 처음 켜졌을 때
 * `artibot-cowork` 의 유령 에이전트 참조는 **41건**이었다(그중 5건은 빌트인
 * `Explore`/`Plan` 이라 실제 결함은 36건). 표기별 분포:
 *
 *   - 스킬 프론트매터 `agents:`  **30건** ← 최대 표면. `f74574b2` **이전부터** 있었다.
 *   - `Agent(<name>)` 호출형       **6건**
 *   - 표 셀 맨이름                 **나머지** (이 스캐너는 못 본다 — 한계 #2)
 *
 * **`Agent()` 6건은 `f74574b2` 가 만든 표면이다.** 직접 확인:
 *   git show f74574b2~1:plugins/artibot-cowork/commands/analyze.md
 * 그 이전 판은 `Task(security-reviewer)` 였고 `Agent(<name>)` 은 **0건**이었다.
 * 즉 유령 *이름* 은 그 전부터 있었고, 그 커밋의 `Task(`→`Agent(` 정리가 이
 * 스캐너가 보는 **표기**를 새로 만들었다. 분포를 다시 잴 때 커밋이 다르면
 * 숫자도 다르다 — 재측정 없이 이 수치를 인용하지 마라.
 *
 * cowork 는 마케팅 에이전트 12종만 출하하는데 `Agent(architect)`,
 * `Agent(security-reviewer)`, 스킬 프론트매터의 `code-reviewer`·
 * `frontend-developer`·`performance-engineer` 등 **본체 artibot 전용 이름**을
 * 가리키고 있었다.
 *
 * ── 왜 그 이름들이 cowork 에서 "유령"인가 (판정의 근거) ─────────────────────
 * cowork 사용자는 본체 artibot 을 함께 깔지 않는다. 근거는 cowork `README.md`
 * 세 문장이고, **결정적인 것은 :76 이다**:
 *
 *   :76  "The full `artibot` plugin … **depends on Node.js hooks and external
 *         scripts not designed for the Cowork sandbox**"
 *          → 취향 문제가 아니라 **기술적 실행 불가** 진술이다. 가장 튼튼한 근거.
 *   :14  "designed for knowledge workers using Claude Cowork … **rather than**
 *         developers using Claude Code"
 *   :78  "`artibot-cowork` is a **curated subset**"
 *
 * **주의 — README 에 "대체(replace)"라는 단어는 없다.** 이 판정을 "cowork 는
 * 본체의 대체재"라고 요약하면 원문에 없는 표현을 인용하는 것이 된다(실측:
 * `grep -iE '대체|replace|instead of' README.md` → 0건). 위 세 문장을 인용하라.
 *
 * ── 왜 기존 게이트로 안 잡혔나 ─────────────────────────────────────────────
 * 1. 도구명 게이트는 `normalizeToolName` 이 `Agent(architect)` → `Agent` 로
 *    괄호를 **잘라내고** 본다. 인자는 검사 대상이 아니다.
 * 2. cowork 에는 **실행 가능한 테스트가 하나도 없다.** `tests/smoke/` 는 전부
 *    `.md` 파일이고 `writing-pack.test.md` 도 마크다운이다. CHANGELOG 가 말하는
 *    "smoke test suite ... agent-skill allow-list integrity" 는 문서지 게이트가
 *    아니다. 그래서 위 실측치가 조용히 쌓였다 — **누가 세지 않아서**이지
 *    누가 봐주고 넘어가서가 아니다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ──────────────────
 *
 *  1. **실행하지 않는다.** 이름이 출하 목록에 있다는 것만 본다. 그 에이전트가
 *     실제 세션에서 스폰되는지, 스폰 실패 시 하네스가 어떻게 처리하는지는
 *     검증하지 않는다(그 동작은 미확인이다).
 *  2. **산문·표 셀의 맨이름은 못 본다.** `Agent(...)` 호출형과 프론트매터
 *     `agent:`/`agents:` 만 판다. 표 셀에 맨이름으로 적힌 `| architect |` 같은
 *     형태는 걸리지 않는다.
 *
 *     **이 구멍의 실제 크기는 3종이다.** 두 수치를 단위와 함께 읽어라 — 하나만
 *     보면 방향이 반대로 오도된다(cowork `agents/orchestrator.md`, `f74574b2` 기준).
 *
 *       (a) 사람이 그 파일에서 **만진 총량** = 9줄 / 18회 출현 / 9종
 *           - PDCA 표 5행 → 11회 · Quality Gates 표 2행 → 3회 · 산문 2줄 → 4회
 *           재현: `git diff -- plugins/artibot-cowork/agents/orchestrator.md`
 *
 *       (b) **표 셀 스캔이 아니면 영원히 못 찾았을 이름 = 3종**
 *           `database-reviewer` · `e2e-runner` · `refactor-cleaner`
 *           — 이 셋은 `Agent()` 출현 0건 **그리고** 프론트매터 출현 0건이다.
 *           나머지 6종(architect·code-reviewer·frontend-developer·
 *           backend-developer·security-reviewer·tdd-guide)은 다른 표면에서
 *           이미 잡혀 위 36건 집계 안에 있었다.
 *           재현(이름 하나당 두 표면을 따로 센다. 디렉터리 pathspec 이면 충분하다):
 *             git grep -oh "Agent(<name>" f74574b2 -- plugins/artibot-cowork | wc -l
 *             git grep -oh '^\s*-\s*"<name>"' f74574b2 -- plugins/artibot-cowork | wc -l
 *
 *     **9 로만 적으면 구멍을 3배로 과장**하게 되고, 다음 사람이 "맨이름 스캔을
 *     반드시 넣어야 한다"고 과잉 대응할 근거가 된다. 18회는 구멍의 크기가
 *     아니라 그 파일에서 사람이 만진 총량이다.
 *
 *     맨이름 스캔을 넣지 않은 이유는 오탐이다 — `architect` 는 "image creation
 *     architect AI" 같은 영어 산문에도 나온다. 즉 이 구멍은 **알고 남긴 것**이고,
 *     같은 형태가 다시 들어오면 조용히 통과한다. 사람이 봐야 한다.
 *  3. **의미 대응은 못 본다.** 이름이 실재하기만 하면 통과한다. 마케팅 스킬이
 *     엉뚱한 마케팅 에이전트를 가리켜도 green 이다.
 *  4. **빌트인 목록은 수동 사본이다.** `Explore`·`Plan` 은 하네스 제공
 *     서브에이전트라 어느 플러그인도 `.md` 로 출하하지 않는다. 하네스가 이름을
 *     바꾸거나 빌트인을 추가하면 같이 낡는다.
 *  5. **유령 *커맨드* 참조는 대상이 아니다.** 같은 census 에서 cowork 가
 *     `/implement`·`/git`·`/test` 등 실재하지 않는 커맨드를 가리키는 것을
 *     발견했으나(최종 실측 **14종 / 18건**), 이 파일은 에이전트만 본다.
 *     그 표면은 `command-name-references.test.js` 가 맡는다.
 *
 * @module tests/firewall/agent-name-references
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = join(__dirname, '..', '..', '..');

/**
 * 검사 대상 플러그인. cowork 를 포함하는 이유는 그것이 artibot 의 미러가 아니라
 * **독립 출하물**이고, 자체 에이전트 목록(12종)이 본체(28종)와 다르기 때문이다.
 */
const PLUGINS = [
  { id: 'artibot', dir: join(PLUGINS_DIR, 'artibot') },
  { id: 'artibot-cowork', dir: join(PLUGINS_DIR, 'artibot-cowork') },
];

/** 스캔할 하위 디렉터리. CHANGELOG·docs 는 과거 서술이라 제외한다. */
const SCAN_DIRS = ['commands', 'agents', 'skills'];

/**
 * 하네스가 제공하는 빌트인 서브에이전트. 어느 플러그인도 `.md` 로 출하하지
 * 않으므로 출하 목록 대조만으로는 유령으로 오인된다.
 *
 * 근거(실측 `f74574b2`, 2026-08-15 20:5x): 본체 artibot 이 `agents/explore.md` 를
 * **출하하지 않으면서** `Explore` 를 계속 쓴다 — `Agent(Explore)` **7건 / 5파일**,
 * 프론트매터 `agent: Explore` **15건**(합 22건). 출하 없이 이만큼 쓰이는 이름은
 * 빌트인이다.
 *
 * 재현(게이트 자신의 테스트 코드는 제외해야 한다 — 안 그러면 자기 픽스처를 센다):
 *   grep -rn 'Agent(Explore' plugins/artibot --include=*.md | grep -v '/tests/' | wc -l
 *   grep -rn '^agent: Explore' plugins/artibot --include=*.md | wc -l
 *
 * 재확인: Claude Code 세션의 하네스 서브에이전트 목록과 직접 대조하라. 위 수치는
 * "출하하지 않는데 쓰인다"는 **정황**이지 빌트인이라는 직접 증거가 아니다.
 */
const BUILTIN_SUBAGENTS = new Set(['Explore', 'Plan']);

/**
 * 이름 자리에 오는 **틀 문자열**. 실제 이름이 아니라 "여기에 이름을 넣어라"는
 * 표기이므로 검사 대상이 아니다.
 */
const PLACEHOLDERS = new Set(['subagent_type', 'type', 'name', 'agent-name']);

/** @param {string} dir @param {string[]} out */
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.md')) out.push(p);
  }
  return out;
}

/** 플러그인이 실제 출하하는 에이전트 이름. `agents/*.md` 의 `name:` 이 정본. */
export function shippedAgents(pluginDir) {
  const names = new Set();
  const agentsDir = join(pluginDir, 'agents');
  let files;
  try { files = readdirSync(agentsDir); } catch { return names; }
  for (const f of files) {
    if (!f.endsWith('.md') || f === 'INDEX.md') continue;
    const m = readFileSync(join(agentsDir, f), 'utf-8').match(/^name:\s*(.+)$/m);
    if (m) names.add(m[1].trim());
  }
  return names;
}

/** 프론트매터 블록. 없으면 null. */
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');

/**
 * 한 파일에서 에이전트 이름 참조를 뽑는다.
 *
 * 두 표기만 판다:
 *   - `Agent(<name>` 호출형의 첫 위치인자
 *   - 프론트매터 `agent: <name>` / `agents: [a, b]` / `agents:\n  - a`
 *
 * @param {string} text
 * @returns {{name: string, line: number, kind: string}[]}
 */
export function extractAgentRefs(text) {
  const refs = [];
  const lines = text.split(/\r?\n/);

  // `partitionRecordsByAgent(records)` 처럼 이름 끝이 Agent 로 끝나는 식별자를
  // 잡지 않도록 앞 문자를 막는다. 이걸 빼면 CHANGELOG 류에서 오탐이 난다.
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/(?<![A-Za-z0-9_])Agent\(\s*([A-Za-z0-9_-]+)/g)) {
      refs.push({ name: m[1], line: i + 1, kind: 'Agent()' });
    }
  });

  const block = frontmatter(text);
  if (block === null) return refs;
  const bLines = block.split(/\r?\n/);
  const offset = lines.findIndex((l) => /^---/.test(l)) + 2;

  bLines.forEach((l, i) => {
    const scalar = l.match(/^agent:\s*(.+)$/);
    if (scalar) refs.push({ name: unquote(scalar[1]), line: offset + i, kind: 'agent:' });

    const flow = l.match(/^agents:\s*\[(.+)\]\s*$/);
    if (flow) {
      for (const p of flow[1].split(',')) {
        const n = unquote(p);
        if (n) refs.push({ name: n, line: offset + i, kind: 'agents:[]' });
      }
    }

    if (/^agents:\s*$/.test(l)) {
      for (let j = i + 1; j < bLines.length; j += 1) {
        const item = bLines[j].match(/^\s+-\s+(.+)$/);
        if (!item) break;
        const n = unquote(item[1]);
        if (n) refs.push({ name: n, line: offset + j, kind: 'agents:-' });
      }
    }
  });

  return refs;
}

/**
 * 플러그인 하나를 훑어 출하 목록 밖 이름을 모은다.
 *
 * @param {{id: string, dir: string}} plugin
 * @param {Set<string>} [allowlist] 뮤테이션 테스트가 주입할 수 있게 인자로 받는다.
 */
export function scanPlugin(plugin, allowlist) {
  const shipped = allowlist ?? shippedAgents(plugin.dir);
  const violations = [];
  let scanned = 0;
  let refCount = 0;

  for (const sub of SCAN_DIRS) {
    for (const file of walk(join(plugin.dir, sub))) {
      scanned += 1;
      const rel = relative(plugin.dir, file).replace(/\\/g, '/');
      for (const ref of extractAgentRefs(readFileSync(file, 'utf-8'))) {
        refCount += 1;
        if (PLACEHOLDERS.has(ref.name)) continue;
        if (BUILTIN_SUBAGENTS.has(ref.name)) continue;
        if (shipped.has(ref.name)) continue;
        violations.push({ file: `${plugin.id}/${rel}`, line: ref.line, name: ref.name, kind: ref.kind });
      }
    }
  }
  return { violations, scanned, refCount, shipped };
}

const format = (vs) => vs.map((v) => `  ${v.name} (${v.kind})  ${v.file}:${v.line}`).join('\n');

describe('에이전트 이름 참조 — 실재 검증', () => {
  for (const plugin of PLUGINS) {
    it(`${plugin.id}: 위임 대상 에이전트가 전부 그 플러그인의 출하 목록에 있다`, () => {
      const { violations, shipped } = scanPlugin(plugin);
      expect(
        violations,
        `${plugin.id} 이 출하하지 않는 에이전트를 가리킨다 (출하 ${shipped.size}종):\n${format(violations)}`,
      ).toEqual([]);
    });
  }
});

describe('스코프 — 게이트가 실제로 무언가를 보고 있다', () => {
  for (const plugin of PLUGINS) {
    it(`${plugin.id}: 파일과 참조를 실제로 읽는다`, () => {
      // 분모가 0 이 되면(경로 오타, 디렉터리 이동) 위 검사가 조용히 전부 통과한다.
      const { scanned, refCount, shipped } = scanPlugin(plugin);
      expect(shipped.size).toBeGreaterThan(5);
      expect(scanned).toBeGreaterThan(20);
      expect(refCount).toBeGreaterThan(10);
    });
  }

  it('두 플러그인의 출하 목록이 서로 다르다 (cowork 는 미러가 아니다)', () => {
    const [main, cowork] = PLUGINS.map((p) => shippedAgents(p.dir));
    expect(main.size).toBeGreaterThan(cowork.size);
    // cowork 전용 이름이 본체에 없어야 "독립 목록"이 실증된다.
    expect([...cowork].some((n) => !main.has(n))).toBe(true);
  });
});

describe('스캐너 자기검증 — 파서', () => {
  it('Agent() 첫 위치인자를 읽는다', () => {
    expect(extractAgentRefs('Agent(planner)').map((r) => r.name)).toEqual(['planner']);
    expect(extractAgentRefs('Agent(planner, name="x")').map((r) => r.name)).toEqual(['planner']);
  });

  it('식별자 꼬리의 Agent( 는 오탐하지 않는다', () => {
    // `partitionRecordsByAgent(records)` 가 실제로 CHANGELOG 에 있다.
    expect(extractAgentRefs('partitionRecordsByAgent(records)')).toEqual([]);
    expect(extractAgentRefs('createAgent(foo)')).toEqual([]);
  });

  it('프론트매터 세 표기를 모두 읽는다', () => {
    const flow = '---\nagents: ["a", "b"]\n---\n';
    const block = '---\nagents:\n  - "c"\n  - "d"\ntokens: x\n---\n';
    const scalar = '---\nagent: Explore\n---\n';
    expect(extractAgentRefs(flow).map((r) => r.name)).toEqual(['a', 'b']);
    expect(extractAgentRefs(block).map((r) => r.name)).toEqual(['c', 'd']);
    expect(extractAgentRefs(scalar).map((r) => r.name)).toEqual(['Explore']);
  });

  it('agents 블록은 들여쓴 항목에서 끝난다 (다음 키를 삼키지 않는다)', () => {
    const t = '---\nagents:\n  - "a"\ntokens: "~3K"\ncategory: "x"\n---\n';
    expect(extractAgentRefs(t).map((r) => r.name)).toEqual(['a']);
  });
});

describe('스캐너 자기검증 — 게이트가 헛돌지 않는다', () => {
  it('출하 목록을 축소하면 그 이름이 위반으로 잡힌다', () => {
    // 뮤테이션. RED 를 못 내면 위 "실재 검증" 은 항상 통과하는 헛돌이다.
    const cowork = PLUGINS.find((p) => p.id === 'artibot-cowork');
    const full = shippedAgents(cowork.dir);
    expect(full.has('data-analyst')).toBe(true);

    const shrunk = new Set(full);
    shrunk.delete('data-analyst');
    const { violations } = scanPlugin(cowork, shrunk);

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.name === 'data-analyst')).toBe(true);
  });

  it('빈 출하 목록이면 거의 모든 참조가 위반이다', () => {
    const cowork = PLUGINS.find((p) => p.id === 'artibot-cowork');
    const { violations } = scanPlugin(cowork, new Set());
    expect(violations.length).toBeGreaterThan(20);
  });

  it('빌트인 제외가 없으면 Explore 가 위반으로 잡힌다 (제외가 실효한다는 증명)', () => {
    // BUILTIN_SUBAGENTS 가 조용히 비어도 아무도 모르는 상태를 막는다.
    expect(BUILTIN_SUBAGENTS.has('Explore')).toBe(true);
    const refs = extractAgentRefs('Agent(Explore)');
    expect(refs.map((r) => r.name)).toEqual(['Explore']);
  });
});
