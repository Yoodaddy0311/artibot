/**
 * Firewall — the 4-line completion block (design §33) is SPECIFIED but NOT RENDERED.
 *
 * ── Why a gate at all ───────────────────────────────────────────────────────
 * PRD T-48 carves the block into two waves on purpose: this wave writes the
 * spec and the carrier registry, the next wave wires the render. The split
 * exists because rendering CHANGES COMMAND OUTPUT, and the leader's Phase 0
 * boundary is "출력 무변경". A spec wave has no visible artifact, so nothing
 * would notice if a render leaked in early — or if the registry drifted away
 * from the command set it claims to describe. This gate is that notice.
 *
 * It asserts three separable things:
 *   1. The registry holds only carriers with EVIDENCE — named by the design, or
 *      derived by a marker scan reproduced here on every run. It is a strict
 *      subset of the report-contract carrier set, and the remainder is parked
 *      in `unresolved` at one shared 미확인 grade — named and kept, rather than
 *      papered over with an equality or silently dropped.
 *   2. The progress-bar template that the block will attach to is unchanged,
 *      asserted by SHAPE (rule width, bar width, glyphs, row order), not by a
 *      file hash. `commands/team.md` was measured under concurrent edit at
 *      2026-09-02T07:09:55Z; a hash baseline would go red on any unrelated
 *      edit above the box and teach the next person to delete the gate.
 *   3. No block line appears in ANY command body yet. This is the actual
 *      "output unchanged" proof, and it is the assertion the render wave will
 *      deliberately flip.
 *
 * ── WHAT THIS GATE CANNOT SEE ───────────────────────────────────────────────
 *   - Whether the carrier set is COMPLETE. The design says "5캐리어" and this
 *     registry holds 3 carriers plus 2 in `unresolved`. Those two are neither
 *     design-named nor marker-derived; the gap is asserted as 미확인, but
 *     nothing here can tell you whether the design meant those two, two other
 *     files, or miscounted. A green means the gap is RECORDED, not resolved.
 *   - Whether `split.md` belongs. It is design-named and scores ZERO on every
 *     marker — it renders no progress bar at all. This gate pins that
 *     contradiction; it does not resolve it. The `grepDerived=false` set is
 *     anchored at exactly `['split.md']` so the contradiction cannot be
 *     dissolved by flipping one boolean: emptying the set now goes red instead
 *     of no-opping a loop into a green. The anchor pins the COUNT, not the
 *     correctness — it cannot tell you whether split.md ought to be a carrier.
 *   - Vacuity in loops it does not own. Every `for`/`filter` assertion here is
 *     anchored to a cardinality asserted somewhere in this file (block.lines
 *     via toHaveLength(4), designNamed and unresolved.files via exact toEqual,
 *     markerScan keys via Object.keys parity, commandFiles via the denominator
 *     check, carriers via the parity equation). If a future edit adds a loop
 *     over a registry-derived array WITHOUT such an anchor, that loop is a
 *     silent pass waiting to happen and nothing here will notice.
 *   - Whether anything renders the block. This proves the opposite — absence.
 *     After the render wave lands, a passing "block is not rendered anywhere"
 *     means the render REGRESSED, not that the system is healthy.
 *   - The block's SEMANTICS. Spec §3 says `✓` must not be printed
 *     unconditionally and the `MISSION COMPLETE` terminator requires all four
 *     rows green. Nothing enforces that; a render wave that hardcodes four
 *     checkmarks passes this file completely.
 *   - Drift D1's RESOLUTION. The two literal copies of the completion box
 *     disagree (`(전 작업 검수 통과)` vs `(전 작업 완료)`). This pins the
 *     disagreement at its measured values so it cannot silently widen. It does
 *     NOT assert either is right — both files are outside T-48's ownership and
 *     the two phrases make different claims (review verdict vs execution fact).
 *     A green here is not "the copies agree".
 *   - Whether `scripts/render-progress.js` is ever CALLED. team.md documents it
 *     as optional with an inline fallback. File ≠ registered ≠ executed.
 *   - Command files outside `commands/`. Skills, agents and hooks could print
 *     the block and this gate would not look there.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const COMMANDS_DIR = path.join(PLUGIN_ROOT, 'commands');
const REGISTRY_PATH = path.join(PLUGIN_ROOT, 'schemas', 'completion-block-carriers.json');
const SPEC_PATH = path.join(PLUGIN_ROOT, 'docs', 'completion-block-spec.md');
const PARITY_TEST_PATH = path.join(
  PLUGIN_ROOT,
  'tests',
  'commands',
  'report-contract-parity.test.js',
);
const RENDERER_PATH = path.join(PLUGIN_ROOT, 'scripts', 'render-progress.js');

/** Read as UTF-8 with CRLF normalized — the repo checks out CRLF on this host. */
const read = (p) => readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');

const registry = JSON.parse(read(REGISTRY_PATH));

/**
 * `.gitignore:24` denies `plugins/artibot/docs/*` and re-includes user-facing
 * files one `!` line at a time. `completion-block-spec.md` has NO such line as
 * of 2026-09-02T07:20:32Z, so it lives untracked in a working tree and is
 * absent from a fresh clone. That is a landing blocker for T-48, not a reason
 * to soften this gate: the spec is the human-readable half of the contract the
 * registry encodes, and a distributed registry pointing at an undistributed
 * spec is worse than a red test. Fail loudly, and name the one-line fix.
 */
let spec;
try {
  spec = read(SPEC_PATH);
} catch (err) {
  throw new Error(
    `완료 블록 스펙을 읽지 못했다: ${SPEC_PATH}\n` +
      `원인 후보 1순위 — .gitignore 의 \`plugins/artibot/docs/*\` deny-by-default.\n` +
      `조치: .gitignore 의 "!plugins/artibot/docs/…" allowlist 에 아래 한 줄을 추가하라.\n` +
      `  !plugins/artibot/docs/completion-block-spec.md\n` +
      `원본 오류: ${err.message}`,
    { cause: err },
  );
}

const teamMd = read(path.join(COMMANDS_DIR, 'team.md'));
const renderer = read(RENDERER_PATH);

const commandFiles = readdirSync(COMMANDS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();

/**
 * The carrier set is NOT re-declared here. It is parsed out of the report-
 * contract gate, because the design row that defines these carriers defines
 * them as "보고 계약과 같은 parity 게이트 대상" — same set, by construction.
 * Parsing keeps that identity live: add a 6th carrier there and this goes red.
 */
function parseParityCarriers() {
  const src = read(PARITY_TEST_PATH);
  const m = src.match(/const CARRIERS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

describe('완료 블록 캐리어 레지스트리', () => {
  it('캐리어 + unresolved 가 보고 계약 CARRIERS 를 정확히 덮는다', () => {
    // 설계는 캐리어 집합을 "보고 계약과 같은 parity 게이트 대상" 이라 규정하며
    // "5캐리어" 라 쓴다. 실측 캐리어는 3개다. 그 차이를 등식으로 덮지도, 조용히
    // 버리지도 않는다 — 남는 2개는 unresolved 로 이름을 달고 남는다.
    // 캐리어 3 + unresolved 2 = parity 5 를 등식으로 고정하면, parity 에 6번째가
    // 생겼는데 어느 쪽에도 넣지 않은 경우가 레드가 된다.
    const parity = parseParityCarriers();
    expect(parity, `${PARITY_TEST_PATH} 에서 CARRIERS 배열을 파싱하지 못했다`).not.toBeNull();
    const unresolved = registry.unresolved;
    const registryFiles = registry.carriers.map((c) => c.file);

    expect([...unresolved.reportContractCarriers].sort()).toEqual([...parity].sort());
    expect([...registryFiles, ...unresolved.files].sort()).toEqual([...parity].sort());

    const notCarriers = parity.filter((f) => !registryFiles.includes(f)).sort();
    expect(notCarriers).toEqual([...unresolved.files].sort());
  });

  it('unresolved 2건은 같은 등급이고 미확인이다', () => {
    // 한쪽만 캐리어로 올리는 것은 근거가 아니라 선호다. 등급이 갈라지는 순간
    // 다음 사람은 갈라진 쪽에 근거가 있다고 읽는다.
    const unresolved = registry.unresolved;
    expect([...unresolved.files].sort()).toEqual(['sc.md', 'ultraplan.md']);
    expect(unresolved.grade, '미확인 이외의 등급으로 올리려면 근거가 필요하다').toBe('미확인');
    expect(unresolved.sameGrade).toBe(true);
    expect(unresolved.reason, '사유가 비어 있으면 다음 사람은 이유 없이 지운다').toMatch(
      /설계가 이름으로 명시하지 않았고/,
    );
    expect(unresolved.reason).toMatch(/M1~M8 전건 0건/);
  });

  it('unresolved 파일은 캐리어 목록에 동시에 있을 수 없다', () => {
    const registryFiles = registry.carriers.map((c) => c.file);
    const both = registry.unresolved.files.filter((f) => registryFiles.includes(f));
    expect(both, `캐리어와 unresolved 에 동시 등재: ${JSON.stringify(both)}`).toEqual([]);
  });

  it('unresolved 파일은 실제로 마커 0건이다 (등급의 근거를 매번 재측정)', () => {
    // "근거가 없다" 는 주장 자체가 실측이어야 한다. 나중에 sc.md 가 진행률 바를
    // 갖게 되면 이 어서션이 레드가 되고, 그때는 unresolved 에서 캐리어로 옮겨라.
    const NEEDLES = ['📊 작업 진행률', '🎉 작업 완료', '✅ 완료 {done} / 전체 {total}'];
    for (const f of registry.unresolved.files) {
      const body = read(path.join(COMMANDS_DIR, f));
      for (const n of NEEDLES) {
        expect(body.includes(n), `${f} 가 마커 ${JSON.stringify(n)} 를 갖게 됐다`).toBe(false);
      }
    }
  });

  it('설계가 이름으로 명시한 3개가 전부 들어 있다', () => {
    const files = registry.carriers.map((c) => c.file);
    for (const named of registry.carrierSetDerivation.designNamed) {
      expect(files, `설계 명시 캐리어 ${named} 누락`).toContain(named);
    }
    expect([...registry.carrierSetDerivation.designNamed].sort()).toEqual([
      'autopilot.md',
      'split.md',
      'team.md',
    ]);
  });

  it('설계 명시도 grep 도출도 아닌 캐리어는 하나도 없다 (추측 금지)', () => {
    const guessed = registry.carriers.filter((c) => !c.designNamed && !c.grepDerived);
    expect(guessed, `근거 없이 들어온 캐리어: ${JSON.stringify(guessed.map((c) => c.file))}`).toEqual(
      [],
    );
  });

  it('모든 캐리어 파일이 commands/ 에 실재한다', () => {
    const missing = registry.carriers.map((c) => c.file).filter((f) => !commandFiles.includes(f));
    expect(missing, `commands/ 에 없는 캐리어: ${JSON.stringify(missing)}`).toEqual([]);
  });

  it('canonical 은 team.md 이고 캐리어 목록 안에 있다', () => {
    expect(registry.canonical).toBe('team.md');
    expect(registry.carriers.map((c) => c.file)).toContain(registry.canonical);
  });

  it('마커 스캔이 재현된다 (레지스트리에 적힌 히트 = 지금 실측한 히트)', () => {
    // 레지스트리의 도출 근거가 "그때 한 번 돌린 결과"로 굳는 것을 막는다.
    // 마커 정의는 여기 있고 결과는 레지스트리에 있다 — 커맨드가 바뀌면 갈라진다.
    const MARKERS = {
      'M1_📊_작업_진행률': '📊 작업 진행률',
      'M2_🎉_작업_완료': '🎉 작업 완료',
      M3_완료_done_전체_total: '✅ 완료 {done} / 전체 {total}',
      M4_현재_단계: '└ 현재 단계:',
      M5_괘선_40: '━'.repeat(40),
      M6_바_20: '█'.repeat(20),
      M7_render_progress_js: 'render-progress.js',
      M8_Phase_3_5_진행률_렌더링: 'Phase 3.5 진행률 렌더링',
    };
    const scan = registry.carrierSetDerivation.markerScan;
    expect(Object.keys(scan).sort()).toEqual(Object.keys(MARKERS).sort());
    for (const [key, needle] of Object.entries(MARKERS)) {
      const hits = commandFiles
        .filter((f) => read(path.join(COMMANDS_DIR, f)).includes(needle))
        .sort();
      expect(hits, `${key} 히트가 레지스트리 기록과 다르다`).toEqual([...scan[key]].sort());
    }
  });

  it('분모가 실제 커맨드 수와 같다', () => {
    expect(registry.carrierSetDerivation.denominator).toBe(commandFiles.length);
  });

  it('literal 캐리어 집합이 리더 지정 마커(📊 작업 진행률) 히트와 정확히 같다', () => {
    const literal = registry.carriers
      .filter((c) => c.progressBar === 'literal')
      .map((c) => c.file)
      .sort();
    const m1 = commandFiles
      .filter((f) => read(path.join(COMMANDS_DIR, f)).includes('📊 작업 진행률'))
      .sort();
    expect(literal).toEqual(m1);
  });

  it('grepDerived=false 캐리어는 정확히 split.md 1건이다 (카디널리티 앵커)', () => {
    // 앵커가 없으면 이 검사는 스스로 무력화된다: split.md 의 grepDerived 를 true 로
    // 한 글자 바꾸는 순간 필터가 비고, 아래 루프는 0회 돌며, 테스트는 그린이다.
    // 그러면 "측정 근거 없는 캐리어가 자기 유보를 적는다" 는 계약이 조용히 사라진다.
    // 집합을 먼저 고정한 뒤 내용을 검사한다.
    const unevidenced = registry.carriers.filter((x) => !x.grepDerived).map((c) => c.file);
    expect(
      unevidenced.sort(),
      'grepDerived=false 집합이 변했다. split.md 가 진짜 진행률 바를 갖게 됐다면 ' +
        '레지스트리에서 grepDerived=true + grepMarkers 를 채우고 이 앵커도 함께 고쳐라. ' +
        '앵커만 지우는 것은 계약을 지우는 것이다.',
    ).toEqual(['split.md']);
  });

  it('측정 근거 없는 캐리어는 마커 0건이라고 스스로 적는다', () => {
    // split.md 가 여기 해당한다 — 설계 명시로만 들어와 있고 측정 근거가 없다.
    // 이 유보가 지워지면 다음 사람은 3개 전부를 실측으로 읽는다.
    const unevidenced = registry.carriers.filter((x) => !x.grepDerived);
    expect(unevidenced.length, '앵커 테스트와 함께 레드가 되어야 한다').toBe(1);
    for (const c of unevidenced) {
      expect(c.grepMarkers, `${c.file} 은 grepDerived=false 인데 마커가 적혀 있다`).toEqual([]);
      expect(c.progressBar, `${c.file} 은 마커 0건인데 바를 렌더한다고 적혀 있다`).toBe('none');
    }
  });

  it('renderer 는 캐리어가 아니다 (커맨드가 아니라 헬퍼다)', () => {
    expect(registry.renderer.isCarrier).toBe(false);
    expect(registry.carriers.map((c) => c.file)).not.toContain('render-progress.js');
  });
});

describe('완료 블록 리터럴', () => {
  const { lines, terminator, preamble, labelPad } = registry.block;

  it('4줄이고 라벨 열이 전부 같은 폭이다', () => {
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const m = line.match(/^(\S+)(\s+)✓ /);
      expect(m, `라벨/체크마크 형식 위반: ${JSON.stringify(line)}`).not.toBeNull();
      expect(m[1].length + m[2].length, `라벨 폭 불일치: ${JSON.stringify(line)}`).toBe(labelPad);
    }
  });

  it('설계 §33 의 네 라벨을 순서대로 싣는다', () => {
    expect(lines.map((l) => l.split(/\s/)[0])).toEqual([
      'Execution',
      'Review',
      'Verification',
      'Outcome',
    ]);
  });

  it('종결 줄과 선행 2줄이 설계 문구 그대로다', () => {
    expect(terminator).toBe('✓ MISSION COMPLETE');
    expect(preamble).toEqual(['Execution complete.', 'Running independent review...']);
  });

  it('스펙 문서가 레지스트리 리터럴을 바이트 그대로 싣는다', () => {
    // 두 곳에 같은 문자열이 있는 한 드리프트가 가능하다. 사람이 읽는 쪽(스펙)과
    // 기계가 읽는 쪽(레지스트리)이 갈라지면 렌더 웨이브는 둘 중 아무거나 고른다.
    for (const line of [...lines, terminator, ...preamble]) {
      expect(spec, `스펙 문서에 없는 리터럴: ${JSON.stringify(line)}`).toContain(line);
    }
  });
});

describe('출력 무변경 — 블록은 아직 어디에도 렌더되지 않는다', () => {
  const { lines, terminator } = registry.block;

  it('레지스트리가 스스로 "미렌더" 라고 선언한다', () => {
    expect(registry.block.renderedYet).toBe(false);
  });

  it.each(lines.map((l) => [l]))('커맨드 어디에도 %s 가 없다', (line) => {
    const hits = commandFiles.filter((f) => read(path.join(COMMANDS_DIR, f)).includes(line));
    expect(hits, `블록 줄이 커맨드 본문에 들어왔다: ${JSON.stringify(hits)}`).toEqual([]);
  });

  it('커맨드 어디에도 MISSION COMPLETE 종결 줄이 없다', () => {
    const hits = commandFiles.filter((f) => read(path.join(COMMANDS_DIR, f)).includes(terminator));
    expect(hits).toEqual([]);
  });

  it('커맨드 어디에도 "Running independent review" 단계가 없다', () => {
    const hits = commandFiles.filter((f) =>
      read(path.join(COMMANDS_DIR, f)).includes('Running independent review'),
    );
    expect(hits).toEqual([]);
  });
});

describe('진행률 바 템플릿 불변 (블록이 붙을 자리)', () => {
  const { ruleWidth, ruleGlyph, barWidth, barGlyphs } = registry.renderer;
  const RULE = ruleGlyph.repeat(ruleWidth);

  it('team.md 가 진행률 렌더 절을 그대로 들고 있다', () => {
    expect(teamMd).toContain('Phase 3.5: 진행률 렌더링');
    expect(teamMd).toContain('📊 작업 진행률');
    expect(teamMd).toContain('🎉 작업 완료');
  });

  it(`team.md 괘선이 ${ruleGlyph}×${ruleWidth} 이다`, () => {
    expect(teamMd).toContain(RULE);
    // 더 긴 괘선이 생기면 폭이 바뀐 것이다 — 포함 검사만으로는 못 잡는다.
    expect(teamMd).not.toContain(RULE + ruleGlyph);
  });

  it(`완료 박스 바가 ${barGlyphs.filled}×${barWidth} 이다`, () => {
    expect(teamMd).toContain(barGlyphs.filled.repeat(barWidth));
    expect(teamMd).not.toContain(barGlyphs.filled.repeat(barWidth + 1));
  });

  it('진행 행/완료 행의 플레이스홀더 구성이 그대로다', () => {
    expect(teamMd).toContain('✅ 완료 {done} / 전체 {total}');
    expect(teamMd).toContain('└ 현재 단계: {phaseLabel}');
    expect(teamMd).toContain('✅ 완료 {total} / 전체 {total}');
  });

  it('바 계산 공식이 20칸·round 그대로다', () => {
    expect(teamMd).toContain('20칸 기준 `filled = round(pct / 5)`');
    expect(teamMd).toContain('`pct = round(done / total * 100)`');
  });

  it('렌더러 상수가 레지스트리 값과 일치한다', () => {
    expect(renderer).toContain(`const BAR_WIDTH = ${barWidth};`);
    expect(renderer).toContain(`const RULE = '${ruleGlyph}'.repeat(${ruleWidth});`);
    expect(renderer).toContain(`'${barGlyphs.filled}'.repeat(filled) + '${barGlyphs.empty}'`);
  });
});

describe('알려진 드리프트 D1 — 고정만 한다', () => {
  const d1 = registry.knownDrift.find((d) => d.id === 'D1');

  it('레지스트리에 D1 이 기록돼 있고 미해결이라고 적혀 있다', () => {
    expect(d1, 'D1 기록이 사라졌다').toBeTruthy();
    expect(d1.status).toMatch(/기록만/);
  });

  it('team.md 쪽 꼬리말이 측정값 그대로다', () => {
    expect(teamMd).toContain(`✅ 완료 {total} / 전체 {total}   ${d1.teamMd}`);
  });

  it('renderer 쪽 꼬리말이 측정값 그대로다', () => {
    expect(renderer).toContain(d1.renderer);
  });

  it('두 꼬리말은 여전히 다르다 — 같아졌으면 누군가 통일한 것이니 D1 을 닫아라', () => {
    // 이 어서션이 레드가 되는 것은 결함이 아니라 "해결됐다"는 신호다.
    // 그때 할 일은 게이트를 지우는 것이 아니라 registry.knownDrift 에서 D1 을
    // 닫고 두 사본의 동일성을 주장하는 어서션으로 바꾸는 것이다.
    expect(d1.teamMd).not.toBe(d1.renderer);
  });

  it('스펙 문서가 D1 을 숨기지 않는다', () => {
    expect(spec).toContain(d1.teamMd);
    expect(spec).toContain(d1.renderer);
  });
});

describe('설계 삽화와 라이브 규격 불일치', () => {
  it('32칸 괄호 바는 삽화이고 라이브는 20칸 무괄호임을 기록한다', () => {
    const mm = registry.designMockMismatch;
    expect(mm.designBarCells).toBe(32);
    expect(mm.liveBarCells).toBe(20);
    expect(mm.liveBarCells).toBe(registry.renderer.barWidth);
    expect(mm.resolution).toMatch(/라이브/);
  });

  it('설계 삽화의 괄호 바가 커맨드에 새어 들어오지 않았다', () => {
    const bracketed = `[${'█'.repeat(32)}]`;
    const hits = commandFiles.filter((f) => read(path.join(COMMANDS_DIR, f)).includes(bracketed));
    expect(hits).toEqual([]);
  });
});
