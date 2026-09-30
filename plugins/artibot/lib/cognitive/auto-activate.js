/**
 * CA-01 — Canary auto-activation of LOW-RISK commands (decision half, L4).
 *
 * WHAT IT DECIDES. For one prompt: should the UserPromptSubmit hook tell the
 * model "run /<command> now, without asking"? Nothing else. It executes no
 * command, spawns nothing and writes nothing; the caller renders the answer.
 *
 * WHAT "AUTO-ACTIVATE" ACTUALLY IS. A hook cannot run a slash command — its
 * only lever is the text the model reads. So this changes ONE instruction: from
 * the confirm-first shape of `[artibot:hint recommend=X]` (`CLAUDE.md`
 * "Recommend-hint surfacing rule": surface a sentence, wait for confirmation) to
 * `[artibot:auto-activate command=X]` (run it, say so in one sentence). Whether
 * the model follows that line is UNMEASURED — nothing in this repo observes the
 * model's reaction, and the record this feature writes says a directive was
 * SHOWN, not that a command RAN.
 *
 * WHAT LIMITS THE BLAST RADIUS — an argument from the code's structure, not a
 * measurement, and where it stops. It is not the gate screen below: the screen
 * is a text match on natural language. The directive only removes a QUESTION
 * ("may I run this command?"). The plugin's PreToolUse hooks (`hooks/hooks.json`)
 * still run, but only where they are registered: Write|Edit, Bash, Agent (observe
 * only) and WebFetch (cache) — not for Read, Glob, Grep or TaskCreate, which the
 * commands also use. The human-gate matrix (`lib/security/human-gates.js`) only
 * classifies and records, so it is not a second fence either
 * (`tests/firewall/auto-activate-contract.test.js` pins both facts). The host's
 * own permission prompt is a different matter: a command's frontmatter
 * `allowed-tools` can pre-approve the tools it
 * lists, and all four activatable commands list Bash (`commands/<name>.md`) —
 * whether that waives the prompt for a run the model starts from this directive
 * is UNVERIFIED here. So a wrong activation may run those tools without a
 * prompt, and TRIGGER PRECISION is the safety line: an over-eager trigger is
 * not the safe direction, it is the one that removes a confirmation. That is
 * why the table below fires only for a short, single-sentence request that
 * both STARTS and ENDS inside a closed grammar (the START grammar, below; the
 * FINAL predicate is the trigger). The allowlist keeps the removed question
 * cheap: by their own command docs each activatable command is a
 * read-and-report flow (`allowed-tools` has no Write/Edit), and `/scorecard`'s
 * default path also appends a snapshot to `.artibot/scorecard.json`.
 * "Read-only" is documented intent, not enforcement: their `allowed-tools` do
 * include Bash, and `/analyze` and `/explain` may spawn Agents.
 *
 * DESIGN SOURCE (v5 design, ARTIBOT-5.0-DESIGN.md; quoted fragments, line numbers
 * as of 2026-09-30):
 *  - :257 Canary row — "저위험 커맨드 자동 활성(allowlist A2)", behaviour change
 *    "있음, config 1키로 되돌림".
 *  - :272 A2 — proposal "제안 `/analyze /explain /blindspot /scorecard /why` +
 *    autopilot 무확인 진입 조건"; recommendation "위 5종 + autopilot 은 게이트 히트
 *    0 ∧ allowlist".
 *  - :273 A3 — "Shadow 원장 1릴리스 후". WAIVED for this feature by the owner's
 *    2026-09-30 instruction (relayed by the leader; not verified against the
 *    owner's own message) — the Shadow-ledger precondition is NOT met and this
 *    file does not pretend otherwise.
 *  - :202 — Canary keeps `autoFire: ['solo','team']`; "autopilot 은 게이트 히트 0
 *    + allowlist 일 때만". The autopilot half of that rule is NOT implemented:
 *    `docs/ORCHESTRATION-ROUTING.md` "Harness Constraint" says orchestrate and
 *    autopilot must never auto-fire, and CA-06 (owner decision) is what would
 *    relax it. Only the CONDITION shape (gate hits 0 ∧ allowlist) is reused.
 *  - :564 — "게이트 판정 정본 = 훅 계층 `human-gates.js#classify`; 라우터 hit 는
 *    advisory, 결정에 사용 금지". Hence this module screens with `classify` and
 *    NOT with `topology-router.js#humanGateHits` (which the live hook never
 *    feeds a matrix or planned actions, so it is always `[]` /
 *    `human-gates:unavailable` — a vacuous "0").
 *  - :230 — "`/why` `/cost` `/status`(D17, 전부 미존재)"; :275 and :519 — A5
 *    settled on extending `/doctor` and `/scorecard` instead of creating them.
 *
 * THE ALLOWLIST HAS FIVE NAMES AND FOUR SURFACES. `why` is in the list because
 * the design names it; it has no command file and no trigger, so it can never
 * fire. `tests/firewall/auto-activate-contract.test.js` fails the day a
 * `commands/why.md` appears, so that day is a decision, not an accident.
 *
 * WHAT "GATE HIT" MEANS HERE. A hit is any of:
 *  1. `human-gates.js#classify({command: <prompt>})` returns a row whose
 *     `default` is `policy` or `human` (HG-06 … HG-13). The `auto` rows
 *     (HG-01 … HG-05) are classification rows, not gates — counting them would
 *     make "run the tests and analyze the result" a gate hit.
 *  2. `autopilot/safety.js#classifyRisk(<prompt>)` is not `safe` (destructive
 *     fs/git/SQL, secrets, curl/wget to a host, publish — `caution` counts).
 * Both catalogs were written for tool-call payloads. Run over prose they
 * over-match (measured 2026-09-30: a prompt whose last token is a path such as
 * `.claude/settings.json` trips HG-12) — and that error is the SAFE direction:
 * a hit only withholds the convenience, it never blocks and never grants
 * anything.
 *
 * WHAT THIS CANNOT SEE (stated beside the code so the tests cannot become the
 * next false assurance):
 *  - Precision of the trigger table on real prompts. It was written from each
 *    command's own frontmatter (trigger list or example hint) and pinned on
 *    synthetic prompts, among them the false positives a 2026-09-30 review
 *    measured on the real hook (the noun "설명 좀", a quoted phrase, "분석하고
 *    커밋해줘", "메일 놓친 거 있어?", a pasted code fence) and the reverse-order
 *    compounds the same review measured firing ("커밋하고 이 함수 분석해줘",
 *    "푸시하고 이 코드 분석해줘", "파일 삭제하고 이 코드 설명해줘", "리팩토링하고
 *    이 코드 설명해줘"); live false-positive and false-negative rates are
 *    unmeasured.
 *  - What the START grammar gives up, and what it leaves open. The Korean
 *    `analyze` and `explain` shapes used to be anchored at the END only, and the
 *    topic before the object was open vocabulary, so a leading clause fired. The
 *    Korean connectives ("-하고", "-한 다음", "-해서") bind to open-class verb
 *    stems, which is why no list of forbidden leading verbs could ever be
 *    complete. The shapes are now a CLOSED grammar at the START as well — `^`,
 *    then only: opener words (이, 그, 해당, 현재 … — first in the prompt, never
 *    after a noun) · ONE ASCII word and ONE path or URL, either order (a term,
 *    not a command) · at most one adnominal clause (a free stem plus 한 / 된 /
 *    하는 …, which can only modify the noun behind it) · nouns from
 *    `AUTO_ACTIVATE_START_VOCABULARY` · the object · the verb · `$`. A clause
 *    that ends in a connective ("커밋하고", "푸시한 다음", "삭제 후") has no slot
 *    to sit in, nor has an English command ("git push", "npm test": two words),
 *    and no third party can be addressed ("고객한테"). A word added to the
 *    vocabulary widens only what a request may be ABOUT; a bound noun or a
 *    connective ("다음", "뒤", "-하고") would put the hole back, and
 *    `tests/cognitive/auto-activate-start-anchor.test.js` fails on it.
 *    RECALL GIVEN UP, by choice and not by measurement: a Korean noun outside
 *    the vocabulary ("제품 설명 좀 해줘", "회의록 설명해주세요" — an open noun
 *    slot cannot be told from a leading "X하고"), a two-word English term
 *    ("event loop 설명해줘", "REST API 설명해줘" — no grammar tells it from
 *    "git push"), a relative clause with an object of its own ("이 함수를
 *    호출하는 코드"), free verbs and adverbs in an explain ("이 코드가 뭘
 *    하는지 설명해줘", "… 이해할 수 있게").
 *    STILL OPEN: ONE English word in front of the request ("push 코드 분석해줘",
 *    "commit 이 함수 분석해줘", "push origin/main 코드 분석해줘"): a bare word
 *    carries no Korean connective and is indistinguishable from a one-word term
 *    ("JWT 설명해줘"). What stands there is the router's ambiguity gate
 *    (`detectIntent`), which withholds the fix / implement / deploy / publish
 *    words and does not know commit / push, and the gate screen, which catches
 *    only gated commands. Measured 2026-09-30 with the real router and screen
 *    on a two-word slot: "npm publish 코드 분석해줘" was withheld by the router,
 *    while "git push 코드 분석해줘" and "git commit 이 코드 분석해줘" passed both
 *    — which is why the slot holds one word. Also open: two clauses typed with
 *    NO space between them ("푸시하고수정한 코드") read as one adnominal stem.
 *    `blindspot` and `scorecard` never had the hole: only `SCOPE` words may
 *    precede their term, and every English shape starts with `^`.
 *  - Natural-language risk with no command in it ("delete production and then
 *    analyze the code") passes the screen. The command that would do harm is
 *    not the allowlisted one, and it stays behind the PreToolUse hooks of the
 *    tools they cover (see above).
 *  - Whether the model complies, and whether the user found it helpful.
 *
 * PURE apart from two lazy `import()`s of the gate catalogs, taken only after a
 * trigger has matched (a cold import of both costs ~20 ms, measured 2026-09-30,
 * and most prompts match nothing). No fs, no clock, no randomness.
 *
 * @module lib/cognitive/auto-activate
 */

/**
 * Dot path of the ONE kill switch. Shipped `true` (the 2026-09-30 owner
 * instruction, as relayed in the CA-01 lane brief); the reader is strict
 * `=== true`, so a missing key, a string `"true"` or an unparsable config all
 * read as OFF — the byte-identical path.
 */
export const AUTO_ACTIVATE_CONFIG_PATH = 'automation.autoActivate.commands';

/**
 * The design's A2 list, in the design's order (ARTIBOT-5.0-DESIGN.md:272).
 * A closed ALLOWLIST: nothing outside it can be activated, and adding a name is
 * an owner-visible decision — `tests/firewall/auto-activate-contract.test.js`
 * pins this exact array.
 * @type {readonly string[]}
 */
export const AUTO_ACTIVATE_ALLOWLIST = Object.freeze([
  'analyze', 'explain', 'blindspot', 'scorecard', 'why',
]);

/**
 * A code/system object — what makes `/analyze` fit. The command describes
 * itself as "Multi-dimensional code and system analysis" (`commands/analyze.md`
 * description), so a bare "분석해줘" ("analyze this data / market / sentiment")
 * is NOT enough: the verb rule below must be joined by one of these.
 * `리포`/`레포` refuse a following `트` so "리포트" (report) is not "repo".
 * `코드베이스` is listed before `코드` so the analyze shape can end an object
 * right against the verb ("코드베이스 분석해줘"). This regex is a MENTION test
 * (any position); the shape that decides whether it is the request's object is
 * built from its `source` below.
 * Every quantifier is bounded: an open `+`/`*` before a literal is quadratic on
 * a long single run, and the prompt is user-sized.
 *
 * The noun and file-extension pieces are named because the START grammar below
 * builds its object from the same words: one list, two uses.
 */
const KO_CODE_NOUN = '코드베이스|코드|소스|모듈|함수|클래스|저장소|아키텍처|의존성|취약점'
  + '|리포지토리|레포지토리|리포(?!트)|레포(?!트)';
const EN_CODE_WORD = '\\bcode(?:base)?\\b|\\bsource\\b|\\bmodules?\\b|\\bfunctions?\\b|\\bclass(?:es)?\\b'
  + '|\\brepo(?:sitory)?\\b|\\barchitecture\\b|\\bdependenc(?:y|ies)\\b|\\bvulnerabilit(?:y|ies)\\b';
const SOURCE_EXT = 'js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|rb|sh';
const CODE_OBJECT = new RegExp([
  KO_CODE_NOUN,
  EN_CODE_WORD,
  '(?:^|\\s)@[\\w./-]{1,128}',
  `\\b[\\w-]{1,64}\\.(?:${SOURCE_EXT})\\b`,
].join('|'), 'i');

/**
 * Longest prompt — trimmed, without its closing punctuation — that can activate
 * anything. A pasted document, a log or a code block is not one short request,
 * and a trigger word inside it is not the user's ask. The `{1,200}` in
 * `PLAIN_PROMPT` mirrors it; a test pins both at the boundary.
 */
export const AUTO_ACTIVATE_MAX_PROMPT_CHARS = 200;

/**
 * What the body of an eligible prompt may contain, as an ALLOWLIST of
 * characters: letters, digits, a plain space, the path characters `_ / @ \ -`,
 * and a `.` or `:` INSIDE a token (`router.js`, `https://x.dev`). Anything else
 * makes the prompt ineligible: a newline, a quote or backtick (so a quoted
 * phrase, a code span and a fence are all out — the simple, fail-closed choice
 * over stripping them), a bracket, `, ; ! ?`, a dot before a space (a sentence
 * boundary). Text that quotes, pastes or chains sentences never reaches the
 * trigger table. The bound is AUTO_ACTIVATE_MAX_PROMPT_CHARS.
 */
const PLAIN_PROMPT = /^(?:[\p{L}\p{N} _/@\\-]|[.:](?=[\p{L}\p{N}_/@\\-])){1,200}$/u;

/** The closing punctuation a request may carry; dropped before the body check. */
const TRAILING_PUNCT = /[ .!?~…]{1,8}$/u;

/**
 * The prompt the trigger rows are tested against, or null when this prompt may
 * not activate anything: not a string, longer than
 * {@link AUTO_ACTIVATE_MAX_PROMPT_CHARS} once trimmed, or not one plain
 * sentence (`PLAIN_PROMPT`). Fail-closed by construction: the result is
 * non-null only after every check passed. The length test comes first, so a
 * 120 KB paste costs one comparison and never reaches a regex.
 *
 * @param {unknown} text the prompt
 * @returns {string|null} the trimmed prompt without its closing punctuation
 */
export function normalizeAutoActivateProbe(text) {
  if (typeof text !== 'string' || text.length > 4 * AUTO_ACTIVATE_MAX_PROMPT_CHARS) return null;
  const core = text.trim().replace(TRAILING_PUNCT, '');
  return PLAIN_PROMPT.test(core) ? core : null;
}

// ---------------------------------------------------------------------------
// Shape building blocks. Every string below is regex SOURCE and every quantifier
// in it is bounded (the unit tests scan the table for an open one).
// ---------------------------------------------------------------------------

/**
 * How a Korean request may CLOSE — an ALLOWLIST of endings: a clause that ends
 * in anything else ("다듬어줘", "추가해서") is not a trigger.
 */
const ASK = '(?:줘요?|주세요|주라|주십시오|주시겠어요|주실래요?|줄래요?|볼래요?|봐요?'
  + '|줄\\s{0,2}수\\s{0,2}있(?:어요?|나요|을까요?))';
/** An optional softener between a noun and its verb: "설명 좀 해줘". */
const SOFT = '(?:(?:좀|한번|한\\s{0,2}번)\\s{0,2})?';
/** The light verb plus a closing: "해줘", "해 주세요". */
const DO = `해\\s{0,2}${ASK}`;
/** `<noun>해줘` / `<noun> 좀 해줘` for one of `nouns`. */
const doVerb = (nouns) => `(?:${nouns})\\s{0,2}${SOFT}${DO}`;
/** `<stem>줘` — a native verb stem plus a closing (보여줘, 찾아줘, 봐줘). */
const giveVerb = (stems) => `(?:${stems})\\s{0,2}${ASK}`;
/** The verbs a "check this" request ends in: 점검해줘, 확인 좀 해줘, 봐줘, 찾아줘. */
const CHECK_KO = `(?:${doVerb('점검|확인|체크|검토')}|${giveVerb('봐|살펴봐|살펴|찾아봐|찾아')})`;
/**
 * What may PRECEDE a `blindspot` / `scorecard` term: only these openers and
 * scope words, each with an optional particle — an ALLOWLIST, so a noun that
 * names no work ("메일 놓친 거 있어?") cannot pass. The "가" particle lets
 * 내/제/우리 be the speaker ("내가 빠뜨린 거").
 *
 * Split by what the words ARE: OPENERS are function words (deictic, possessive,
 * temporal, quantifier, discourse) and can open any request; NOUNS name a kind of
 * work and only make sense in front of a term about that work. `SCOPE_WORDS` is
 * their concatenation in the original order, so the `SCOPE` regex below — and with
 * it every `blindspot` / `scorecard` row — is unchanged; the START grammar of the
 * `analyze` / `explain` shapes reuses the openers only.
 */
const SCOPE_OPENERS = [
  '이', '그', '저', '해당', '현재', '우리', '내', '제', '이번', '최근', '방금', '지금까지', '그동안',
  '전체', '모든', '혹시나', '혹시', '일단', '우선', '먼저', '지금', '자', '그럼', '뭔가', '뭐', '더',
  '또', '아직',
];
const SCOPE_NOUNS = [
  '작업', '변경', '구현', '코드', '모듈', '기능', '프로젝트', '세션', '커밋',
  '요구사항', '설계', '계획', '테스트', '리뷰', '파일', '시스템', '서비스', 'PR',
];
const SCOPE_WORDS = [...SCOPE_OPENERS, ...SCOPE_NOUNS];
const SCOPE = `(?:(?:${SCOPE_WORDS.join('|')})(?:들|의|에서|에|중|중에|가)?\\s{1,3}){0,4}`;
/** English opener: an optional "please" and "can/could/would you (please)". */
const EN_OPEN = '(?:please\\s{1,3})?(?:(?:can|could|would)\\s{1,3}you\\s{1,3}(?:please\\s{1,3})?)?';
/** English determiner: "this ", "the ", "our ". */
const EN_DET = '(?:(?:this|that|these|those|the|a|an|my|our|its)\\s{1,3})?';
/** One free English word — only ever in a small bounded count, never an open tail. */
const EN_FREE = '[\\w-]{1,32}';
/**
 * English nouns a request may END on — an ALLOWLIST (an unknown head selects
 * nothing). A verb-first language has no "last predicate" to anchor on, so an
 * English shape is a closed grammar instead: verb, determiner, at most one free
 * word, then one of these. "explain this and commit" cannot fit it.
 */
const EN_CODE_HEAD = 'code(?:base)?|source|modules?|functions?|class(?:es)?|repo(?:sitory)?|architecture'
  + '|dependenc(?:y|ies)|vulnerabilit(?:y|ies)';
const EN_HEAD = `${EN_CODE_HEAD}|files?|pipelines?|flows?|systems?|logic|designs?|hooks?|middleware`
  + '|routers?|dispatchers?|components?|services?|handlers?|schemas?|configs?|configuration|apis?'
  + '|algorithms?|patterns?|concepts?';
/** The verbs an English "explain how/why/what X …" clause may end on. */
const EN_PRED = 'works?|happens?|fails?|breaks?|is|are|does|do|means?|behaves?|handles?|runs?|loads?|differs?';

// ---------------------------------------------------------------------------
// The START grammar of the Korean `analyze` / `explain` shapes (the header,
// "What the START grammar gives up, and what it leaves open", says why). Every
// piece is a CLOSED class and every quantifier is bounded. Korean is verb-final,
// so a leading clause ("커밋하고 …") cannot be refused by anchoring on the verb:
// the prompt has to be refused by what may stand BEFORE the request, and that
// can only be an allowlist — the connectives bind to open-class verb stems.
// ---------------------------------------------------------------------------

/** Alternation source, longest word first so a short word never hides a longer one. */
const alt = (words) => [...words].sort((a, b) => b.length - a.length).join('|');

/**
 * Nouns a Korean request may be ABOUT or qualified by: code and its parts,
 * aspects, domains, a few concepts, modifiers, quantifiers and pronouns. CLOSED
 * and BARE on purpose: no word here takes a connective, and none is a bound noun
 * ("다음", "뒤", "후", "김", "채") — either would let a leading clause back in
 * ("커밋한 다음 …"). Adding one widens only what a request may be about; the
 * start-anchor test suite checks that the list stays free of both kinds.
 */
const TOPIC_NOUNS = [
  // code and its parts
  '코드베이스', '코드', '소스', '모듈', '함수', '클래스', '저장소', '리포지토리', '레포지토리',
  '파일', '폴더', '디렉터리', '프로젝트', '시스템', '서비스', '컴포넌트', '인터페이스',
  '라이브러리', '패키지', '프레임워크', '플러그인', '에이전트', '프롬프트', '스크립트', '명령어',
  '커맨드', '설정', '스키마', '쿼리', '모델', '핸들러', '컨트롤러', '라우터', '라우팅', '미들웨어',
  '파이프라인', '훅', '알고리즘', '정규식', '로그', '에러', '오류', '예외', '버그', '이슈',
  '커밋', '브랜치', '변경', 'PR', '구현', '기능', '테스트', '배포', '빌드', '세션',
  // aspects
  '성능', '보안', '품질', '구조', '아키텍처', '의존성', '취약점', '설계', '동작', '원리', '흐름',
  '로직', '역할', '목적', '의도', '방식', '작동', '용도', '차이', '구성',
  // domains and concepts
  '인증', '인가', '권한', '로그인', '결제', '주문', '사용자', '유저', '데이터', '데이터베이스',
  '네트워크', '서버', '클라이언트', '프론트엔드', '프런트엔드', '백엔드', '캐시', '스레드',
  '프로세스', '메모리', '이벤트', '루프', '비동기', '동시성', '트랜잭션', '인덱스', '클로저',
  '콜백', '프로미스', '재귀', '상속', '다형성', '제네릭', '스코프', '해시', '스택', '트리',
  '포인터', '렌더링', '상태', '토큰', '쿠키', '리팩토링', '리팩터링', '마이그레이션', '디버깅',
  '최적화', '머지', '리베이스', '롤백',
  // modifiers
  '핵심', '공통', '기존', '신규', '레거시', '내부', '외부', '메인',
  // quantifiers
  '전체', '전부', '모든', '각',
  // pronouns
  '이거', '이것', '이걸', '그거', '그것', '그걸', '저거', '저것',
];

/** Adverbs an `explain` request may carry right before its verb ("자세히 설명해줘"). */
const EXPLAIN_ADVERBS = [
  '자세히', '상세히', '상세하게', '쉽게', '간단히', '간단하게', '간략히', '간략하게',
  '차근차근', '꼼꼼히', '꼼꼼하게', '천천히', '깊이', '깊게', '친절하게',
];

/**
 * What a free stem must END in to be an adnominal clause — the form that can only
 * MODIFY the noun behind it ("수정한 코드", "호출하는 함수", "복잡한 모듈"). Not a
 * connective: "수정하고", "수정해서", "수정한 다음" do not end in one of these, and
 * after one the next word has to be a noun of the vocabulary, never a bound noun.
 */
const ADNOMINAL_ENDINGS = ['하는', '되는', '했던', '하던', '한', '된', '할', '될'];

/**
 * The lists above, exposed for the contract tests (frozen; not an extension point —
 * a new word is a code change with its own pinned phrase).
 */
export const AUTO_ACTIVATE_START_VOCABULARY = Object.freeze({
  openers: Object.freeze([...SCOPE_OPENERS]),
  topicNouns: Object.freeze([...TOPIC_NOUNS]),
  adverbs: Object.freeze([...EXPLAIN_ADVERBS]),
  adnominalEndings: Object.freeze([...ADNOMINAL_ENDINGS]),
});

/** Opener words, first in the prompt: "이 ", "우리의 ", "내가 ", "일단 ". */
const START_OPENERS = `(?:(?:${alt(SCOPE_OPENERS)})(?:들|의|에서|에|중|중에|가)?\\s{1,3}){0,3}`;
/**
 * The ASCII slot: at most ONE bare term or identifier ("JWT", "auth", "Node.js",
 * "SECRET-MARKER-XYZ") and at most ONE path or URL (it contains `/`, `\` or `@`, or
 * ends in a source extension), in either order, each with the particle that may
 * follow it ("JWT를 ", "CORS에 대해 "). Neither class has Hangul, so "commit하고" and
 * "push 하고" (the connective is a Hangul token) do not fit. One word, not two:
 * "git push" / "git commit" / "npm test" are an English clause, and no grammar can
 * tell a two-word command from a two-word term ("event loop"), so the slot gives
 * up the second word of a term rather than let the command through.
 */
const ASCII_GAP = '(?:의|을|를|은|는|도|만|에서|에|에\\s{0,2}대해서?|에\\s{0,2}관해서?)?\\s{1,3}';
const ASCII_WORD = `[A-Za-z0-9][A-Za-z0-9_.-]{0,31}${ASCII_GAP}`;
const ASCII_PATH = '(?:@[\\w./-]{1,128}|[\\w.:-]{0,64}[/\\\\][\\w./\\\\:-]{0,128}'
  + `|[\\w.-]{1,64}\\.(?:${SOURCE_EXT})\\b)${ASCII_GAP}`;
const START_ASCII = `(?:(?:${ASCII_WORD})?(?:${ASCII_PATH})?|(?:${ASCII_PATH})(?:${ASCII_WORD}))`;
/** At most one adnominal clause: a free stem plus a closed ending, then the gap. */
const START_ADNOMINAL = `(?:[가-힣]{1,8}(?:${alt(ADNOMINAL_ENDINGS)})\\s{1,3})?`;
/** Nouns of the vocabulary, spaced or glued ("소스코드", "보안취약점"), each with an optional particle. */
const START_NOUNS = `(?:(?:${alt(TOPIC_NOUNS)})(?:들|의|에서|에|중|중에)?\\s{0,3}){0,5}`;
/**
 * Everything that may stand between `^` and the object: the ASCII slot goes on ONE
 * side of the openers (so one word and one path in all), the adnominal clause and
 * the nouns come after both. An opener never follows a noun: "커밋 이 코드 …" does
 * not fit.
 */
const START = `(?:${START_ASCII}${START_OPENERS}|${START_OPENERS}${START_ASCII})`
  + `${START_ADNOMINAL}${START_NOUNS}`;
/** The object of an analyze request: a code noun (glued pairs allowed), @path or a file path. */
const OBJECT_HEAD = `(?:(?:${KO_CODE_NOUN}){1,2}|${EN_CODE_WORD}|@[\\w./-]{1,128}`
  + `|[\\w./\\\\:-]{1,96}\\.(?:${SOURCE_EXT})\\b)`;
/** What may close an explain topic before its verb: a particle or "에 대해". */
const EXPLAIN_FINAL = '(?:을|를|도|만|은|는|에\\s{0,2}대해서?|에\\s{0,2}관해서?)?';

/**
 * @param {string} id stable rule id (charset `[a-z0-9-]`)
 * @param {string} command the allowlisted command this rule selects
 * @param {RegExp[]} all MENTION — EVERY regex must match somewhere in the prompt
 *   for it to count as being about `command`. This, not `shape`, is what makes a
 *   prompt that mentions two commands ambiguous. No `g`/`y` flag: `.test` must be
 *   stateless across calls.
 * @param {...string} shapes TRIGGER SHAPE — regex sources OR-ed into one
 *   case-insensitive regex, each anchored at BOTH ends: `^`, so only a closed
 *   grammar may precede the request, and `$`, so the trigger clause is the LAST
 *   thing in the prompt. A row fires only when its mention regexes AND its shape
 *   match. (`tests/cognitive/auto-activate-start-anchor.test.js` checks every
 *   alternative of every row for both anchors.)
 */
function rule(id, command, all, ...shapes) {
  const shape = new RegExp(shapes.map((source) => `(?:${source})`).join('|'), 'i');
  return Object.freeze({ id, command, all: Object.freeze(all), shape });
}

/**
 * The trigger table — ALLOWLIST-SHAPED like the topology router's NL patterns
 * (a deny list fails open on every phrase nobody thought of). Provenance differs
 * by command: `blindspot` and `scorecard` rows come from the trigger lists in
 * their own frontmatter `description`, deliberately NARROWER than them (the
 * generic ones — "점검해줘", "얼마나 남았" — are left out, because a false
 * positive here removes a confirmation). `analyze` and `explain` document no
 * trigger list, only an `argument-hint` example ("보안 취약점 분석해줘",
 * "이벤트 루프 동작 원리"), so their rows are the verb (+ object) shape of such a
 * request. There is no row for `why`: it has no command.
 *
 * A row is a MENTION plus a SHAPE (see `rule`). The mention says what the prompt
 * is about; the shape says the trigger IS the request — a short plain sentence
 * that opens inside a closed grammar and whose final predicate is the trigger,
 * not a noun, a quoted phrase or one half of a compound. Ambiguity is decided on
 * mentions, so a prompt that names two commands still selects none.
 * @type {readonly Readonly<{id: string, command: string,
 *   all: readonly RegExp[], shape: RegExp}>[]}
 */
const TRIGGER_RULES = Object.freeze([
  // Korean: `^`, the START grammar (openers, one ASCII word and one path, at most one
  // adnominal clause, vocabulary nouns), the code object, then only a particle,
  // "전체" or a focus noun (성능·보안·품질·구조·아키텍처·의존성, after the `--focus`
  // domains of `commands/analyze.md`), the verb and `$`. So "커밋하고 이 함수
  // 분석해줘" has no slot for its first clause, "이 함수 커밋하고 분석해줘" has
  // none for its middle one, and "이 함수 분석하고 커밋해줘" ends in another verb.
  // English: verb first, at most one modifier, and the code object is the LAST
  // word ("analyze the auth module", "analyze src/lib/foo.js").
  rule(
    'analyze-code',
    'analyze',
    [/분석|analy[sz]e|analysis/i, CODE_OBJECT],
    `^${START}${OBJECT_HEAD}(?:들)?(?:\\s{0,2}(?:전체|전부|모두))?(?:의|을|를|도|만)?`
      + `(?:\\s{0,2}(?:성능|보안|품질|구조|아키텍처|의존성))?(?:을|를)?\\s{0,2}${SOFT}${doVerb('분석')}$`,
    `^${EN_OPEN}analy[sz]e\\s{1,3}${EN_DET}(?:${EN_FREE}\\s{1,3})?`
      + `(?:${EN_CODE_HEAD}|@[\\w./-]{1,128}`
      + '|[\\w./-]{1,96}\\.(?:js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|rb|sh))(?:\\s{1,3}please)?$',
  ),
  // The VERB form closes the prompt ("설명해줘", "설명 좀 해줘"). The noun forms —
  // "제품 설명 좀 다듬어줘", "설명 부탁" — are not requests to be taught anything.
  // What may stand before the verb is the START grammar alone: an explain has no
  // code object to anchor on ("이벤트 루프 설명해줘", "JWT 설명해줘"), so the topic
  // is the closed vocabulary or an ASCII term, plus an optional particle or
  // "에 대해" and one adverb of a fixed list.
  rule(
    'explain-ko',
    'explain',
    [/설명/],
    `^${START}${EXPLAIN_FINAL}\\s{0,2}${SOFT}(?:(?:${alt(EXPLAIN_ADVERBS)})\\s{1,2})?${doVerb('설명')}$`,
  ),
  // English: "explain this", "explain the auth module", "explain how the router
  // works" — a closed grammar (see `EN_HEAD`), not an open tail.
  rule(
    'explain-en',
    'explain',
    [/\bexplain\b/i],
    `^${EN_OPEN}explain\\s{1,3}(?:this|that|it)(?:\\s{1,3}to\\s{1,3}me)?(?:\\s{1,3}please)?$`,
    `^${EN_OPEN}explain\\s{1,3}${EN_DET}(?:${EN_FREE}\\s{1,3})?(?:${EN_HEAD})`
      + '(?:\\s{1,3}to\\s{1,3}me)?(?:\\s{1,3}please)?$',
    `^${EN_OPEN}explain\\s{1,3}(?:how|why|what)\\s{1,3}${EN_DET}(?:${EN_FREE}\\s{1,3}){1,2}`
      + `(?:${EN_PRED})(?:\\s{1,3}please)?$`,
  ),
  rule(
    'explain-walkthrough',
    'explain',
    [/\bwalk\s{1,4}me\s{1,4}through\b/i],
    `^${EN_OPEN}walk\\s{1,3}me\\s{1,3}through\\s{1,3}${EN_DET}(?:${EN_FREE}\\s{1,3})?(?:${EN_HEAD})`
      + '(?:\\s{1,3}please)?$',
  ),
  // The whole prompt is the trigger: only a scope word or opener (`SCOPE`) may
  // precede the term, and a check verb closes it — "사각지대 없는지 보고 바로
  // 수정해줘" ends in another verb and does not fit.
  rule(
    'blindspot-term',
    'blindspot',
    [/사각지대|blind\s{0,2}-?\s{0,2}spot/i],
    `^${SCOPE}사각지대(?:가|를|은|는|도)?\\s{0,2}${SOFT}(?:(?:있는지|없는지|있나|없나)\\s{0,2})?${CHECK_KO}$`,
    `^${EN_OPEN}(?:(?:check|scan|find|review)\\s{1,3}(?:for\\s{1,3})?(?:(?:any|my|our|the)\\s{1,3})?)?`
      + 'blind\\s{0,2}-?\\s{0,2}spots?(?:\\s{1,3}(?:check|scan|review))?(?:\\s{1,3}please)?$',
  ),
  // The command's own triggers are "빠뜨린 거" / "놓친 거", but on their own those
  // fire on "메일 놓친 거 같아". Requiring the CHECK verb (or a question ending)
  // after them keeps the "did I miss anything?" reading and drops the statement
  // reading; `SCOPE` in front keeps it about the user's own work, not "메일 놓친
  // 거 있어?" (a mailbox).
  rule(
    'blindspot-missed',
    'blindspot',
    [/(?:빠뜨린|빠트린|놓친|빠진)\s{0,3}(?:거|것|게|부분|점)\s{0,3}(?:없|있|점검|확인|찾)/],
    `^${SCOPE}(?:빠뜨린|빠트린|놓친|빠진)\\s{0,3}(?:거|것|게|부분|점)(?:이|가)?\\s{0,3}`
      + `(?:(?:없는지|있는지|없나|있나)\\s{0,3}${SOFT}${CHECK_KO}|${CHECK_KO}`
      + '|(?:없어|있어|없나요|있나요|없나|있나|없을까요?|있을까요?|없냐|있냐))$',
  ),
  // A view/run verb closes it: "스코어카드 보여줘". Not "만들어줘"/"구현해줘" — with
  // a feature that has a `scorecard.js` of its own, those mean "build it".
  rule(
    'scorecard-term',
    'scorecard',
    [/스코어\s{0,2}카드|score\s{0,2}card/i],
    `^${SCOPE}스코어\\s{0,2}카드(?:를|을|는|도)?\\s{0,2}${SOFT}`
      + `(?:${giveVerb('보여|뽑아|돌려|띄워')}|${doVerb('채점|비교|평가|출력')})$`,
    `^${EN_OPEN}(?:(?:show|run|give|display)\\s{1,3}(?:me\\s{1,3})?(?:(?:the|a|our|my)\\s{1,3})?)?`
      + '(?:(?:feature|project|progress)\\s{1,3})?score\\s{0,2}card(?:\\s{1,3}please)?$',
  ),
  rule(
    'scorecard-completeness',
    'scorecard',
    [/기능\s{0,3}완성도|완성도\s{0,3}(?:평가|점수|채점)|기능별\s{0,3}점수|작업\s{0,3}전후\s{0,3}(?:비교|점수)/],
    `^${SCOPE}(?:기능\\s{0,3}완성도|완성도\\s{0,3}(?:평가|점수|채점)|기능별\\s{0,3}점수`
      + `|작업\\s{0,3}전후\\s{0,3}(?:비교|점수))(?:를|을)?\\s{0,3}${SOFT}`
      + `(?:${doVerb('평가|채점|측정|확인|비교')}|${giveVerb('보여|알려|뽑아')}|${DO})$`,
  ),
]);

/**
 * The trigger rows, exposed for the contract tests (frozen; the table itself is
 * not an extension point — a new row is a code change with its own tests).
 */
export const AUTO_ACTIVATE_TRIGGER_RULES = TRIGGER_RULES;

/**
 * Allowlisted names that CAN fire: the allowlist ∩ the names the trigger table
 * selects. Today that is the allowlist minus `why`.
 * @type {readonly string[]}
 */
export const AUTO_ACTIVATE_ACTIVATABLE = Object.freeze(
  AUTO_ACTIVATE_ALLOWLIST.filter((name) => TRIGGER_RULES.some((r) => r.command === name)),
);

/**
 * Is the kill switch on? Strict `=== true` on the dot path, the same reading
 * shape as `workflow-mode.js#readFollowWorkflowPlan` and
 * `question-gate.js#readQuestionGateEnforce`.
 *
 * @param {object|null|undefined} config artibot.config.json contents
 * @returns {boolean}
 */
export function readAutoActivateEnabled(config) {
  return AUTO_ACTIVATE_CONFIG_PATH
    .split('.')
    .reduce((node, key) => node?.[key], config) === true;
}

/**
 * Which ONE allowlisted command does this prompt select? Three stages.
 *
 *  1. `normalizeAutoActivateProbe`: only a short, plain, single-sentence prompt
 *     gets past — no paste, quote, code fence, newline or chained sentences.
 *  2. Mentions: a row is about its command when EVERY regex of `all` matches.
 *     Two or more distinct commands ("analyze the code and give me a
 *     scorecard") is ambiguous and selects NOTHING: two rows of the SAME
 *     command agree and count once, but a prompt that fits two commands is
 *     exactly where asking is cheaper than guessing.
 *  3. Shape: the one mentioned command is selected only if a row of it also
 *     matches its `shape` — the trigger is the request itself, the last
 *     predicate of the prompt. A row without a `shape` never fires.
 *
 * `rules` holds the ids of the rows that fired or, when ambiguous, of the rows
 * that made it ambiguous.
 *
 * `table` exists so a test can prove the allowlist is enforced HERE and not
 * only by how the shipped table happens to be written: a synthetic row for a
 * command outside the allowlist must never be returned.
 *
 * @param {unknown} text the prompt
 * @param {readonly {id: string, command: string, all: readonly RegExp[], shape?: RegExp}[]} [table]
 * @returns {{command: string|null, rules: string[], ambiguous: boolean}}
 */
export function matchAutoActivateCommand(text, table = TRIGGER_RULES) {
  const probe = normalizeAutoActivateProbe(text);
  if (probe === null) return { command: null, rules: [], ambiguous: false };
  const mentioned = new Set();
  const mentionRules = [];
  const fired = new Set();
  const firedRules = [];
  for (const row of table) {
    if (!AUTO_ACTIVATE_ALLOWLIST.includes(row.command)) continue;
    if (!row.all.every((re) => re.test(probe))) continue;
    mentioned.add(row.command);
    mentionRules.push(row.id);
    if (row.shape instanceof RegExp && row.shape.test(probe)) {
      fired.add(row.command);
      firedRules.push(row.id);
    }
  }
  if (mentioned.size > 1) return { command: null, rules: mentionRules, ambiguous: true };
  if (fired.size === 1) return { command: [...fired][0], rules: firedRules, ambiguous: false };
  return { command: null, rules: [], ambiguous: false };
}

/**
 * Screen a prompt against the two gate catalogs (see the header for what a
 * "gate hit" is). Async only because the catalogs are imported lazily.
 *
 * @param {unknown} text the prompt
 * @returns {Promise<string[]>} hit ids — `HG-nn` and `risk:<rule id>`; empty = zero hits
 */
export async function screenGateHits(text) {
  const probe = typeof text === 'string' ? text : '';
  const [gates, safety] = await Promise.all([
    import('../security/human-gates.js'),
    import('../autopilot/safety.js'),
  ]);
  const hits = [];
  for (const { id } of gates.classify({ command: probe }).hits) {
    const row = gates.getGateRow(id);
    // An unknown row id is a hit: the direction of doubt is "withhold".
    if (row === null || row.default !== 'auto') hits.push(id);
  }
  const risk = safety.classifyRisk(probe);
  if (risk.level !== 'safe') hits.push(`risk:${risk.matchedId ?? risk.level}`);
  return hits;
}

/**
 * The full decision. Every condition must hold; any false one returns
 * `activate: false` with a `reason`, and the caller then emits nothing — which
 * is today's behaviour byte for byte. Cheap conditions first: the gate screen
 * (two lazy imports) only runs for a prompt that already selected a command.
 *
 * `reason`: `switch-off` · `no-text` · `slash-command` · `no-trigger` ·
 * `ambiguous-trigger` · `intent-unavailable` · `intent-ambiguous` · `gate-hit` ·
 * `gate-screen-failed` · `allowlist-match`. `no-trigger` covers every prompt
 * `matchAutoActivateCommand` returns no command for: one that is not a short
 * plain sentence, names no allowlisted command, or names one without its
 * trigger shape.
 *
 * @param {object} [params]
 * @param {unknown} [params.text] the prompt the user typed
 * @param {object} [params.config] artibot.config.json contents (the kill switch)
 * @param {string|null} [params.slashCommand] `detectSlashCommand(text)`. A typed
 *   slash command is already an explicit choice; nothing to activate.
 * @param {{ambiguous?: boolean}|null} [params.intent] the router's intent for
 *   this prompt (`state.context.intent`). Absent = the runtime pipeline did not
 *   run (fallback envelope) and the decision fails closed.
 * @param {(text: string) => Promise<string[]>} [params.screen] gate screen port
 * @returns {Promise<Readonly<{activate: boolean, command: string|null,
 *   reason: string, rules: readonly string[], gates: readonly string[]}>>}
 */
export async function decideAutoActivation({
  text, config, slashCommand = null, intent = null, screen = screenGateHits,
} = {}) {
  const result = (activate, command, reason, rules = [], gates = []) => Object.freeze({
    activate, command, reason, rules: Object.freeze([...rules]), gates: Object.freeze([...gates]),
  });
  if (!readAutoActivateEnabled(config)) return result(false, null, 'switch-off');
  if (typeof text !== 'string' || text.trim() === '') return result(false, null, 'no-text');
  if (typeof slashCommand === 'string' && slashCommand !== '') {
    return result(false, null, 'slash-command');
  }
  const match = matchAutoActivateCommand(text);
  if (match.command === null) {
    return result(false, null, match.ambiguous ? 'ambiguous-trigger' : 'no-trigger', match.rules);
  }
  if (intent === null || typeof intent !== 'object') {
    return result(false, null, 'intent-unavailable', match.rules);
  }
  if (intent.ambiguous === true) return result(false, null, 'intent-ambiguous', match.rules);
  let gates;
  try {
    gates = await screen(text);
  } catch {
    return result(false, null, 'gate-screen-failed', match.rules);
  }
  if (!Array.isArray(gates)) return result(false, null, 'gate-screen-failed', match.rules);
  if (gates.length > 0) return result(false, null, 'gate-hit', match.rules, gates);
  return result(true, match.command, 'allowlist-match', match.rules);
}

/**
 * Render the directive for one activatable command, or '' for anything else.
 * The closed-set check is repeated HERE (not only in the matcher) so a caller
 * that hands in a name of its own reaches the prompt as nothing.
 *
 * One line, no newline: the hook joins directives into one head line and the
 * caller-side shape gate (`runtime-prompt.js#acceptAutoActivation`) refuses
 * anything that is not `[artibot:auto-activate command=<name>] <one line>`.
 * The final clause is an escape hatch on purpose — the triggers are heuristics,
 * and a model that can see the request does not fit should be free to say so.
 *
 * @param {unknown} command
 * @returns {string}
 */
export function renderAutoActivateDirective(command) {
  if (typeof command !== 'string' || !AUTO_ACTIVATE_ACTIVATABLE.includes(command)) return '';
  return `[artibot:auto-activate command=${command}] `
    + `Low-risk allowlisted command: run /${command} for this request now without asking for confirmation, `
    + 'and say so in one short Korean sentence first. '
    + 'If the request clearly does not fit it, ignore this line. '
    + 'This line skips only that confirmation and is not approval for any other action; '
    + 'PreToolUse hooks still run on Bash, Write and Edit calls.';
}
