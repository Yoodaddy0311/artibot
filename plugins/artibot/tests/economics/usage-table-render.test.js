/**
 * Contract for `lib/economics/usage-table-render.js` — the markdown a leader
 * pastes at the end of a completion report.
 *
 * WHAT IS PINNED
 * ---------------------------------------------------------------------------
 *  - the table: one row per serving model, a total row, the four token columns
 *    and the cost column, in the order the report reader expects;
 *  - COST HONESTY IN THE TEXT: the price source and its reference date are
 *    printed, the unit prices that produced the numbers are printed (so a reader
 *    can redo the multiplication), an unverified price is `가격 미검증` and never
 *    a number, and a receipt recorded under an old price stamp is called out with
 *    both amounts;
 *  - THE PRICE CHECK IS NOT OVERSTATED: the line says the catalog's own
 *    `priceMeasured` flag was the basis and that no per-model comparison source
 *    is shown — it never says every model was compared with the official page;
 *  - ZERO ROWS ARE PRINTED AS ZERO ROWS: no table, no `$0.00`, and the reason
 *    (no ledger / no receipts / everything filtered) is on the line — and it is
 *    the reason that applies: a missing ledger is not blamed for receipts a live
 *    read supplied and the filters removed;
 *  - WHAT THE READ COULD NOT SEE IS ON THE PAGE: unreadable ledger lines (they
 *    may have been receipts) and a live read that came back partial (the ledger
 *    rows were kept, so the session's cost may be under-stated);
 *  - A RECEIPT WITH NO `usage.source` IS `출처 미기재`, not an estimate;
 *  - THE LIMIT IS ONE LINE UNDER THE TABLE: SessionEnd is the only writer, so a
 *    session that has not ended is not in the ledger;
 *  - PURITY: same input, same string; the timestamp is the caller's.
 *
 * WHAT THIS FILE CANNOT SEE
 * ---------------------------------------------------------------------------
 *  - HOW A MARKDOWN VIEWER RENDERS THE TABLE. The strings are asserted, not the
 *    pixels: a pipe inside a model id would break a row and is guarded only by
 *    the escaping case below.
 *  - WHETHER THE WORDING IS RIGHT. Only load-bearing tokens are pinned (source,
 *    date, `가격 미검증`, `SessionEnd`, `0행`); a reworded sentence that keeps
 *    them stays green.
 *  - WHICH SOURCE THE CATALOG COMPARED A GIVEN PRICE WITH. The catalog keeps that
 *    in code comments, not in a field, so nothing here can assert it per model.
 *
 * @module tests/economics/usage-table-render
 */

import { describe, expect, it } from 'vitest';
import {
  getPricing,
  MODELS,
  PRICING_SOURCE,
  PRICING_VERSION,
  tierForModelId,
} from '../../lib/core/model-catalog.js';
import { priceUsage } from '../../lib/economics/usage-receipt.js';
import { foldUsageTable } from '../../lib/economics/usage-table.js';
import { formatUsageTableMarkdown, liveWarning } from '../../lib/economics/usage-table-render.js';

const OPUS_NEW = MODELS.opus.id;
const OPUS_OLD = MODELS.opus.legacyIds[0];
const SONNET_NEW = MODELS.sonnet.id;
const HAIKU = MODELS.haiku.id;

const MEASURED_AT = '2026-09-30T02:30:00.000Z';
const CTX = { measuredAt: MEASURED_AT, ledgerPath: '/repo/.git/artibot/ledger.jsonl', ledgerState: 'ok' };

function receipt(o = {}) {
  const {
    session = 'S1', run = 'agent-a1', model = OPUS_NEW, usage = {}, cost, source = 'transcript',
    started = '2026-09-30T00:00:00.000Z', completed = '2026-09-30T00:05:00.000Z',
  } = o;
  const tier = tierForModelId(model) ?? 'opus';
  const u = {
    source,
    fresh_input_tokens: 1000,
    cached_input_tokens: 200000,
    cache_creation_tokens: 10000,
    output_tokens: 5000,
    thinking_tokens: 100,
    requests: 3,
    ...usage,
  };
  return {
    v: 1,
    ts: completed,
    event: 'usage.receipt',
    session_id: session,
    run_id: run,
    model,
    data: {
      run_id: run,
      model_identity: { tier, model_id: model },
      usage: u,
      timing: { started_at: started, completed_at: completed, latency_ms: 300000 },
      cost: cost ?? priceUsage(u, tier, model),
    },
  };
}

const twoModels = () => foldUsageTable([
  receipt({ run: 'S1', model: OPUS_NEW, usage: { fresh_input_tokens: 1234567 } }),
  receipt({ run: 'agent-a1', model: SONNET_NEW }),
  receipt({ run: 'agent-a2', model: SONNET_NEW }),
]);

const lines = (md) => md.split('\n');

/** Catalog ports in which the named models have no verified price, and so no dollar figure. */
function unverifiedPorts(unverified) {
  return {
    getPricing: (key) => {
      const real = getPricing(key);
      return real === null ? null : { ...real, measured: !unverified.includes(key) };
    },
    priceUsage: (usage, tier, model) => (
      unverified.includes(model) ? { total: null, pricing_version: 'unresolved' } : priceUsage(usage, tier, model)
    ),
  };
}

/** A `live` block as `scripts/ledger/usage-cost-table.mjs` builds it. */
const liveBlock = (o = {}) => ({
  requested: true,
  status: 'ok',
  session_id: '64753a4c-d89c-4ced-a076-9f1e0a2f2d55',
  files: 3,
  receipts: 4,
  unreadable_files: 0,
  replaced_ledger_receipts: 0,
  kept_ledger_receipts: null,
  unresolved_models: [],
  searched: null,
  ...o,
});

describe('formatUsageTableMarkdown: the table', () => {
  it('prints a header, one row per model, and a total row', () => {
    const md = formatUsageTableMarkdown(twoModels(), CTX);
    const rows = lines(md).filter((l) => l.startsWith('|'));

    expect(rows[0]).toBe('| 모델 | 세션 | 스폰 | 입력 | 출력 | 캐시 읽기 | 캐시 쓰기 | 비용(USD) |');
    expect(rows[1]).toMatch(/^\|[-: |]+\|$/);
    expect(rows).toHaveLength(2 + 2 + 1); // header + rule + 2 models + total
    expect(rows[2]).toContain(OPUS_NEW);
    expect(rows[3]).toContain(SONNET_NEW);
    expect(rows[4]).toContain('**합계**');
    // Every row has the same number of cells.
    const cells = rows.map((r) => r.split('|').length);
    expect(new Set(cells).size).toBe(1);
  });

  it('sets the table off with a blank line above and below, whatever the renderer', () => {
    const all = lines(formatUsageTableMarkdown(twoModels(), CTX));
    const first = all.findIndex((l) => l.startsWith('| 모델'));
    const last = all.findIndex((l) => l.startsWith('| **합계**'));

    expect(all[first - 1]).toBe('');
    expect(all[last + 1]).toBe('');
    // The notes are a list, so a table row can never swallow them.
    expect(all[last + 2]).toMatch(/^- /);
  });

  it('names the receipt count, the measurement time and the ledger it read', () => {
    const md = formatUsageTableMarkdown(twoModels(), CTX);
    expect(lines(md)[0]).toContain('영수증 3행');
    expect(lines(md)[0]).toContain(MEASURED_AT);
    expect(lines(md)[0]).toContain(CTX.ledgerPath);
  });

  it('puts thousands separators in token counts', () => {
    const md = formatUsageTableMarkdown(twoModels(), CTX);
    // The opus receipt alone carries 1,234,567 fresh input tokens; the total row
    // adds the two sonnet receipts' 1,000 each.
    expect(md).toContain('| 1,234,567 |');
    expect(md).toContain('| 1,236,567 |');
    // Cache reads: 200,000 on the one opus receipt, 2 x 200,000 on the sonnet row.
    expect(md).toContain('| 200,000 |');
    expect(md).toContain('| 400,000 |');
  });

  it('marks a legacy id and an id the catalog does not know', () => {
    const table = foldUsageTable([
      receipt({ run: 'agent-1', model: OPUS_OLD }),
      receipt({ run: 'agent-2', model: 'claude-mystery-9' }),
    ]);
    const md = formatUsageTableMarkdown(table, CTX);
    expect(md).toContain(`${OPUS_OLD} [legacy]`);
    expect(md).toContain('claude-mystery-9 [카탈로그 밖]');
  });

  it('escapes a pipe in a model id so a row cannot grow a cell', () => {
    const table = foldUsageTable([receipt({ run: 'agent-1', model: 'claude|odd' })]);
    const md = formatUsageTableMarkdown(table, CTX);
    const row = lines(md).find((l) => l.startsWith('|') && l.includes('odd'));
    // Cells are counted on UNESCAPED pipes: `\|` is a literal pipe inside a cell.
    const cellCount = (line) => line.split(/(?<!\\)\|/).length;
    expect(cellCount(row)).toBe(cellCount(lines(md).find((l) => l.startsWith('| 모델'))));
    expect(row).toContain('claude\\|odd');
  });

  it('writes a sub-cent cost as <$0.01 instead of $0.00', () => {
    const table = foldUsageTable([receipt({
      run: 'agent-tiny', model: HAIKU,
      usage: { fresh_input_tokens: 10, cached_input_tokens: 0, cache_creation_tokens: 0, output_tokens: 1 },
    })]);
    const md = formatUsageTableMarkdown(table, CTX);
    expect(md).toContain('<$0.01');
    expect(md).not.toContain('$0.00');
  });

  it('never prints NaN, undefined or null in the table body', () => {
    const table = foldUsageTable([
      receipt({ run: 'agent-1', model: 'claude-mystery-9' }),
      receipt({ run: 'agent-2', model: OPUS_NEW }),
    ]);
    const md = formatUsageTableMarkdown(table, CTX);
    const body = lines(md).filter((l) => l.startsWith('|')).join('\n');
    expect(body).not.toMatch(/NaN|undefined|null/);
  });
});

describe('formatUsageTableMarkdown: cost honesty', () => {
  it('prints the price source, its reference date and the unit prices used', () => {
    const md = formatUsageTableMarkdown(twoModels(), CTX);
    expect(md).toContain(PRICING_SOURCE);
    expect(md).toContain(PRICING_VERSION);
    const opus = getPricing(OPUS_NEW);
    // `input·output·cache-read·cache-write` in USD per million tokens.
    expect(md).toContain(
      `${OPUS_NEW} ${opus.input}·${opus.output}·${opus.cacheRead}·${opus.cacheWrite5m}`,
    );
    // It is a conversion of tokens, not an invoice.
    expect(md).toMatch(/청구액이 아니/);
  });

  it('bases the price check on the catalog verified flag, says later changes are unchecked, and names no per-model source', () => {
    const md = formatUsageTableMarkdown(twoModels(), CTX);
    const line = lines(md).find((l) => l.startsWith('- 단가 출처:'));

    expect(line).toMatch(/카탈로그 가격 검증 표시\(priceMeasured\) 기준으로 검증됨/);
    expect(line).toMatch(/이후 공식 가격 변동은 미확인/);
    // The catalog records which source a price was compared with in code comments,
    // not in a field, so the table cannot name one per model — and says it does not.
    expect(line).toMatch(/모델별 대조 출처는 표시하지 않음/);
  });

  it('never says every model was compared with the official price table', () => {
    // One catalog row (the current sonnet id) is documented as compared with a skill
    // price table, not the official page, and its cache-write prices are derived: a
    // line that said "compared with the official price table" for every model
    // would be false for it.
    const md = formatUsageTableMarkdown(twoModels(), CTX);
    expect(md).not.toMatch(/공식 가격표와 대조/);
  });

  it('shows 가격 미검증 — never a number — for a model whose price is not verified', () => {
    const table = foldUsageTable([receipt({ run: 'agent-1', model: OPUS_NEW })], { ports: unverifiedPorts([OPUS_NEW]) });
    const md = formatUsageTableMarkdown(table, CTX);
    const row = lines(md).find((l) => l.includes(OPUS_NEW) && l.startsWith('|'));

    expect(row).toContain('가격 미검증');
    expect(row).not.toMatch(/\$\d/);
    expect(md).toMatch(/가격 미검증: .*claude-opus/);
    // A price line that claimed verification would contradict the row.
    expect(md).not.toMatch(/기준으로 검증됨/);
    expect(md).toMatch(/가격 검증 표시\(priceMeasured\)가 있는 단가 없음/);
  });

  it('names the verified models when only some are, instead of claiming the whole table', () => {
    const table = foldUsageTable([
      receipt({ run: 'agent-1', model: OPUS_NEW }),
      receipt({ run: 'agent-2', model: SONNET_NEW }),
    ], { ports: unverifiedPorts([OPUS_NEW]) });
    const line = lines(formatUsageTableMarkdown(table, CTX)).find((l) => l.startsWith('- 단가 출처:'));

    expect(line).toContain(`${SONNET_NEW} 만 카탈로그 가격 검증 표시(priceMeasured) 있음`);
    expect(line).not.toContain(`${OPUS_NEW} 만`);
    expect(line).not.toMatch(/기준으로 검증됨/);
  });

  it('calls out a receipt recorded under an old price stamp, with both amounts', () => {
    // One million fresh input tokens and nothing else, so today's price for the
    // receipt is exactly the catalog's input price per MTok.
    const stale = receipt({
      run: 'agent-old',
      usage: { fresh_input_tokens: 1000000, cached_input_tokens: 0, cache_creation_tokens: 0, output_tokens: 0 },
      // Deliberately far above any plausible input price, so "recorded > today"
      // holds whatever the catalog says.
      cost: { total: 50, pricing_version: '2026-09-12' },
    });
    const md = formatUsageTableMarkdown(foldUsageTable([stale]), CTX);
    const note = lines(md).find((l) => l.includes('구 단가'));

    expect(note).toBeDefined();
    expect(note).toContain('2026-09-12');
    expect(note).toContain(OPUS_NEW);
    expect(note).toContain('$50.00'); // what the receipt recorded
    expect(note).toContain(`$${getPricing(OPUS_NEW).input.toFixed(2)}`); // today's price for the same tokens
    expect(note).toMatch(/과다/);
  });

  it('does not list a model whose old-stamp receipts read the same as today, and says none differ', () => {
    // The legacy opus id keeps its own price row, so a receipt recorded under the
    // old stamp at THAT id's price is not over-stated. Naming it would be noise.
    const u = {
      source: 'transcript', fresh_input_tokens: 1000000, cached_input_tokens: 0, cache_creation_tokens: 0, output_tokens: 0,
    };
    const same = receipt({
      run: 'agent-same', model: OPUS_OLD, usage: u,
      cost: { total: priceUsage(u, 'opus', OPUS_OLD).total, pricing_version: '2026-09-12' },
    });
    const md = formatUsageTableMarkdown(foldUsageTable([same]), CTX);
    const note = lines(md).find((l) => l.includes('구 단가'));

    expect(note).toContain('2026-09-12');
    expect(note).toContain('모델별 차이 없음');
    expect(note).not.toContain('차이 나는 모델');
    expect(note).not.toMatch(/과다|과소/);
  });

  it('names only the models that differ when old-stamp receipts are mixed', () => {
    const u = {
      source: 'transcript', fresh_input_tokens: 1000000, cached_input_tokens: 0, cache_creation_tokens: 0, output_tokens: 0,
    };
    const same = receipt({
      run: 'agent-same', model: OPUS_OLD, usage: u,
      cost: { total: priceUsage(u, 'opus', OPUS_OLD).total, pricing_version: '2026-09-12' },
    });
    const over = receipt({ run: 'agent-over', model: OPUS_NEW, usage: u, cost: { total: 50, pricing_version: '2026-09-12' } });
    const under = receipt({ run: 'agent-under', model: SONNET_NEW, usage: u, cost: { total: 0.01, pricing_version: '2026-09-12' } });
    const md = formatUsageTableMarkdown(foldUsageTable([same, over, under]), CTX);
    const note = lines(md).find((l) => l.includes('구 단가'));

    expect(note).toContain('영수증 3건');
    const differing = note.slice(note.indexOf('차이 나는 모델'));
    expect(differing).toContain(`${OPUS_NEW} 1건 기록 $50.00`);
    expect(differing).toMatch(/기록이 과다/);
    expect(differing).toContain(`${SONNET_NEW} 1건 기록 $0.01`);
    expect(differing).toMatch(/기록이 과소/);
    // The legacy id is a PREFIX of the current one, so match it as a whole item
    // (`<id> <count>건`), not as a substring.
    expect(differing).not.toMatch(new RegExp(`${OPUS_OLD} \\d`));
  });

  it('says so when an unpriced receipt was filled from tokens', () => {
    const unpriced = receipt({ run: 'agent-u', cost: { total: null, pricing_version: 'unresolved' } });
    const md = formatUsageTableMarkdown(foldUsageTable([unpriced]), CTX);
    expect(md).toMatch(/기록 비용이 없는 1건/);
  });

  it('does not say an unpriced receipt was filled from tokens when its model has no verified price', () => {
    // Nothing was filled: the model has no price to multiply the tokens by, so the
    // row shows 가격 미검증 and the receipt stays out of the sum.
    const unpriced = receipt({ run: 'agent-u', model: OPUS_NEW, cost: { total: null, pricing_version: 'unresolved' } });
    const md = formatUsageTableMarkdown(foldUsageTable([unpriced], { ports: unverifiedPorts([OPUS_NEW]) }), CTX);

    expect(md).toContain('가격 미검증');
    expect(md).not.toContain('기록 비용이 없는');
    expect(md).not.toContain('채웠다');
  });

  it('counts only the receipts of priced models when it says unpriced ones were filled from tokens', () => {
    const noCost = { total: null, pricing_version: 'unresolved' };
    const table = foldUsageTable([
      receipt({ run: 'agent-u1', model: OPUS_NEW, cost: noCost }),
      receipt({ run: 'agent-u2', model: SONNET_NEW, cost: noCost }),
      receipt({ run: 'agent-u3', model: SONNET_NEW, cost: noCost }),
    ], { ports: unverifiedPorts([OPUS_NEW]) });
    const line = lines(formatUsageTableMarkdown(table, CTX)).find((l) => l.includes('기록 비용이 없는'));

    // Three receipts have no recorded cost; two of them belong to the priced model.
    expect(table.total.cost.unrecorded_receipts).toBe(3);
    expect(line).toMatch(/기록 비용이 없는 2건/);
    expect(line).toContain('토큰×현재 단가로 채웠다');
  });

  it('prints no old-stamp or unpriced note when every receipt carries the current stamp', () => {
    const md = formatUsageTableMarkdown(twoModels(), CTX);
    expect(md).not.toContain('구 단가');
    expect(md).not.toContain('기록 비용이 없는');
    expect(md).not.toContain('가격 미검증');
  });

  it('notes that cache writes are priced at the 5-minute rate (a lower bound)', () => {
    const md = formatUsageTableMarkdown(twoModels(), CTX);
    expect(md).toMatch(/캐시 쓰기는 5분 TTL 단가/);
    expect(md).toMatch(/하한/);
  });

  it('carries the date that stamps the price columns, not the date of the catalog data', () => {
    const md = formatUsageTableMarkdown(twoModels(), CTX);
    expect(md).toContain(`카탈로그 기준일 ${PRICING_VERSION}`);
  });
});

describe('formatUsageTableMarkdown: zero rows', () => {
  it('prints 영수증 0행 and no table when the ledger does not exist', () => {
    const md = formatUsageTableMarkdown(foldUsageTable([]), { ...CTX, ledgerState: 'missing' });
    expect(lines(md)[0]).toContain('영수증 0행');
    expect(md).toContain('원장 파일이 없다');
    expect(md).toContain(CTX.ledgerPath);
    expect(md).not.toContain('| 모델 |');
    expect(md).not.toContain('$0');
    expect(md).not.toContain('**합계**');
  });

  it('says the ledger could not be read when it could not', () => {
    const md = formatUsageTableMarkdown(foldUsageTable([]), { ...CTX, ledgerState: 'unreadable' });
    expect(md).toContain('원장을 읽지 못했다');
  });

  it('says there are no receipts in a ledger that has none', () => {
    const md = formatUsageTableMarkdown(foldUsageTable([]), CTX);
    expect(md).toContain('원장에 usage.receipt 행이 없다');
  });

  it('says how many receipts the filters removed when every one was filtered out', () => {
    const table = foldUsageTable(
      [receipt({ session: 'S1' }), receipt({ session: 'S1', run: 'agent-b' })],
      { sessionIds: ['nope'] },
    );
    const md = formatUsageTableMarkdown(table, CTX);
    expect(lines(md)[0]).toContain('영수증 0행');
    expect(md).toMatch(/2행 중 조건 통과 0행/);
    expect(md).toMatch(/세션 필터 2/);
    expect(md).not.toContain('| 모델 |');
  });

  it('does not blame a missing ledger for zero rows that the filters caused on a live read', () => {
    // No ledger file, but the current session was read from its transcript (2
    // receipts) and `--session` asked for a different session: the ledger being
    // absent is true and is not why the table is empty.
    const table = foldUsageTable(
      [receipt({ session: 'LIVE', run: 'LIVE' }), receipt({ session: 'LIVE', run: 'agent-a' })],
      { sessionIds: ['other'] },
    );
    const md = formatUsageTableMarkdown(table, { ...CTX, ledgerState: 'missing', live: liveBlock({ receipts: 2 }) });
    const finding = lines(md).find((l) => l.startsWith('조건에 맞는 usage.receipt 가 없다'));

    expect(finding).toMatch(/2행 중 조건 통과 0행/);
    expect(finding).toMatch(/세션 필터 2/);
    expect(finding).toContain('현재 세션 직접 집계');
    // The ledger's state is still said, as a fact about where the receipts came from.
    expect(finding).toContain('원장 파일이 없다');
    expect(finding).not.toMatch(/없다 — 원장 파일이 없다\./);
  });

  it('says the same for a ledger that could not be read', () => {
    const table = foldUsageTable([receipt({ session: 'LIVE', run: 'LIVE' })], { sessionIds: ['other'] });
    const md = formatUsageTableMarkdown(table, { ...CTX, ledgerState: 'unreadable', live: liveBlock({ receipts: 1 }) });
    const finding = lines(md).find((l) => l.startsWith('조건에 맞는 usage.receipt 가 없다'));

    expect(finding).toMatch(/1행 중 조건 통과 0행/);
    expect(finding).toContain('현재 세션 직접 집계');
    expect(finding).toContain('원장을 읽지 못했다');
    expect(finding).not.toMatch(/없다 — 원장을 읽지 못했다\./);
  });

  it('names both sources when a readable ledger and a live read together had receipts that the filters removed', () => {
    const table = foldUsageTable(
      [receipt({ session: 'S1' }), receipt({ session: 'S1', run: 'agent-b' }), receipt({ session: 'LIVE', run: 'LIVE' })],
      { sessionIds: ['other'] },
    );
    const md = formatUsageTableMarkdown(table, { ...CTX, live: liveBlock({ receipts: 1 }) });
    const finding = lines(md).find((l) => l.startsWith('조건에 맞는 usage.receipt 가 없다'));

    expect(finding).toMatch(/원장·현재 세션 직접 집계 usage\.receipt 3행 중 조건 통과 0행/);
    expect(finding).not.toMatch(/원장 파일이 없다|원장을 읽지 못했다/);
  });

  it('keeps naming the ledger alone when no live read contributed receipts', () => {
    const table = foldUsageTable([receipt({ session: 'S1' }), receipt({ session: 'S1', run: 'agent-b' })], { sessionIds: ['nope'] });
    // A live read that came back partial adds nothing to the fold, so it is not a source.
    const live = liveBlock({ status: 'incomplete', receipts: 5, unreadable_files: 1, kept_ledger_receipts: 0 });
    const finding = lines(formatUsageTableMarkdown(table, { ...CTX, live }))
      .find((l) => l.startsWith('조건에 맞는 usage.receipt 가 없다'));

    expect(finding).toContain('원장 usage.receipt 2행 중 조건 통과 0행');
    expect(finding).not.toContain('현재 세션 직접 집계');
  });

  it('keeps blaming the ledger when there was no receipt at all to filter', () => {
    // Nothing was seen, so the ledger's state IS the reason — even next to a live read
    // that produced nothing.
    const missing = formatUsageTableMarkdown(foldUsageTable([]), {
      ...CTX, ledgerState: 'missing', live: liveBlock({ status: 'empty', receipts: 0, files: 1 }),
    });
    expect(lines(missing).find((l) => l.startsWith('조건에 맞는 usage.receipt 가 없다'))).toContain('— 원장 파일이 없다.');
  });

  it('still carries the limit line, set off from the finding by a blank line', () => {
    const all = lines(formatUsageTableMarkdown(foldUsageTable([]), CTX));
    expect(all.join('\n')).toMatch(/한계: .*SessionEnd/);
    const finding = all.findIndex((l) => l.startsWith('조건에 맞는 usage.receipt 가 없다'));
    expect(all[finding + 1]).toBe('');
    expect(all[finding + 2]).toMatch(/^- 한계:/);
  });
});

describe('formatUsageTableMarkdown: the limit is one line under the table', () => {
  it('states that SessionEnd is the only writer and that an unfinished session is absent', () => {
    const md = formatUsageTableMarkdown(twoModels(), CTX);
    const limit = lines(md).filter((l) => l.includes('한계:'));
    expect(limit).toHaveLength(1);
    expect(limit[0]).toContain('SessionEnd');
    expect(limit[0]).toMatch(/끝나지 않은 세션/);
    expect(limit[0]).toContain('--live-session');
    // After the table, not before it.
    expect(lines(md).indexOf(limit[0])).toBeGreaterThan(lines(md).findIndex((l) => l.includes('**합계**')));
  });

  it('changes the limit when the current session was read live', () => {
    const live = {
      requested: true, status: 'ok', session_id: '64753a4c-d89c-4ced-a076-9f1e0a2f2d55',
      files: 3, receipts: 4, replaced_ledger_receipts: 0, unresolved_models: [], searched: null,
    };
    const md = formatUsageTableMarkdown(twoModels(), { ...CTX, live });
    const limit = lines(md).filter((l) => l.includes('한계:'));
    expect(limit).toHaveLength(1);
    expect(limit[0]).toMatch(/다른 창/);
    expect(limit[0]).not.toContain('--live-session');
    const note = lines(md).find((l) => l.includes('64753a4c'));
    expect(note).toContain('transcript 직접 집계');
    expect(note).toMatch(/영수증 4건/);
  });

  it('reports a live session it could not find, with where it looked', () => {
    const live = {
      requested: true, status: 'not-found', session_id: 'abcdef12-0000-0000-0000-000000000000',
      files: 0, receipts: 0, replaced_ledger_receipts: 0, unresolved_models: [], searched: '/home/u/.claude/projects',
    };
    const md = formatUsageTableMarkdown(twoModels(), { ...CTX, live });
    expect(md).toMatch(/abcdef12.*찾지 못했다/);
    expect(md).toContain('/home/u/.claude/projects');
    // Not read live, so the default limit still applies.
    expect(lines(md).find((l) => l.includes('한계:'))).toContain('--live-session');
  });

  it('reports a blank live session id as skipped', () => {
    const live = {
      requested: true, status: 'blank-session-id', session_id: '',
      files: 0, receipts: 0, replaced_ledger_receipts: 0, unresolved_models: [], searched: null,
    };
    const md = formatUsageTableMarkdown(twoModels(), { ...CTX, live });
    expect(md).toContain('세션 id 가 비어 있어');
  });

  it('names models the catalog rejected during the live read', () => {
    const live = {
      requested: true, status: 'ok', session_id: 'abcdef12-0000-0000-0000-000000000000',
      files: 1, receipts: 1, replaced_ledger_receipts: 2, unresolved_models: ['claude-future-9'], searched: null,
    };
    const md = formatUsageTableMarkdown(twoModels(), { ...CTX, live });
    expect(md).toContain('claude-future-9');
    expect(md).toMatch(/원장의 같은 세션 2건은 대체/);
  });

  it('warns that a live read was incomplete, what was not read, and that the ledger rows were kept', () => {
    const live = liveBlock({
      status: 'incomplete', files: 3, receipts: 2, unreadable_files: 1, kept_ledger_receipts: 2,
    });
    const md = formatUsageTableMarkdown(twoModels(), { ...CTX, live });
    const note = lines(md).find((l) => l.includes('64753a4c'));

    expect(note).toContain('live 판독 불완전: 읽지 못한 파일 1 — 원장 행 유지');
    expect(note).toContain('원장 행 2건');
    expect(note).toMatch(/영수증 2건은 표에 넣지 않았다/);
    expect(note).toMatch(/과소일 수 있다/);
    // It did not aggregate the transcript, and it must not say it did.
    expect(note).not.toContain('transcript 직접 집계');
    expect(note).not.toContain('대체(이중 계산 방지)');
    // Not read live as far as the table goes, so the default limit still applies.
    const limit = lines(md).filter((l) => l.includes('한계:'));
    expect(limit).toHaveLength(1);
    expect(limit[0]).toContain('--live-session');
  });

  it('says the session is missing from the table when an incomplete live read has no ledger rows to fall back on', () => {
    const live = liveBlock({
      status: 'incomplete', files: 2, receipts: 1, unreadable_files: 1, kept_ledger_receipts: 0,
    });
    const note = lines(formatUsageTableMarkdown(twoModels(), { ...CTX, live })).find((l) => l.includes('64753a4c'));

    expect(note).toContain('live 판독 불완전: 읽지 못한 파일 1 — 원장 행 유지');
    expect(note).toContain('원장 행 0건');
    expect(note).toContain('이 세션은 표에 없다');
  });

  it('prints the incomplete-read warning on a zero-row report too', () => {
    const live = liveBlock({
      status: 'incomplete', files: 2, receipts: 1, unreadable_files: 2, kept_ledger_receipts: 0,
    });
    const md = formatUsageTableMarkdown(foldUsageTable([]), { ...CTX, live });
    expect(md).toContain('live 판독 불완전: 읽지 못한 파일 2 — 원장 행 유지');
  });

  it('exports the warning sentence for the JSON output, and only for an incomplete read', () => {
    expect(liveWarning(liveBlock({ status: 'incomplete', unreadable_files: 3 })))
      .toBe('live 판독 불완전: 읽지 못한 파일 3 — 원장 행 유지');
    for (const status of ['ok', 'empty', 'not-found', 'blank-session-id', 'invalid-session-id', 'read-failed']) {
      expect(liveWarning(liveBlock({ status, unreadable_files: 3 })), status).toBeNull();
    }
    expect(liveWarning(null)).toBeNull();
    expect(liveWarning(undefined)).toBeNull();
    expect(liveWarning({ requested: false })).toBeNull();
  });
});

describe('formatUsageTableMarkdown: ledger lines that could not be read', () => {
  it('says how many were unreadable, and that they may have been receipts', () => {
    const all = lines(formatUsageTableMarkdown(twoModels(), { ...CTX, corruptLines: 2 }));
    const line = all.find((l) => l.includes('원장 깨진 줄'));

    expect(line).toBe('- 원장 깨진 줄 2 (usage.receipt 여부 판별 불가 — 비용 과소 가능)');
    // Under the table, and before the limit line that always closes the block.
    expect(all.indexOf(line)).toBeGreaterThan(all.findIndex((l) => l.includes('**합계**')));
    expect(all.indexOf(line)).toBeLessThan(all.findIndex((l) => l.includes('한계:')));
    expect(all.at(-1)).toMatch(/^- 한계:/);
  });

  it('says it on a zero-row report as well — an empty table beside unreadable lines is not a clean ledger', () => {
    const all = lines(formatUsageTableMarkdown(foldUsageTable([]), { ...CTX, corruptLines: 3 }));
    const line = all.find((l) => l.includes('원장 깨진 줄'));

    expect(line).toBe('- 원장 깨진 줄 3 (usage.receipt 여부 판별 불가 — 비용 과소 가능)');
    expect(all.at(-1)).toMatch(/^- 한계:/);
  });

  it('prints nothing when no line was unreadable, or when the caller did not say', () => {
    for (const corruptLines of [0, undefined, null]) {
      const md = formatUsageTableMarkdown(twoModels(), { ...CTX, corruptLines });
      expect(md, String(corruptLines)).not.toContain('깨진 줄');
    }
    expect(formatUsageTableMarkdown(twoModels(), CTX)).not.toContain('깨진 줄');
  });

  it('separates thousands like every other count', () => {
    const md = formatUsageTableMarkdown(twoModels(), { ...CTX, corruptLines: 1234 });
    expect(md).toContain('- 원장 깨진 줄 1,234 (');
  });
});

describe('formatUsageTableMarkdown: what was left out, and the scope', () => {
  it('lists only the non-zero left-out buckets, including estimate grade and key collisions', () => {
    const table = foldUsageTable([
      receipt({ run: 'agent-ok' }),
      receipt({ run: 'agent-est', source: 'estimate' }),
      receipt({ run: 'agent-dup' }),
      receipt({ run: 'agent-dup', usage: { output_tokens: 7 } }),
    ]);
    const md = formatUsageTableMarkdown(table, CTX);
    const line = lines(md).find((l) => l.startsWith('- 집계에서 뺀 것:'));
    expect(line).toContain('estimate 등급 1');
    expect(line).not.toContain('형식 불량');
    expect(line).not.toContain('출처 미기재');
    expect(md).not.toContain('- 필터로 뺀 것:');
    expect(md).toMatch(/키 충돌 1건/);
  });

  it('names a receipt with no usage.source 출처 미기재 — not estimate grade', () => {
    // Nobody graded it `estimate`: the row simply carries no source. Calling it an
    // estimate would put a claim on it that the row never made.
    const table = foldUsageTable([
      receipt({ run: 'agent-ok' }),
      receipt({ run: 'agent-nosrc', source: null }),
      receipt({ run: 'agent-nosrc2', source: null }),
    ]);
    const md = formatUsageTableMarkdown(table, CTX);
    const line = lines(md).find((l) => l.startsWith('- 집계에서 뺀 것:'));

    expect(line).toContain('출처 미기재 2');
    expect(line).toContain('측정값과 섞지 않음');
    expect(line).not.toContain('estimate 등급');
  });

  it('lists both when a ledger has an estimate-grade receipt and one with no source', () => {
    const table = foldUsageTable([
      receipt({ run: 'agent-ok' }),
      receipt({ run: 'agent-est', source: 'estimate' }),
      receipt({ run: 'agent-nosrc', source: null }),
    ]);
    const line = lines(formatUsageTableMarkdown(table, CTX)).find((l) => l.startsWith('- 집계에서 뺀 것:'));
    expect(line).toContain('estimate 등급 1');
    expect(line).toContain('출처 미기재 1');
  });

  it('keeps what the caller asked to filter on a quieter line of its own, apart from data problems', () => {
    // `--session` runs every completion report: "416 removed by the session
    // filter" is the request working, not a defect, and must not read like one.
    const table = foldUsageTable(
      [receipt({ session: 'S1', run: 'agent-a' }), receipt({ session: 'S2', run: 'agent-b' }), receipt({ session: 'S2', run: 'agent-c' })],
      { sessionIds: ['S1'] },
    );
    const md = formatUsageTableMarkdown(table, CTX);
    const filtered = lines(md).find((l) => l.startsWith('- 필터로 뺀 것:'));
    expect(filtered).toContain('세션 필터 2');
    expect(md).not.toContain('- 집계에서 뺀 것:');
  });

  it('describes the scope the caller asked for', () => {
    const table = foldUsageTable([receipt({ run: 'agent-1' })], {
      sessionIds: ['S1'], since: '2026-09-30T00:00:00.000Z', runIds: ['agent-1'],
    });
    const md = formatUsageTableMarkdown(table, CTX);
    const scope = lines(md).find((l) => l.startsWith('범위:'));
    expect(scope).toContain('세션 1개');
    expect(scope).toContain('시작 ≥ 2026-09-30T00:00:00.000Z');
    expect(scope).toContain('런 1개');
  });

  it('explains a straddling receipt instead of dropping it silently', () => {
    const table = foldUsageTable(
      [receipt({ run: 'S1', started: '2026-09-30T00:00:00.000Z', completed: '2026-09-30T02:00:00.000Z' })],
      { since: '2026-09-30T01:00:00.000Z' },
    );
    const md = formatUsageTableMarkdown(table, CTX);
    expect(md).toMatch(/시작 경계에 걸침 1/);
  });

  it('splits main-thread and spawn spend on one line', () => {
    const md = formatUsageTableMarkdown(twoModels(), CTX);
    const line = lines(md).find((l) => l.startsWith('- 구성:'));
    expect(line).toMatch(/메인 스레드 1건/);
    expect(line).toMatch(/스폰 2건/);
  });
});

describe('formatUsageTableMarkdown: purity', () => {
  it('returns the same string for the same input and never reads a clock', () => {
    const a = formatUsageTableMarkdown(twoModels(), CTX);
    const b = formatUsageTableMarkdown(twoModels(), CTX);
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(false);
  });

  it('does not throw on a missing context and says the time and ledger are unknown', () => {
    const md = formatUsageTableMarkdown(twoModels());
    expect(md).toContain('측정 미확인');
    expect(md).toContain('원장 미확인');
  });
});
