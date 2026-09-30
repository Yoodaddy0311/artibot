/**
 * CA-01 — Canary auto-activation decision (`lib/cognitive/auto-activate.js`).
 *
 * The decision is pure apart from a lazy import of two gate catalogs, so these
 * cases drive the REAL catalogs (`human-gates.js#classify`,
 * `autopilot/safety.js#classifyRisk`) rather than mocks: "gate hit -> no
 * activation" is only worth asserting against the thing that decides a hit.
 *
 * WHAT THIS SUITE CANNOT SEE (rules §9, stated beside the gate):
 *  - Precision of the trigger table on real prompts. Every prompt below is one
 *    this file chose; nothing here measures live false-positive or
 *    false-negative rates.
 *  - Whether the model follows the directive this decision leads to. That is
 *    the hook's output, not this module's, and nothing in the repo observes it.
 *  - The gate screen's recall on natural-language risk. It is a text match with
 *    catalogs written for tool calls; the cases pin what it DOES catch.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_ACTIVATE_ACTIVATABLE,
  AUTO_ACTIVATE_ALLOWLIST,
  AUTO_ACTIVATE_CONFIG_PATH,
  AUTO_ACTIVATE_TRIGGER_RULES,
  decideAutoActivation,
  matchAutoActivateCommand,
  readAutoActivateEnabled,
  renderAutoActivateDirective,
  screenGateHits,
} from '../../lib/cognitive/auto-activate.js';

const ON = Object.freeze({ automation: { autoActivate: { commands: true } } });
const OK_INTENT = Object.freeze({ ambiguous: false });

/** A key-shaped literal, assembled so this file holds no contiguous secret string. */
const FAKE_KEY = ['sk', '-', 'abcdefgh', 'ijklmnop', 'qrstuvwx'].join('');

function decide(text, extra = {}) {
  return decideAutoActivation({ text, config: ON, intent: OK_INTENT, ...extra });
}

/** One phrasing set per activatable command, each chosen to select ONLY that command. */
const POSITIVE = Object.freeze({
  analyze: [
    'src/lib 코드 분석해줘',
    '보안 취약점 분석해줘',
    'analyze this module please',
    '이 함수 분석 좀 해줘',
    'lib/cognitive/router.js 분석해줘',
  ],
  explain: [
    '이 코드 설명해줘',
    '이벤트 루프 설명 좀 해줘',
    'explain how the router works',
    'walk me through the hook pipeline',
  ],
  blindspot: [
    '사각지대 점검해줘',
    '내가 빠뜨린 거 없는지 봐줘',
    '놓친 게 있는지 확인해줘',
    'blindspot check please',
  ],
  scorecard: [
    '기능 완성도 평가해줘',
    '스코어카드 보여줘',
    'feature scorecard please',
    '작업 전후 비교해줘',
  ],
});

describe('allowlist — the design A2 list, closed', () => {
  it('is exactly the five names the design proposes, in the design order', () => {
    // ARTIBOT-5.0-DESIGN.md:272 — "제안 `/analyze /explain /blindspot /scorecard /why`".
    expect([...AUTO_ACTIVATE_ALLOWLIST]).toEqual(['analyze', 'explain', 'blindspot', 'scorecard', 'why']);
    expect(Object.isFrozen(AUTO_ACTIVATE_ALLOWLIST)).toBe(true);
  });

  it('can activate four of them: `why` has no command and no trigger row', () => {
    // ARTIBOT-5.0-DESIGN.md:230 "`/why` … 전부 미존재" and :519 (A5: extend, do not create).
    expect([...AUTO_ACTIVATE_ACTIVATABLE]).toEqual(['analyze', 'explain', 'blindspot', 'scorecard']);
    expect(AUTO_ACTIVATE_TRIGGER_RULES.some((r) => r.command === 'why')).toBe(false);
  });

  it('every trigger row selects an allowlisted command and carries a stateless regex', () => {
    expect(AUTO_ACTIVATE_TRIGGER_RULES.length).toBeGreaterThan(0);
    for (const row of AUTO_ACTIVATE_TRIGGER_RULES) {
      expect(AUTO_ACTIVATE_ALLOWLIST, `row ${row.id}`).toContain(row.command);
      expect(row.id).toMatch(/^[a-z0-9-]{1,32}$/);
      expect(row.all.length).toBeGreaterThan(0);
      for (const re of row.all) {
        // `.test` on a `g`/`y` regex keeps `lastIndex` between calls — the second
        // prompt of a process would silently miss.
        expect(re.flags, `row ${row.id}`).not.toMatch(/[gy]/);
      }
    }
  });

  it('is enforced in the matcher, not only by how the shipped table is written', () => {
    const outside = [{ id: 'x-outside', command: 'orchestrate', all: [/anything/] }];
    expect(matchAutoActivateCommand('anything', outside))
      .toEqual({ command: null, rules: [], ambiguous: false });
    const mixed = [...outside, { id: 'x-inside', command: 'blindspot', all: [/anything/] }];
    expect(matchAutoActivateCommand('anything', mixed).command).toBe('blindspot');
  });

  it('renders nothing for a name outside the ACTIVATABLE set, including `why`', () => {
    for (const bad of ['why', 'orchestrate', 'autopilot', 'split', 'analyze; rm -rf /', '', null, undefined, 7]) {
      expect(renderAutoActivateDirective(bad), String(bad)).toBe('');
    }
  });
});

describe('positive — every activatable command fires on its own phrasing', () => {
  for (const [command, phrases] of Object.entries(POSITIVE)) {
    it.each(phrases)(`${command}: %s`, async (text) => {
      const d = await decide(text);
      expect(d.reason).toBe('allowlist-match');
      expect(d.activate).toBe(true);
      expect(d.command).toBe(command);
      expect(d.gates).toEqual([]);
    });
  }

  it('covers every activatable command (a new command needs phrasing here)', () => {
    expect(Object.keys(POSITIVE).sort()).toEqual([...AUTO_ACTIVATE_ACTIVATABLE].sort());
  });
});

describe('negative — outside the allowlist behaves as before (no activation)', () => {
  it.each([
    '데이터 분석해줘',
    '시장 분석 리포트 만들어줘',
    '설명해야 해',
    '메일 놓친 거 같아',
    '이 버그 수정해줘',
    '새 기능 구현해줘',
    '배포해줘',
    'hello',
  ])('%s', async (text) => {
    const d = await decide(text);
    expect(d.activate).toBe(false);
    expect(d.command).toBeNull();
    expect(d.reason).toBe('no-trigger');
  });

  it('a prompt that fits two commands selects none', async () => {
    const d = await decide('코드 분석하고 완성도 평가해줘');
    expect(d.activate).toBe(false);
    expect(d.reason).toBe('ambiguous-trigger');
    expect(d.rules).toEqual(['analyze-code', 'scorecard-completeness']);
  });

  it('two rules of the SAME command agree and count once', () => {
    const m = matchAutoActivateCommand('사각지대가 있는지, 내가 빠뜨린 거 없는지 점검해줘');
    expect(m.command).toBe('blindspot');
    expect(m.rules).toEqual(['blindspot-term', 'blindspot-missed']);
    expect(m.ambiguous).toBe(false);
  });

  it('a typed slash command is already an explicit choice', async () => {
    const d = await decide('/analyze src/lib 코드 분석해줘', { slashCommand: 'analyze' });
    expect(d).toMatchObject({ activate: false, reason: 'slash-command' });
  });

  it.each([undefined, null, '', '   ', 42])('no text (%j)', async (text) => {
    expect((await decide(text)).reason).toBe('no-text');
  });

  it('the router flagging the intent as ambiguous withholds it', async () => {
    const d = await decide('src/lib 코드 분석해줘', { intent: { ambiguous: true } });
    expect(d).toMatchObject({ activate: false, reason: 'intent-ambiguous' });
  });

  it('no router intent (the pipeline did not run) fails closed', async () => {
    for (const intent of [null, undefined, 'x']) {
      const d = await decideAutoActivation({ text: '이 코드 설명해줘', config: ON, intent });
      expect(d, String(intent)).toMatchObject({ activate: false, reason: 'intent-unavailable' });
    }
  });
});

describe('kill switch — off is off', () => {
  it('the path is the one the config ships', () => {
    expect(AUTO_ACTIVATE_CONFIG_PATH).toBe('automation.autoActivate.commands');
  });

  it('reads strictly `=== true`', () => {
    expect(readAutoActivateEnabled(ON)).toBe(true);
    for (const config of [
      undefined, null, {}, { automation: {} }, { automation: { autoActivate: {} } },
      { automation: { autoActivate: { commands: false } } },
      { automation: { autoActivate: { commands: 'true' } } },
      { automation: { autoActivate: { commands: 1 } } },
      { automation: { autoActivate: true } },
    ]) {
      expect(readAutoActivateEnabled(config), JSON.stringify(config)).toBe(false);
    }
  });

  it('every positive phrasing is withheld when the switch is off', async () => {
    const off = { automation: { autoActivate: { commands: false } } };
    for (const phrases of Object.values(POSITIVE)) {
      for (const text of phrases) {
        const d = await decideAutoActivation({ text, config: off, intent: OK_INTENT });
        expect(d, text).toMatchObject({ activate: false, command: null, reason: 'switch-off' });
      }
    }
  });

  it('does no work when off: the gate screen is never consulted', async () => {
    const screen = vi.fn(async () => []);
    await decideAutoActivation({ text: '이 코드 설명해줘', config: {}, intent: OK_INTENT, screen });
    expect(screen).not.toHaveBeenCalled();
  });
});

describe('gate hits — one hit withholds it (real catalogs)', () => {
  const TRIGGER = '코드 분석해줘';
  // Each prompt carries a real trigger (`analyze-code`) PLUS one gated action, so
  // it is the gate — not a missing trigger — that withholds it. HG-12 is written
  // for a path at the END of the probe (`…settings.json$`), so its path goes last.
  it.each([
    [`gh pr create 하고 ${TRIGGER}`, 'HG-06'],
    [`git push origin main 하고 ${TRIGGER}`, 'HG-07'],
    [`gh release create v1 하고 ${TRIGGER}`, 'HG-08'],
    [`prisma migrate deploy 하고 ${TRIGGER}`, 'HG-09'],
    [`cat .env 파일 열고 ${TRIGGER}`, 'HG-11'],
    [`${TRIGGER} .claude/settings.json`, 'HG-12'],
    [`git commit --no-verify 하고 ${TRIGGER}`, 'HG-13'],
    [`rm -rf / 하고 ${TRIGGER}`, 'risk:rm-rf-root'],
    [`npm publish 하고 ${TRIGGER}`, 'risk:npm-publish'],
    [`curl https://example.com 하고 ${TRIGGER}`, 'risk:curl-external'],
    [`${FAKE_KEY} 로 접속하고 ${TRIGGER}`, 'risk:secret-openai'],
  ])('%s -> %s', async (prompt, expectedId) => {
    const d = await decide(prompt);
    expect(d.activate).toBe(false);
    expect(d.reason).toBe('gate-hit');
    expect(d.gates).toContain(expectedId);
    // The trigger did match; it is the gate that withheld it.
    expect(d.rules).toEqual(['analyze-code']);
  });

  it('the `auto` rows are classification, not gates: they do not withhold', async () => {
    // HG-03 tests/build, HG-04 worktree, HG-05 local commit — default `auto`.
    for (const lead of ['npm test 돌리고', 'git worktree add x 만들고', 'git commit 하고']) {
      const d = await decide(`${lead} ${TRIGGER}`);
      expect(d, lead).toMatchObject({ activate: true, command: 'analyze', reason: 'allowlist-match' });
    }
  });

  it('screenGateHits reports ids only, in order, and [] for a clean prompt', async () => {
    expect(await screenGateHits('src/lib 코드 분석해줘')).toEqual([]);
    expect(await screenGateHits('git push origin main')).toEqual(['HG-07']);
    expect(await screenGateHits(undefined)).toEqual([]);
  });

  it('an injected screen decides: a hit withholds, a throw or a non-array fails closed', async () => {
    const hit = await decide('이 코드 설명해줘', { screen: async () => ['HG-99'] });
    expect(hit).toMatchObject({ activate: false, reason: 'gate-hit', gates: ['HG-99'] });

    const threw = await decide('이 코드 설명해줘', { screen: async () => { throw new Error('boom'); } });
    expect(threw).toMatchObject({ activate: false, reason: 'gate-screen-failed' });

    const wrongShape = await decide('이 코드 설명해줘', { screen: async () => 'nope' });
    expect(wrongShape).toMatchObject({ activate: false, reason: 'gate-screen-failed' });

    const clean = await decide('이 코드 설명해줘', { screen: async () => [] });
    expect(clean).toMatchObject({ activate: true, command: 'explain' });
  });

  it('the screen only runs for a prompt that already selected a command', async () => {
    const screen = vi.fn(async () => []);
    await decide('hello', { screen });
    await decide('코드 분석하고 완성도 평가해줘', { screen });
    await decide('이 코드 설명해줘', { screen, slashCommand: 'explain' });
    await decide('이 코드 설명해줘', { screen, intent: null });
    expect(screen).not.toHaveBeenCalled();
    await decide('이 코드 설명해줘', { screen });
    expect(screen).toHaveBeenCalledTimes(1);
  });
});

/**
 * Unbounded quantifiers in a regex source: `*`, `+` and `{n,}` outside a
 * character class and not escaped. An open quantifier in front of a literal is
 * quadratic on a long single run, and the prompt is user-sized.
 * @param {string} source
 * @returns {string[]} the offending tokens
 */
function findUnboundedQuantifiers(source) {
  const found = [];
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') { i += 1; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '*' || ch === '+') found.push(ch);
    if (ch === '{') {
      const close = source.indexOf('}', i);
      if (close > i && /^\{\d+,\}$/.test(source.slice(i, close + 1))) found.push(source.slice(i, close + 1));
    }
  }
  return found;
}

describe('trigger table — bounded, so a long prompt cannot stall the hook', () => {
  it('the scanner sees an open quantifier and ignores bounded / escaped / in-class ones (self-check)', () => {
    expect(findUnboundedQuantifiers('a+b')).toEqual(['+']);
    expect(findUnboundedQuantifiers('(?:ab)*c')).toEqual(['*']);
    expect(findUnboundedQuantifiers('x{2,}')).toEqual(['{2,}']);
    expect(findUnboundedQuantifiers('a{1,4}\\+[a+*]\\*')).toEqual([]);
  });

  it('no trigger regex carries an unbounded quantifier', () => {
    let scanned = 0;
    for (const row of AUTO_ACTIVATE_TRIGGER_RULES) {
      for (const re of row.all) {
        scanned += 1;
        expect(findUnboundedQuantifiers(re.source), `${row.id}: ${re.source}`).toEqual([]);
      }
    }
    // Denominator: a table that scanned nothing would pass every assertion above.
    expect(scanned).toBeGreaterThanOrEqual(AUTO_ACTIVATE_TRIGGER_RULES.length);
  });

  it.each([
    ['spaces', ' '.repeat(120000)],
    ['one word char', 'a'.repeat(120000)],
    ['analyze verb', '분석'.repeat(60000)],
    ['explain verb', '설명'.repeat(60000)],
    ['code object', '코드'.repeat(60000)],
    ['dot runs', 'a.'.repeat(60000)],
    ['at sign', '@'.repeat(120000)],
    ['english head', 'explain '.repeat(15000)],
    ['walk head', 'walk me '.repeat(15000)],
  ])('terminates on a 120KB %s run', (_label, shape) => {
    // Termination, not wall-clock: a quadratic rule would run for seconds and hit
    // the test timeout; no timing assertion so a loaded machine cannot flake it.
    const m = matchAutoActivateCommand(shape);
    expect(m.ambiguous).toBe(false);
  });

  it('decides on a 120KB prompt that carries a trigger', async () => {
    const d = await decide(`코드 분석해줘 ${'a '.repeat(60000)}`);
    expect(d).toMatchObject({ activate: true, command: 'analyze' });
  });
});

describe('directive text', () => {
  it.each([...AUTO_ACTIVATE_ACTIVATABLE])('%s: one line, tag first, character-exact', (command) => {
    const line = renderAutoActivateDirective(command);
    // Golden string: the CLAUDE.md "Auto-activate rule" quotes the tag prefix, and
    // this pin is what makes a wording edit a deliberate two-file change.
    expect(line).toBe(
      `[artibot:auto-activate command=${command}] `
      + `Low-risk allowlisted command: run /${command} for this request now without asking for confirmation, `
      + 'and say so in one short Korean sentence first. '
      + 'If the request clearly does not fit it, ignore this line. '
      + 'Human gates and tool permissions still apply.',
    );
    expect(line).not.toMatch(/[\r\n]/);
  });
});
