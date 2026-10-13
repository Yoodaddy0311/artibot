/**
 * Generate docs/CLAUDE-MODEL-CATALOG.md from lib/core/model-catalog.js.
 *
 * model-catalog.js is the single source of truth for model specs; this script
 * renders that data into a Markdown reference and OVERWRITES the doc. The doc
 * is generated — never hand-edit it; change model-catalog.js and re-run.
 *
 * The per-model request-shape facts that the catalog's `thinkingMode` vocabulary
 * has no value for are rendered from each row's `thinkingNote`; none is typed here.
 *
 * Korean-path safety: the user's repo lives under `바탕 화면` (non-ASCII + space).
 * pathToFileURL() percent-encodes those chars and Node's import() on Windows
 * cannot resolve them, so we build the file:/// URL manually (see toFileUrl()).
 *
 * Usage:
 *   node scripts/gen-model-catalog-docs.js          # render + overwrite the doc
 *   node scripts/gen-model-catalog-docs.js --check  # render + compare only:
 *       exit 0 when the tracked doc already equals the render, exit 1 when it
 *       is stale or missing. Writes nothing — safe for CI / pre-commit.
 *
 * @module scripts/gen-model-catalog-docs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './hooks/_main-entry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const CATALOG_SRC = join(PLUGIN_ROOT, 'lib', 'core', 'model-catalog.js');
const OUT_PATH = join(PLUGIN_ROOT, 'docs', 'CLAUDE-MODEL-CATALOG.md');

/**
 * Convert an absolute filesystem path to a file:// URL for dynamic import().
 * Manual construction (not pathToFileURL) so Korean/space path segments are not
 * percent-encoded into something Node's import() cannot resolve on Windows.
 * Mirrors scripts/utils/index.js#toFileUrl.
 *
 * @param {string} filePath - Absolute filesystem path.
 * @returns {string} file:// URL string.
 */
function toFileUrl(filePath) {
  const forward = filePath.replace(/\\/g, '/');
  if (/^[A-Z]:/i.test(forward)) {
    return `file:///${forward}`;
  }
  return `file://${forward}`;
}

/** The tier rows, in the order the table lists them. */
const TIER_ORDER = Object.freeze(['fable', 'opus', 'sonnet', 'haiku']);

/** Ties a price cell to the price-band note under the table. */
const BAND_MARK = '†';

/**
 * The largest prompt, in tokens, a model's listed price applies to, or null when
 * the model has one price at any prompt length (catalog `priceMaxPromptTokens`).
 */
function bandOf(model) {
  return model.priceMaxPromptTokens ?? null;
}

/** Format a per-MTok price pair as `$in / $out`, marked when the price has a band. */
function priceCell(model) {
  const pair = `$${model.priceInPerMTok} / $${model.priceOutPerMTok}`;
  return bandOf(model) === null ? pair : `${pair} ${BAND_MARK}`;
}

/** Format a token count as a compact `1M` / `200K` style string. */
function tokens(n) {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}K`;
  return String(n);
}

/** Format a whole token count with thousands separators (`100000` -> `100,000`), locale-free. */
function withCommas(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Build the model spec table rows in a stable, baseline-first order.
 *
 * @param {object} catalog - The imported model-catalog module.
 * @returns {string[]} Markdown table lines.
 */
function specTable(catalog) {
  const lines = [
    '| Tier | Claude API ID | Context | Max output | Price in/out (per MTok) | tokenizerCoeff | Thinking |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const tier of TIER_ORDER) {
    const m = catalog.getModel(tier);
    if (!m) continue;
    const star = tier === 'fable' ? ' ⭐' : '';
    lines.push(
      `| \`${tier}\`${star} | \`${m.id}\` | ${tokens(m.ctxLimit)} | ` +
        `${tokens(m.outLimit)} | ${priceCell(m)} | ${m.tokenizerCoeff} | ` +
        `${m.thinkingMode} |`,
    );
  }
  return lines;
}

/**
 * The price-band note under the table: one bullet per tier whose listed price
 * stops at a prompt size. The tier, its id and the size are read from the catalog
 * and nothing is typed per tier, so a tier that gains or loses a band changes the
 * note and its table marker together. What the note says about a request over the
 * band is the catalog's own account (the `priceMaxPromptTokens` and haiku-row
 * comments in model-catalog.js) and the receipt writer's
 * `meta.overPriceBandRequests`; the higher price list itself is not in the catalog.
 *
 * @param {object} catalog - The imported model-catalog module.
 * @returns {string[]} Markdown lines; empty when no tier has a band.
 */
function priceBandLines(catalog) {
  const bullets = TIER_ORDER.flatMap((tier) => {
    const model = catalog.getModel(tier);
    const limit = model ? bandOf(model) : null;
    return limit === null
      ? []
      : [`- \`${tier}\` (\`${model.id}\`): up to ${withCommas(limit)} tokens.`];
  });
  if (bullets.length === 0) return [];
  return [
    `${BAND_MARK} **Price band.** A price marked ${BAND_MARK} holds only for a prompt up ` +
      'to the size listed for its tier below, where the prompt of a request is its ' +
      'input, cache-read and cache-write tokens together (exactly that size is inside ' +
      `the band). The official pricing page (\`${catalog.PRICING_SOURCE}\`) lists a ` +
      'higher price for a longer prompt; the catalog does not store it and no reader ' +
      'applies it, so a longer request is still priced at the listed columns and its ' +
      'cost is understated. The receipt writer counts such requests in ' +
      '`meta.overPriceBandRequests` and does not re-price them.',
    '',
    ...bullets,
  ];
}

/**
 * What each `thinkingMode` value means. Mirrors the closed vocabulary of the
 * `thinkingMode` typedef in lib/core/model-catalog.js; the test file fails when
 * the two name different sets. `adaptive` promises only the adaptive request
 * shape: whether disabling is accepted too varies per tier, and the sonnet row
 * rejects it.
 */
export const THINKING_LEGEND = Object.freeze({
  adaptive: "takes `{type:'adaptive'}`; whether `{type:'disabled'}` is accepted as well varies per tier",
  'always-on': "takes `{type:'adaptive'}` only; disabling and `budget_tokens` are rejected",
  extended: "takes `{type:'enabled', budget_tokens}` only, no adaptive",
});

/**
 * The per-model lines under the legend: one for each tier whose row carries a
 * `thinkingNote` read for the row's current id, in table order. The tier, id, mode,
 * day and text are the row's own. A note read for another id is not stated: the
 * tier moved on and nobody read the thinking page for the new model, and the
 * catalog test that pins `readFor` to `id` is the cue to read it again.
 *
 * @param {object} catalog - The imported model-catalog module.
 * @returns {string[]} Markdown bullet lines; empty when no tier has a current note.
 */
function thinkingNoteLines(catalog) {
  return TIER_ORDER.flatMap((tier) => {
    const model = catalog.getModel(tier);
    const note = model?.thinkingNote;
    if (!note || note.readFor !== model.id) return [];
    return [
      `- \`${tier}\` (\`${model.id}\`, \`${model.thinkingMode}\`, read ${note.readOn}): ${note.text}.`,
    ];
  });
}

/**
 * The legend for the Thinking column (only the values some tier uses) and the
 * per-model notes that apply to the catalog's current ids.
 *
 * @param {object} catalog - The imported model-catalog module.
 * @returns {string[]} Markdown lines.
 */
function thinkingLines(catalog) {
  const used = new Set(TIER_ORDER.map((tier) => catalog.getModel(tier)?.thinkingMode));
  const legend = Object.entries(THINKING_LEGEND)
    .filter(([mode]) => used.has(mode))
    .map(([mode, meaning]) => `- \`${mode}\`: ${meaning}.`);
  const notes = thinkingNoteLines(catalog);
  return [
    "The `Thinking` column is each tier's `thinkingMode`, the request shape it accepts:",
    '',
    ...legend,
    ...(notes.length === 0
      ? []
      : [
          '',
          'Per-model details the value does not carry (thinking page; each line gives the day it was read):',
          '',
          ...notes,
        ]),
  ];
}

/**
 * The cost-math baseline, read from the catalog so no model name or price is
 * typed here: `label` names the tier and its current id, `priceIn` is the
 * divisor of every cost factor.
 *
 * @param {object} catalog - The imported model-catalog module.
 * @returns {{label: string, priceIn: number}} Baseline facts for the prose.
 */
function baselineOf(catalog) {
  const tier = catalog.BASELINE_TIER;
  const model = catalog.getModel(tier);
  return {
    // Comma-set, not parenthesised: the prose already wraps the label in
    // parentheses in two places, and a nested pair reads badly.
    label: `the \`${tier}\` baseline, \`${model.id}\``,
    priceIn: model.priceInPerMTok,
  };
}

/**
 * The fable effective cost factor and its "price × tokenizer" breakdown, both
 * from catalog numbers, so the headline and its breakdown cannot disagree.
 *
 * @param {object} catalog - The imported model-catalog module.
 * @param {{priceIn: number}} baseline - Output of {@link baselineOf}.
 * @returns {{factor: number, breakdown: string}} Cost facts for the prose.
 */
function costOf(catalog, baseline) {
  const fable = catalog.getModel('fable');
  return {
    factor: catalog.getCostFactor('fable'),
    breakdown: `price ${fable.priceInPerMTok / baseline.priceIn}× × tokenizer ` +
      `${fable.tokenizerCoeff}×`,
  };
}

/**
 * The GENERATED banner, title and summary line that open the document.
 *
 * @returns {string[]} Markdown lines.
 */
function headerLines() {
  return [
    '<!--',
    '  GENERATED by scripts/gen-model-catalog-docs.js — 수기 수정 금지.',
    '  단일 진실원: lib/core/model-catalog.js. 스펙 변경 시 그 파일을 고치고',
    '  `node scripts/gen-model-catalog-docs.js`로 이 문서를 재생성하세요.',
    '-->',
    '',
    '# Claude Model Catalog (Artibot reference)',
    '',
    '> Single-source spec reference for Claude model tiers, IDs, prices, ' +
      'context/output limits, and tokenizer coefficients. Generated from ' +
      '`lib/core/model-catalog.js`.',
  ];
}

/**
 * Render the full Markdown document from catalog data.
 *
 * @param {object} catalog - The imported model-catalog module.
 * @returns {string} Markdown content.
 */
function renderDoc(catalog) {
  const fable = catalog.getModel('fable');
  const baseline = baselineOf(catalog);
  const cost = costOf(catalog, baseline);
  const out = [];

  out.push(...headerLines());
  out.push('');
  out.push('---');
  out.push('');
  out.push('## Model tiers');
  out.push('');
  out.push(...specTable(catalog));
  out.push('');
  out.push('⭐ = most capable widely released model.');
  out.push('');
  const band = priceBandLines(catalog);
  if (band.length > 0) out.push(...band, '');
  out.push(
    `\`tokenizerCoeff\` is tokens-per-content relative to ${baseline.label}, ` +
      'which is 1.0. A coefficient > 1.0 means the same text costs more tokens — ' +
      're-baseline `max_tokens`/budgets accordingly.',
  );
  out.push('');
  out.push(...thinkingLines(catalog));
  out.push('');
  out.push('---');
  out.push('');
  out.push(...fableSection(fable, cost, baseline.label));
  out.push('');
  out.push('---');
  out.push('');
  out.push(...routingSection(cost, baseline.label));
  out.push('');
  out.push('---');
  out.push('');
  out.push('## Sources');
  out.push('');
  // Plain-text references (no URL literals): the DATA POLICY outbound guard
  // (tests/ci/data-policy-outbound-guard.test.js) keeps a strict zero-URL
  // tripwire on this module — doc paths are cited by name instead.
  out.push('- platform.claude.com docs — "Models overview"');
  out.push('- platform.claude.com docs — "Introducing Claude Fable 5 and Claude Mythos 5"');
  out.push('');
  return out.join('\n');
}

/**
 * Render the Fable constraints section. The heading names the tier and the
 * catalog ID only — no generation number is typed here — so a model bump in
 * model-catalog.js flows into the doc without a hand edit in this file.
 *
 * @param {object} fable - The fable model spec.
 * @param {{factor: number, breakdown: string}} cost - Effective cost factor vs
 *   the baseline tier, and its catalog-derived "price × tokenizer" breakdown.
 * @param {string} baseline - Baseline label from {@link baselineOf}.
 * @returns {string[]} Markdown lines.
 */
function fableSection(fable, cost, baseline) {
  return [
    `## Claude Fable (\`${fable.id}\`)`,
    '',
    'Most capable widely released model. Behavioral constraints Artibot must ' +
      'honor when calling it directly:',
    '',
    '- **Thinking is always on** (`thinkingMode: always-on`) and cannot be ' +
      'disabled — control depth with `effort`, not `budget_tokens`.',
    '- **Refusal stop reason:** cyber/bio/chem safety classifiers can return ' +
      '`stop_reason: "refusal"` on a successful HTTP 200 (handle as a normal ' +
      'stop reason, not an error).',
    '- **No prefill:** assistant-message prefill is not supported.',
    '- **30-day data retention** required; not available under zero-data-retention.',
    '- **Task Budgets minimum 20k** tokens.',
    `- **Tokenizer coefficient ${fable.tokenizerCoeff}:** same content yields ` +
      `~${Math.round((fable.tokenizerCoeff - 1) * 100)}% more tokens than ` +
      `${baseline}.`,
    '',
    `Constraint keys (from \`model-catalog.js\`): ${fable.constraints
      .map((c) => `\`${c}\``)
      .join(', ')}.`,
    '',
    `Effective cost vs ${baseline}: **~${cost.factor}×** (${cost.breakdown}).`,
  ];
}

/**
 * Render the Artibot routing constraint section.
 *
 * @param {{factor: number, breakdown: string}} cost - See {@link fableSection}.
 * @param {string} baseline - Baseline label from {@link baselineOf}.
 * @returns {string[]} Markdown lines.
 */
function routingSection(cost, baseline) {
  return [
    '## Artibot routing constraint',
    '',
    'The Claude Code Agent/Task `model` enum now includes `fable` ' +
      '(`sonnet | opus | haiku | fable`) — Fable 5 **can** be a subagent tier.',
    '',
    '**Artibot policy, however, keeps Fable as explicit opt-in (allowlist) ' +
      'only:**',
    '',
    `- Default routing stays **Opus** (${baseline}, in the cost math) for ` +
      'every agent that is not allowlisted — the implementation, test, and ' +
      'marketing agents.',
    '- `fable` is selectable only when an agent is explicitly allowlisted for ' +
      'it (`artibot.config.json#/agents/modelPolicy/fable.allowlist`, the ' +
      'design + review roles); it is never the default. The allowlist wins ' +
      'over the `high` bucket declaration — a high-bucket agent outside it ' +
      'still resolves to `opus`.',
    '- Security-class agents (denylist) must NOT route to `fable`.',
    `- **Cost warning:** effective spend is ~${cost.factor}× ${baseline} ` +
      `(${cost.breakdown}) — budget before opting in.`,
    '',
    'Tier → role aliases live in `model-catalog.js#ROLE_ALIASES` ' +
      '(`frontier→opus`, `deep-async→fable`, `balanced→sonnet`, `fast→haiku`).',
  ];
}

/**
 * Compare a rendered doc against what is on disk WITHOUT writing. Line endings
 * are normalized (git may check the tracked doc out with CRLF on Windows) so a
 * pure EOL difference is not reported as drift.
 *
 * @param {string} rendered - Output of {@link renderDoc}.
 * @param {string|null} onDisk - Current file content, or null when the file is missing.
 * @returns {{ upToDate: boolean, reason: 'match'|'missing'|'stale' }}
 */
function checkDoc(rendered, onDisk) {
  if (onDisk === null) return { upToDate: false, reason: 'missing' };
  const norm = (s) => s.replace(/\r\n/g, '\n');
  return norm(rendered) === norm(onDisk)
    ? { upToDate: true, reason: 'match' }
    : { upToDate: false, reason: 'stale' };
}

/**
 * @param {string[]} argv - process.argv slice (flags only).
 * @returns {Promise<number>} Process exit code.
 */
async function main(argv = process.argv.slice(2)) {
  const catalog = await import(toFileUrl(CATALOG_SRC));
  const md = renderDoc(catalog);

  if (argv.includes('--check')) {
    let onDisk = null;
    try {
      onDisk = await readFile(OUT_PATH, 'utf-8');
    } catch {
      // missing doc → checkDoc reports 'missing'
    }
    const { upToDate, reason } = checkDoc(md, onDisk);
    if (upToDate) {
      console.log(`[gen-model-catalog-docs] --check: up to date (${OUT_PATH})`);
      return 0;
    }
    console.error(
      `[gen-model-catalog-docs] --check: ${reason} — ${OUT_PATH} does not match ` +
        'lib/core/model-catalog.js. Run `node scripts/gen-model-catalog-docs.js` and commit the result.',
    );
    return 1;
  }

  await writeFile(OUT_PATH, md, 'utf-8');
  console.log(`[gen-model-catalog-docs] wrote ${OUT_PATH}`);
  return 0;
}

const isDirectRun = isMainEntry(import.meta.url);
if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('Fatal:', err.message);
      process.exit(2);
    });
}

export { checkDoc, renderDoc, specTable, toFileUrl };
