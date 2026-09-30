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
 *  - The prefix the grammar still lets through: ONE English word (plus a path) in
 *    front of the request ("push 코드 분석해줘" — a bare word carries no Korean
 *    connective and cannot be told from a one-word term such as "JWT"). It is
 *    listed in the module header and deliberately NOT pinned here: a test that
 *    asserts a known false positive reads as endorsing it.
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
