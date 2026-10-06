/**
 * 검사 목적: 에이전트 프론트매터를 읽는 **복제본들이 같은 픽스처에 어떤 판정을 내리는가**를
 * 고정하고, 엄격 방언 오라클(`checkStrictAgentFrontmatter`)이 CI 쪽 소비자까지 같은 함수로
 * 닿아 있는지 본다 (lane 1A, 2026-10-07).
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────────────────
 * 호스트는 agents/*.md 의 frontmatter 를 주석 안의 첫 `---` 에서 닫는다(n=5, audit
 * 2026-10-06 section 2.5). 플러그인 안의 파서는 10개가 넘고 주석을 제각각 다뤘으며, 어느
 * 것도 호스트처럼 잘라 읽지 않아서 30/30 이 결함 상태일 때도 전부 green 이었다. 이 파일은 그
 * 격차를 **없애지 않고 드러낸다**: 런타임 파서는 결정 D1 대로 관대하게 둔다(확장 에이전트가
 * 같은 파서를 타므로 서드파티 에이전트를 거부하면 안 된다). 대신 CI·firewall 쪽은 엄격 방언
 * 하나를 오라클로 삼고, 나머지 복제본이 같은 픽스처에 무엇을 내놓는지를 표로 못박는다. 복제본
 * 하나가 바뀌면 표가 RED 가 되어 사람이 격차를 다시 판단한다.
 *
 * ── 2026-10-07 실측: 관대한 파서끼리도 서로 다르다 ───────────────────────────
 *   - 대시 주석(`# --- X ---`)이 든 tools 블록: firewall·registry·export-to-tool 은 전체 목록을
 *     읽고, `skill-exporter` 는 첫 주석 줄에서 목록을 끝낸다(호스트와 같은 결과, 이유는 다르다).
 *     skill-exporter 가 에이전트에서 소비하는 것은 name 뿐이라 지금은 영향이 없다.
 *   - 항목 뒤 인라인 주석: firewall·export-to-tool 은 벗기고, registry·skill-exporter 는
 *     `SendMessage   # DM` 을 항목 이름으로 남긴다(NEXT-SESSION.md 의 consumeBlockList
 *     줄 끝 주석 결함). 출하된 30개가 주석을 잃어 지금은 휴면이고, 확장 에이전트는 여전히 걸린다.
 *   - `scripts/validate-agent-frontmatter.js` 는 registry 파서의 사본이다. 6개 함수 중 4개가
 *     같고, `extractFrontmatterLines` 는 표현이 다르며(동치 여부 미확인), `consumeBlockList`
 *     는 `-` 단독 항목 분기가 사본에만 있다(함수 단위 diff, 2026-10-07).
 *
 * ── 이 게이트가 못 보는 것 (rules section 9 — 게이트 옆에 적어라) ────────────
 *  1. **호스트의 실제 규칙.** `hostVisibleTools` 는 n=5 관측("첫 `---` 에서 닫힌다")을 옮긴
 *     가설이다. `---` 없는 주석·비호스트 키의 처리는 미확인(프로브 P0a)이고, 이 파일은 그 칸을
 *     채우지 않는다 — 엄격 오라클이 주석을 전부 오류로 보는 이유다.
 *  2. **복제본 목록은 수동이다.** 새 복제본이 생겨도 목록에 넣지 않으면 보이지 않는다. 목록이
 *     실재 코드를 가리키는지(이름 변경·삭제)만 본다. 목록은 2026-10-07 census 결과다:
 *     `function (parse|extract|split|read)Front-?[Mm]atter` 류 정의를 리포 전역(node_modules·
 *     .git 제외)에서 훑어, 에이전트와 무관한 것을 걸러냈다. 걸러낸 것은 스킬(`skill-freshness`,
 *     `gen-skill-docs`), 커맨드(`migrate-command-toolsets`, `add-lang-field`,
 *     `split-window-contract.test`), 메모리·산출물(`memory-md-adapter`, `outcome-artifact`,
 *     `plan-artifact`, `review-artifact`, `planning/artifacts`, `independent-reviewer` 의 의도
 *     문서) 이다. 이름이 다른 파서(예: 정규식 상수만 쓰는 것)는 이 census 에 안 걸린다.
 *  3. **실행하지 않는 복제본.** `exercised:false` 항목은 존재만 확인한다. 이유는 항목마다 적었다.
 *  4. **실제 호스트가 읽는 파일이 아니다.** 설치본(플러그인 캐시)은 이 리포의 사본이고, 동기화가
 *     낡으면 호스트가 보는 파일은 이 테스트가 읽은 파일과 다르다.
 *
 * @module tests/firewall/agent-frontmatter-oracle-parity
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _resetAgentCache, getAgent, loadAgentRegistry } from '../../lib/core/agent-registry.js';
import { parseFrontmatter as skillExporterParse } from '../../lib/core/skill-exporter.js';
import { checkStrictAgentFrontmatter, extractFrontmatter } from '../../scripts/ci/ci-utils.js';
import { parseFrontmatter as exportToToolParse } from '../../scripts/export-to-tool.mjs';
import { parseAgentTools } from './frontmatter-tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** `plugins/artibot` — 이 테스트는 `tests/firewall` 에 있으므로 두 단계 위다. */
const PLUGIN_ROOT = join(__dirname, '..', '..');
const VALIDATE_AGENTS = join(PLUGIN_ROOT, 'scripts', 'ci', 'validate-agents.js');

/** strict 방언을 지키는 최소 에이전트. validate-agents.js 의 필수 키(name·description·model)를 모두 가진다. */
const CLEAN_AGENT = [
  '---',
  'name: demo',
  'capabilities: [a, b]',
  'lifecycle: build',
  'description: |',
  '  A demo agent.',
  'model: opus',
  'tools:',
  '  - Read',
  '  - Grep',
  '  - SendMessage',
  '  - TaskUpdate',
  'category: builder',
  '---',
  '',
  '# Demo',
  '',
].join('\n');

/** 30/30 결함의 원형: tools 블록 한가운데의 대시 주석. 그 뒤 키가 호스트에서는 본문으로 샌다. */
const DASH_COMMENT_AGENT = CLEAN_AGENT.replace(
  '  - SendMessage\n',
  '  # --- Team Collaboration ---\n  - SendMessage\n',
);
/** 대시가 없는 주석. 호스트가 이것을 어떻게 다루는지는 미확인(P0a)이다. */
const PLAIN_COMMENT_AGENT = CLEAN_AGENT.replace('  - SendMessage\n', '  # team tools\n  - SendMessage\n');
/** 항목 뒤 인라인 주석 (cowork orchestrator 와 예전 artibot orchestrator 의 형태). */
const INLINE_COMMENT_AGENT = CLEAN_AGENT.replace('  - SendMessage\n', '  - SendMessage   # DM\n');

const FIXTURES = {
  clean: CLEAN_AGENT,
  dash: DASH_COMMENT_AGENT,
  plain: PLAIN_COMMENT_AGENT,
  inline: INLINE_COMMENT_AGENT,
};

let tmpRoot;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'artibot-oracle-parity-'));
});
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * `validate-agents.js` 를 가짜 플러그인 루트에서 실행한다. 이 스크립트는 `getPluginRoot()` 를
 * 쓰므로 `CLAUDE_PLUGIN_ROOT` 로 루트를 바꿀 수 있다 — 실제 agents/ 를 건드리지 않는다.
 *
 * @param {Record<string, string>} files 파일명 → 내용
 */
function runValidateAgents(files) {
  const root = mkdtempSync(join(tmpRoot, 'plugin-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'agents', name), text, 'utf-8');
  return spawnSync(process.execPath, [VALIDATE_AGENTS], {
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
    encoding: 'utf-8',
  });
}

describe('CI 소비자 — validate-agents.js 가 같은 엄격 오라클을 쓴다', () => {
  it('엄격 방언을 지킨 에이전트는 통과한다 (exit 0)', () => {
    const run = runValidateAgents({ 'demo.md': CLEAN_AGENT });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('PASS: demo.md');
  });

  it('대시 주석이 든 에이전트는 파일·줄·규칙을 대며 실패한다 (exit 1)', () => {
    const run = runValidateAgents({ 'demo.md': DASH_COMMENT_AGENT });
    expect(run.status, `stdout=${run.stdout}`).toBe(1);
    expect(run.stderr).toMatch(/FAIL: demo\.md:\d+ - strict frontmatter \[dashes\]/);
    expect(run.stderr).toMatch(/FAIL: demo\.md:\d+ - strict frontmatter \[comment\]/);
    // 실패한 파일에 PASS 가 같이 찍히면 로그만 보는 사람이 속는다.
    expect(run.stdout).not.toContain('PASS: demo.md');
  });

  it('필수 키 누락(기존 검사)은 그대로 실패한다 — 엄격 검사가 기존 동작을 대체하지 않는다', () => {
    const run = runValidateAgents({ 'demo.md': CLEAN_AGENT.replace('model: opus\n', '') });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Missing required field: model');
  });

  it('출하된 agents/ 전부가 통과하고 분모가 파일 수와 같다', () => {
    const agentsDir = join(PLUGIN_ROOT, 'agents');
    const expected = readdirSync(agentsDir).filter((f) => f.endsWith('.md') && f !== 'INDEX.md' && f !== 'README.md').length;
    const run = spawnSync(process.execPath, [VALIDATE_AGENTS], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
      encoding: 'utf-8',
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(`All ${expected} agent(s) validated successfully.`);
    expect(expected).toBeGreaterThan(20);
  });
});

/**
 * 에이전트 프론트매터를 읽는 복제본 목록 (2026-10-07 census).
 * `exercised`: 'fixture' = 아래 표가 같은 픽스처에 판정을 고정한다 · 'subprocess' = 위 CI 소비자
 * 테스트가 실행한다 · false = 존재만 확인하며 `reason` 을 적었다.
 */
const REPLICAS = [
  { id: 'firewall-lenient', file: 'tests/firewall/frontmatter-tools.js', anchor: 'export function parseAgentTools', role: 'firewall 관대 파서 (D1·cowork 면제 경로)', exercised: 'fixture' },
  { id: 'strict-oracle', file: 'scripts/ci/ci-utils.js', anchor: 'export function checkStrictAgentFrontmatter', role: '엄격 오라클 — firewall 게이트와 validate-agents.js 가 공유', exercised: 'fixture' },
  { id: 'ci-extract', file: 'scripts/ci/ci-utils.js', anchor: 'export function extractFrontmatter', role: 'CI 스칼라 추출기 — commands·skills 검증과 공유라 동결', exercised: 'fixture' },
  { id: 'runtime-registry', file: 'lib/core/agent-registry.js', anchor: 'function consumeBlockList', role: '런타임 레지스트리 — D1 대로 관대, 확장 에이전트도 읽는다', exercised: 'fixture' },
  { id: 'export-to-tool', file: 'scripts/export-to-tool.mjs', anchor: 'export function parseFrontmatter', role: '다른 도구로 내보내기', exercised: 'fixture' },
  { id: 'skill-exporter', file: 'lib/core/skill-exporter.js', anchor: 'export function parseFrontmatter', role: '어댑터용 로더 (에이전트에서는 name 만 소비)', exercised: 'fixture' },
  { id: 'validate-agents', file: 'scripts/ci/validate-agents.js', anchor: 'checkStrictAgentFrontmatter', role: 'CI 소비자 — extractFrontmatter + 엄격 오라클', exercised: 'subprocess' },
  { id: 'cli-validator', file: 'scripts/validate-agent-frontmatter.js', anchor: 'function consumeBlockList', role: '자문용 CLI — registry 파서의 사본', exercised: false, reason: 'import 하면 main() 이 돌고 process.exit(0) 한다. 위 머리글의 사본 간 차이를 보라.' },
  { id: 'validate-js', file: 'scripts/validate.js', anchor: 'async function validateAgents', role: 'npm run validate — 정규식 존재 검사(name, modelTier)', exercised: false, reason: 'export 가 없고 import 하면 전체 검증을 실행한다. 이 스크립트는 validate-agents.js 를 호출하지 않는다.' },
  { id: 'model-policy', file: 'scripts/ci/validate-model-policy.js', anchor: 'export function readAgentModels', role: 'model 키만 읽는다 (extractFrontmatter 경유)', exercised: false, reason: 'ci-extract 와 같은 파서를 거쳐 model 한 키만 본다. 목록 판정과 무관하다.' },
  { id: 'duplicate-keys-test', file: 'tests/ci/frontmatter-duplicate-keys.test.js', anchor: 'export function findDuplicateFrontmatterKeys', role: '테스트 로컬 정규식', exercised: false, reason: '실제 파일을 스스로 읽어 키 중복만 판정한다. 목록·주석은 보지 않는다.' },
  { id: 'empty-values-test', file: 'tests/ci/frontmatter-empty-values.test.js', anchor: 'export function findEmptyQuotedFrontmatterValues', role: '테스트 로컬 정규식', exercised: false, reason: '빈 따옴표 값만 판정한다. 목록·주석은 보지 않는다.' },
  { id: 'agent-name-refs-test', file: 'tests/firewall/agent-name-references.test.js', anchor: 'function frontmatter(text)', role: '테스트 로컬 정규식', exercised: false, reason: '위임 대상 이름만 판정한다. tools 목록 자체는 읽지 않는다.' },
];

/** 같은 목록을 읽는 복제본이 픽스처마다 내놓는 `tools` (undefined = 그 복제본은 리스트를 읽지 않는다). */
const FULL = ['Read', 'Grep', 'SendMessage', 'TaskUpdate'];
/** 주석 앞 항목만 — 호스트가 보게 되는 모양이자 skill-exporter 가 내놓는 모양. */
const HEAD = ['Read', 'Grep'];
/** 인라인 주석이 항목 이름에 남은 모양 — registry·skill-exporter 의 알려진 결함. */
const POLLUTED = ['Read', 'Grep', 'SendMessage   # DM', 'TaskUpdate'];

const VERDICTS = {
  clean: { 'firewall-lenient': FULL, 'runtime-registry': FULL, 'export-to-tool': FULL, 'skill-exporter': FULL, 'ci-extract': undefined },
  dash: { 'firewall-lenient': FULL, 'runtime-registry': FULL, 'export-to-tool': FULL, 'skill-exporter': HEAD, 'ci-extract': undefined },
  plain: { 'firewall-lenient': FULL, 'runtime-registry': FULL, 'export-to-tool': FULL, 'skill-exporter': HEAD, 'ci-extract': undefined },
  inline: { 'firewall-lenient': FULL, 'runtime-registry': POLLUTED, 'export-to-tool': FULL, 'skill-exporter': POLLUTED, 'ci-extract': undefined },
};

/** 엄격 오라클의 판정: 규칙 집합(정렬). 빈 배열 = 통과. */
const STRICT_RULES = {
  clean: [],
  dash: ['comment', 'dashes'],
  plain: ['comment'],
  inline: ['inline-comment'],
};

/** `CLAUDE_PLUGIN_ROOT` 를 바꿔 `fn` 을 실행하고 원복한다. 레지스트리 캐시도 앞뒤로 비운다. */
async function withPluginRoot(root, fn) {
  const saved = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_ROOT = root;
  _resetAgentCache();
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = saved;
    _resetAgentCache();
  }
}

/** 런타임 레지스트리가 이 텍스트에서 만든 엔트리 (가짜 플러그인 루트의 agents/demo.md). */
async function registryEntry(text) {
  const root = mkdtempSync(join(tmpRoot, 'registry-'));
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, 'agents', 'demo.md'), text, 'utf-8');
  return withPluginRoot(root, () => getAgent('demo'));
}

async function toolsByReplica(text) {
  const firewall = parseAgentTools(text);
  const registry = await registryEntry(text);
  return {
    'firewall-lenient': firewall.ok ? firewall.tools : `ERR: ${firewall.reason}`,
    'runtime-registry': registry?.tools,
    'export-to-tool': exportToToolParse(text).frontmatter.tools,
    'skill-exporter': skillExporterParse(text).frontmatter.tools,
    'ci-extract': extractFrontmatter(text).tools,
  };
}

/**
 * 호스트 모델 (가설): n=5 관측 — frontmatter 는 여는 `---` 다음에 오는 **첫 `---`**(줄 머리가
 * 아니어도, 주석 안이어도)에서 닫힌다. 그 안의 tools 블록은 YAML 대로 읽는다. 주석 처리 같은
 * 나머지 규칙은 관측하지 못했으므로 모델에 넣지 않는다.
 */
function hostVisibleTools(text) {
  const lf = text.replace(/\r\n/g, '\n');
  const afterOpen = lf.slice(lf.indexOf('\n') + 1);
  const end = afterOpen.indexOf('---');
  const lines = (end === -1 ? afterOpen : afterOpen.slice(0, end)).split('\n');
  const start = lines.findIndex((l) => /^tools:\s*$/.test(l));
  const tools = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const item = line.match(/^ {2}- (.*)$/);
    if (item) tools.push(item[1].replace(/\s+#.*$/, '').trim());
  }
  return tools;
}

describe('복제본 목록 — 실재하는 코드를 가리킨다', () => {
  it('목록이 10개 이상이고 id 가 겹치지 않는다', () => {
    expect(REPLICAS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(REPLICAS.map((r) => r.id)).size).toBe(REPLICAS.length);
  });

  it.each(REPLICAS)('$id: 파일과 앵커가 실재한다 ($file)', (replica) => {
    const text = readFileSync(join(PLUGIN_ROOT, replica.file), 'utf-8');
    expect(text, `${replica.file} 에서 앵커를 찾지 못했다 — 이름이 바뀌었으면 목록을 고쳐라`).toContain(replica.anchor);
  });

  it('실행하지 않는 복제본은 이유를 적었다', () => {
    for (const r of REPLICAS.filter((x) => x.exercised === false)) {
      expect(r.reason?.length ?? 0, `${r.id}: exercised:false 인데 이유가 없다`).toBeGreaterThan(15);
    }
  });

  it('판정 표에 오르는 복제본 id 는 fixture 로 표시된 항목과 같다 (strict-oracle 은 별도 표)', () => {
    const tabled = Object.keys(VERDICTS.clean).sort();
    const listed = REPLICAS.filter((r) => r.exercised === 'fixture' && r.id !== 'strict-oracle').map((r) => r.id).sort();
    expect(tabled).toEqual(listed);
  });
});

describe('같은 픽스처에 복제본이 내리는 판정 — 표로 고정', () => {
  it.each(Object.keys(FIXTURES))('픽스처 %s: tools 판정이 고정된 표와 같다', async (name) => {
    expect(await toolsByReplica(FIXTURES[name])).toEqual(VERDICTS[name]);
  });

  it.each(Object.keys(FIXTURES))('픽스처 %s: 엄격 오라클의 규칙 집합이 고정된 표와 같다', (name) => {
    const result = checkStrictAgentFrontmatter(FIXTURES[name]);
    const rules = [...new Set(result.violations.map((v) => v.rule))].sort();
    expect(rules).toEqual(STRICT_RULES[name]);
    expect(result.ok).toBe(STRICT_RULES[name].length === 0);
  });

  it('깨끗한 픽스처에서는 목록을 읽는 모든 복제본이 같은 tools 를 낸다', async () => {
    const verdict = await toolsByReplica(CLEAN_AGENT);
    for (const [id, tools] of Object.entries(verdict)) {
      if (tools !== undefined) expect(tools, id).toEqual(FULL);
    }
  });

  it('런타임 레지스트리는 주석 픽스처도 받아들인다 — D1: 확장 에이전트를 거부하지 않는다', async () => {
    for (const name of ['dash', 'plain', 'inline']) {
      const entry = await registryEntry(FIXTURES[name]);
      expect(entry, `${name}: 레지스트리가 엔트리를 만들지 못했다 — D1(런타임은 조이지 않는다) 위반`).not.toBeNull();
      expect(entry.name).toBe('demo');
    }
  });

  it('엄격 오라클은 호스트 모델이 관대 파서와 다르게 읽는 모든 픽스처를 RED 로 본다', () => {
    const divergent = Object.keys(FIXTURES).filter((name) => {
      const lenient = parseAgentTools(FIXTURES[name]);
      return JSON.stringify(hostVisibleTools(FIXTURES[name])) !== JSON.stringify(lenient.tools);
    });
    // 음성 대조: 이 집합이 비면 아래 단언은 공허하다. 대시 주석 픽스처는 반드시 들어 있어야 한다.
    expect(divergent).toContain('dash');
    expect(hostVisibleTools(DASH_COMMENT_AGENT)).toEqual(HEAD);
    expect(hostVisibleTools(CLEAN_AGENT)).toEqual(FULL);
    for (const name of divergent) {
      expect(checkStrictAgentFrontmatter(FIXTURES[name]).ok, `${name}: 호스트는 다르게 읽는데 오라클이 통과시켰다`).toBe(false);
    }
  });
});

describe('출하된 에이전트 — 실데이터에서 복제본이 수렴한다', () => {
  it('목록을 읽는 네 복제본이 에이전트 전부에서 같은 tools 를 낸다', async () => {
    const dir = join(PLUGIN_ROOT, 'agents');
    const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'INDEX.md' && f !== 'README.md').sort();
    const registry = await withPluginRoot(PLUGIN_ROOT, () => loadAgentRegistry());
    const disagreements = [];
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf-8');
      const firewall = parseAgentTools(text);
      const reference = JSON.stringify(firewall.tools);
      const readings = {
        'runtime-registry': registry.get(file.replace(/\.md$/, ''))?.tools,
        'export-to-tool': exportToToolParse(text).frontmatter.tools,
        'skill-exporter': skillExporterParse(text).frontmatter.tools,
      };
      expect(firewall.ok, `${file}: firewall 파서가 tools 를 읽지 못했다`).toBe(true);
      for (const [id, tools] of Object.entries(readings)) {
        if (JSON.stringify(tools) !== reference) disagreements.push(`${file}: ${id} = ${JSON.stringify(tools)}`);
      }
    }
    expect(disagreements, disagreements.join('\n')).toEqual([]);
    // 분모: 파일 수가 줄면 이 단언이 조용히 공허해진다.
    expect(files.length).toBeGreaterThan(20);
    expect(registry.size).toBe(files.length);
  });
});
