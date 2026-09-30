/**
 * CA-01 follow-up F1 — the START anchor of the Korean `analyze` / `explain` shapes.
 *
 * `auto-activate.test.js` pins the trigger table and its END anchor. This file
 * pins the property that file could not: nothing may PRECEDE the request. The
 * Korean shapes of `analyze-code` and `explain-ko` used to be anchored at the end
 * only, so a leading action clause ("커밋하고 이 함수 분석해줘") fired. They are now
 * a CLOSED grammar at the start as well: openers, nouns from a fixed vocabulary,
 * one ASCII word, one path and one adnominal clause may precede the request —
 * nothing else, so there is no list of forbidden leading verbs to fall behind.
 *
 * WHAT THIS SUITE CANNOT SEE (rules §9, stated beside the gate):
 *  - Live precision and recall. Every prompt below is one this file chose, and
 *    the property test draws random Hangul stems, which are not real Korean verbs.
 *  - The prefix the grammar still lets through: what the ASCII slot admits — one
 *    bare English word ("push 코드 분석해줘"), a hyphenated or slash-joined word
 *    ("rm-rf", "reset/rebase"), or a word plus a path ("rm /tmp") in front of the
 *    request. None carries a Korean connective and none can be told from a term
 *    such as "JWT". They are listed in the module header and deliberately NOT
 *    pinned here: a test that asserts a known false positive reads as endorsing it.
 *  - The subset property (nothing fires now that did not fire before) is shown on
 *    a generated corpus, not proved: the generator below is aimed at the object
 *    grammar and will miss a form nobody thought to put in its pools. The shapes
 *    themselves are built so that the property holds by construction (the object
 *    part IS the mention regex's alternatives); the corpus is the check.
 *  - The router's own ambiguity gate and the gate screen: other suites.
 */

import { describe, expect, it } from 'vitest';
import {
  AUTO_ACTIVATE_START_VOCABULARY,
  AUTO_ACTIVATE_TRIGGER_RULES,
  decideAutoActivation,
  matchAutoActivateCommand,
} from '../../lib/cognitive/auto-activate.js';

const ON = Object.freeze({ automation: { autoActivate: { commands: true } } });
const OK_INTENT = Object.freeze({ ambiguous: false });

function decide(text, extra = {}) {
  return decideAutoActivation({ text, config: ON, intent: OK_INTENT, ...extra });
}

/**
 * Reverse-order compounds — `[text, command, control]`: a leading ACTION clause,
 * then an analyze / explain request that fires on its own (`control`). The first
 * four are the prompts a review measured FIRING on the real hook on 2026-09-30.
 * The rest are the other connective shapes of the same request (-하고 / -한 다음 /
 * -한 뒤 / -해서 / -하면서 / -하기 전에 …), a leading clause with no deictic or no
 * object at all, and the prompts `runtime-prompt-auto-activate.test.js` used as
 * "the trigger still matches" cases. All of them must be withheld by the shape.
 */
const REVERSE_ORDER = Object.freeze([
  ['커밋하고 이 함수 분석해줘', 'analyze', '이 함수 분석해줘'],
  ['푸시하고 이 코드 분석해줘', 'analyze', '이 코드 분석해줘'],
  ['파일 삭제하고 이 코드 설명해줘', 'explain', '이 코드 설명해줘'],
  ['리팩토링하고 이 코드 설명해줘', 'explain', '이 코드 설명해줘'],
  ['푸시한 다음 이 코드 분석해줘', 'analyze', '이 코드 분석해줘'],
  ['커밋한 뒤 이 함수 분석해줘', 'analyze', '이 함수 분석해줘'],
  ['삭제한 후 이 코드 설명해줘', 'explain', '이 코드 설명해줘'],
  ['커밋해서 이 함수 분석해줘', 'analyze', '이 함수 분석해줘'],
  ['커밋하면서 이 코드 설명해줘', 'explain', '이 코드 설명해줘'],
  ['커밋 먼저 하고 이 코드 분석해줘', 'analyze', '이 코드 분석해줘'],
  ['먼저 커밋하고 이 함수 분석해줘', 'analyze', '이 함수 분석해줘'],
  ['일단 커밋하고 이 코드 설명해줘', 'explain', '이 코드 설명해줘'],
  ['그럼 푸시하고 이 코드 분석해줘', 'analyze', '이 코드 분석해줘'],
  ['커밋하고 코드 분석해줘', 'analyze', '코드 분석해줘'],
  ['머지한 다음 코드 분석해줘', 'analyze', '코드 분석해줘'],
  ['푸시하고 설명해줘', 'explain', '설명해줘'],
  ['수정하고 이 코드 분석해줘', 'analyze', '이 코드 분석해줘'],
  ['수정 후 이 코드 분석해줘', 'analyze', '이 코드 분석해줘'],
  ['삭제 후 이 코드 설명해줘', 'explain', '이 코드 설명해줘'],
  ['푸시 이후에 코드 분석해줘', 'analyze', '코드 분석해줘'],
  ['커밋을 하고 이 함수 분석해줘', 'analyze', '이 함수 분석해줘'],
  ['커밋하고나서 이 코드 분석해줘', 'analyze', '이 코드 분석해줘'],
  ['커밋하는 김에 이 함수 분석해줘', 'analyze', '이 함수 분석해줘'],
  ['커밋하기 전에 이 함수 분석해줘', 'analyze', '이 함수 분석해줘'],
  ['푸시하자마자 이 코드 설명해줘', 'explain', '이 코드 설명해줘'],
  ['삭제한 채로 이 코드 설명해줘', 'explain', '이 코드 설명해줘'],
  ['지우고 이 코드 설명해줘', 'explain', '이 코드 설명해줘'],
  ['만들고 이 함수 설명해줘', 'explain', '이 함수 설명해줘'],
  ['배포하고 이 코드 설명해줘', 'explain', '이 코드 설명해줘'],
  ['테스트하고 이 함수 설명해줘', 'explain', '이 함수 설명해줘'],
  ['빌드하고 이 모듈 분석해줘', 'analyze', '이 모듈 분석해줘'],
  ['commit하고 이 함수 분석해줘', 'analyze', '이 함수 분석해줘'],
  ['git commit 하고 이 함수 분석해줘', 'analyze', '이 함수 분석해줘'],
  ['git push origin main 하고 src/lib 코드 분석해줘', 'analyze', 'src/lib 코드 분석해줘'],
  ['rm -rf / 하고 이 코드 설명해줘', 'explain', '이 코드 설명해줘'],
  ['npm publish 하고 이 코드 설명해줘', 'explain', '이 코드 설명해줘'],
  // An English clause in front (no Korean connective at all): the ASCII slot holds one
  // bare term and one path, never two words, so a command cannot stand in it.
  ['git push 코드 분석해줘', 'analyze', '코드 분석해줘'],
  ['git commit 이 코드 분석해줘', 'analyze', '이 코드 분석해줘'],
  ['git push origin main 코드 분석해줘', 'analyze', '코드 분석해줘'],
  ['commit then 이 함수 분석해줘', 'analyze', '이 함수 분석해줘'],
  ['npm test 이 코드 설명해줘', 'explain', '이 코드 설명해줘'],
  ['git pull 이 코드 설명해줘', 'explain', '이 코드 설명해줘'],
]);

/** Deterministic PRNG (mulberry32): the property test below must never be flaky. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random Hangul token of 2–4 syllables (the whole precomposed block, 가-힣). */
function randomHangulStem(rand) {
  const n = 2 + Math.floor(rand() * 3);
  let out = '';
  for (let i = 0; i < n; i += 1) out += String.fromCharCode(0xAC00 + Math.floor(rand() * 11172));
  return out;
}

/**
 * Split a regex SOURCE at its top-level `|` (outside any group and any class,
 * honouring escapes). Used to check every alternative of a shape, not only the
 * last one — the compiled regex alone cannot say which alternative is unanchored.
 * @param {string} source
 * @returns {string[]}
 */
function topLevelAlternatives(source) {
  const parts = [];
  let depth = 0;
  let inClass = false;
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') { i += 1; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === '|' && depth === 0) { parts.push(source.slice(start, i)); start = i + 1; }
  }
  parts.push(source.slice(start));
  return parts;
}

describe('START anchor — a leading action clause cannot precede the trigger', () => {
  it.each(REVERSE_ORDER)('withheld: %s', async (text, command, control) => {
    // It still MENTIONS the command (a mention-only table would have fired), so the
    // pin is on the START anchor and not on a trigger that never matched.
    const mentioned = AUTO_ACTIVATE_TRIGGER_RULES
      .some((row) => row.command === command && row.all.every((re) => re.test(text)));
    expect(mentioned, 'the prompt no longer mentions the command: the pin would be vacuous').toBe(true);
    expect(await decide(text)).toMatchObject({ activate: false, command: null, reason: 'no-trigger' });
    // Control: the same request without the leading clause fires, so this is the START
    // anchor and not a dead trigger.
    expect(await decide(control)).toMatchObject({ activate: true, command, reason: 'allowlist-match' });
  });

  it.each([
    // The third-party `explain` the module header used to list as open: a Korean noun
    // slot before the verb is not in the closed vocabulary, so nothing addressed to a
    // person fits (nor does "나한테" — recall given up with it).
    '고객한테 이 정책 설명해줘',
    '팀원한테 이 코드 설명해줘',
    '이 코드 고객에게 설명해줘',
  ])('an explain aimed at a third party is withheld: %s', async (text) => {
    expect(matchAutoActivateCommand(text).command).toBeNull();
    expect(await decide(text)).toMatchObject({ activate: false, command: null, reason: 'no-trigger' });
  });

  it('an opener can only OPEN the request: it cannot follow a noun', async () => {
    // "커밋 이 코드 …" is two clauses with no connective between them.
    for (const [text, command] of [['이 커밋 설명해줘', 'explain'], ['이 테스트 함수 분석해줘', 'analyze']]) {
      expect(await decide(text), text).toMatchObject({ activate: true, command });
    }
    for (const text of ['커밋 이 코드 설명해줘', '테스트 이 함수 분석해줘', '배포 일단 이 코드 설명해줘']) {
      expect(await decide(text), text).toMatchObject({ activate: false, command: null, reason: 'no-trigger' });
    }
  });

  it('the ASCII slot holds one word and one path, in either order — never two words', async () => {
    for (const [text, command] of [
      ['JWT 설명해줘', 'explain'],
      ['Node.js 이벤트 루프 설명해줘', 'explain'],
      ['SECRET-MARKER-XYZ src/lib 코드 분석해줘', 'analyze'],
      ['src/lib auth 코드 분석해줘', 'analyze'],
      ['https://youtu.be/dQw4w9WgXcQ 이 코드 설명해줘', 'explain'],
    ]) {
      expect(await decide(text), text).toMatchObject({ activate: true, command });
    }
    // A second word does not fit. For the English COMMANDS this is the point; the two-word
    // TERMS in this list ("event loop") are recall given up with them, because no grammar
    // can tell "git push" from "event loop" (module header, "RECALL GIVEN UP").
    for (const text of ['event loop 설명해줘', 'REST API 설명해줘', 'auth service 코드 분석해줘']) {
      expect(matchAutoActivateCommand(text).command, text).toBeNull();
    }
  });

  it('no free Korean clause fits before the trigger: random stems × connective forms (a closed grammar, not a deny list)', () => {
    const CONNECTIVES = [
      '하고', '해서', '하면서', '하며', '하고나서', '하자마자', '하다가', '하니까',
      '한 다음', '한 뒤', '한 후', '한 이후에', '하기 전에', '하는 김에', '한 채로', '한 뒤에',
    ];
    const TEMPLATES = [
      (lead) => `${lead} 이 함수 분석해줘`,
      (lead) => `${lead} 이 코드 설명해줘`,
      (lead) => `${lead} 코드 분석해줘`,
      (lead) => `${lead} 설명해줘`,
    ];
    const rand = mulberry32(20260930);
    const leaked = [];
    let probes = 0;
    for (let i = 0; i < 250; i += 1) {
      const stem = randomHangulStem(rand);
      for (const connective of CONNECTIVES) {
        for (const template of TEMPLATES) {
          const text = template(`${stem}${connective}`);
          probes += 1;
          if (matchAutoActivateCommand(text).command !== null) leaked.push(text);
        }
      }
    }
    expect(leaked.slice(0, 10)).toEqual([]);
    // Denominator: a loop that probed nothing would pass the line above.
    expect(probes).toBe(250 * CONNECTIVES.length * TEMPLATES.length);
    // Positive control: every template fires with no leading clause at all.
    for (const template of TEMPLATES) {
      const bare = template('').trim();
      expect(matchAutoActivateCommand(bare).command, bare).not.toBeNull();
    }
  });

  it('every alternative of every shape is anchored at BOTH ends', () => {
    // Self-check of the splitter first: a scanner that cannot see a bare alternative proves nothing.
    expect(topLevelAlternatives('a|(b|c)|[d|e]\\|f')).toEqual(['a', '(b|c)', '[d|e]\\|f']);
    expect(topLevelAlternatives('(?:^a$)|(?:^b$)')).toEqual(['(?:^a$)', '(?:^b$)']);
    let scanned = 0;
    for (const row of AUTO_ACTIVATE_TRIGGER_RULES) {
      for (const alternative of topLevelAlternatives(row.shape.source)) {
        scanned += 1;
        expect(alternative, `row ${row.id}: ${alternative.slice(0, 48)}`).toMatch(/^\(\?:\^/);
        expect(alternative, `row ${row.id}: …${alternative.slice(-48)}`).toMatch(/\$\)$/);
      }
    }
    // Denominator: every row carries at least one alternative.
    expect(scanned).toBeGreaterThanOrEqual(AUTO_ACTIVATE_TRIGGER_RULES.length);
  });
});

/**
 * REFERENCE for the subset property below: the Korean shapes of `analyze-code` and
 * `explain-ko` as they were BEFORE the START grammar (commit ac5dfb4d) — unanchored
 * at the start, so ANY prefix was accepted and only object + tail + verb were tested.
 * The object is the mention regex itself (`CODE_OBJECT`, the second `all` entry of
 * `analyze-code`), so this reference says exactly "the object the mention regex
 * accepts, right before the verb". The verb pieces are the frozen old ones: a
 * deliberate change of the verb grammar updates them in the same commit.
 */
const OLD_ASK = '(?:줘요?|주세요|주라|주십시오|주시겠어요|주실래요?|줄래요?|볼래요?|봐요?'
  + '|줄\\s{0,2}수\\s{0,2}있(?:어요?|나요|을까요?))';
const OLD_SOFT = '(?:(?:좀|한번|한\\s{0,2}번)\\s{0,2})?';
const oldDoVerb = (nouns) => `(?:${nouns})\\s{0,2}${OLD_SOFT}해\\s{0,2}${OLD_ASK}`;

/** The trigger table with the two Korean shapes swapped for their pre-START versions. */
function buildOldTable() {
  const analyze = AUTO_ACTIVATE_TRIGGER_RULES.find((row) => row.id === 'analyze-code');
  const oldKorean = `(?:${analyze.all[1].source})(?:들)?(?:\\s{0,2}(?:전체|전부|모두))?(?:의|을|를|도|만)?`
    + `(?:\\s{0,2}(?:성능|보안|품질|구조|아키텍처|의존성))?(?:을|를)?\\s{0,2}${OLD_SOFT}${oldDoVerb('분석')}$`;
  // The English alternative of the row is untouched by the START grammar: reuse it.
  const [, ...english] = topLevelAlternatives(analyze.shape.source);
  return AUTO_ACTIVATE_TRIGGER_RULES.map((row) => {
    if (row.id === 'analyze-code') return { ...row, shape: new RegExp([`(?:${oldKorean})`, ...english].join('|'), 'i') };
    if (row.id === 'explain-ko') return { ...row, shape: new RegExp(`(?:${oldDoVerb('설명')}$)`, 'i') };
    return row;
  });
}

/**
 * Prompts that fire under `table` but are not an old activation: a different
 * command, or a row the old table did not fire. (A prompt that fires under both
 * is fine; one that fires only under the old table is the START grammar working.)
 * @returns {{fires: number, leaks: string[]}}
 */
function findNewFires(texts, table, oldTable) {
  const leaks = [];
  let fires = 0;
  for (const text of texts) {
    const now = matchAutoActivateCommand(text, table);
    if (now.command === null) continue;
    fires += 1;
    const then = matchAutoActivateCommand(text, oldTable);
    if (then.command !== now.command || !now.rules.every((id) => then.rules.includes(id))) leaks.push(text);
  }
  return { fires, leaks };
}

/**
 * One prompt from a generator aimed at the object grammar: openers, vocabulary
 * nouns, ASCII tokens, adnominal / connective stems in front, then an object from
 * a pool that includes the forms a review found widening — an `@path` glued to a
 * noun, an `@path` with no extension, a path whose last component is empty,
 * punctuation or longer than 64 characters — then a tail, then a verb, with the
 * pieces joined by nothing, one space or two.
 */
function adversarialPrompt(rand) {
  const V = AUTO_ACTIVATE_START_VOCABULARY;
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const glue = () => pick(['', ' ', ' ', ' ', '  ']);
  const ASCII = ['git', 'rm', 'JWT', 'auth', 'src/lib', 'https://x.dev/a', 'rm-rf', 'reset/rebase', 'a.js',
    '/tmp', 'src/', '@x', '-rf', '--force', 'C:\\x'];
  const STEM_ENDINGS = ['한', '된', '하는', '하고', '해서', '한 다음', '하기 전에'];
  const OBJECTS = [
    '코드', '함수', '모듈', '클래스', '저장소', '코드베이스', '소스', 'code', 'module',
    '@src/x', '@x', '@a.ts', '@', '@@x', '@x@y', '@../x', '@C:/x', '@src/lib/',
    'a.js', 'src/a.js', 'src/.js', '/.js', '..js', ':.js', '\\.ts', '\\a.ts', 'a/-.js', '--.js', '-.js',
    'a-.js', '.js', 'x..js', 'C:\\x\\a.js', 'dir/sub/.py', 'A.JS', 'name.jsx', 'a.jsxx', 'src/lib/',
    `${'n'.repeat(64)}.js`, `${'n'.repeat(65)}.js`, `${'n'.repeat(96)}.js`, `src/${'n'.repeat(70)}.js`,
  ];
  const TAILS = ['', '', '를', '을', '의', '들', ' 전체', ' 전체를', '의 구조를', ' 구조', '도', '만', '에 대해'];
  const VERBS = [
    '분석해줘', '분석 좀 해줘', '분석해 주세요', '한번 분석해봐',
    '설명해줘', '설명 좀 해줘', '설명해주세요', '자세히 설명해줘',
  ];
  let text = '';
  for (let i = Math.floor(rand() * 5); i > 0; i -= 1) {
    const r = rand();
    let piece;
    if (r < 0.2) piece = pick(V.openers);
    else if (r < 0.5) piece = pick(V.topicNouns);
    else if (r < 0.65) piece = pick(ASCII);
    else if (r < 0.8) piece = `${randomHangulStem(rand)}${pick(STEM_ENDINGS)}`;
    else piece = pick(V.adverbs);
    text += `${piece}${glue()}`;
  }
  const object = rand() < 0.85 ? pick(OBJECTS) : `${pick(V.topicNouns)}${pick(OBJECTS)}`;
  return `${text}${object}${pick(TAILS)}${glue()}${pick(VERBS)}`;
}

describe('START grammar only REMOVES activations — every new fire is an old fire', () => {
  const OLD = buildOldTable();

  it('the reference is faithful where it matters: the reviewed compounds fire under it, the START forms do not', () => {
    // Positive control for the oracle: a reference that fired on nothing (or everything)
    // would make every assertion below vacuous.
    for (const [text, command] of [
      ['커밋하고 이 함수 분석해줘', 'analyze'], ['푸시하고 이 코드 분석해줘', 'analyze'],
      ['파일 삭제하고 이 코드 설명해줘', 'explain'], ['리팩토링하고 이 코드 설명해줘', 'explain'],
      ['이 함수 분석해줘', 'analyze'], ['lib/cognitive/router.js 분석해줘', 'analyze'],
    ]) {
      expect(matchAutoActivateCommand(text, OLD).command, text).toBe(command);
    }
    expect(matchAutoActivateCommand('코드@src/x 분석해줘', OLD).command).toBeNull();
  });

  it('the comparator catches a widening (self-check: an over-wide shape leaks)', () => {
    const wide = AUTO_ACTIVATE_TRIGGER_RULES.map((row) => (
      row.id === 'analyze-code' ? { ...row, shape: /분석해줘$/i } : row));
    const { leaks } = findNewFires(['코드@x 분석해줘', '이 함수 분석해줘'], wide, OLD);
    expect(leaks).toEqual(['코드@x 분석해줘']);
  });

  it.each([
    // The four a review measured ACTIVATING under the first START grammar (2026-09-30),
    // and two of the same family: the object grammar was wider than the mention regex
    // (an `@path` needs no guard, a path may end in `/.js`).
    '코드@src/x 분석해줘',
    '코드 src/.js 분석해줘',
    '삭제한 코드@x분석해 주세요',
    'rm 전체 코드@x를 분석 좀 해줘',
    '코드 \\.ts 분석해줘',
    '코드 --.js 분석해줘',
    // A last component of 65 characters (the mention regex stops at 64); "코드" is there
    // only so the prompt MENTIONS analyze — without it no shape could fire at all.
    `코드 ${'n'.repeat(65)}.js 분석해줘`,
    `코드 src/${'n'.repeat(70)}.js 분석해줘`,
  ])('an object the mention regex does not accept does not activate: %s', (text) => {
    expect(matchAutoActivateCommand(text, OLD).command, 'the old table never fired on it').toBeNull();
    expect(matchAutoActivateCommand(text).command).toBeNull();
  });

  it.each([
    '이 @src/app.ts 분석해줘',
    '@src/app.ts 분석해줘',
    'lib/cognitive/router.js 분석해줘',
    String.raw`C:\Users\me\proj\a.js 분석해줘`,
    'src/lib/a-b.ts 분석해줘',
    `${'n'.repeat(64)}.js 분석해줘`,
  ])('a well-formed @path or file-path object still fires: %s', (text) => {
    expect(matchAutoActivateCommand(text).command).toBe('analyze');
    expect(matchAutoActivateCommand(text, OLD).command).toBe('analyze');
  });

  it('30,000 generated prompts: nothing fires now that did not fire before (objects, glue and odd path characters included)', () => {
    const rand = mulberry32(20260930);
    const texts = Array.from({ length: 30000 }, () => adversarialPrompt(rand));
    const { fires, leaks } = findNewFires(texts, AUTO_ACTIVATE_TRIGGER_RULES, OLD);
    expect(leaks.slice(0, 10)).toEqual([]);
    // Denominators: a generator that never reached the firing region, or never built
    // the widening forms, would pass the line above.
    const gluedAt = texts.filter((t) => /[^\s]@/.test(t)).length;
    const oddPath = texts.filter((t) => /(?:^|[^\w-])\.(?:js|ts|py)|(?:^|\W)-+\.(?:js|ts)|\w{65,}\.js/.test(t)).length;
    expect(fires).toBeGreaterThan(1000);
    expect(gluedAt).toBeGreaterThan(1000);
    expect(oddPath).toBeGreaterThan(1000);
  });
});

describe('START vocabulary — closed lists, and the lists the shapes really use', () => {
  const V = AUTO_ACTIVATE_START_VOCABULARY;

  it('is frozen, and every list is a non-empty, duplicate-free array of plain words', () => {
    expect(Object.isFrozen(V)).toBe(true);
    expect(Object.keys(V).sort()).toEqual(['adnominalEndings', 'adverbs', 'openers', 'topicNouns']);
    for (const [name, words] of Object.entries(V)) {
      expect(Object.isFrozen(words), name).toBe(true);
      expect(words.length, name).toBeGreaterThan(0);
      expect(new Set(words).size, `${name} has a duplicate`).toBe(words.length);
      for (const word of words) {
        // A space or a regex metacharacter would change what the alternation means.
        expect(word, `${name}: ${word}`).toMatch(/^[\p{L}\p{N}]{1,12}$/u);
      }
    }
  });

  it('holds no bound noun and no connective form: those are how a clause slot reopens', () => {
    const BOUND = ['다음', '뒤', '후', '이후', '이전', '전', '직후', '전후', '김', '때', '채', '동안', '사이', '나서'];
    const CONNECTIVE_ENDING = /(?:하고|해서|하며|하면|하면서|하다가|하니까|하자마자)$/;
    for (const [name, words] of Object.entries(V)) {
      for (const word of words) {
        expect(BOUND, `${name}: ${word}`).not.toContain(word);
        expect(word, `${name}: ${word}`).not.toMatch(CONNECTIVE_ENDING);
      }
    }
  });

  it('every listed word really is accepted: the export is the list the shapes use', () => {
    for (const noun of V.topicNouns) {
      expect(matchAutoActivateCommand(`${noun} 설명해줘`).command, noun).toBe('explain');
    }
    for (const opener of V.openers) {
      expect(matchAutoActivateCommand(`${opener} 코드 설명해줘`).command, opener).toBe('explain');
    }
    for (const adverb of V.adverbs) {
      expect(matchAutoActivateCommand(`이 코드 ${adverb} 설명해줘`).command, adverb).toBe('explain');
    }
    for (const ending of V.adnominalEndings) {
      expect(matchAutoActivateCommand(`방금 작성${ending} 코드 설명해줘`).command, ending).toBe('explain');
    }
  });
});
