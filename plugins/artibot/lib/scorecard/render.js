/**
 * Render a scorecard as Markdown. Deterministic, and deliberately plain.
 *
 * DETERMINISM IS THE CONTRACT
 * ---------------------------------------------------------------------------
 * Same card in, same bytes out — no clock, no locale-dependent formatting, no
 * iteration over unsorted keys. Histograms arrive key-sorted from `metric()`
 * and are rendered in that order; percentages go through one fixed formatter.
 * A renderer whose output wobbles cannot be diffed between two runs, and
 * diffing two runs is the whole point of a scorecard (§35 vs §34: snapshot,
 * then final).
 *
 * WHY NO PROGRESS BAR
 * ---------------------------------------------------------------------------
 * §34 and §35 draw box-framed cards with filled bars. This renders tables
 * instead, for two reasons that both point the same way. First, PRD §3 excludes
 * changing any existing command's output in this wave, and the repo already has
 * a live progress-bar template pinned by
 * `tests/firewall/command-output-invariance.test.js` — a second bar renderer
 * would be a second answer to "what does an Artibot bar look like". Second, a
 * filled bar has no way to draw `unmeasured`: every bar-like glyph reads as a
 * measured zero, which is exactly the misreading this directory exists to
 * prevent. A table cell can hold the word.
 *
 * ── WHAT THIS RENDERER CANNOT SEE ───────────────────────────────────────────
 *   - Whether the card is TRUE. It formats what it is handed. A card built from
 *     an empty ledger renders a complete, well-formed page of `unmeasured`,
 *     and that page is the correct output rather than a failure.
 *   - Terminal width, theme, and TTY state. Unlike `lib/planning/scorecard.js`,
 *     which switches on `process.stdout.isTTY`, this emits one form only.
 *     Reading the process is an effect and this module is L2-pure.
 *
 * @module lib/scorecard/render
 */

import { UNMEASURED_TEXT } from './metric.js';

/** Heading per card kind. An allowlist — an unknown kind throws rather than renders. */
const HEADINGS = Object.freeze({
  session: 'ARTIBOT · SESSION SCORECARD',
  routing: 'ARTIBOT · ROUTING SCORECARD',
});

/** Column headers of the metric table, in render order. */
const COLUMNS = Object.freeze(['지표', '값', '분모', '비율', '미분류', '상태']);

/**
 * Format a ratio as a percentage with one decimal place.
 *
 * `toFixed` is used rather than `toLocaleString` because the latter's output
 * depends on the host locale, and a card that renders `34.5%` on one machine
 * and `34,5%` on another cannot be diffed.
 *
 * @param {number} ratio - the ratio, where 1 means 100%.
 * @returns {string} e.g. `34.5%`.
 */
export function formatPercent(ratio) {
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Escape the cell separator so a value containing `|` cannot forge a column.
 *
 * Metric labels and histogram keys are partly ledger-derived (mission ids, tier
 * names), and a ledger value is data rather than markup. An unescaped pipe
 * would let a written value change the shape of the table it appears in.
 *
 * @param {string} text - cell content.
 * @returns {string} content safe to place between pipes.
 */
export function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|');
}

/**
 * One metric's row cells.
 *
 * An unmeasured metric writes the word in BOTH the value and ratio columns. It
 * would be shorter to leave them blank, but a blank cell reads as "nothing
 * happened" and the word reads as "nobody measured" — the distinction this
 * whole directory is built around.
 *
 * @param {object} m - a metric from `metric()`.
 * @returns {string[]} six cells matching `COLUMNS`.
 */
export function metricRow(m) {
  const value = !m.measured
    ? UNMEASURED_TEXT
    : (m.numerator === null ? sumCounts(m.counts) : String(m.numerator));
  const ratio = m.ratio === null ? (m.measured ? '—' : UNMEASURED_TEXT) : formatPercent(m.ratio);
  return [
    escapeCell(m.label),
    escapeCell(value),
    String(m.denominator),
    ratio,
    String(m.absent),
    m.state,
  ];
}

/**
 * Total of a histogram, or `—` when there is none.
 *
 * @param {Record<string, number>|null} counts - histogram.
 * @returns {string} the sum, or an em dash.
 */
function sumCounts(counts) {
  if (!counts) return '—';
  let total = 0;
  for (const n of Object.values(counts)) total += n;
  return String(total);
}

/**
 * Render one Markdown table.
 *
 * @param {string[]} header - column headers.
 * @param {string[][]} rows - body rows.
 * @returns {string[]} lines.
 */
function table(header, rows) {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ];
}

/**
 * Render a scorecard as Markdown.
 *
 * @param {object} scorecard - a card from `buildSessionScorecard` or
 *   `buildRoutingScorecard`.
 * @returns {string} deterministic Markdown, newline-terminated.
 * @throws {TypeError} when the card is malformed or its kind is unknown.
 */
export function renderScorecardMarkdown(scorecard) {
  if (!scorecard || typeof scorecard !== 'object' || !Array.isArray(scorecard.metrics)) {
    throw new TypeError('renderScorecardMarkdown requires a scorecard object with metrics[].');
  }
  const heading = HEADINGS[scorecard.kind];
  if (!heading) {
    throw new TypeError(
      `renderScorecardMarkdown: unknown card kind ${JSON.stringify(scorecard.kind)}. `
      + `Known kinds: ${Object.keys(HEADINGS).join(', ')}.`,
    );
  }

  const out = [`# ${heading}`, ''];
  out.push(...scopeLines(scorecard.scope), '');
  out.push(...table(COLUMNS, scorecard.metrics.map(metricRow)), '');

  const distributions = scorecard.metrics.filter((m) => m.counts && Object.keys(m.counts).length);
  if (distributions.length > 0) {
    out.push('## 분포', '');
    for (const m of distributions) {
      out.push(...table(
        ['지표', '항목', '건수'],
        Object.entries(m.counts).map(([k, n]) => [escapeCell(m.label), escapeCell(k), String(n)]),
      ), '');
    }
  }

  out.push('## 근거', '');
  out.push(...table(
    ['지표', '원장 출처', '주의'],
    scorecard.metrics.map((m) => [escapeCell(m.label), escapeCell(m.source), escapeCell(m.note)]),
  ), '');

  out.push('## 미측정', '');
  if (scorecard.unmeasured.length === 0) {
    out.push('- 없음 — 모든 지표에 분모가 있었다.');
  } else {
    // The count is stated with its own denominator, because "3 unmeasured"
    // means something different on a card of 4 metrics than on a card of 30.
    out.push(`- ${scorecard.unmeasured.length} / ${scorecard.metrics.length} 지표가 분모 0 이다. `
      + '0% 가 아니라 미측정이다.');
    for (const key of scorecard.unmeasured) out.push(`  - \`${key}\``);
  }
  out.push('');
  return out.join('\n');
}

/**
 * Scope lines for the card header.
 *
 * @param {object} scope - the card's scope object.
 * @returns {string[]} lines.
 */
function scopeLines(scope) {
  return Object.entries(scope ?? {})
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `- **${escapeCell(k)}**: \`${escapeCell(v)}\``);
}
