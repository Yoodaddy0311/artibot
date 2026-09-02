/**
 * Boundary cases for the PII scrubber, from the 2026-08-30 adversarial audit.
 *
 * Every case here was measured against the shipped scrubber before the fix and
 * either leaked PII or corrupted legitimate text. The NEGATIVE CONTROL cases
 * pin behavior the fix must NOT change: without them, a fix that merely widens
 * or narrows a pattern would look green while breaking its neighbour.
 *
 * Strings are built by concatenation with the BS / SQ / DQ constants rather
 * than escape sequences, so a Windows path or a quoted secret reads as itself.
 */
/**
 * WHAT THIS FILE DOES NOT COVER — read this before treating a green run here as
 * evidence. Written next to the gate on purpose: a gate whose blind spots are
 * only in someone\u2019s head becomes the basis for the next false confidence.
 *
 *  - **Fixtures, not live data.** Every case is a hand-written string. The
 *    scrubber also runs over swarm payloads and ledger lines whose real shape and
 *    size are not represented here. A green run says the listed shapes are
 *    handled; it does not say production text comes out clean.
 *  - **False-positive control is sampled, not exhaustive.** The over-detection
 *    cases enumerate specific strings (`keyword`, `authority`, `keyboard`). They
 *    cannot show that no OTHER legitimate string is newly masked.
 *  - **KNOWN LIMIT cases pin CURRENT behaviour, not desired behaviour.** They
 *    assert that something is NOT scrubbed, so that widening a pattern later has
 *    to confront them. Do not read them as evidence of safety.
 *  - **Pattern interaction is only partly swept.** `scrub()` applies ~40 patterns
 *    in priority order, and one pattern\u2019s replacement can destroy the shape a
 *    later pattern needs — that is exactly how the six secret assignments leaked.
 *    It is exercised for those six; it is not swept across the whole pattern set.
 *  - **Nothing here measures the consumers.** Whether `lib/swarm/*` and
 *    `lib/learning/ledger/*` route their text through `scrub()` at all is
 *    asserted in those suites, not this one.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  getScrubStats,
  resetStats,
  scrub,
  validateScrubbed,
} from "../../lib/privacy/pii-scrubber.js";

/** Cyrillic a (U+0430), a lookalike for Latin a. */
const CYR_A = "\u0430";
const CYRILLIC = /[\u0400-\u04FF]/;
const GREEK = /[\u0370-\u03FF]/;
/** Literal backslash / single quote / double quote, so samples stay legible. */
const BS = String.fromCharCode(92);
const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);

// -------------------------------------------------------------------------
// P-1 - homoglyph normalization must be scoped to mixed-script TOKENS
// -------------------------------------------------------------------------

describe("homoglyph normalization is scoped to mixed-script tokens", () => {
  beforeEach(() => resetStats());

  it("leaves a Cyrillic word intact when a Latin word appears elsewhere", () => {
    // Measured before fix: the leading O and the trailing a were swapped to Latin.
    const russianLog =
      "\u041E\u0448\u0438\u0431\u043A\u0430: cannot open file";
    expect(scrub(russianLog)).toBe(russianLog);
    expect(getScrubStats().homoglyphNormalized).toBe(0);
  });

  it("leaves a Cyrillic identifier intact inside an otherwise Latin code line", () => {
    // Measured before fix: five characters of the identifier were swapped.
    const codeLine =
      "const \u043F\u0435\u0440\u0435\u043C\u0435\u043D\u043D\u0430\u044F = 1;";
    expect(scrub(codeLine)).toBe(codeLine);
    expect(getScrubStats().homoglyphNormalized).toBe(0);
  });

  it("leaves a Greek word intact beside Latin words", () => {
    const greekLog = "\u0394\u03BF\u03BA\u03B9\u03BC\u03AE test alpha";
    expect(scrub(greekLog)).toBe(greekLog);
    expect(getScrubStats().homoglyphNormalized).toBe(0);
  });

  // NEGATIVE CONTROL - the attack this normalization exists for must still fire.
  it("still normalizes a homoglyph mixed inside one token (spoofed email)", () => {
    const spoofed = "mail " + CYR_A + "dmin@corp.io now";
    const out = scrub(spoofed);
    expect(out).toBe("mail [EMAIL] now");
    expect(out).not.toMatch(CYRILLIC);
    expect(getScrubStats().homoglyphNormalized).toBe(1);
  });

  // NEGATIVE CONTROL - the classic IDN homograph must still be neutralized.
  it("still normalizes a spoofed domain token", () => {
    const out = scrub("visit p" + CYR_A + "ypal.com today");
    expect(out).not.toMatch(CYRILLIC);
    expect(out).toContain("paypal.com");
  });

  it("leaves pure-Latin text untouched", () => {
    const clean = "plain ascii text only";
    expect(scrub(clean)).toBe(clean);
    expect(getScrubStats().homoglyphNormalized).toBe(0);
  });

  it("leaves Greek-only text untouched", () => {
    const greek = "\u03BA\u03B1\u03BB\u03B7\u03BC\u03AD\u03C1\u03B1";
    expect(scrub(greek)).toBe(greek);
    expect(scrub(greek)).toMatch(GREEK);
  });
});
// -------------------------------------------------------------------------
// P-2 - Windows paths whose segments contain spaces
// -------------------------------------------------------------------------

describe("windows_user_path covers segments containing spaces", () => {
  it("scrubs a path whose account name contains a space", () => {
    // Measured before fix: the whole path survived, account name exposed.
    const out = scrub(
      "file C:" + BS + "Users" + BS + "alice bob" + BS + "notes.txt end",
    );
    expect(out).not.toContain("alice bob");
    expect(out).toBe("file {USER_HOME}" + BS + "[PATH] end");
  });

  it("scrubs a path with a non-ASCII directory segment containing a space", () => {
    // Measured before fix: the tail after the space survived verbatim.
    const out = scrub(
      "file C:" + BS + "Users" + BS + "nowhe" + BS + "OneDrive" + BS
        + "바탕 화면" + BS + "AI" + BS + "x.js end",
    );
    expect(out).not.toContain("nowhe");
    expect(out).not.toContain("화면");
    expect(out).toBe("file {USER_HOME}" + BS + "[PATH] end");
  });

  // NEGATIVE CONTROL - a path must not swallow the sentence that follows it.
  it("does not swallow prose following a path", () => {
    const out = scrub(
      "file C:" + BS + "Users" + BS + "alice" + BS
        + "notes.txt and then some prose",
    );
    expect(out).toBe("file {USER_HOME}" + BS + "[PATH] and then some prose");
  });

  // NEGATIVE CONTROL - prose with no path stays byte-identical.
  it("leaves prose with no path untouched", () => {
    const prose = "Users of this tool report that C drives fill up quickly";
    expect(scrub(prose)).toBe(prose);
  });
});

// -------------------------------------------------------------------------
// P-3 - quoted secret values must be consumed to the closing quote
// -------------------------------------------------------------------------

describe("quoted secret values are consumed whole", () => {
  it("redacts a single-quoted password containing spaces with no residue", () => {
    // Measured before fix: the text after the first space survived.
    const out = scrub("password: " + SQ + "p@ss word 1" + SQ);
    expect(out).not.toContain("p@ss");
    expect(out).not.toContain("word 1");
  });

  it("redacts a double-quoted password containing spaces with no residue", () => {
    const out = scrub("password: " + DQ + "p@ss word 1" + DQ);
    expect(out).not.toContain("word 1");
  });

  it("redacts a quoted api key containing spaces with no residue", () => {
    // Measured before fix: the tail after the space survived.
    const out = scrub("api_key: " + SQ + "abcdefghijklmnop qrst" + SQ);
    expect(out).not.toContain("qrst");
    expect(out).not.toContain("abcdefghijklmnop");
  });

  // NEGATIVE CONTROL - below the length floor, must stay untouched.
  it("leaves a too-short unquoted password alone", () => {
    expect(scrub("password=abc")).toBe("password=abc");
  });

  // NEGATIVE CONTROL - an unquoted value is one token; prose after it survives.
  it("redacts an unquoted password without swallowing the following prose", () => {
    expect(scrub("password: hunter2 and more prose")).toBe(
      "password=[REDACTED_SECRET] and more prose",
    );
  });

  // NEGATIVE CONTROL - an unbalanced quote must not run to end of input.
  it("does not run past a line break when a quote is unbalanced", () => {
    const out = scrub(
      "password: " + SQ + "unterminated value\nnext line here",
    );
    expect(out).toContain("next line here");
  });
});

// -------------------------------------------------------------------------
// P-4 - the validator must not share the blind spot of the detector
// -------------------------------------------------------------------------

describe("non-ASCII email detection and independent validation", () => {
  it("scrubs an email with a non-ASCII local part", () => {
    // Measured before fix: untouched, and validateScrubbed reported clean.
    const out = scrub("mail 김철수@naver.com end");
    expect(out).not.toContain("김철수");
    expect(out).toBe("mail [EMAIL] end");
  });

  it("scrubs an email with an internationalized domain", () => {
    const out = scrub("mail bob@회사.한국 end");
    expect(out).not.toContain("회사");
    expect(out).toContain("[EMAIL]");
  });

  it("reports residual for a non-ASCII email left in the text", () => {
    const result = validateScrubbed("mail 김철수@naver.com end");
    expect(result.clean).toBe(false);
    expect(result.residual.length).toBeGreaterThan(0);
  });

  // NEGATIVE CONTROL - scrubbed output must still read as clean.
  it("reports clean on fully scrubbed output", () => {
    expect(validateScrubbed("mail [EMAIL] end").clean).toBe(true);
  });

  // NEGATIVE CONTROL - ordinary prose must not trip the widened validator.
  it("reports clean on ordinary prose", () => {
    expect(validateScrubbed("This is completely safe text.").clean).toBe(true);
  });

  // NEGATIVE CONTROL - Korean prose with no address must not trip it either.
  it("reports clean on Korean prose containing no address", () => {
    expect(validateScrubbed("바탕 화면에 파일을 저장했습니다").clean).toBe(true);
  });

  // NEGATIVE CONTROL - ASCII email detection is unchanged.
  it("still scrubs a plain ASCII email", () => {
    expect(scrub("contact user@example.com for support")).toBe(
      "contact [EMAIL] for support",
    );
  });
});

// -------------------------------------------------------------------------
// P-3 매트릭스 — 6개 secret-assignment 패턴 전부, 축 4개
//
// 왜 매트릭스인가: 최초 리뷰가 이 4개를 "이미 안전"으로 판정했고, 그 판정이
// 테스트에도 그대로 물려서 24케이스가 수정한 2패턴만 검사했다. 그린이 근거가
// 되지 못한 사례다. 임계 축(atFloor)이 빠지면 픽스처가 실패 영역에 닿지 못한다.
// -------------------------------------------------------------------------

/**
 * 키 이름에도 마스킹 토큰에도 등장하지 않는 채움말. 이 단어들로 단언해야
 * 마스크 자신이 단언을 만족시키는 위양성이 생기지 않는다.
 */
const FILLER = ["zulu", "yankee"];

/**
 * atFloor - 패턴 길이 하한 이상인 첫 토큰. 최초 리뷰가 놓친 축이다. 하한 미만이면
 *           narrow 패턴이 아예 매치되지 않아 우선순위 86 포괄 패턴이 값을 덮으므로,
 *           하한 미만 픽스처는 narrow 패턴에 대해 아무것도 증명하지 못한다.
 */
const SECRET_KEYS = [
  { key: "password",     atFloor: "hunter2secret",        plural: "passwords" },
  { key: "api_key",      atFloor: "abcdefghijklmnopqrst", plural: "api_keys" },
  { key: "secret",       atFloor: "longenough",           plural: "secrets" },
  { key: "credential",   atFloor: "longenough",           plural: "credentials" },
  { key: "private_key",  atFloor: "sixteencharsplus1",    plural: "private_keys" },
  { key: "access_token", atFloor: "tencharstok",          plural: "access_tokens" },
];

const quoted = (key, value) => key + ": " + SQ + value + SQ;
const survivors = (out) => FILLER.filter((w) => out.includes(w));

describe("every secret-assignment pattern consumes a quoted value whole", () => {
  it.each(SECRET_KEYS)(
    "$key: 첫 토큰이 길이 하한 이상인 따옴표 값에 잔여가 없다",
    ({ key, atFloor }) => {
      const out = scrub(quoted(key, atFloor + " zulu yankee"));
      expect(survivors(out), out).toEqual([]);
      expect(out).not.toContain(atFloor);
    },
  );

  it.each(SECRET_KEYS)(
    "$key: 첫 토큰이 하한 미만이어도 잔여가 없다 (포괄 패턴 경유)",
    ({ key }) => {
      const out = scrub(quoted(key, "ab zulu yankee"));
      expect(survivors(out), out).toEqual([]);
    },
  );

  it.each(SECRET_KEYS)(
    "$plural: 복수형 키에서도 따옴표 값이 마스킹된다",
    ({ plural }) => {
      const out = scrub(quoted(plural, "ab zulu yankee"));
      expect(survivors(out), out).toEqual([]);
    },
  );

  // NEGATIVE CONTROL - 무따옴표 값은 한 토큰이며 뒤 산문을 삼키지 않는다.
  it.each(SECRET_KEYS)(
    "$key: 무따옴표 값이 뒤따르는 산문을 삼키지 않는다",
    ({ key, atFloor }) => {
      const out = scrub(key + ": " + atFloor + " and more prose");
      expect(out).toContain("and more prose");
      expect(out).not.toContain(atFloor);
    },
  );
});

// NEGATIVE CONTROL - 복수형 허용(s?)이 평범한 설정 키로 번지지 않는다.
describe("the plural allowance does not widen into ordinary config keys", () => {
  it.each([
    ["keyword",   "search term here"],
    ["authority", "eu-west-1 region"],
    ["keyboard",  "mechanical brown switches"],
  ])("%s 는 비밀 키로 취급되지 않는다", (key, value) => {
    const text = quoted(key, value);
    expect(scrub(text)).toBe(text);
  });
});

// -------------------------------------------------------------------------
// P-2 경계 — 세그먼트가 어디서 끊기느냐가 무엇이 새는지를 가른다
// -------------------------------------------------------------------------

describe("windows_user_path: where a segment breaks decides what leaks", () => {
  it("later segment breaks: the account name is still scrubbed", () => {
    const out = scrub(
      "C:" + BS + "Users" + BS + "alice" + BS + "Program  Files" + BS + "x.txt",
    );
    expect(out).not.toContain("alice");
    expect(out).toBe("{USER_HOME}" + BS + "[PATH]  Files" + BS + "x.txt");
  });

  // NEGATIVE CONTROL for the single-space bound itself. The bound exists so a
  // path cannot swallow the prose after it — but that only becomes visible when
  // the prose contains a LATER backslash for a widened segment to reach.
  // Measured 2026-08-30: the other prose control in this file passes even with
  // the bound removed, because its fixture has nothing past it to swallow, so it
  // could never have caught a widening. This fixture reaches that failure region.
  it("a path does not swallow prose that itself contains a backslash", () => {
    const out = scrub(
      "file C:" + BS + "Users" + BS + "alice" + BS + "f.txt see also foo" + BS + "bar",
    );
    expect(out).toBe(
      "file {USER_HOME}" + BS + "[PATH] see also foo" + BS + "bar",
    );
  });

  // KNOWN LIMIT, pinned on purpose. The account name is the FIRST segment, so
  // when it breaks the whole pattern fails and nothing is scrubbed at all —
  // the opposite of the case above. Accepted 2026-08-30 rather than widened,
  // because allowing unbounded spaces reopens the prose-swallowing over-detection
  // this pattern was narrowed to avoid. These assert CURRENT behaviour so that a
  // later widening fails here first instead of passing silently.
  it.each([
    ["consecutive spaces", "alice  bob"],
    ["a leading space",    " alice"],
    ["a trailing space",   "alice "],
  ])("KNOWN LIMIT — an account name with %s is not scrubbed at all", (_label, account) => {
    const text = "C:" + BS + "Users" + BS + account + BS + "notes.txt";
    expect(scrub(text)).toBe(text);
  });
});
