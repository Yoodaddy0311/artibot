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
 *    this file chose — including the seven false positives a review measured on
 *    the real hook, pinned in REVIEWED_FALSE_POSITIVES — and nothing here
 *    measures live false-positive or false-negative rates. The holes the shape
 *    gate leaves open (a foreign clause BEFORE an `analyze`/`explain` trigger,
 *    an `explain` aimed at a third party) are listed in the module header, not
 *    pinned here: a test that asserts a known false positive reads as
 *    endorsing it.
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
  AUTO_ACTIVATE_MAX_PROMPT_CHARS,
  AUTO_ACTIVATE_TRIGGER_RULES,
  decideAutoActivation,
  matchAutoActivateCommand,
  normalizeAutoActivateProbe,
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

/**
 * One phrasing set per activatable command, each chosen to select ONLY that
 * command. Every phrase is ONE short request whose last predicate is the
 * trigger. The leading entries are the original set (five for `analyze`, four
 * for each other command); every one of them still fires under the shape gate.
 */
const POSITIVE = Object.freeze({
  analyze: [
    'src/lib 코드 분석해줘',
    '보안 취약점 분석해줘',
    'analyze this module please',
    '이 함수 분석 좀 해줘',
    'lib/cognitive/router.js 분석해줘',
    // The code object sits right before the verb; particles and a focus noun may sit between.
    '이 저장소 전체를 분석해줘',
    '인증 모듈의 구조를 분석해줘',
    '이 코드 한번 분석해봐',
    'analyze the auth module',
    'analyze src/lib/foo.js',
  ],
  explain: [
    '이 코드 설명해줘',
    '이벤트 루프 설명 좀 해줘',
    'explain how the router works',
    'walk me through the hook pipeline',
    '이벤트 루프 설명해주세요',
    'explain this',
    'explain the auth module please',
    'walk me through the router',
  ],
  blindspot: [
    '사각지대 점검해줘',
    '내가 빠뜨린 거 없는지 봐줘',
    '놓친 게 있는지 확인해줘',
    'blindspot check please',
    '이번 작업 사각지대 점검해줘',
    '혹시 놓친 거 있어?',
    'check for blind spots',
  ],
  scorecard: [
    '기능 완성도 평가해줘',
    '스코어카드 보여줘',
    'feature scorecard please',
    '작업 전후 비교해줘',
    '기능별 점수 보여줘',
    'show me the scorecard',
  ],
});

/**
 * The seven false positives a review measured on the REAL hook path (shipped
 * config) before the shape gate existed — `analyze-code`, `explain-ko`,
 * `blindspot-term` and `blindspot-missed` each fired on one of these. `control`
 * is the same request without the defect: it fires, so the withholding below is
 * the shape gate and not a dead trigger.
 */
const REVIEWED_FALSE_POSITIVES = Object.freeze([
  {
    defect: 'noun "설명 좀" in a rewrite request', command: 'explain',
    text: '고객한테 보낼 제품 설명 좀 다듬어줘', control: '제품 설명 좀 해줘',
  },
  {
    defect: 'noun "설명 좀" in an editing request', command: 'explain',
    text: '이 메일에 설명 좀 추가해서 보내줘', control: '이 메일 설명 좀 해줘',
  },
  {
    defect: 'quoted text ("설명해주세요" inside a sentence)', command: 'explain',
    text: '회의록에 "설명해주세요" 라고 적혀 있는데 그 부분 지워줘', control: '회의록 설명해주세요',
  },
  {
    defect: 'compound request (analyze, then commit)', command: 'analyze',
    text: '이 함수 분석하고 커밋해줘', control: '이 함수 분석해줘',
  },
  {
    defect: 'compound request (check, then fix)', command: 'blindspot',
    text: '사각지대 없는지 보고 바로 수정해줘', control: '사각지대 없는지 봐줘',
  },
  {
    defect: 'loose "놓친 거 있어?" about a mailbox', command: 'blindspot',
    text: '메일 놓친 거 있어?', control: '놓친 거 있어?',
  },
  {
    defect: 'a trigger inside a pasted code fence', command: 'explain',
    text: 'summarize this file:\n```// TODO: explain this module and its exports```', control: 'explain this module',
  },
]);

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
      for (const re of [...row.all, row.shape]) {
        expect(re, `row ${row.id}`).toBeInstanceOf(RegExp);
        // `.test` on a `g`/`y` regex keeps `lastIndex` between calls — the second
        // prompt of a process would silently miss.
        expect(re.flags, `row ${row.id}`).not.toMatch(/[gy]/);
      }
      // The last alternative of every shape is anchored to the END of the prompt;
      // "every positive stops firing once a clause follows it" (below) covers the rest.
      expect(row.shape.source, `row ${row.id}`).toMatch(/\$\)$/);
    }
  });

  it('is enforced in the matcher, not only by how the shipped table is written', () => {
    const outside = [{ id: 'x-outside', command: 'orchestrate', all: [/anything/], shape: /anything/ }];
    expect(matchAutoActivateCommand('anything', outside))
      .toEqual({ command: null, rules: [], ambiguous: false });
    const mixed = [...outside, { id: 'x-inside', command: 'blindspot', all: [/anything/], shape: /anything/ }];
    expect(matchAutoActivateCommand('anything', mixed).command).toBe('blindspot');
  });

  it('a row that only mentions its command never fires: no shape, no activation', () => {
    const mentionOnly = [{ id: 'x-mention', command: 'blindspot', all: [/anything/] }];
    expect(matchAutoActivateCommand('anything', mentionOnly))
      .toEqual({ command: null, rules: [], ambiguous: false });
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

  it('fires every trigger row at least once (a dead row would pass every negative below)', () => {
    const fired = new Set(Object.values(POSITIVE).flat().flatMap((text) => matchAutoActivateCommand(text).rules));
    expect(AUTO_ACTIVATE_TRIGGER_RULES.map((row) => row.id).filter((id) => !fired.has(id))).toEqual([]);
  });
});

describe('shape gate — the trigger must BE the request', () => {
  it.each(REVIEWED_FALSE_POSITIVES)('reviewed false positive, $defect: withheld', async ({ command, text, control }) => {
    // It still MENTIONS the command: a table that tested mentions alone would have
    // fired here, so this is not a pin on a trigger that never matched.
    const mentioned = AUTO_ACTIVATE_TRIGGER_RULES
      .some((row) => row.command === command && row.all.every((re) => re.test(text)));
    expect(mentioned, 'the prompt no longer mentions the command: the pin would be vacuous').toBe(true);

    const d = await decide(text);
    expect(d).toMatchObject({ activate: false, command: null, reason: 'no-trigger' });

    // Control: the same request without the defect fires, so what withholds the
    // prompt above is the shape gate and not a dead trigger.
    expect(await decide(control)).toMatchObject({ activate: true, command, reason: 'allowlist-match' });
  });

  it('every positive phrase stops firing once another clause follows it (the end anchor, every shape)', async () => {
    for (const phrases of Object.values(POSITIVE)) {
      for (const text of phrases) {
        const followed = /[가-힣]/.test(text) ? `${text} 그리고 커밋해줘` : `${text} and commit it`;
        const d = await decide(followed);
        expect(d, followed).toMatchObject({ activate: false, command: null });
      }
    }
  });

  it.each([
    // The noun forms are not requests to be taught anything.
    '제품 설명 부탁드립니다',
    '이 코드에 설명 추가해줘',
    '설명 좀',
    // A compound: the trigger is not the last predicate.
    '이 코드 분석해줘 그리고 커밋해줘',
    '이 코드 분석한 뒤 수정해줘',
    '이 코드 설명해주고 테스트도 짜줘',
    '사각지대 점검해줘 그리고 배포해줘',
    'explain this and commit',
    'analyze the code and commit it',
    'explain how it works and fix it',
    'check for blind spots and fix them',
    // `/scorecard` has a `scorecard.js` of its own; building or fixing it is not running it.
    '스코어카드 만들어줘',
    '스코어카드 버그 수정해줘',
    // A statement, not a request.
    '메일 놓친 거 같아',
    '이 코드는 분석해야 해',
    // A paste whose LAST line is the request: the end anchor alone would let it through, so
    // only the one-plain-sentence gate (no newline) withholds it.
    '로그 붙여넣기:\nERROR foo\n이 코드 설명해줘',
    '아래는 로그야\nTypeError at bar.js\n이 함수 분석해줘',
  ])('is not a request: %j', async (text) => {
    expect(await decide(text)).toMatchObject({ activate: false, command: null, reason: 'no-trigger' });
  });

  it.each([
    // blindspot / scorecard: only a scope word or opener may precede the term, so a
    // foreign clause in front of it selects nothing.
    '커밋하고 사각지대 점검해줘',
    '테스트 돌리고 사각지대 점검해줘',
    '커밋하고 기능 완성도 평가해줘',
    '푸시하고 스코어카드 보여줘',
    '택배 빠진 거 없는지 봐줘',
    '메일 놓친 거 있어',
  ])('a term with a foreign clause before it selects nothing: %s', async (text) => {
    expect(await decide(text)).toMatchObject({ activate: false, command: null });
  });

  it('a prompt that names two commands is ambiguous even when one of them ends it', () => {
    // "analyze the code AND evaluate completeness": only the scorecard clause is last,
    // but the analyze request is just as much in the prompt — asking is cheaper.
    const m = matchAutoActivateCommand('코드 분석하고 완성도 평가해줘');
    expect(m).toEqual({ command: null, rules: ['analyze-code', 'scorecard-completeness'], ambiguous: true });
  });
});

describe('normalizeAutoActivateProbe — one short plain sentence, or nothing', () => {
  it('returns the trimmed prompt without its closing punctuation', () => {
    expect(normalizeAutoActivateProbe('  이 코드 설명해줘  ')).toBe('이 코드 설명해줘');
    expect(normalizeAutoActivateProbe('이 코드 설명해줘!')).toBe('이 코드 설명해줘');
    expect(normalizeAutoActivateProbe('이 코드 설명해줘 ?!')).toBe('이 코드 설명해줘');
    expect(normalizeAutoActivateProbe('explain this…')).toBe('explain this');
    expect(normalizeAutoActivateProbe('이 코드 설명해줘\n')).toBe('이 코드 설명해줘');
  });

  it.each([
    ['a newline inside', '이 코드 설명해줘\n그리고 아래는 로그야'],
    ['a code fence', '```\nexplain this\n```'],
    ['a backtick', '`explain this` 를 설명해줘'],
    ['a double quote', '회의록에 "설명해주세요" 라고 적혀 있어'],
    ['a single quote', "'explain this' 를 번역해줘"],
    ['a curly quote', '“설명해줘” 라는 문구'],
    ['a corner bracket', '「설명해줘」 라는 문구'],
    ['a bracket', '이 함수(foo) 설명해줘'],
    ['a comma', '이 코드 분석해줘, 그리고 커밋해줘'],
    ['a semicolon', '이 코드 분석해줘; 커밋해줘'],
    ['a label colon', 'summary: 이 코드 설명해줘'],
    ['a sentence boundary', '커밋해줘. 이 코드 분석해줘'],
    ['a question mark inside', '뭐가 문제야? 이 코드 설명해줘'],
    ['a tab', '이 코드\t설명해줘'],
    ['an emoji', '이 코드 설명해줘 🙏'],
    ['only punctuation', '?!…'],
    ['nothing', ''],
    ['a non-string', 42],
  ])('refuses %s', (_label, text) => {
    expect(normalizeAutoActivateProbe(text)).toBeNull();
  });

  it('lets path- and URL-shaped tokens through (a dot or colon INSIDE a token is not a sentence)', () => {
    for (const text of [
      'lib/cognitive/router.js 분석해줘',
      'https://example.com/a.b 분석해줘',
      String.raw`C:\Users\me\proj\a.js 분석해줘`,
      '@src/a.ts 분석해줘',
    ]) {
      expect(normalizeAutoActivateProbe(text), text).not.toBeNull();
    }
  });

  it('the length cap is exactly AUTO_ACTIVATE_MAX_PROMPT_CHARS, and a 200-char request still fires', async () => {
    expect(AUTO_ACTIVATE_MAX_PROMPT_CHARS).toBe(200);
    const request = ' 설명해줘';
    const atCap = `${'x'.repeat(AUTO_ACTIVATE_MAX_PROMPT_CHARS - request.length)}${request}`;
    expect(atCap).toHaveLength(AUTO_ACTIVATE_MAX_PROMPT_CHARS);
    expect(normalizeAutoActivateProbe(atCap)).toBe(atCap);
    expect(await decide(atCap)).toMatchObject({ activate: true, command: 'explain' });

    const overCap = `x${atCap}`;
    expect(normalizeAutoActivateProbe(overCap)).toBeNull();
    expect(await decide(overCap)).toMatchObject({ activate: false, reason: 'no-trigger' });
  });

  it('padding does not count: the cap applies to the trimmed prompt', () => {
    const padded = `${' '.repeat(50)}이 코드 설명해줘${' '.repeat(50)}`;
    expect(normalizeAutoActivateProbe(padded)).toBe('이 코드 설명해줘');
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

  it('two rows of the SAME command agree and count once', () => {
    // Both blindspot rows MENTION this prompt: one command, so it is not ambiguous
    // (it fires nothing only because it is two questions, not one request).
    expect(matchAutoActivateCommand('사각지대 있는지 내가 빠뜨린 거 없는지 봐줘'))
      .toEqual({ command: null, rules: [], ambiguous: false });

    // When both rows DO fire, the command is returned once, with both row ids.
    const table = [
      { id: 'x-one', command: 'blindspot', all: [/anything/], shape: /anything$/ },
      { id: 'x-two', command: 'blindspot', all: [/thing/], shape: /thing$/ },
    ];
    expect(matchAutoActivateCommand('anything', table))
      .toEqual({ command: 'blindspot', rules: ['x-one', 'x-two'], ambiguous: false });
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
  // it is the gate — not a missing trigger — that withholds it. HG-12 (a path to
  // `settings.json` at the END of the probe, `…settings.json$`) is not in this
  // table: a trigger must now be the LAST thing in the prompt, so the two can no
  // longer meet in one prompt. It is pinned at the screen below instead.
  it.each([
    [`gh pr create 하고 ${TRIGGER}`, 'HG-06'],
    [`git push origin main 하고 ${TRIGGER}`, 'HG-07'],
    [`gh release create v1 하고 ${TRIGGER}`, 'HG-08'],
    [`prisma migrate deploy 하고 ${TRIGGER}`, 'HG-09'],
    [`cat .env 파일 열고 ${TRIGGER}`, 'HG-11'],
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
    // HG-12 needs the path last, which a trigger prompt can no longer be.
    expect(await screenGateHits('코드 분석해줘 .claude/settings.json')).toContain('HG-12');
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
      for (const re of [...row.all, row.shape]) {
        scanned += 1;
        expect(findUnboundedQuantifiers(re.source), `${row.id}: ${re.source}`).toEqual([]);
      }
    }
    // Denominator: a table that scanned nothing would pass every assertion above.
    // Every row carries at least one mention regex and exactly one shape.
    expect(scanned).toBeGreaterThanOrEqual(2 * AUTO_ACTIVATE_TRIGGER_RULES.length);
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
    // Near-misses: every start position matches most of a shape before it fails.
    ['near-miss analyze', '코드 분석해 '.repeat(20000)],
    ['near-miss explain', '설명 좀 해 '.repeat(20000)],
    ['near-miss blindspot', '사각지대 있는지 '.repeat(10000)],
    ['near-miss scope', '이번 작업 '.repeat(24000)],
    ['near-miss missed', '내가 놓친 거 '.repeat(10000)],
    ['near-miss english', 'analyze the a '.repeat(8000)],
  ])('terminates on a 120KB %s run', (_label, shape) => {
    // Termination, not wall-clock: a quadratic rule would run for seconds and hit
    // the test timeout; no timing assertion so a loaded machine cannot flake it.
    expect(matchAutoActivateCommand(shape)).toEqual({ command: null, rules: [], ambiguous: false });
    // The matcher refuses a prompt this long before any row regex runs. Run the
    // regexes directly as well: the length cap is one guard and the bounded
    // quantifiers are the other, and neither should be the only thing standing.
    for (const row of AUTO_ACTIVATE_TRIGGER_RULES) {
      for (const re of [...row.all, row.shape]) re.test(shape);
    }
  });

  it('a 120KB prompt is refused before any regex runs, whether the trigger leads or ends it', async () => {
    for (const text of [`코드 분석해줘 ${'a '.repeat(60000)}`, `${'a '.repeat(60000)}코드 분석해줘`]) {
      expect(normalizeAutoActivateProbe(text)).toBeNull();
      expect(await decide(text)).toMatchObject({ activate: false, command: null, reason: 'no-trigger' });
    }
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
