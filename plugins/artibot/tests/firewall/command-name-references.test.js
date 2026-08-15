/**
 * 검사 목적: 커맨드 문서가 **"다음에 이걸 실행하라"고 가리키는 슬래시 커맨드**가
 * 그 플러그인이 실제로 출하하는 커맨드인가.
 *
 * `agent-name-references.test.js` 의 자매 게이트다. 그쪽은 위임 대상 **에이전트**를
 * 보고, 이쪽은 후속 액션으로 지목하는 **커맨드**를 본다. 두 파일을 나눈 이유는
 * 참조 대상이 다르고, 무엇보다 **오탐 클래스가 완전히 다르기** 때문이다(아래).
 *
 * ── 실측 (수치는 커밋 의존이다 — 시점을 지우지 마라) ────────────────────────
 * **기준 커밋 `f74574b2`, 2026-08-15 20:4x 측정.** cowork 유령 커맨드 참조는
 * **18건 / 14종**이었고 세 부류로 갈렸다:
 *
 *   - **본체 개발자 커맨드 14건 / 10종** — `/improve`(3)·`/git`(3)·`/test`·
 *     `/task`·`/plan`·`/orchestrate`·`/implement`·`/checkpoint`·`/recap`·`/team`.
 *     전부 본체 artibot 78종에 실재하지만 cowork 사용자에게는 없다. 근거는
 *     cowork `README.md:76` — *"The full `artibot` plugin … depends on Node.js
 *     hooks and external scripts **not designed for the Cowork sandbox**"*.
 *     기술적 실행 불가 진술이라 "취향상 안 깐다"보다 강하다. 보조로 :14
 *     ("rather than developers using Claude Code")·:78("curated subset").
 *     ※ README 에 "대체(replace)"라는 단어는 **없다** — 그렇게 요약해 인용하지 마라.
 *   - **스킬인데 슬래시 표기 3건** — `/ab-testing`·`/competitive-intelligence`·
 *     `/swarm-intelligence` (셋 다 cowork 에 **스킬로는 실재**한다).
 *     본체 `commands/social.md` 에도 같은 것이 2건 있었다 — 같은 파일이 두
 *     플러그인에 같은 결함으로 복제돼 있었다.
 *   - **본체 라우터 규약 잔재 1건** — `commands/playbook.md` 제목이 `# /sc playbook`.
 *
 * **오탐으로 제외한 것 11종**도 함께 남긴다(다음 사람이 다시 세지 않도록):
 * `/insights`(외부 귀속 서술 — "Inspired by Claude Code's /insights") ·
 * `/plugin`(빌트인) · `/imagine`(Midjourney) · `/skill`·`/voice-reference`(산문) ·
 * URL 경로 6종(`/api`·`/docs`·`/about`·`/webhooks`·`/playbooks`·`/runbooks`).
 *
 * ── 왜 `commands/` 만 스캔하는가 (이 게이트의 핵심 설계) ────────────────────
 * 슬래시 커맨드와 **URL 경로**는 표기가 같다. 리포 전역을 스캔하면 오탐이
 * 진짜 결함을 압도한다 — 실측된 오탐: `/api/auth/token`(음성 정의 예시),
 * `/webhooks/campaign-update`(루틴 설정), `/playbooks/...`·`/docs/...`·
 * `/runbooks/...`(장문 샘플의 내부 링크), `/about` 페이지(llms.txt 템플릿),
 * `/imagine`(Midjourney 명령어). 이것들은 전부 `skills/` 안의 **콘텐츠**다.
 *
 * "다음에 이 커맨드를 실행하라"는 **라우팅 지시**는 `commands/` 안에 산다.
 * 그래서 분모를 거기로 좁혔다. 좁힌 사실 자체를 아래 한계에 명시한다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ──────────────────
 *
 *  1. **`commands/` 밖은 보지 않는다.** `skills/`·`agents/`·`README.md` 에 있는
 *     유령 커맨드 참조는 잡히지 않는다. URL 경로 오탐을 피하려 의도적으로 좁힌
 *     결과이고, 놓침의 비용(문서가 낡음)이 오탐의 비용(게이트가 늘 RED 라 무시됨)
 *     보다 싸다고 판단했다.
 *  2. **실행하지 않는다.** 파일이 있다는 것만 본다. 그 커맨드가 실제로 로드되는지,
 *     없는 커맨드를 입력하면 하네스가 무엇을 하는지는 **미확인**이다.
 *  3. **빌트인 목록은 수동 사본이다.** `BUILTIN_SLASH` 는 하네스/Claude Code 가
 *     제공해 어느 플러그인도 `.md` 로 출하하지 않는 이름이다. 하네스가 개명하거나
 *     추가하면 같이 낡는다. **관측된 것만 넣었고 추측으로 채우지 않았다** —
 *     재확인 방법은 그 상수 주석에 있다.
 *  4. **의미 적절성은 못 본다.** 실재하는 커맨드를 가리키기만 하면 통과한다.
 *     마케팅 커맨드가 엉뚱한 마케팅 커맨드를 후속으로 제안해도 green 이다.
 *  5. **스킬을 커맨드 표기로 쓴 것은 "스킬이 실재하면" 잡지 못한다.** 이 게이트는
 *     커맨드 목록만 대조하므로 `/ab-testing` 은 RED 가 되지만, 그 원인이
 *     "스킬인데 표기가 틀렸다"인지 "정말 없는 커맨드"인지는 사람이 봐야 한다.
 *
 * @module tests/firewall/command-name-references
 */

import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach, beforeEach, describe, expect, it,
} from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = join(__dirname, '..', '..', '..');

const PLUGINS = [
  { id: 'artibot', dir: join(PLUGINS_DIR, 'artibot') },
  { id: 'artibot-cowork', dir: join(PLUGINS_DIR, 'artibot-cowork') },
];

/**
 * 하네스/Claude Code 가 제공하는 빌트인 슬래시 커맨드. 플러그인이 `.md` 로
 * 출하하지 않으므로 출하 목록 대조만으로는 유령으로 오인된다.
 *
 * **관측된 것만 넣었다.** 짐작으로 목록을 부풀리면 진짜 유령을 통과시킨다.
 * 각 항목은 리포 안에 "빌트인"임을 밝히는 문장이 실재하는 것들이다:
 *   - `insights`      — `commands/daily.md`: "Inspired by Claude Code's `/insights`"
 *   - `workflows`     — `commands/dynamic.md`: "native **`/workflows` monitor**"
 *   - `clear`         — `commands/theme.md`: "적용: `/clear` 또는 새 세션"
 *   - `output-style`  — `commands/theme.md`: 테마 output-style 활성화
 *   - `plugin`        — **예외: 선제적 항목이지 관측 기반이 아니다.**
 *       스캔 범위(`commands/`) 안의 발화가 **0회**이고, 근거 문장은 범위 밖인
 *       `artibot/README.md:126` / `artibot-cowork/README.md:66`
 *       (`/plugin marketplace add …`)에 있다. 즉 지금은 **사문(死文)** 이다.
 *       그래도 남긴다 — 지우면 `commands/` 에 `/plugin` 이 등장하는 순간
 *       오탐이 나고 같은 조사를 다시 해야 한다. "관측된 것만 넣는다"는 위
 *       원칙의 **명시된 예외**이며, 다른 항목을 이 선례로 정당화하지 마라.
 *
 * 재확인 방법: Claude Code 세션에서 `/help` 로 빌트인 목록을 띄워 대조한다.
 * 여기에 이름을 추가할 때는 **그 근거 문장도 함께** 적어라.
 */
const BUILTIN_SLASH = new Set([
  'insights',
  'workflows',
  'clear',
  'output-style',
  'plugin',
]);

/** `commands/*.md` 파일명이 곧 커맨드 이름이다. */
export function shippedCommands(pluginDir) {
  try {
    return new Set(
      readdirSync(join(pluginDir, 'commands'))
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3)),
    );
  } catch {
    return new Set();
  }
}

/**
 * 한 문서에서 슬래시 커맨드 참조를 뽑는다.
 *
 * 백틱 코드스팬 안의 `/name` 과, 토큰 경계에 선 맨 `/name` 둘 다 본다. 뒤에
 * `/` 가 더 오는 형태(`/api/auth`)는 **URL 경로**이므로 제외한다 — 이 한 줄이
 * `commands/` 밖까지 스캔할 때 오탐의 대부분을 만들던 형태다.
 *
 * @param {string} text
 * @returns {{name: string, line: number}[]}
 */
export function extractCommandRefs(text) {
  const refs = [];
  text.split(/\r?\n/).forEach((l, i) => {
    // 조건 1 — 바로 앞 문자가 줄머리/공백/백틱/파이프/괄호. 이게 `https://github.com`
    // 의 `/github`(앞이 `/`)과 정규식 리터럴 `/[a-z]+/g` 의 `/g`(앞이 `+`)를 막는다.
    for (const m of l.matchAll(/(?:^|[\s`|(])\/([a-z][a-z0-9-]*(?::[a-z0-9-]+)?)(?![\w/-])/g)) {
      // 조건 2 — 공백을 걷어낸 앞 토큰이 낱말로 끝나면 커맨드가 아니라 **인자**다.
      // `powercfg /requests`(윈도우 CLI 플래그)가 실측된 형태다. 조건 1만으로는
      // 공백이 앞에 있어 통과해버린다.
      // m.index 는 **구분자 문자**를 가리킨다(정규식이 함께 소비한다). `/` 위치로
      // 다시 잡지 않으면 백틱이 잘려나가 `` Claude Code's `/insights` `` 가
      // "Code's" 로 판정돼 엉뚱하게 걸러진다.
      const slashAt = m.index + m[0].indexOf('/');
      const before = l.slice(0, slashAt).replace(/\s+$/, '');
      if (/[A-Za-z0-9]$/.test(before)) continue;
      refs.push({ name: m[1], line: i + 1 });
    }
  });
  return refs;
}

/** 플러그인 네임스페이스 접두사. `/artibot:assemble` = `/assemble` 의 정규화 형태. */
const PLUGIN_NAMESPACES = new Set(['artibot', 'artibot-cowork']);

/**
 * 콜론 표기를 검사 대상 커맨드명으로 정규화한다.
 *
 * 콜론은 두 가지로 쓰인다:
 *   - **네임스페이스** `/artibot:assemble` → 뒤가 커맨드다
 *   - **서브커맨드**   `/autopilot:tail`   → 앞이 커맨드다
 *
 * @param {string} name
 * @returns {string}
 */
export function baseCommand(name) {
  const [head, tail] = name.split(':');
  if (tail && PLUGIN_NAMESPACES.has(head)) return tail;
  return head;
}

/**
 * @param {{id: string, dir: string}} plugin
 * @param {Set<string>} [allowlist] 뮤테이션 테스트가 주입할 수 있게 인자로 받는다.
 */
export function scanPlugin(plugin, allowlist) {
  const shipped = allowlist ?? shippedCommands(plugin.dir);
  const dir = join(plugin.dir, 'commands');
  const violations = [];
  let scanned = 0;
  let refCount = 0;

  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { files = []; }

  for (const f of files) {
    scanned += 1;
    for (const ref of extractCommandRefs(readFileSync(join(dir, f), 'utf-8'))) {
      refCount += 1;
      const base = baseCommand(ref.name);
      if (BUILTIN_SLASH.has(base)) continue;
      if (shipped.has(base)) continue;
      violations.push({ file: `${plugin.id}/commands/${f}`, line: ref.line, name: `/${ref.name}` });
    }
  }
  return { violations, scanned, refCount, shipped };
}

const format = (vs) => vs.map((v) => `  ${v.name}  ${v.file}:${v.line}`).join('\n');

describe('커맨드 이름 참조 — 실재 검증', () => {
  for (const plugin of PLUGINS) {
    it(`${plugin.id}: commands/ 가 가리키는 슬래시 커맨드가 전부 출하 목록에 있다`, () => {
      const { violations, shipped } = scanPlugin(plugin);
      expect(
        violations,
        `${plugin.id} 이 출하하지 않는 커맨드를 가리킨다 (출하 ${shipped.size}종):\n${format(violations)}`,
      ).toEqual([]);
    });
  }
});

describe('스코프 — 게이트가 실제로 무언가를 보고 있다', () => {
  for (const plugin of PLUGINS) {
    it(`${plugin.id}: 파일과 참조를 실제로 읽는다`, () => {
      const { scanned, refCount, shipped } = scanPlugin(plugin);
      expect(shipped.size).toBeGreaterThan(10);
      expect(scanned).toBeGreaterThan(10);
      expect(refCount).toBeGreaterThan(20);
    });
  }

  it('두 플러그인의 커맨드 목록이 다르다 (cowork 는 미러가 아니다)', () => {
    const [main, cowork] = PLUGINS.map((p) => shippedCommands(p.dir));
    expect(main.size).toBeGreaterThan(cowork.size);
  });
});

describe('스캐너 자기검증 — 파서', () => {
  it('백틱형과 맨 표기를 모두 읽는다', () => {
    expect(extractCommandRefs('| 1 | x | `/content` | y |').map((r) => r.name)).toEqual(['content']);
    expect(extractCommandRefs('/ultraplan deep [topic]').map((r) => r.name)).toEqual(['ultraplan']);
  });

  it('URL 경로는 커맨드로 읽지 않는다', () => {
    // 이 한 줄이 없으면 `skills/` 샘플의 내부 링크가 전부 유령으로 잡힌다.
    expect(extractCommandRefs('POST /api/auth/token')).toEqual([]);
    expect(extractCommandRefs('[playbook](/playbooks/service-ownership)')).toEqual([]);
    expect(extractCommandRefs('endpoint: /webhooks/campaign-update')).toEqual([]);
  });

  it('앞 토큰이 낱말이면 인자·플래그로 보고 읽지 않는다', () => {
    // `powercfg /requests` 는 윈도우 CLI 플래그다 (commands/autopilot.md 에 실재).
    expect(extractCommandRefs('- Windows: `powercfg /requests` 출력에서')).toEqual([]);
    expect(extractCommandRefs('systemd-inhibit --list')).toEqual([]);
  });

  it('제목·표셀·백틱 스팬 첫 토큰은 읽는다 (위 규칙이 과하게 자르지 않는다)', () => {
    expect(extractCommandRefs('# /sc playbook').map((r) => r.name)).toEqual(['sc']);
    expect(extractCommandRefs('| 1 | 회고 | `/daily` | x |').map((r) => r.name)).toEqual(['daily']);
    expect(extractCommandRefs("Claude Code's `/insights` 참고").map((r) => r.name)).toEqual(['insights']);
  });

  it('서브커맨드는 베이스로 정규화한다', () => {
    expect(extractCommandRefs('`/autopilot:tail`').map((r) => r.name)).toEqual(['autopilot:tail']);
    expect(baseCommand('autopilot:tail')).toBe('autopilot');
    expect(baseCommand('daily')).toBe('daily');
  });

  it('경로 중간의 슬래시 토큰은 잡지 않는다', () => {
    expect(extractCommandRefs('~/.claude/agents/')).toEqual([]);
  });
});

describe('스캐너 자기검증 — 게이트가 헛돌지 않는다', () => {
  it('출하 목록을 축소하면 그 이름이 위반으로 잡힌다', () => {
    const cowork = PLUGINS.find((p) => p.id === 'artibot-cowork');
    const full = shippedCommands(cowork.dir);
    expect(full.has('content')).toBe(true);

    const shrunk = new Set(full);
    shrunk.delete('content');
    const { violations } = scanPlugin(cowork, shrunk);

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.name.startsWith('/content'))).toBe(true);
  });

  it('빈 출하 목록이면 거의 모든 참조가 위반이다', () => {
    const cowork = PLUGINS.find((p) => p.id === 'artibot-cowork');
    const { violations } = scanPlugin(cowork, new Set());
    expect(violations.length).toBeGreaterThan(20);
  });

  it('빌트인 제외가 실효한다 (조용히 비면 알 수 있게)', () => {
    expect(BUILTIN_SLASH.has('insights')).toBe(true);
    expect(extractCommandRefs("Claude Code's `/insights`").map((r) => r.name)).toEqual(['insights']);
  });
});

describe('음성 대조 — 없는 커맨드를 심으면 RED 가 된다', () => {
  // 공유 워킹트리를 변조하지 않는다. 임시 디렉터리에 가짜 플러그인을 만들어
  // 스캐너를 그쪽으로 겨눈다 — 다른 팀원의 스위트에 영향을 주지 않으면서
  // "이 게이트가 실제로 유령을 잡는가"를 매 실행마다 증명한다.
  //
  // (2026-08-15 교훈: 공유 트리에서 뮤테이션을 돌려 관측자 3명이 20건 실패를
  //  "플레이크"로 오판한 사건이 있었다. 그래서 음성 대조를 상설 픽스처로 둔다.)
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'artibot-cmdref-'));
    mkdirSync(join(tmp, 'commands'), { recursive: true });
    // 출하 커맨드 2종
    writeFileSync(join(tmp, 'commands', 'alpha.md'), '# /alpha\n');
    writeFileSync(join(tmp, 'commands', 'beta.md'), '# /beta\n');
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const scan = () => scanPlugin({ id: 'fixture', dir: tmp });

  it('실재하는 커맨드만 가리키면 통과한다 (양성 대조)', () => {
    writeFileSync(join(tmp, 'commands', 'alpha.md'), '# /alpha\n\n| 1 | x | `/beta` | y |\n');
    expect(scan().violations).toEqual([]);
  });

  it('없는 커맨드를 가리키면 잡는다', () => {
    writeFileSync(join(tmp, 'commands', 'alpha.md'), '# /alpha\n\n| 1 | x | `/ghost-command` | y |\n');
    const { violations } = scan();
    expect(violations).toHaveLength(1);
    expect(violations[0].name).toBe('/ghost-command');
    expect(violations[0].line).toBe(3);
  });

  it('URL 경로를 심어도 오탐하지 않는다 (음성 대조의 반대편)', () => {
    writeFileSync(join(tmp, 'commands', 'alpha.md'), '# /alpha\n\nPOST /api/v1/tokens 로 호출\n');
    expect(scan().violations).toEqual([]);
  });

  it('출하 목록이 비어 있으면 실재 참조도 위반이 된다 (분모 확인)', () => {
    writeFileSync(join(tmp, 'commands', 'alpha.md'), '# /alpha\n\n`/beta` 참고\n');
    rmSync(join(tmp, 'commands', 'beta.md'));
    expect(scan().violations.map((v) => v.name)).toContain('/beta');
  });
});
