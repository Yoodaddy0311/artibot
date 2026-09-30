/**
 * Markdown for the per-model usage table — the block a leader pastes at the end
 * of a completion report (`commands/team.md`, `commands/autopilot.md`,
 * `commands/split.md`).
 *
 * The numbers come from `usage-table.js#foldUsageTable`; this module only
 * decides how to SAY them, and it says the caveats in the same block as the
 * numbers, because a table pasted into a report travels without the CLI that
 * printed it:
 *
 *  - the price source and its reference date, and the unit prices that produced
 *    the dollars (so a reader can redo the multiplication);
 *  - `가격 미검증` — never a number — for a model whose catalog price is not
 *    verified, and a call-out with BOTH amounts for receipts recorded under an
 *    older price table (the recorded figure may be over-stated);
 *  - zero rows as "영수증 0행" with the reason, never as a table of zeros;
 *  - ONE limit line under the table: receipts are written by SessionEnd only,
 *    so a session that has not ended — the one producing the report, and every
 *    spawn inside it — is not in the ledger.
 *
 * PURITY. Same input, same string. The measurement time is the caller's
 * (`context.measuredAt`): a formatter that read the clock would print a
 * different report for the same table.
 *
 * WHAT THIS MODULE CANNOT SEE
 *  - HOW A VIEWER RENDERS THE TABLE. A pipe in a model id is escaped; nothing
 *    else about markdown dialects is checked.
 *  - WHETHER THE WORDING IS RIGHT FOR A READER WHO SKIPS THE NOTES. The table
 *    shows `가격 미검증` in the cost cell for the case that matters most; the
 *    rest of the caveats live in the lines below it.
 *
 * @module lib/economics/usage-table-render
 */

/** Text of the cost cell for a model that has no verified price. */
const UNVERIFIED = '가격 미검증';

/** Stamps that are not a price table: an unpriced receipt, or one with no stamp at all. */
const NON_TABLE_STAMPS = Object.freeze(['unresolved', 'missing']);

/** Most models named on one caveat line, so a wide ledger cannot make the notes longer than the table. */
const MAX_NAMED = 5;

/** `1234567` as `1,234,567`; the locale is pinned so the same table prints the same on every host. */
const fmtInt = (n) => Number(n).toLocaleString('en-US');

/**
 * Dollars for a cost cell. A positive amount under half a cent is `<$0.01`, not
 * `$0.00`: zero would read as a measured absence of spend. `null` is not a
 * price and has no text here — callers choose the wording.
 *
 * @param {number} n
 * @returns {string}
 */
function fmtUsd(n) {
  if (n > 0 && n < 0.005) return '<$0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A pipe would end the cell early. */
const escapeCell = (text) => String(text).replace(/\|/g, '\\|');

/** First eight characters of a session id — enough to find it, short enough to read. */
const shortId = (id) => String(id ?? '').slice(0, 8);

/** `claude-opus-5 [legacy]`, `mystery-9 [카탈로그 밖]`, or the bare id. */
function modelLabel(row) {
  if (row.id_status === 'legacy') return `${row.model_id} [legacy]`;
  if (row.id_status === 'unknown') return `${row.model_id} [카탈로그 밖]`;
  return row.model_id;
}

/** The cost cell of a model row. */
const rowCost = (cost) => (cost.usd === null ? UNVERIFIED : fmtUsd(cost.usd));

/** The bold cost cell of the total row; models left out of the sum are named by count. */
function totalCost(cost) {
  if (cost.usd === null) return `**${UNVERIFIED}**`;
  const left = cost.unpriced_models.length;
  return left === 0 ? `**${fmtUsd(cost.usd)}**` : `**${fmtUsd(cost.usd)}** (${UNVERIFIED} ${left}모델 제외)`;
}

/** The six count cells shared by a model row and the total row. */
function countCells(row) {
  return [
    fmtInt(row.sessions),
    fmtInt(row.spawns),
    fmtInt(row.usage.fresh_input_tokens),
    fmtInt(row.usage.output_tokens),
    fmtInt(row.usage.cached_input_tokens),
    fmtInt(row.usage.cache_creation_tokens),
  ];
}

/** @param {string[]} cells @returns {string} */
const tableRow = (cells) => `| ${cells.join(' | ')} |`;

/** The table: header, alignment row, one row per model, total row. */
function tableLines(table) {
  const lines = [
    '| 모델 | 세션 | 스폰 | 입력 | 출력 | 캐시 읽기 | 캐시 쓰기 | 비용(USD) |',
    '|---|--:|--:|--:|--:|--:|--:|--:|',
  ];
  for (const row of table.rows) {
    lines.push(tableRow([escapeCell(modelLabel(row)), ...countCells(row), rowCost(row.cost)]));
  }
  lines.push(tableRow(['**합계**', ...countCells(table.total), totalCost(table.total.cost)]));
  return lines;
}

// ---------------------------------------------------------------------------
// Header, scope, exclusions
// ---------------------------------------------------------------------------

/** The first line: what this is, how many receipts, when, and which ledger. */
function headerLine(counted, context) {
  return `**모델별 사용량·비용** — 영수증 ${fmtInt(counted)}행 · 측정 ${context.measuredAt ?? '미확인'} · 원장 ${context.ledgerPath ?? '미확인'}`;
}

/** `범위: …`, or null when the caller asked for everything. */
function scopeLine(filter) {
  const parts = [];
  if (filter.since !== null) parts.push(`시작 ≥ ${filter.since}`);
  if (filter.session_ids !== null) parts.push(`세션 ${filter.session_ids.length}개`);
  if (filter.run_ids !== null) parts.push(`런 ${filter.run_ids.length}개`);
  return parts.length === 0 ? null : `범위: ${parts.join(' · ')}`;
}

/**
 * The non-zero buckets of a list of `[label, count, hint]` candidates. The count
 * follows the label directly (`시작 경계에 걸침 1`) and any explanation follows
 * the count, so a reader can find a bucket by its name.
 */
function nonZeroParts(candidates) {
  return candidates
    .filter(([, n]) => n > 0)
    .map(([label, n, hint]) => `${label} ${fmtInt(n)}${hint}`);
}

/** Receipts the caller's own filters removed — expected, so they get the quieter line. */
function filterParts(receipts) {
  const f = receipts.filtered;
  return nonZeroParts([
    ['세션 필터', f.session, ''],
    ['런 필터', f.run, ''],
    ['시작 이전', f.before_since, ''],
  ]);
}

/**
 * Receipts left OUT of the sums for a reason about the receipt, not about the
 * caller's request — the ones a reader of the table should notice.
 */
function leftOutParts(receipts) {
  return nonZeroParts([
    ['형식 불량', receipts.malformed, ''],
    ['시작 경계에 걸침', receipts.filtered.straddling_since, '(세션 단위 합이라 분할 불가)'],
    ['시각 없음', receipts.filtered.no_time, ''],
    ['estimate 등급', receipts.estimate_grade, '(측정값과 섞지 않음)'],
    ['중복 기록', receipts.duplicates, ''],
  ]);
}

/** Why there are no rows: the ledger's state first, then what removed every receipt. */
function zeroReason(table, context) {
  if (context.ledgerState === 'missing') return '원장 파일이 없다';
  if (context.ledgerState === 'unreadable') return '원장을 읽지 못했다';
  const { seen } = table.receipts;
  if (seen === 0) return '원장에 usage.receipt 행이 없다';
  const parts = [...filterParts(table.receipts), ...leftOutParts(table.receipts)];
  return `원장 usage.receipt ${fmtInt(seen)}행 중 조건 통과 0행 (제외: ${parts.join(' · ')})`;
}

// ---------------------------------------------------------------------------
// Notes under the table
// ---------------------------------------------------------------------------

/** How much of the price table the catalog compared with the source. */
function verificationClause(rows) {
  const verified = rows.filter((r) => r.cost.usd !== null && r.cost.price_status === 'verified');
  if (verified.length === rows.length) return '공식 가격표와 대조됨(이후 공식 가격 변동은 미확인)';
  if (verified.length === 0) return '대조된 단가 없음';
  return `${verified.map((r) => r.model_id).join(', ')} 만 공식 가격표와 대조됨(이후 공식 가격 변동은 미확인)`;
}

/** Source, reference date, and what the dollars are (and are not). */
function priceSourceLine(table) {
  const { pricing } = table;
  return `- 단가 출처: ${pricing.source} · 카탈로그 기준일 ${pricing.version} — ${verificationClause(table.rows)}. `
    + '토큰×단가 환산이며 청구액이 아니다. 캐시 쓰기는 5분 TTL 단가라 하한.';
}

/** The unit prices that were applied, USD per million tokens. */
function unitPriceLine(table) {
  const used = table.pricing.models.filter((m) => m.per_mtok !== null
    && table.rows.some((r) => r.model_id === m.model_id && r.cost.usd !== null));
  if (used.length === 0) return null;
  const items = used.map((m) => {
    const p = m.per_mtok;
    return `${m.model_id} ${p.input}·${p.output}·${p.cache_read}·${p.cache_write_5m}`;
  });
  return `- 적용 단가($/MTok 입력·출력·캐시읽기·캐시쓰기): ${items.join(' · ')}`;
}

/** The models that carry no price, named so nobody reads a missing number as a free one. */
function unverifiedLine(table) {
  const ids = table.total.cost.unpriced_models;
  if (ids.length === 0) return null;
  return `- ${UNVERIFIED}: ${ids.join(', ')} — 카탈로그가 공식 가격표와 대조하지 않았거나 모르는 모델이라 비용을 표시하지 않고 합계에서 뺐다.`;
}

/**
 * `기록이 과다` / `기록이 과소` for a recorded figure against today's price of
 * the same tokens, or null when the two read the same at display precision —
 * a reader sees strings, so a difference below the printed cent has nothing to
 * explain.
 */
function staleVerdict(recorded, current) {
  if (fmtUsd(recorded) === fmtUsd(current)) return null;
  return recorded > current ? '기록이 과다' : '기록이 과소';
}

/** The stamps the rows carry other than the current price table — never a hard-coded date. */
function staleStamps(rows, current) {
  const stamps = new Set();
  for (const row of rows) {
    for (const stamp of Object.keys(row.cost.stamps)) {
      if (stamp !== current && !NON_TABLE_STAMPS.includes(stamp)) stamps.add(stamp);
    }
  }
  return [...stamps].sort();
}

/** `claude-opus-5-5 1건 기록 $50.00 → $4.00(기록이 과다)`, or null when that model reads the same. */
function staleModelItem(row) {
  const c = row.cost;
  if (c.stale_current_usd === null) return `${row.model_id} ${fmtInt(c.stale_receipts)}건(환산 불가)`;
  const verdict = staleVerdict(c.stale_recorded_usd, c.stale_current_usd);
  if (verdict === null) return null;
  return `${row.model_id} ${fmtInt(c.stale_receipts)}건 기록 ${fmtUsd(c.stale_recorded_usd)} → ${fmtUsd(c.stale_current_usd)}(${verdict})`;
}

/**
 * Receipts recorded under an older price table: what they recorded, what the
 * same tokens cost at today's table, and — only for the models where the two
 * differ — which way. The table shows today's price; this line is what makes a
 * possibly over-stated recorded figure visible instead of silently replaced.
 */
function staleLine(table) {
  const stale = table.rows.filter((r) => r.cost.stale_receipts > 0);
  if (stale.length === 0) return null;
  const total = table.total.cost;
  const stamps = staleStamps(stale, table.pricing.version).join(', ');
  const head = `- 구 단가 스탬프(${stamps})로 기록된 영수증 ${fmtInt(total.stale_receipts)}건 — 표는 현재 단가로 환산했다`;
  if (total.stale_current_usd === null) return `${head}(환산 불가 모델 포함)`;
  const sums = `기록 ${fmtUsd(total.stale_recorded_usd)} → 현재 단가 ${fmtUsd(total.stale_current_usd)}`;
  const items = stale.map(staleModelItem).filter((item) => item !== null);
  if (items.length === 0) return `${head}: ${sums}, 모델별 차이 없음`;
  const more = items.length > MAX_NAMED ? ` 외 ${items.length - MAX_NAMED}모델` : '';
  return `${head}: ${sums} — 차이 나는 모델: ${items.slice(0, MAX_NAMED).join(' · ')}${more}`;
}

/** Receipts that recorded no cost at all; the table filled them from tokens. */
function unrecordedLine(table) {
  const n = table.total.cost.unrecorded_receipts;
  if (n === 0) return null;
  return `- 영수증에 기록 비용이 없는 ${fmtInt(n)}건(cost.total 없음, 스탬프 unresolved)은 토큰×현재 단가로 채웠다.`;
}

/** `메인 스레드 1건 $3.21`; nothing after the count when the bucket is empty, `가격 미검증` when it could not be priced. */
function kindPart(label, kind) {
  let amount = '';
  if (kind.usd !== null) amount = ` ${fmtUsd(kind.usd)}`;
  else if (kind.receipts > 0) amount = ` ${UNVERIFIED}`;
  return `${label} ${fmtInt(kind.receipts)}건${amount}`;
}

/** Main-thread vs spawn spend, and what the session/spawn columns mean. */
function compositionLine(table) {
  return `- 구성: ${kindPart('메인 스레드', table.by_kind.main)} · ${kindPart('스폰', table.by_kind.spawn)}`
    + ' — 세션·스폰 수는 모델별로 따로 센 값이고 합계 행은 전체 고유 수다.';
}

/** What the caller's filters removed, only when they removed something. */
function filterLine(receipts) {
  const parts = filterParts(receipts);
  return parts.length === 0 ? null : `- 필터로 뺀 것: ${parts.join(' · ')}`;
}

/** What was left out of the sums, only when something was. */
function leftOutLine(receipts) {
  const parts = leftOutParts(receipts);
  return parts.length === 0 ? null : `- 집계에서 뺀 것: ${parts.join(' · ')}`;
}

/** Same-key receipts with different content: kept, and said. */
function collisionLine(receipts) {
  if (receipts.key_collisions === 0) return null;
  return `- 키 충돌 ${fmtInt(receipts.key_collisions)}건: 같은 세션·런·모델 키에 내용이 다른 영수증이 겹친다`
    + '(중복 기록이거나 run_id 가 redaction 으로 합쳐진 서로 다른 런) — 모두 합산했고 스폰 수는 적게 잡힐 수 있다.';
}

/** The note for a live-session read, in whichever state it ended. */
function liveLine(live) {
  if (live === null || live === undefined || live.requested !== true) return null;
  const id = shortId(live.session_id);
  switch (live.status) {
    case 'ok':
    case 'empty': {
      const parts = [live.status === 'ok'
        ? `영수증 ${fmtInt(live.receipts)}건(파일 ${fmtInt(live.files)}개)`
        : 'transcript 에서 영수증을 만들지 못했다(항목 0건)'];
      const unresolved = live.unresolved_models ?? [];
      if (live.replaced_ledger_receipts > 0) parts.push(`원장의 같은 세션 ${fmtInt(live.replaced_ledger_receipts)}건은 대체(이중 계산 방지)`);
      if (unresolved.length > 0) parts.push(`카탈로그가 모르는 모델 ${unresolved.join(', ')} 은 집계에서 빠졌다`);
      return `- 현재 세션 ${id}: transcript 직접 집계 — ${parts.join(', ')}. 진행 중인 스폰은 이 시각까지의 값.`;
    }
    case 'not-found':
      return `- 현재 세션 ${id} 의 transcript 를 찾지 못했다(검색: ${live.searched ?? '미확인'}) — 표에 현재 세션 없음.`;
    case 'blank-session-id':
      return '- 현재 세션 id 가 비어 있어 직접 집계를 건너뛰었다(환경변수 CLAUDE_CODE_SESSION_ID 가 비었을 수 있다).';
    case 'invalid-session-id':
      return '- 현재 세션 id 형식이 올바르지 않아 직접 집계를 건너뛰었다.';
    default:
      return `- 현재 세션 ${id} 의 transcript 를 읽지 못했다.`;
  }
}

/**
 * The one limit line. It is always the last line, and there is exactly one:
 * whichever variant applies says what is NOT in the table.
 */
function limitLine(live) {
  if (live !== null && live !== undefined && live.requested === true && live.status === 'ok') {
    return '- 한계: 다른 창(/split 워커 등)의 영수증은 그 세션의 SessionEnd 뒤에야 원장에 들어온다 — 끝나지 않은 다른 세션은 이 표에 없고, 현재 세션은 이 시각까지의 스냅샷이다(진행 중 스폰 포함).';
  }
  return '- 한계: 영수증은 SessionEnd 에서만 원장에 쓰인다 — 아직 끝나지 않은 세션(현재 세션과 그 스폰 전부, 열려 있는 /split 창)은 이 표에 없다'
    + '(현재 세션만 `--live-session <id>` 로 transcript 에서 직접 집계할 수 있다).';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the usage table as markdown.
 *
 * @param {object} table - {@link import('./usage-table.js').foldUsageTable} result.
 * @param {object} [context]
 * @param {string} [context.measuredAt] - ISO time the caller measured at.
 * @param {string|null} [context.ledgerPath] - the ledger file that was read.
 * @param {'ok'|'missing'|'unreadable'|null} [context.ledgerState] - what the
 *   read found; picks the reason printed when there are no rows.
 * @param {object|null} [context.live] - the live-session read, when one was
 *   requested (`scripts/ledger/usage-cost-table.mjs`).
 * @returns {string} markdown, no trailing newline.
 */
export function formatUsageTableMarkdown(table, context = {}) {
  const ctx = context ?? {};
  const out = [headerLine(table.receipts.counted, ctx)];
  const scope = scopeLine(table.filter);
  if (scope !== null) out.push(scope);

  // A blank line before and after the table: every markdown renderer then reads
  // it as a table, whatever it does with a table that follows a paragraph line
  // directly.
  if (table.total === null) {
    out.push(`조건에 맞는 usage.receipt 가 없다 — ${zeroReason(table, ctx)}. 비용 0 이 아니라 "측정된 영수증 없음"이다.`, '');
    out.push(...[liveLine(ctx.live), collisionLine(table.receipts), limitLine(ctx.live)].filter((l) => l !== null));
    return out.join('\n');
  }

  out.push('', ...tableLines(table), '');
  const notes = [
    priceSourceLine(table),
    unitPriceLine(table),
    unverifiedLine(table),
    staleLine(table),
    unrecordedLine(table),
    compositionLine(table),
    leftOutLine(table.receipts),
    filterLine(table.receipts),
    collisionLine(table.receipts),
    liveLine(ctx.live),
    limitLine(ctx.live),
  ];
  out.push(...notes.filter((line) => line !== null));
  return out.join('\n');
}
