/**
 * Printer-segment preprocessing for the command guards (L1 `lib/core/guard-registry.js`
 * and L2 `lib/autopilot/safety.js`).
 *
 * WHY. Neither rule set is anchored to the command position, so a pure MENTION
 * fires them: `echo "rm -rf /"`, `# rm -rf /tmp/x`, `grep -n "TRUNCATE" file`
 * were all blocked while executing nothing. Measured 2026-09-11 on the guard
 * fixtures: 39/39 L1 rules and 22/22 L2 rules fired through the `echo`/comment/
 * `printf`/`grep`/`git commit -m` wrappers. Three options were compared on the
 * real rule arrays; anchoring the rules themselves and stripping quoted spans
 * both lost EXECUTING positives (18/67 adversarial shapes each). This one —
 * blanking whole segments whose command word is a known printer — lost none.
 *
 * WHAT IT DOES. Splits the command into shell segments (quote-aware), decides
 * per segment whether it can possibly execute its arguments, and rewrites the
 * text of the ones that cannot with {@link BLANK_FILL} — an inert filler, NOT a
 * space (see that constant for the measurement that forced it). Offsets and
 * line structure survive (`\n`/`\r` are kept, output length === input length),
 * so every rule that depends on a newline boundary or on `[^\n]{0,N}` bounds
 * keeps its meaning and no rule regex has to change.
 *
 * WHY SEGMENT-LEVEL AND NOT A SHAPE REGEX. "skip the whole command when it
 * matches /^echo /" is fail-OPEN: `echo "safe" ; rm -rf /` would walk through
 * whole. Only the `echo "safe"` segment is blanked here; the `rm -rf /` segment
 * reaches the rules byte-identical.
 *
 * WHY IT IS FAIL-CLOSED. Blanking happens only for an ALLOWLIST of printers
 * ({@link PRINTER_COMMANDS} plus the `git commit|tag|notes -m` message form).
 * An unknown command word is never blanked, so a future command cannot walk in
 * the way a deny-list would let it. The three escape hatches out of a printer —
 * a pipe into another program, a command substitution, a redirect — each veto
 * the exemption on their own.
 *
 * WHAT IT DOES NOT SEE (write this next to the gate, not after it):
 *  - heredoc bodies. `cat <<'EOF' … EOF` is not parsed, so a dangerous line in
 *    a heredoc body is still blocked. That is deliberate: parsing heredocs
 *    would open `bash <<EOF` as a blind spot.
 *  - `echo "$(…)"`, backticks, `<(…)`, `>(…)` — always left intact (condition
 *    iii), even when the substitution is inside single quotes.
 *  - printers outside the allowlist (`logger`, `notify-send`, `cat`) — a
 *    mention through them is still blocked. Growing the allowlist requires the
 *    segment conditions to be re-checked plus tests, not a one-line append.
 *  - a `;` inside quotes is not a separator (same limit as the 4.60.0
 *    separator work) — `echo 'a; rm -rf /'` is one segment, and it is blanked.
 *  - an unterminated quote is read as running to end of input. Such a command
 *    is a bash syntax error and executes nothing, so the segment is still
 *    eligible for the exemption.
 *
 * @module lib/core/command-segments
 */

/**
 * Commands that print or search their arguments and never execute them.
 * Allowlist — anything absent from it keeps the current blocking behaviour.
 */
const PRINTER_COMMANDS = new Set([
  'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'true', 'test', '[',
]);

/** `git <sub>` forms that only record a message. */
const GIT_MESSAGE_SUBCOMMANDS = new Set(['commit', 'tag', 'notes']);

/** Flags that turn a `git` message form into something that runs a program or an editor. */
const GIT_REJECT_FLAGS = new Set(['-e', '--exec', '--edit']);

/** Wrappers that are transparent: they run the command word that follows them. */
const TRANSPARENT_PREFIXES = new Set([
  'sudo', 'env', 'time', 'nohup', 'command', 'builtin', 'nice', 'timeout', 'xargs',
]);

/**
 * Wrapper flags whose VALUE is the next word (`sudo -u root`, `xargs -I {}`).
 * Deliberately small: a flag listed here that is really a boolean makes the
 * command word resolve to the wrong token, which ends in "not exempt" — a
 * false negative, never a hole.
 */
const FLAGS_TAKING_VALUE = new Set(['-u', '--user', '-I', '-d', '-a']);

/** `VAR=value` prefix assignment. Linear, no nested quantifier. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `timeout 30`, `nice -n 10`, `xargs -n 4` style numeric wrapper arguments. */
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

/** Characters replaced by {@link BLANK_FILL} when a segment is blanked. `\n`/`\r` survive. */
const BLANKABLE = /[^\n\r]/g;

/**
 * The filler a blanked segment is rewritten with. NOT a space: a space run is
 * `\s`, and the `$`-anchored L1 rules (`delete from …;\s*$`, `export PATH=\s*$`)
 * would read a blanked second line as trailing whitespace and match through it
 * — measured 2026-09-14 (lead), `delete from users;` + LF + `echo hi` flipped
 * from approve to block with a space filler. `@` is neither `\s` nor `\w`, no
 * rule in either catalogue references it, and it sits inside every `[^\n]`
 * window exactly like the text it replaces.
 */
const BLANK_FILL = '@';

/** Max words retained per segment for command-word resolution. */
const WORD_CAP = 24;

/** Max characters retained per word. A longer word is replaced by a sentinel. */
const WORD_LIMIT = 64;

/** Sentinel for a truncated word — matches no allowlist entry, so it fails closed. */
const LONG_WORD = '\u0000';

/**
 * Blank every segment of `raw` that can only print or match its arguments.
 *
 * The returned string has exactly the same length as the input, every character
 * outside an exempt segment is byte-identical, and inside an exempt segment
 * only `\n` and `\r` survive — every other character becomes
 * {@link BLANK_FILL}. Single pass, O(n) in the input length.
 *
 * @param {string} raw Raw command text, exactly as the user typed it.
 * @returns {string} Same-length text with printer segments blanked out.
 */
export function blankPrinterSegments(raw) {
  if (typeof raw !== 'string') return '';
  if (raw.length === 0) return raw;

  const ranges = collectExemptRanges(raw);
  if (ranges.length === 0) return raw;

  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) out += raw.slice(cursor, range.start);
    out += raw.slice(range.start, range.end).replace(BLANKABLE, BLANK_FILL);
    cursor = range.end;
  }
  return cursor < raw.length ? out + raw.slice(cursor) : out;
}

/** @returns {{words: string[], subst: boolean, redirect: boolean, reject: boolean, message: boolean, comment: boolean, pipe: boolean}} */
function freshSegment() {
  return {
    words: [],
    subst: false,
    redirect: false,
    reject: false,
    message: false,
    comment: false,
    pipe: false,
  };
}

/**
 * Scan `raw` once and collect the half-open ranges of the exempt segments.
 * @param {string} raw
 * @returns {Array<{start: number, end: number}>}
 */
function collectExemptRanges(raw) {
  const len = raw.length;
  const ranges = [];
  const state = {
    raw,
    len,
    depth: 0,
    word: '',
    wordOpen: false,
    truncated: false,
    seg: freshSegment(),
    segStart: 0,
    sepLength: 1,
    sepPipe: false,
  };

  let i = 0;
  while (i < len) {
    const ch = raw[i];

    if (ch === '\\') { i = readEscape(state, i); continue; }
    if (ch === "'") { i = readSingleQuote(state, i); continue; }
    if (ch === '"') { i = readDoubleQuote(state, i); continue; }
    if (ch === '`') { state.seg.subst = true; i = readBacktick(state, i); continue; }
    if (ch === '$') { i = readDollar(state, i); continue; }

    if (state.depth > 0) {
      if (ch === '(') state.depth += 1;
      else if (ch === ')') state.depth -= 1;
      i += 1;
      continue;
    }

    if (ch === '#' && !state.wordOpen) { i = readComment(state, i, ranges); continue; }
    if (ch === '<' || ch === '>') { i = readRedirect(state, i); continue; }

    if (takeSeparator(state, ch, i)) {
      closeSegment(state, i, state.sepPipe, ranges);
      i += state.sepLength;
      state.segStart = i;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') { finishWord(state); i += 1; continue; }

    addToWord(state, ch);
    i += 1;
  }

  closeSegment(state, len, false, ranges);
  return ranges;
}

/**
 * Classify `ch` as a segment separator at the top level.
 * `||` is a separator but NOT a pipe; `|` and `|&` are pipes (condition ii).
 *
 * Answers a boolean and writes the width/pipe-ness into `state` instead of
 * returning a record: a 122,880-byte separator run calls this once per byte,
 * and returning a fresh object there allocated 120K short-lived records for
 * nothing (measured 2026-09-14, see the linearity block in the test file).
 *
 * @param {object} state Scanner state; receives `sepLength` and `sepPipe`.
 * @param {string} ch
 * @param {number} i
 * @returns {boolean} whether `ch` starts a separator
 */
function takeSeparator(state, ch, i) {
  state.sepLength = 1;
  state.sepPipe = false;
  if (ch === '\n' || ch === ';') return true;
  if (ch === '&') {
    state.sepLength = state.raw[i + 1] === '&' ? 2 : 1;
    return true;
  }
  if (ch === '|') {
    const next = state.raw[i + 1];
    if (next === '|') { state.sepLength = 2; return true; }
    state.sepLength = next === '&' ? 2 : 1;
    state.sepPipe = true;
    return true;
  }
  // Grouping punctuation splits only at a word boundary, so `rm -rf /{a,b}`
  // and `find … {} \;` keep their command word attached to its own segment.
  return !state.wordOpen && (ch === '(' || ch === ')' || ch === '{' || ch === '}');
}

/**
 * Handle a backslash. A backslash before LF/CRLF is a line continuation — one
 * command, not a separator, and not a word break.
 * @param {object} state
 * @param {number} i
 * @returns {number} next index
 */
function readEscape(state, i) {
  const next = state.raw[i + 1];
  if (next === undefined) return i + 1;
  if (next === '\n') return i + 2;
  if (next === '\r' && state.raw[i + 2] === '\n') return i + 3;
  addToWord(state, next);
  return i + 2;
}

/**
 * Read a `'…'` literal span. An unterminated quote runs to end of input.
 * @param {object} state
 * @param {number} i index of the opening quote
 * @returns {number} next index
 */
function readSingleQuote(state, i) {
  const end = state.raw.indexOf("'", i + 1);
  const stop = end === -1 ? state.len : end;
  markSpanContent(state, i + 1, stop);
  return stop + 1;
}

/**
 * Read a `"…"` span, honouring backslash escapes. Command substitutions inside
 * still veto the exemption (condition iii).
 * @param {object} state
 * @param {number} i index of the opening quote
 * @returns {number} next index
 */
function readDoubleQuote(state, i) {
  const { raw, len } = state;
  let j = i + 1;
  while (j < len) {
    const ch = raw[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '"') break;
    j += 1;
  }
  const stop = Math.min(j, len);
  markSpanContent(state, i + 1, stop);
  return stop + 1;
}

/**
 * Read a `$'…'` ANSI-C span, honouring backslash escapes.
 * @param {object} state
 * @param {number} i index of the `$`
 * @returns {number} next index
 */
function readAnsiQuote(state, i) {
  const { raw, len } = state;
  let j = i + 2;
  while (j < len) {
    const ch = raw[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === "'") break;
    j += 1;
  }
  const stop = Math.min(j, len);
  markSpanContent(state, i + 2, stop);
  return stop + 1;
}

/**
 * Read a backtick span. Marking already happened at the call site.
 * @param {object} state
 * @param {number} i index of the opening backtick
 * @returns {number} next index
 */
function readBacktick(state, i) {
  const { raw, len } = state;
  let j = i + 1;
  while (j < len) {
    if (raw[j] === '\\') { j += 2; continue; }
    if (raw[j] === '`') break;
    j += 1;
  }
  state.wordOpen = true;
  return Math.min(j, len) + 1;
}

/**
 * Handle `$(`, `${`, `$'…'`, `$"…"` and a bare `$`.
 * @param {object} state
 * @param {number} i index of the `$`
 * @returns {number} next index
 */
function readDollar(state, i) {
  const next = state.raw[i + 1];
  if (next === '(') { state.seg.subst = true; state.depth += 1; state.wordOpen = true; return i + 2; }
  if (next === "'") return readAnsiQuote(state, i);
  if (next === '"') return readDoubleQuote(state, i + 1);
  if (next === '{') return readBraceExpansion(state, i);
  addToWord(state, '$');
  return i + 1;
}

/**
 * Read `${…}` as a single word, tolerating nesting.
 * @param {object} state
 * @param {number} i index of the `$`
 * @returns {number} next index
 */
function readBraceExpansion(state, i) {
  const { raw, len } = state;
  let j = i + 2;
  let nest = 1;
  while (j < len && nest > 0) {
    if (raw[j] === '{') nest += 1;
    else if (raw[j] === '}') nest -= 1;
    j += 1;
  }
  markSpanContent(state, i + 2, Math.min(j, len));
  return Math.min(j, len);
}

/**
 * Handle an unquoted `<`/`>`. Both veto the exemption (condition iv); `<(`/`>(`
 * additionally open a process-substitution context.
 * @param {object} state
 * @param {number} i
 * @returns {number} next index
 */
function readRedirect(state, i) {
  state.seg.redirect = true;
  if (state.raw[i + 1] === '(') {
    state.seg.subst = true;
    state.depth += 1;
    return i + 2;
  }
  return i + 1;
}

/**
 * Close the running segment at an unquoted `#` and read the comment to the end
 * of the line as its own (always exempt) segment.
 * @param {object} state
 * @param {number} i index of the `#`
 * @param {Array<{start: number, end: number}>} ranges
 * @returns {number} next index
 */
function readComment(state, i, ranges) {
  closeSegment(state, i, false, ranges);
  const nl = state.raw.indexOf('\n', i);
  const stop = nl === -1 ? state.len : nl;
  state.segStart = i;
  state.seg.comment = true;
  closeSegment(state, stop, false, ranges);
  state.segStart = stop;
  return stop;
}

/**
 * Record that a quoted/expanded span belongs to the current word, and flag any
 * command substitution found inside it — including inside single quotes, which
 * is deliberately conservative.
 * @param {object} state
 * @param {number} start
 * @param {number} end
 */
function markSpanContent(state, start, end) {
  const span = state.raw.slice(start, end);
  if (span.includes('$(') || span.includes('`') || span.includes('<(') || span.includes('>(')) {
    state.seg.subst = true;
  }
  addToWord(state, span);
}

/**
 * Append text to the word in progress, capped at {@link WORD_LIMIT}.
 * @param {object} state
 * @param {string} text
 */
function addToWord(state, text) {
  state.wordOpen = true;
  if (state.word.length + text.length > WORD_LIMIT) {
    state.truncated = true;
    return;
  }
  state.word += text;
}

/**
 * Finish the word in progress and fold it into the segment's flags.
 * Flag detection runs on EVERY word, not only the retained ones, so a reject
 * flag past the retention cap still vetoes the exemption.
 * @param {object} state
 */
function finishWord(state) {
  if (!state.wordOpen) return;
  const word = state.truncated ? LONG_WORD : state.word;
  state.word = '';
  state.truncated = false;
  state.wordOpen = false;

  if (GIT_REJECT_FLAGS.has(word)) state.seg.reject = true;
  if (word === '-m' || word === '--message' || word.startsWith('--message=')) {
    state.seg.message = true;
  }
  if (state.seg.words.length < WORD_CAP) state.seg.words.push(word);
}

/**
 * Close the running segment at `end` and record its range when it is exempt.
 * @param {object} state
 * @param {number} end exclusive end offset of the segment text
 * @param {boolean} pipe whether the separator that ends it is a pipe
 * @param {Array<{start: number, end: number}>} ranges
 */
function closeSegment(state, end, pipe, ranges) {
  finishWord(state);
  // A zero-width segment consumed no characters, so nothing was accumulated in
  // it and the record can be reused instead of reallocated. This is the whole
  // cost of a 122,880-byte `;`/`\n`/`|` run, which closes one empty segment per
  // byte (measured 2026-09-14: 120K newlines 4.07ms before, see the test file).
  if (end <= state.segStart) {
    state.seg.pipe = false;
    return;
  }
  state.seg.pipe = pipe;
  if (isExemptSegment(state.seg)) {
    ranges.push({ start: state.segStart, end });
  }
  state.seg = freshSegment();
}

/**
 * Decide whether a segment can only print or match its arguments.
 * All four conditions must hold; anything unrecognised answers `false`.
 * @param {object} seg
 * @returns {boolean}
 */
function isExemptSegment(seg) {
  if (seg.comment) return true;
  if (seg.pipe || seg.subst || seg.redirect) return false;

  const index = resolveCommandIndex(seg.words);
  if (index >= seg.words.length) return false;

  const command = seg.words[index];
  if (PRINTER_COMMANDS.has(command)) return true;
  if (command !== 'git') return false;
  if (seg.reject) return false;
  return GIT_MESSAGE_SUBCOMMANDS.has(seg.words[index + 1]) && seg.message;
}

/**
 * Index of the real command word, after leading assignments and transparent
 * wrappers (`sudo -u root env FOO=1 timeout 30 echo …`).
 * @param {string[]} words
 * @returns {number}
 */
function resolveCommandIndex(words) {
  let k = 0;
  let guard = 0;
  while (k < words.length && guard <= WORD_CAP) {
    guard += 1;
    const word = words[k];
    if (ASSIGNMENT.test(word)) { k += 1; continue; }
    if (!TRANSPARENT_PREFIXES.has(word)) return k;
    k = skipWrapperArgs(words, k + 1);
  }
  return k;
}

/**
 * Skip a transparent wrapper's own flags and numeric arguments.
 * @param {string[]} words
 * @param {number} start
 * @returns {number}
 */
function skipWrapperArgs(words, start) {
  let k = start;
  while (k < words.length) {
    const word = words[k];
    if (word.length > 1 && word.startsWith('-')) {
      k += FLAGS_TAKING_VALUE.has(word) ? 2 : 1;
      continue;
    }
    if (DURATION.test(word)) { k += 1; continue; }
    return k;
  }
  return k;
}
