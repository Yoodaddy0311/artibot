/**
 * 검사 목적: `commands/*.md` 의 **본문이 호출하라고 지시하는 도구**가 그 커맨드의
 * `allowed-tools` 에 **선언돼 있는가**.
 *
 * ── 왜 필요했나 (2026-08-16 실측) ────────────────────────────────────────────
 * 이 계열 결함이 3건 나왔는데 **기존 게이트가 전부 초록이었다.**
 *
 *   commands/sc.md#보고-계약        본문이 `SendMessage(to=…)` 로 보고하라고
 *                                   지시하는데 `allowed-tools` 에 SendMessage 없음
 *   commands/ultraplan.md           같은 결함 (다른 담당자가 같은 세션에 수정)
 *   commands/team.md#Phase-5.5      본문이 `AskUserQuestion(...)` 를 호출하라고
 *                                   지시하는데 선언 없음 ← **이 게이트가 처음 찾음**
 *
 * 왜 안 잡혔는가는 두 게이트의 스코프를 보면 명확하다:
 *  - `frontmatter-tool-names.test.js` 는 **프론트매터만** 본다. 선언된 이름이
 *    실재하는지는 보지만, 본문이 요구하는 도구가 선언됐는지는 안 본다
 *    (그 파일의 "못 보는 것" #2 가 이 구멍을 자기 입으로 적어 두었다).
 *  - `tests/commands/report-contract-parity.test.js` 는 `[보고 계약]` 블록의
 *    **문자열 동일성**만 본다. 4캐리어 전부 SHA256 바이트 동일이라 40/40 통과인데,
 *    그중 2개는 자기가 나눠주는 계약 1조를 **이행할 도구가 없었다**.
 *
 * 즉 "선언은 실재한다" + "계약문은 동일하다" 가 둘 다 참인데 **커맨드는 동작하지
 * 않는다**. 이 파일이 그 사이의 구멍을 닫는다.
 *
 * ── 형태 (rules §10) ────────────────────────────────────────────────────────
 * 스크립트형이 아니라 `tests/firewall/` vitest 다. `check-unused-ratchet` 이
 * `node_modules` 부재 시 `Baseline tightened 59 → 0. PASS.` 로 **자기 기준선을
 * 파괴하며 통과**한 선례가 있다. 파일이 없으면 red = fail-closed 인 형태만 쓴다.
 *
 * ── 위임 예외를 어떻게 다루는가 (이 게이트의 핵심 설계 판단) ────────────────
 * 본문이 `Agent(...)` 로 위임하면서 언급한 도구는 커맨드 자신에게 필요 없을 수
 * 있다. 그래서 "위임 문맥이면 자동 면제" 라는 **구조적 예외**를 넣고 싶어진다.
 * **넣지 않았다.** 세 가지 이유가 있고, 셋째가 결정적이다:
 *
 *  1. **`allowed-tools` 가 스폰된 서브에이전트에게 상속되는지 미확인이다.**
 *     구조적 면제는 "상속된다"를 가정해야 성립하는데, 그 가정을 확인하지 못했다.
 *     미확인을 게이트에 하드코딩하면 게이트가 다음 착시의 근거가 된다.
 *  2. 위임 문맥의 경계가 기계적으로 불안정하다. `[보고 계약]` 은 펜스 코드블록
 *     안에 있지만, 같은 펜스 안에 리더가 **직접** 호출할 것도 들어 있다.
 *  3. **가장 중요 — 구조적 면제를 넣었다면 `sc.md` 가 green 으로 남는다.**
 *     sc.md 의 `SendMessage` 는 계약 블록 안에 있어 "위임"으로 분류되지만,
 *     sc.md 의 캐리어는 그 계약을 받은 팀원의 **리더**다. 리더는 중간 지시와
 *     회수 프로토콜(rules §10.5(d) 3지선다)을 보내야 하므로 SendMessage 가
 *     **자기에게** 필요하다. 실제로 나머지 두 캐리어(`team.md`·`autopilot.md`)는
 *     둘 다 SendMessage 를 선언하고 있다. 즉 구조적 면제는 이 게이트가 잡아야 할
 *     바로 그 결함을 면제했을 것이다.
 *
 * 대신 **명시 등록 + 근거 강제**를 쓴다(`DOCUMENTED_UNDECLARED_REFERENCES`).
 * 등록되지 않은 참조는 전부 실패한다(= allowlist, 부정 목록 아님 — 새 커맨드·새
 * 참조는 자동 통과가 아니라 자동 RED 다). 등록에는 사람이 읽을 근거가 **강제**되고,
 * 개수가 **정확히** 일치해야 하며(`!==`, `>` 아님), 참조가 사라지면 stale 로 RED 다.
 * 즉 이 표는 "고치면 조용해지는 baseline" 이 아니라 **고치면 시끄러워지는 기록**이다.
 *
 * ── 이 게이트가 못 보는 것 (rules §9 — 게이트 옆에 적어라) ──────────────────
 *
 *  1. **`Name(` 형태만 본다.** 괄호 없는 산문 언급은 못 잡는다. 실측 예:
 *     `commands/repo.md#Forbidden-shortcuts` 는 `WebFetch`/`WebSearch` 를
 *     "클론 후 보조용으로" 쓰라고 하면서 둘 다 선언하지 않는데, 백틱 산문이라
 *     이 게이트에 **걸리지 않는다**. 넓히면 오탐이 폭발한다 —
 *     `commands/export.md` 처럼 도구명을 **데이터로** 다루는 문서가 실재하고,
 *     `agents/*.md` 를 설명하는 산문 전체가 걸린다. 이 경계는 의도적이며,
 *     **산문 언급의 정합은 여전히 사람이 봐야 한다.**
 *  2. **반대 방향(미사용 선언)은 안 본다.** `allowed-tools` 에 있는데 본문이 한
 *     번도 안 쓰는 도구는 통과한다. 과잉 권한은 이 게이트의 대상이 아니다 —
 *     커맨드는 본문에 안 적힌 도구도 정당하게 쓸 수 있기 때문이다(Read/Bash 등).
 *  3. **`agents/*.md` 본문은 통째로 스코프 밖이다.** 같은 결함이 에이전트
 *     정의에도 있을 수 있다. 여기 green 을 "리포 전체 본문이 정합"의 근거로 쓰지
 *     마라.
 *  4. **`artibot-cowork` 는 스코프 밖이다.** `SCANNED_ROOTS` 주석에 이유가 있다.
 *     `frontmatter-tool-names.test.js` 는 cowork 를 덮으므로 **선언 실재성은**
 *     양쪽 다 검사되지만, **본문 정합은 artibot 만** 검사된다.
 *  5. **도구가 실제로 호출 가능한지는 못 본다.** `allowed-tools` 에 이름이 있다는
 *     것과 런타임이 그 도구를 제공한다는 것은 다른 진술이다(rules §2).
 *  6. **`allowed-tools` 상속 여부 미확인.** 캐리어가 선언하지 않아도 서브에이전트
 *     쪽 `tools:` 로 실동작이 성립할 가능성을 배제하지 못했다. 그래서 이 게이트는
 *     "위반"이 아니라 "**등록되지 않은 참조**"를 실패로 삼는다 — 판단은 등록
 *     시점에 사람이 근거와 함께 내린다.
 *
 * @module tests/firewall/command-body-tool-parity
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KNOWN_TOOL_NAMES, normalizeToolName, parseCommandTools, splitFrontmatter } from './frontmatter-tools.js';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = join(__dirname, '..', '..', '..');

/**
 * 본문 정합을 검사하는 루트.
 *
 * **cowork 를 넣지 않은 이유**(rules §9 — 안 한 것은 안 했다고 적는다): 이 게이트는
 * 정확 개수 등록표를 쓰는데, cowork 커맨드 문서는 측정 시각 기준 다른 담당자가
 * 동시 편집 중이라 개수가 계속 움직인다. 동시 편집 트리에서 정확 개수를 고정하면
 * 그 수치는 상태가 아니라 스냅샷이다(rules §10.5(a)). 확장은 **한 줄 추가**로
 * 되지만, 그때 등록표를 cowork 기준으로 다시 채워야 한다.
 *
 * 새 루트를 추가하면 `MIN_COMMAND_FILES` 에도 항목을 넣어야 한다 — 넣지 않으면
 * 분모 단언이 그 루트를 **모른 채 0으로 통과**시키므로 아래에서 RED 로 만든다.
 */
const SCANNED_ROOTS = [{ id: 'artibot', dir: join(PLUGINS_DIR, 'artibot') }];

/**
 * 루트별 커맨드 파일 수 하한. **"0 위반"과 "0개 검사"를 구분하기 위한 분모다.**
 * `scripts/ci/ci-utils.js#MIN_DOC_FILES` 와 같은 규약 — 알 수 없는 루트는 건너뛰지
 * 않고 실패시킨다.
 */
const MIN_COMMAND_FILES = { artibot: 70 };

/**
 * 본문이 호출하지만 `allowed-tools` 에 없어도 되는, **근거가 붙은** 참조.
 *
 * 형식: 파일 상대경로 → { 도구명: { count, why } }
 *
 * 규약 (이 넷을 아래 테스트가 전부 강제한다):
 *  - `count` 는 **정확한 개수**다. 늘어도 줄어도 RED (`!==`). 총량 baseline 이
 *    아니므로 "고치면 조용해지는" 자동 완화 경로가 없다 — 고치면 stale 로 RED 가
 *    나고 사람이 항목을 지워야 한다.
 *  - `why` 는 근거 산문이다. 길이 하한을 강제한다(빈 문자열·"ok" 같은 통과용
 *    토큰 차단).
 *  - 등록된 도구가 **선언돼 있으면** 그 항목은 무의미하므로 RED (죽은 예외 차단).
 *  - 등록된 파일이 사라지거나 참조가 0건이 되면 RED.
 *
 * **여기에 항목을 추가해 게이트를 통과시키기 전에**: 그 커맨드의 캐리어가 그
 * 도구를 정말 안 쓰는지 확인하라. 캐리어가 리더로서 팀원에게 지시·회수해야 한다면
 * `SendMessage` 는 **캐리어에게 필요하다** (sc.md 가 정확히 그 사례였다).
 */
const DOCUMENTED_UNDECLARED_REFERENCES = new Map([
  [
    'commands/export.md',
    {
      Agent: {
        count: 2,
        why:
          'export 는 **다른 파일의 본문을 변환하는** 커맨드다. 여기 나오는 `Agent(...)` 는 ' +
          'export 가 호출할 도구가 아니라 **변환 대상 문자열**이다 — "Antigravity 변환기가 ' +
          'agents/*.md 본문의 Claude Teams API 호출을 Agent Manager 등가물로 다시 쓴다"는 ' +
          '설명과, 그 한계에 대한 정직성 노트(`Agent(architect)` 가 그대로 남는다)에서만 ' +
          '나온다. export.md 의 allowed-tools 는 [Read, Write, Bash, Glob, Grep] 이며 ' +
          'export 는 팀원을 스폰하지 않는다. 선언을 늘리는 것은 과잉 권한이다.',
      },
      SendMessage: {
        count: 1,
        why:
          'Agent 와 같은 문장에 나오는 **변환 대상 목록**의 일부다 ' +
          '("`Agent(...)`, `SendMessage(...)`, `TaskCreate(...)`, … 를 다시 쓴다"). ' +
          'export 는 팀원에게 보고하지 않는다 — 파일을 변환해 디스크에 쓸 뿐이다.',
      },
      TaskCreate: {
        count: 1,
        why:
          '위 두 항목과 같은 열거의 세 번째 원소다. export 는 태스크를 만들지 않는다. ' +
          '이 세 항목이 한 문장에서 나오므로 셋 중 하나만 지우는 편집은 count 불일치로 RED 가 된다.',
      },
    },
  ],
]);

/** `why` 최소 길이. 통과용 토큰("n/a", "ok", "위임")을 막는다. */
const MIN_RATIONALE_CHARS = 40;

/**
 * 본문에서 도구 호출 표기 `Name(` 의 **파일 기준** 줄번호를 모은다.
 *
 * 앞뒤 경계 조건:
 *  - 앞: `[A-Za-z0-9_$.]` 가 오면 매치하지 않는다. `MyAgent(` · `subAgent(` 같은
 *    다른 식별자와, `obj.Read(` 같은 메서드 호출을 배제하기 위함이다.
 *  - 뒤: `\s*\(` — `Agent (`, `Agent(` 둘 다 호출로 본다.
 *
 * @param {string} body
 * @param {string} tool
 * @param {number} bodyOffset 본문 첫 줄의 파일 기준 줄번호
 * @returns {number[]} 파일 기준 줄번호 (같은 줄에 2회 나와도 1건으로 세지 않고 회수만큼 센다)
 */
export function findToolCallSites(body, tool, bodyOffset = 1) {
  const re = new RegExp(`(?<![A-Za-z0-9_$.])${tool}\\s*\\(`, 'g');
  const sites = [];
  body.split(/\r?\n/).forEach((line, i) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      sites.push(bodyOffset + i);
      if (m.index === re.lastIndex) re.lastIndex += 1; // zero-width 방어
    }
  });
  return sites;
}

function commandFiles(root) {
  return readdirSync(join(root.dir, 'commands'))
    .filter((f) => f.endsWith('.md'))
    .sort();
}

/**
 * 전 루트의 커맨드를 훑어 **선언되지 않은 본문 호출**을 모은다.
 *
 * @param {object} [opts]
 * @param {Set<string>} [opts.tools] 검사할 도구 이름 집합 (뮤테이션 테스트가 주입).
 * @param {(rel: string, declared: Set<string>) => Set<string>} [opts.mutateDeclared]
 *        선언 집합을 가로채는 훅. 3단 음성 대조에서 "도구를 일시 제거"를
 *        **워킹트리를 건드리지 않고** 재현하기 위한 주입점이다.
 * @returns {{ refs: Array<{file: string, tool: string, lines: number[]}>, unparsed: Array<{file: string, reason: string}>, counts: Record<string, number>, scanned: number }}
 */
export function scanBodyToolReferences(opts = {}) {
  const tools = opts.tools ?? KNOWN_TOOL_NAMES;
  const mutateDeclared = opts.mutateDeclared ?? ((_rel, d) => d);

  const refs = [];
  const unparsed = [];
  const counts = {};
  let scanned = 0;

  for (const root of SCANNED_ROOTS) {
    counts[root.id] = 0;
    for (const file of commandFiles(root)) {
      const rel = `commands/${file}`;
      const abs = join(root.dir, 'commands', file);
      const text = readFileSync(abs, 'utf-8');

      const split = splitFrontmatter(text);
      const parsed = parseCommandTools(text);
      // 파싱 실패는 "위반 0" 이 아니라 RED 다. 못 읽은 파일을 조용히 건너뛰면
      // 프론트매터 표기를 바꾸는 것만으로 게이트를 무력화할 수 있다.
      if (split === null || !parsed.ok) {
        unparsed.push({ file: rel, reason: split === null ? '프론트매터 블록이 없다' : parsed.reason });
        counts[root.id] += 1;
        scanned += 1;
        continue;
      }

      const declaredRaw = new Set();
      for (const d of parsed.tools) {
        const n = normalizeToolName(d);
        if (!n.skip) declaredRaw.add(n.base);
      }
      const declared = mutateDeclared(rel, declaredRaw);

      for (const tool of tools) {
        if (declared.has(tool)) continue;
        const lines = findToolCallSites(split.body, tool, split.bodyOffset);
        if (lines.length > 0) refs.push({ file: rel, tool, lines });
      }

      counts[root.id] += 1;
      scanned += 1;
    }
  }

  return { refs, unparsed, counts, scanned };
}

/** 등록표에서 (파일, 도구) 항목을 꺼낸다. */
function registered(file, tool) {
  return DOCUMENTED_UNDECLARED_REFERENCES.get(file)?.[tool];
}

function describeRef(r) {
  return `${r.file}:${r.lines.join(',')}  ${r.tool}(`;
}

describe('커맨드 본문 ↔ allowed-tools 정합 — 분모', () => {
  it('스캔한 커맨드 수가 루트별 하한을 넘는다 ("0 위반" ≠ "0개 검사")', () => {
    const { counts } = scanBodyToolReferences();
    const failures = [];
    for (const [id, floor] of Object.entries(MIN_COMMAND_FILES)) {
      if (!(id in counts)) failures.push(`루트 '${id}' 를 아예 스캔하지 않았다`);
      else if (counts[id] < floor) failures.push(`'${id}' 는 ${counts[id]}개 — 하한 ${floor} 미달`);
    }
    // 반대 방향: 하한이 없는 루트가 생기면 그 루트는 검사되지 않은 0으로 무임승차한다.
    for (const id of Object.keys(counts)) {
      if (!(id in MIN_COMMAND_FILES)) {
        failures.push(`루트 '${id}' 에 MIN_COMMAND_FILES 항목이 없다 — 분모를 단언하라`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('스캔 분모가 실제 파일 수와 정확히 같다', () => {
    const { scanned } = scanBodyToolReferences();
    const expected = SCANNED_ROOTS.reduce((sum, r) => sum + commandFiles(r).length, 0);
    expect(scanned).toBe(expected);
  });

  it('모든 커맨드의 allowed-tools 가 파싱된다 (파싱 실패 = RED, 조용한 스킵 아님)', () => {
    const { unparsed } = scanBodyToolReferences();
    const detail = unparsed.map((u) => `${u.file}: ${u.reason}`).join('\n');
    expect(detail).toBe('');
  });
});

describe('커맨드 본문 ↔ allowed-tools 정합 — 본 검사', () => {
  it('본문이 호출하는 도구는 모두 선언돼 있거나 근거와 함께 등록돼 있다', () => {
    const { refs } = scanBodyToolReferences();
    const unregistered = refs.filter((r) => registered(r.file, r.tool) === undefined);
    const detail = unregistered
      .map(
        (r) =>
          `  ${describeRef(r)}\n` +
          `      → ${r.file} 의 allowed-tools 에 ${r.tool} 을 추가하거나,\n` +
          '        DOCUMENTED_UNDECLARED_REFERENCES 에 근거(why)와 함께 등록하라.',
      )
      .join('\n');
    expect(unregistered.map(describeRef), `선언되지 않은 본문 호출:\n${detail}`).toEqual([]);
  });

  it('등록된 참조의 개수가 정확히 일치한다 (늘어도 줄어도 RED)', () => {
    const { refs } = scanBodyToolReferences();
    const mismatches = [];
    for (const r of refs) {
      const entry = registered(r.file, r.tool);
      if (entry === undefined) continue; // 위 테스트가 담당
      if (entry.count !== r.lines.length) {
        mismatches.push(
          `${r.file} ${r.tool}: 등록 ${entry.count} ≠ 실제 ${r.lines.length} (L${r.lines.join(',')})`,
        );
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
  });

  it('등록표에 stale 항목이 없다 (고치면 조용해지지 않고 시끄러워진다)', () => {
    const { refs } = scanBodyToolReferences();
    const live = new Set(refs.map((r) => `${r.file} ${r.tool}`));
    const stale = [];
    for (const [file, entries] of DOCUMENTED_UNDECLARED_REFERENCES) {
      for (const tool of Object.keys(entries)) {
        if (!live.has(`${file} ${tool}`)) {
          stale.push(`${file} ${tool}: 등록돼 있으나 본문에 그런 참조가 없다 — 항목을 지워라`);
        }
      }
    }
    expect(stale, stale.join('\n')).toEqual([]);
  });
});

describe('등록표 자체의 규약', () => {
  it('모든 항목에 최소 길이 이상의 근거(why)가 있다', () => {
    const bad = [];
    for (const [file, entries] of DOCUMENTED_UNDECLARED_REFERENCES) {
      for (const [tool, e] of Object.entries(entries)) {
        if (typeof e.why !== 'string' || e.why.trim().length < MIN_RATIONALE_CHARS) {
          bad.push(`${file} ${tool}: why 가 ${MIN_RATIONALE_CHARS}자 미만 — 근거를 적어라`);
        }
        if (!Number.isInteger(e.count) || e.count < 1) {
          bad.push(`${file} ${tool}: count 는 1 이상의 정수여야 한다`);
        }
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('등록된 도구가 실제로 미선언 상태다 (죽은 예외 차단)', () => {
    // 나중에 allowed-tools 에 추가해 놓고 등록표를 안 지우면, 그 항목은 아무것도
    // 면제하지 않으면서 "예외가 있다"는 인상만 남긴다. stale 테스트가 대부분
    // 잡지만, 이건 의미를 직접 못박는다.
    const bad = [];
    for (const [file, entries] of DOCUMENTED_UNDECLARED_REFERENCES) {
      const root = SCANNED_ROOTS[0];
      const parsed = parseCommandTools(readFileSync(join(root.dir, file), 'utf-8'));
      expect(parsed.ok, `${file}: allowed-tools 파싱 실패`).toBe(true);
      const declared = new Set(
        parsed.tools.map((d) => normalizeToolName(d)).filter((n) => !n.skip).map((n) => n.base),
      );
      for (const tool of Object.keys(entries)) {
        if (declared.has(tool)) bad.push(`${file} ${tool}: 이미 선언돼 있다 — 등록 항목을 지워라`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('등록된 도구명이 알려진 하네스 도구다 (오탈자로 무한 면제되지 않게)', () => {
    const bad = [];
    for (const [file, entries] of DOCUMENTED_UNDECLARED_REFERENCES) {
      for (const tool of Object.keys(entries)) {
        if (!KNOWN_TOOL_NAMES.has(tool)) bad.push(`${file} ${tool}: 알려진 도구가 아니다`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });
});

describe('스캐너 자기검증 — 호출 검출기', () => {
  it('호출 표기를 잡고 파일 기준 줄번호를 낸다', () => {
    // bodyOffset=6 → 본문 1번째 줄이 파일 6번째 줄.
    expect(findToolCallSites('a\nSendMessage(to="x")\n', 'SendMessage', 6)).toEqual([7]);
  });

  it('공백을 낀 호출도 잡는다', () => {
    expect(findToolCallSites('Agent (subagent_type="x")', 'Agent', 1)).toEqual([1]);
  });

  it('한 줄에 여러 번 나오면 그만큼 센다', () => {
    expect(findToolCallSites('TaskCreate(a) TaskCreate(b)', 'TaskCreate', 1)).toEqual([1, 1]);
  });

  it('식별자 일부이거나 메서드 호출이면 잡지 않는다 (과대탐지 통제)', () => {
    expect(findToolCallSites('MyAgent(x)', 'Agent', 1)).toEqual([]);
    expect(findToolCallSites('sub_Agent(x)', 'Agent', 1)).toEqual([]);
    expect(findToolCallSites('obj.Read(x)', 'Read', 1)).toEqual([]);
    expect(findToolCallSites('client.SendMessage(x)', 'SendMessage', 1)).toEqual([]);
  });

  it('괄호 없는 산문 언급은 잡지 않는다 (설계된 경계 — 못 보는 것 #1)', () => {
    // commands/repo.md#Forbidden-shortcuts 가 실제로 이 형태다. 이 단언은 그
    // 경계가 **의도**임을 못박는다. 넓히려면 이 테스트를 먼저 고쳐야 한다.
    expect(findToolCallSites('Forbidden: `WebFetch https://…`, `WebSearch "x"`', 'WebFetch', 1)).toEqual([]);
    expect(findToolCallSites('use WebSearch to find it', 'WebSearch', 1)).toEqual([]);
  });

  it('프론트매터는 본문이 아니다 (선언 줄이 자기 자신을 호출로 세지 않는다)', () => {
    const text = '---\nallowed-tools: [Read]\n---\nbody\n';
    const split = splitFrontmatter(text);
    expect(findToolCallSites(split.body, 'Read', split.bodyOffset)).toEqual([]);
  });
});

describe('스캐너 자기검증 — 게이트가 헛돌지 않는다', () => {
  // ── 3단 음성 대조 ②③ (rules §10.5(e)) ──────────────────────────────────
  // 뮤테이션을 **적용했음을 독립 확인**한 뒤 RED 를 본다. 워킹트리를 건드리지
  // 않고 `mutateDeclared` 주입점으로 한다 — 공유 트리 뮤테이션이 관측자 3명의
  // 시간을 태운 선례가 있다(rules §10.5(a)).
  it('선언에서 도구를 제거하면 그 커맨드가 위반으로 잡힌다', () => {
    const baseline = scanBodyToolReferences().refs;
    expect(baseline.some((r) => r.file === 'commands/team.md' && r.tool === 'Agent')).toBe(false);

    // ② 뮤테이션이 실제로 적용됐는지 독립 확인: 훅이 호출되고 Agent 가 빠졌는가.
    let applied = false;
    const mutated = scanBodyToolReferences({
      mutateDeclared: (rel, declared) => {
        if (rel !== 'commands/team.md') return declared;
        expect(declared.has('Agent'), 'team.md 가 애초에 Agent 를 선언하지 않는다 — 전제가 틀렸다').toBe(true);
        const copy = new Set(declared);
        copy.delete('Agent');
        applied = true;
        return copy;
      },
    });
    expect(applied, '뮤테이션 훅이 한 번도 호출되지 않았다 — 아래 RED 단언은 공허하다').toBe(true);

    // ③ RED 확인.
    const hit = mutated.refs.find((r) => r.file === 'commands/team.md' && r.tool === 'Agent');
    expect(hit, 'team.md 에서 Agent( 호출이 검출되지 않았다').toBeDefined();
    expect(hit.lines.length).toBeGreaterThan(0);
    // 차분으로 본다. 절대값은 남은 등록 항목이 섞여 흐려진다.
    expect(mutated.refs.length).toBe(baseline.length + 1);
  });

  it('선언을 전부 비우면 대량의 위반이 나온다 (양성 대조 — 스캐너가 실제로 돌았다)', () => {
    const { refs, scanned } = scanBodyToolReferences({ mutateDeclared: () => new Set() });
    expect(scanned).toBeGreaterThan(MIN_COMMAND_FILES.artibot);
    // 분모가 0이 아니고 검출도 0이 아님을 함께 못박는다. `hits=0` 이 "그린"인지
    // "아예 안 돌았다"인지 구분 못 하는 상태를 만들지 않는다(rules §10.5(e)).
    expect(refs.length).toBeGreaterThan(20);
    expect(new Set(refs.map((r) => r.file)).size).toBeGreaterThan(5);
  });

  it('검사 도구 집합이 비면 위반이 0이다 (검출이 도구 집합에 실제로 의존한다)', () => {
    const { refs, scanned } = scanBodyToolReferences({ tools: new Set() });
    expect(refs).toEqual([]);
    expect(scanned).toBeGreaterThan(MIN_COMMAND_FILES.artibot); // 분모는 그대로여야 한다
  });

  it('등록표는 선언 누락을 무한정 덮지 못한다 — 개수를 넘으면 RED 다', () => {
    // 등록표가 "무제한 면제 쿠폰"이 아님을 못박는다. export.md 의 Agent 는 2건으로
    // 등록돼 있으므로, 실제가 3건이 되면 개수 불일치로 잡혀야 한다.
    const entry = registered('commands/export.md', 'Agent');
    expect(entry).toBeDefined();
    expect(entry.count).toBe(2);
    const { refs } = scanBodyToolReferences();
    const actual = refs.find((r) => r.file === 'commands/export.md' && r.tool === 'Agent');
    expect(actual, 'export.md 의 Agent 참조가 사라졌다 — 등록 항목을 지워라').toBeDefined();
    expect(actual.lines.length).toBe(entry.count);
  });
});
