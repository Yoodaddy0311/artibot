import { beforeEach, describe, expect, it } from 'vitest';
import { blankPrinterSegments } from '../../lib/core/command-segments.js';
import { executeChain, registerBuiltinGuards, resetGuards } from '../../lib/core/guard-registry.js';

/** 백슬래시. 리터럴로 쓰면 이스케이프 단계에서 사고가 난다. */
const BACKSLASH = String.fromCharCode(92);
/** 백틱. 템플릿 리터럴 안에서 쓰려면 조립이 안전하다. */
const BACKTICK = String.fromCharCode(96);

/**
 * 벽시계 3회 중앙값(ms). 단일 회차는 Windows 러너에서 회차 간 1.9배까지
 * 흔들린다(2026-09-11 실측) — 비율 단언의 분모로 쓰려면 중앙값이어야 한다.
 * 헬퍼는 이 파일 안에 자족적으로 둔다(다른 타이밍 파일과 공유하지 않는다 —
 * 공유하면 한쪽 튜닝이 다른 쪽 게이트를 조용히 움직인다).
 * @param {() => unknown} fn 측정할 호출
 * @param {number} [runs] 회차 수(홀수)
 * @returns {number} 중앙값 ms
 */
const medianMs = (fn, runs = 3) => {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  return samples.sort((a, b) => a - b)[Math.floor(runs / 2)];
};

/**
 * 비율 단언의 감쇠항(ms). 분자·분모에 함께 더해 서브밀리초 구간의 타이머
 * 잡음을 누른다 — `tests/core/blocked-patterns.test.js#RATIO_FLOOR_MS` 와 같은
 * 시프트형 공식이다.
 */
const RATIO_FLOOR_MS = 4;

/** 크기 스케일 임계. 선형 기대 6.0, 2차식 기대 36.0 사이의 18. */
const GROWTH_LIMIT = 18;

/**
 * 블랭크 채움 문자. **공백이 아니다** — `lib/core/command-segments.js#BLANK_FILL`
 * 참조. 공백으로 채우면 `$` 앵커 L1 규칙(`delete from …;\s*$`)이 공백이 된
 * 둘째 줄을 후행 공백으로 읽어 통과해 버린다(리더 실측 2026-09-14).
 * 이 상수를 바꾸려면 아래 `$`-앵커 회귀 it 가 먼저 RED 가 되어야 한다.
 */
const FILL = '@';

/** 세그먼트가 통째로 블랭크됐는가 — 채움 문자와 보존된 줄바꿈만 남는다. */
const isFullyBlanked = (text) => /^[@\n\r]*$/.test(text);

/** `unit` 을 정확히 size 바이트까지 반복한다. */
const sized = (unit, size) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

/** `echo "aaa…"` 한 덩어리 — 따옴표 스팬 하나가 입력 전체를 덮는 모양. */
const oneQuotedSpan = (size) => {
  const head = 'echo "';
  return `${head}${'a'.repeat(Math.max(0, size - head.length - 1))}"`.slice(0, size);
};

/** 닫히지 않은 따옴표 — 스캐너가 입력 끝까지 달리는 최악형. */
const unbalancedQuote = (size) => `echo "${'a'.repeat(Math.max(0, size - 6))}`.slice(0, size);

/**
 * 적대 입력 10형. 각각 `(size) => string` 이고 길이가 정확히 size 여야 한다
 * (그 자체를 단언한다 — 빌더가 짧으면 타이밍 표 전체가 거짓 그린이 된다).
 */
const SHAPES = [
  ['echo segment run', (size) => sized('echo x; ', size)],
  ['space run', (size) => `echo ${' '.repeat(Math.max(0, size - 5))}`.slice(0, size)],
  ['semicolon run', (size) => sized(';', size)],
  ['pipe run', (size) => sized('|', size)],
  ['and-and run', (size) => sized('&&', size)],
  ['one long quoted span', oneQuotedSpan],
  ['dollar-paren run', (size) => sized('$(', size)],
  ['unbalanced quote', unbalancedQuote],
  ['comment run', (size) => sized('# x\n', size)],
  ['backslash continuation run', (size) => sized(`x ${BACKSLASH}\n`, size)],
];

describe('command-segments', () => {
  describe('blankPrinterSegments — 면제(프린터 세그먼트는 공백으로)', () => {
    it.each([
      ['double-quoted echo', 'echo "rm -rf /"'],
      ['bare echo', 'echo rm -rf /'],
      ['single-quoted echo', "echo 'rm -rf /'"],
      ['printf', "printf '%s' 'TRUNCATE users;'"],
      ['grep', 'grep -rn "DROP TABLE" .'],
      ['rg', 'rg -n "DELETE FROM users" src'],
      ['git commit message', 'git commit -m "rm -rf build"'],
      ['git tag message', 'git tag -m "shutdown now" v1'],
      ['sudo-wrapped echo', 'sudo echo "rm -rf /"'],
      ['sudo -u wrapped echo', 'sudo -u root echo "rm -rf /"'],
      ['env-wrapped echo', 'env FOO=1 echo "rm -rf /"'],
      ['timeout-wrapped echo', 'timeout 30 echo "rm -rf /"'],
      ['assignment-prefixed echo', 'FOO=1 echo "rm -rf /"'],
      ['backslash-escaped echo', `${BACKSLASH}echo "rm -rf /"`],
      ['comment', '# rm -rf /tmp/x'],
      ['quoted separator stays inside the segment', "echo 'a; rm -rf /'"],
      ['unterminated quote', 'echo "rm -rf /'],
      ['test builtin', 'test -f /etc/passwd'],
    ])('blanks a %s segment', (_name, command) => {
      const blanked = blankPrinterSegments(command);
      expect(isFullyBlanked(blanked)).toBe(true);
      expect(blanked).toHaveLength(command.length);
    });

    it('blanks both the echo and the trailing comment', () => {
      expect(isFullyBlanked(blankPrinterSegments('echo hi # rm -rf /'))).toBe(true);
    });

    it('blanks the echo inside a subshell group', () => {
      const command = '(echo "rm -rf /")';
      expect(blankPrinterSegments(command)).toBe(`(${FILL.repeat(16)}`);
      expect(blankPrinterSegments(command)).toHaveLength(command.length);
    });

    it('blanks the echo inside a brace group', () => {
      expect(blankPrinterSegments('{ echo "rm -rf /"; }')).toBe(`{${FILL.repeat(16)}; }`);
    });
  });

  describe('blankPrinterSegments — 면제 거부(네 조건 각각의 음성 대조)', () => {
    it.each([
      ['(ii) pipe into a shell', "echo 'rm -rf /' | sh"],
      ['(ii) pipe into a database client', 'echo "DROP TABLE users" | psql'],
      ['(iii) command substitution', 'echo "$(rm -rf /)"'],
      ['(iii) backtick substitution', `echo "${BACKTICK}rm -rf /${BACKTICK}"`],
      ['(iii) process substitution', 'grep -f <(rm -rf /) file'],
      ['(iv) redirect', 'echo x > /dev/sda'],
      ['(iv) append redirect', 'echo x >> /etc/passwd'],
      ['(i) command outside the allowlist', 'logger "rm -rf /"'],
      ['(i) cat is not a printer', 'cat /etc/shadow'],
      ['(i) git commit with --exec', 'git commit --exec "rm -rf /" -m "x"'],
      ['(i) git commit with -e', 'git commit -e -m "x"'],
      ['(i) git without a message flag', 'git push --force origin main'],
      ['(i) xargs of a non-printer', 'echo a | xargs rm -rf'],
    ])('leaves a %s segment untouched', (_name, command) => {
      expect(blankPrinterSegments(command)).toBe(command);
    });

    it('leaves an unparsed heredoc body untouched', () => {
      const command = `cat <<'EOF'\nrm -rf /\nEOF`;
      expect(blankPrinterSegments(command)).toBe(command);
    });
  });

  describe('blankPrinterSegments — 세그먼트 분리(fail-open 방지)', () => {
    it.each([
      ['semicolon', 'echo "safe" ; rm -rf /'],
      ['or-or', 'echo x || rm -rf /'],
      ['and-and', 'echo x && rm -rf /'],
      ['newline', 'echo x\nrm -rf /'],
      ['background', 'echo x & rm -rf /'],
    ])('keeps the dangerous half after a %s separator', (_name, command) => {
      const blanked = blankPrinterSegments(command);
      expect(blanked).toContain('rm -rf /');
      expect(blanked).not.toContain('echo');
      expect(blanked).toHaveLength(command.length);
    });

    it('keeps the second command when the first is a grep', () => {
      const blanked = blankPrinterSegments('grep -rn "x" . ; shutdown -h now');
      expect(blanked).toContain('shutdown -h now');
      expect(blanked).not.toContain('grep');
    });

    it('keeps a push that follows a commit message', () => {
      const blanked = blankPrinterSegments('git commit -m "wip" && git push --force');
      expect(blanked).toContain('git push --force');
      expect(blanked).not.toContain('commit');
    });
  });

  describe('blankPrinterSegments — 계약(길이·오프셋·줄 구조)', () => {
    it.each([
      'echo "rm -rf /"',
      'echo "safe" ; rm -rf /',
      '# rm -rf /tmp/x',
      "echo 'rm -rf /' | sh",
      'echo hi # rm -rf /',
      'echo "rm -rf /',
      `echo a ${BACKSLASH}\necho b`,
      '(echo "x"){ echo "y"; }',
    ])('preserves the exact length of %j', (command) => {
      expect(blankPrinterSegments(command)).toHaveLength(command.length);
    });

    it('preserves every newline inside a blanked multi-line input', () => {
      const command = 'echo one\necho two\necho three';
      const blanked = blankPrinterSegments(command);
      expect(blanked).toHaveLength(command.length);
      expect(blanked.split('\n')).toHaveLength(3);
      expect(isFullyBlanked(blanked)).toBe(true);
    });

    it('preserves a CR inside a blanked CRLF input', () => {
      const command = 'echo one\r\necho two';
      const blanked = blankPrinterSegments(command);
      expect(blanked).toBe(`${FILL.repeat(8)}\r\n${FILL.repeat(8)}`);
    });

    it('keeps every character outside an exempt segment byte-identical', () => {
      const command = 'echo "safe" ; rm -rf /tmp/x ; echo "done"';
      const blanked = blankPrinterSegments(command);
      const start = command.indexOf('rm');
      const end = command.indexOf('/tmp/x') + '/tmp/x'.length;
      expect(blanked.slice(start, end)).toBe(command.slice(start, end));
    });

    it.each([
      [null],
      [undefined],
      [42],
      [{}],
      [['echo x']],
    ])('returns an empty string for the non-string input %j', (input) => {
      expect(blankPrinterSegments(input)).toBe('');
    });

    it('returns the empty input unchanged', () => {
      expect(blankPrinterSegments('')).toBe('');
    });
  });

  // 채움 문자가 공백이면 안 되는 이유를 회귀로 고정한다. `$` 앵커 L1 규칙
  // (`delete from <table> …;\s*$`, `export PATH=\s*$`)은 문자열 끝의 공백을
  // 흡수한다 — 둘째 줄 `echo hi` 를 공백으로 채우면 첫 줄이 "문장 끝까지"로
  // 읽혀 approve 이던 두 핀이 block 으로 뒤집힌다(리더 실측 2026-09-14,
  // `tests/core/guard-registry.test.js` 의 줄바꿈 경계 핀 2건).
  // 이 describe 가 그린인데 `BLANK_FILL` 을 ' ' 로 되돌리면 RED 가 되어야 한다.
  describe('blankPrinterSegments — 채움 문자가 `$` 앵커를 건드리지 않는다', () => {
    beforeEach(() => {
      resetGuards();
      registerBuiltinGuards();
    });

    const decisionFor = (command) => executeChain(
      'pre', 'Bash', { tool_name: 'Bash', tool_input: { command } },
    ).decision;

    it.each([
      ['sql-delete', 'delete from users;\necho hi'],
      ['export PATH', 'export PATH=\necho hi'],
    ])('keeps the %s newline-boundary pin at approve', (_name, command) => {
      expect(decisionFor(command)).toBe('approve');
    });

    it.each([
      ['sql-delete', 'delete from users;\necho hi'],
      ['export PATH', 'export PATH=\necho hi'],
    ])('introduces no whitespace when blanking the second line of a %s pin', (_name, command) => {
      const blanked = blankPrinterSegments(command);
      expect(blanked).toHaveLength(command.length);
      // 보존된 줄바꿈 말고는 공백이 새로 생기지 않는다. 원문에 있던 공백은
      // 블랭크된 구간에서 채움 문자로 바뀌므로, 남은 공백은 원문 첫 줄의 것뿐이다.
      expect(blanked.slice(command.indexOf('\n') + 1)).toMatch(/^[@]*$/);
    });
  });

  // 선형성. 프로브(2026-09-11)의 c 열 수치는 세그먼트마다 문자열을 재조립해서
  // O(n^2) 였다 — 그 표는 인용하지 않는다. 여기 수치가 정본이다.
  // 실측 2026-09-14 KST, node v24.15.0, Windows 11: 아래 `it` 이 기록한다.
  describe('blankPrinterSegments — 선형성(전처리 단계 단독)', () => {
    it.each(SHAPES)('builds the %s shape at the exact requested size', (_name, build) => {
      for (const size of [20480, 40962, 122880]) {
        expect(build(size)).toHaveLength(size);
      }
    });

    it.each(SHAPES)('stays under 200ms at 40,962B on a %s', (_name, build) => {
      const input = build(40962);
      expect(medianMs(() => blankPrinterSegments(input))).toBeLessThan(200);
    });

    it.each(SHAPES)('scales sub-quadratically from 20,480B to 122,880B on a %s', (_name, build) => {
      const small = build(20480);
      const large = build(122880);
      const t20 = medianMs(() => blankPrinterSegments(small));
      const t120 = medianMs(() => blankPrinterSegments(large));
      expect((t120 + RATIO_FLOOR_MS) / (t20 + RATIO_FLOOR_MS)).toBeLessThan(GROWTH_LIMIT);
    });

    it.each(SHAPES)('preserves length at 122,880B on a %s', (_name, build) => {
      const input = build(122880);
      expect(blankPrinterSegments(input)).toHaveLength(122880);
    });
  });
});
