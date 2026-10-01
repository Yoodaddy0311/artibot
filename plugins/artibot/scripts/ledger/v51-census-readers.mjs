/**
 * The reader registry behind `v51-census.mjs`: how each existing reader is
 * invoked, where it prints the ledger path it read, how its JSON becomes
 * numerator / denominator rows, and the consistency checks over a run. PURE — no
 * filesystem, no child process, no clock; `v51-census.mjs` is the impure shell
 * and owns every run.
 *
 * Split from the shell only to keep both under the 800-line standard. Nothing here
 * is a second arithmetic: a ratio the reader prints is carried through, and a
 * ratio is computed (`finishRow`) only where no reader owns one (an inventory share).
 *
 * EVERY EXTRACTOR MUST SURVIVE AN EMPTY OBJECT. When a reader dies the census still
 * needs the ROW IDS it would have produced, so it can mark them `error` with null
 * numbers instead of dropping them; it gets them by calling the extractor on `{}`.
 * An extractor therefore reads every field with optional access and never assumes
 * a key exists. Rows that depend on the data (one per served model) simply do not
 * appear for a dead reader.
 *
 * WHAT A SPEC SAYS (`READERS[i]`):
 *   id, axis    name and the Observe/Shadow/Canary axis it measures
 *   script      plugin-relative path of the reader
 *   feed        `cwd` (`--cwd <snapshot root>`), `ledger` (`--ledger <file>`) or
 *               `store` (its input is not the central ledger — run as-is)
 *   windowed    whether it takes `--since`
 *   prefix      arguments before the feed flags (`validate --live --json`)
 *   extra       (ctx) => more arguments (pass-throughs)
 *   inputPath   where the reader prints the ledger path it actually read
 *   census      where it prints the line census (`readLedgerCensus`'s)
 *   measuredAt  where it prints its own clock, or null when it has none
 *   extract     (result) => metric partials
 *   identities  (result) => identities the reader promises by construction
 *
 * @module scripts/ledger/v51-census-readers
 */

export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const get = (obj, dotted) => dotted.split('.')
  .reduce((o, k) => (o !== null && typeof o === 'object' ? o[k] : undefined), obj);

/**
 * A metric as an extractor returns it; the census adds reader, scope, status and
 * time. `counts` is `[numerator, denominator, ratio]`: the ratio is the reader's
 * own, or `undefined` when no reader owns one and the shell divides.
 */
function rowOf(id, label, unit, [numerator, denominator, ratio], extra = {}) {
  return { id, label, unit, numerator, denominator, ratio, ...extra };
}

function coverageRows(r) {
  const out = [rowOf('observe4.receipt-coverage', 'Observe 4 영수증 커버리지 (with_receipts / ended)', 'sessions',
    [r.with_receipts, r.ended, r.coverage], {
      note: '통과선 95%, 표본 조건 ended 50 이상(런북 3.4) — 이 행은 판정하지 않는다',
      detail: {
        receiptSessions: r.receipt_sessions,
        receiptOnlySessions: Array.isArray(r.receipt_only_sessions) ? r.receipt_only_sessions.length : null,
        malformedEnded: r.malformed_ended,
        duplicateEndedRows: r.duplicate_ended_rows,
      },
    })];
  const ex = get(r, 'views.window.excluded');
  if (isObj(ex)) {
    out.push(rowOf('observe4.receipt-coverage.excluded', 'Observe 4 제외 view (raw 행과 병기)', 'sessions',
      [ex.with_receipts, ex.ended, ex.coverage], { note: '--exclude-sessions 를 준 경우에만, session-coverage 한 판독기에만 적용' }));
  }
  return out;
}

function verifyRateRows(r) {
  const s = get(r, 'rate.sessions');
  const f = get(r, 'rate.firings');
  return [
    rowOf('observe3.verify-answered-sessions', 'Observe 3 /verify 자기보고가 답한 세션 (answered / hook)', 'sessions',
      [s?.answered, s?.hook, s?.rate]),
    rowOf('observe3.verify-answered-firings', 'Observe 3 자기보고가 답한 Stop 발화 (answered / hook)', 'firings',
      [f?.answered, f?.hook, f?.rate]),
    rowOf('observe3.verify-measured-firings', 'Observe 3 훅이 직접 잰 발화 (measured / hook)', 'firings',
      [f?.measured, f?.hook, f?.measured_rate]),
  ];
}

function callRateRows(r) {
  const carriers = get(r, 'call_rate.carriers') ?? {};
  return [['intent_command', 'intent-command'], ['tool_used_skill', 'tool-used-skill']].map(([key, id]) => {
    const c = carriers[key];
    return rowOf(`observe3.verify-call.${id}`, `Observe 3 /verify 호출이 자기보고를 남긴 세션 (${key})`, 'sessions',
      [c?.answered_sessions, c?.verify_sessions, c?.rate], { note: c?.status ?? null });
  });
}

function routeRows(r) {
  return [rowOf('observe2.route-agreement', 'Observe 2 추천 모델 = 서빙 모델 (same / compared)', 'spawn pairs',
    [get(r, 'by_agreement.same'), r.compared, r.agreement_rate], {
      detail: {
        binds: r.binds,
        receipts: r.receipts,
        excludedFifo: r.excluded_fifo,
        unjoinedBinds: r.unjoined_binds,
        unjoinedReceipts: r.unjoined_receipts,
        modelMismatch: r.model_mismatch,
        duplicateReceipts: r.duplicate_receipts,
      },
    })];
}

function existenceRows(r) {
  const kinds = isObj(r.kinds) ? r.kinds : {};
  return ['hooks', 'commands', 'skills'].map((kind) => {
    const entries = Array.isArray(kinds[kind]?.entries) ? kinds[kind].entries : null;
    const measured = entries === null ? null : entries.filter((e) => e.measured === true).length;
    const fired = entries === null ? null : entries.filter((e) => e.measured === true && e.fired > 0).length;
    return rowOf(`observe5.fired.${kind}`, `Observe 5 한 번 이상 발화한 ${kind} (measured 인벤토리 중)`, 'inventory entries',
      [fired, measured, undefined], {
        detail: {
          carrierRows: kinds[kind]?.denominator ?? null,
          enumerated: kinds[kind]?.enumerated ?? null,
          unmatchedNames: Object.keys(r.unmatched?.[kind] ?? {}).length,
        },
      });
  });
}

function usageRows(r) {
  const total = isObj(r.total) ? r.total : null;
  const rows = [rowOf('usage.receipts-counted', 'usage.receipt 행 중 집계된 것 (counted / seen)', 'receipts',
    [get(r, 'receipts.counted'), get(r, 'receipts.seen'), undefined], {
      detail: { malformed: get(r, 'receipts.malformed'), duplicates: get(r, 'receipts.duplicates') },
    })];
  for (const m of Array.isArray(r.rows) ? r.rows : []) {
    rows.push(rowOf(`usage.model.${m.model_id}`, `${m.model_id} 가 서빙한 영수증 (집계분 중)`, 'receipts',
      [m.receipts, total?.receipts, undefined], {
        detail: {
          tier: m.tier,
          idStatus: m.id_status,
          sessions: m.sessions,
          spawns: m.spawns,
          mainReceipts: m.main_receipts,
          spawnReceipts: m.spawn_receipts,
          listPriceUsd: get(m, 'cost.usd') ?? null,
        },
      }));
  }
  return rows;
}

function routingRows(r) {
  const d = isObj(r.denominators) ? r.denominators : {};
  const v = isObj(r.verdicts) ? r.verdicts : {};
  const rt = isObj(r.rates) ? r.rates : {};
  return [
    rowOf('canary.routing-honored', 'Canary 기대 티어대로 서빙된 스폰 (honored / measured)', 'spawn runs',
      [v.honored, d.measured, rt.honored_of_measured], { detail: { unhonored: v.unhonored, unmeasured: v.unmeasured } }),
    rowOf('canary.routing-joined', 'Canary 스폰 중 bind 와 영수증이 짝지어진 것 (joined / subagent_runs)', 'spawn runs',
      [d.joined, d.subagent_runs, rt.join_of_subagent_runs]),
  ];
}

function recoveryRows(r) {
  const c = isObj(r.census) ? r.census : {};
  const detail = {
    divergentFalse: r.divergentFalse,
    divergentMissing: r.divergentMissing,
    filesRead: c.filesRead,
    // The directory the reader actually read, so the row alone says which store it was.
    inputPath: r.inputPath ?? null,
  };
  // The session store moved out of the plugin root (owner decision D2) and the reader
  // then began to print these two. A reader from before the move prints neither, and
  // neither is invented here: each is surfaced only when it is present.
  if (typeof c.legacyFallback === 'boolean') detail.legacyFallback = c.legacyFallback;
  if (typeof c.primaryStore === 'string') detail.primaryStore = c.primaryStore;
  const fellBack = c.legacyFallback === true ? '옛 위치를 읽었다(새 저장소가 비어 있고 채택 기록이 없다)' : null;
  return [rowOf('ca03.recovery-journal-divergent', 'CA-03 복구 저널 중 divergent=true (divergentTrue / rows)', 'journal rows',
    [r.divergentTrue, r.rows, isObj(r.ratio) ? r.ratio.divergentTrue : null], {
      note: [r.status, fellBack].filter((x) => typeof x === 'string').join(' · ') || null,
      detail,
    })];
}

/** An identity that must hold by the reader's own construction; `holds` is null when a field is absent. */
function identity(id, lhs, rhs) {
  const holds = num(lhs) === null || num(rhs) === null ? null : lhs === rhs;
  return { id, holds, expected: rhs ?? null, actual: lhs ?? null };
}

function coverageIdentities(r) {
  const v = get(r, 'views.window.unexcluded');
  if (!isObj(v)) return [];
  const causes = isObj(v.skipped_by_cause) ? Object.values(v.skipped_by_cause).reduce((a, b) => a + b, 0) : null;
  return [
    identity('coverage-ended-is-covered-plus-skipped', v.ended, v.with_receipts + v.skipped),
    identity('coverage-skipped-causes-add-up', causes, v.skipped),
    identity('coverage-top-level-is-raw-window-view', r.ended, v.ended),
  ];
}

function routeIdentities(r) {
  return [identity('route-compared-is-same-plus-diverged', r.compared, get(r, 'by_agreement.same') + get(r, 'by_agreement.diverged'))];
}

function usageIdentities(r) {
  if (!isObj(r.total)) return [];
  const sum = Array.isArray(r.rows) ? r.rows.reduce((a, m) => a + (num(m.receipts) ?? 0), 0) : null;
  return [
    identity('usage-total-is-main-plus-spawn', r.total.receipts, r.total.main_receipts + r.total.spawn_receipts),
    identity('usage-rows-add-up-to-total', sum, r.total.receipts),
  ];
}

const pluginRootFlag = (ctx) => (ctx.pluginRoot === null ? [] : ['--plugin-root', ctx.pluginRoot]);

/**
 * Readers the census runs: seven against the snapshot and one against a store.
 *
 * @type {ReadonlyArray<object>}
 */
export const READERS = Object.freeze([
  {
    id: 'session-coverage', axis: 'observe-4', script: 'scripts/ledger/session-coverage.mjs', feed: 'cwd', windowed: true,
    extra: (ctx) => (ctx.exclude === null ? [] : ['--exclude-sessions', ctx.exclude]),
    inputPath: (r) => r.ledger_path, census: (r) => r.census, measuredAt: (r) => r.measured_at,
    extract: coverageRows, identities: coverageIdentities,
  },
  {
    id: 'verify-rate', axis: 'observe-3', script: 'scripts/ledger/verify-rate.mjs', feed: 'cwd', windowed: true,
    inputPath: (r) => r.file, census: (r) => r.census, measuredAt: () => null, extract: verifyRateRows,
  },
  {
    id: 'verify-call-rate', axis: 'observe-3', script: 'scripts/ledger/verify-call-rate.mjs', feed: 'cwd', windowed: true,
    inputPath: (r) => r.file, census: (r) => r.census, measuredAt: () => null, extract: callRateRows,
  },
  {
    id: 'route-compare', axis: 'observe-2', script: 'scripts/ledger/route-compare.mjs', feed: 'cwd', windowed: true,
    inputPath: (r) => r.ledger_path, census: (r) => r.census, measuredAt: (r) => r.measured_at,
    extract: routeRows, identities: routeIdentities,
  },
  {
    id: 'existence-audit', axis: 'observe-5', script: 'scripts/ledger/existence-audit.mjs', feed: 'cwd', windowed: true,
    extra: pluginRootFlag,
    inputPath: (r) => r.inputPath, census: (r) => r.summary?.census ?? null, measuredAt: (r) => r.measuredAt,
    extract: existenceRows,
  },
  {
    id: 'usage-cost-table', axis: 'economics', script: 'scripts/ledger/usage-cost-table.mjs', feed: 'ledger', windowed: true,
    prefix: ['--json'],
    inputPath: (r) => r.ledger_path, census: (r) => r.census, measuredAt: (r) => r.measured_at,
    extract: usageRows, identities: usageIdentities,
  },
  {
    id: 'model-routing-live', axis: 'canary', script: 'scripts/model-routing/model-routing.mjs', feed: 'cwd', windowed: true,
    prefix: ['validate', '--live', '--json'], extra: pluginRootFlag,
    inputPath: (r) => r.inputPath, census: (r) => r.census, measuredAt: () => null, extract: routingRows,
  },
  {
    id: 'recovery-journal-census', axis: 'ca-03', script: 'scripts/ledger/recovery-journal-census.mjs', feed: 'store', windowed: false,
    extra: (ctx) => (ctx.autopilotDir === null ? [] : ['--dir', ctx.autopilotDir]),
    inputPath: (r) => r.inputPath, census: () => null, measuredAt: (r) => r.measuredAt, extract: recoveryRows,
  },
]);

/**
 * Runbook 3.1 readers the census does NOT run, each with why and how to run it.
 * A reader that cannot be handed only a snapshot is listed here, never read live.
 *
 * @type {ReadonlyArray<{id: string, script: string, why: string, runSeparately: string}>}
 */
export const NOT_RUN = Object.freeze([
  {
    id: 'outcome-census', script: 'scripts/ledger/outcome-census.mjs',
    why: '원장 말고도 프로젝트 루트에서 상태 스토어와 미션 산출물을 읽는다 — 스냅샷만 넘기면 답이 달라진다',
    runSeparately: 'node scripts/ledger/outcome-census.mjs --cwd <repo> [--since <iso>]',
  },
  {
    id: 'nl-activation-report', script: 'scripts/evals/nl-activation-report.mjs',
    why: '결정 스토어와 원장을 하나의 --project-root 로 읽는다 — 스냅샷만 넘길 수 없다',
    runSeparately: 'node scripts/evals/nl-activation-report.mjs --project-root <repo>',
  },
  {
    id: 'topology-agreement', script: 'scripts/ledger/topology-agreement.mjs',
    why: '중앙 원장이 아니라 결정 스토어와 스폰 원장을 읽고, 기본 창이 이 리포의 릴리스 시각이다',
    runSeparately: 'node scripts/ledger/topology-agreement.mjs --cwd <repo> --since <iso> --json',
  },
  {
    id: 'question-rate', script: 'scripts/evals/question-rate.mjs',
    why: '원장이 아니라 호스트 transcript 를 읽고, 창 경계(설치 시각)를 사람이 정해야 한다',
    runSeparately: 'node scripts/evals/question-rate.mjs --cwd <repo> --window <name>=<iso>',
  },
  {
    id: 'resume-report', script: 'scripts/checkpoint/resume-report.mjs',
    why: '상태 스토어와 run.json 을 읽는다 — 원장 판독기가 아니다',
    runSeparately: 'node scripts/checkpoint/resume-report.mjs --all --cwd <repo> --json',
  },
  {
    id: 'read-order-guard', script: 'scripts/checkpoint/read-order-guard.mjs',
    why: '미션 하나를 판정하는 스크립트라 미션 id 가 필요하고, staleGuard 가 꺼져 있으면 출력이 없다',
    runSeparately: 'node scripts/checkpoint/read-order-guard.mjs --mission <M-id> --cwd <repo>',
  },
]);

/**
 * What the numbers cannot see. Always printed; none of these is a finding about
 * the project.
 *
 * @type {ReadonlyArray<{id: string, text: string}>}
 */
export const LIMITATIONS = Object.freeze([
  { id: 'snapshot-copy', text: '원장 유래 수치는 전부 시작 시점에 한 번 복사한 바이트 사본에서 나왔다. 그 뒤에 원장에 붙은 행은 어떤 수치에도 없고, 증가분은 ledger.bytesAtEnd 에만 있다.' },
  { id: 'store-readers-not-windowed', text: 'recovery-journal-census 는 원장이 아니라 자동조종 세션 저장소를 읽고 --since 를 받지 않는다. 범위는 all 이고 스냅샷 대상이 아니다. 읽은 디렉터리는 runs[].inputPath 에 있다. 기본은 판독기가 고른 위치(v4.71.0 부터 사용자 상태 디렉터리, 그 전에는 플러그인 루트 아래)이고, 새 저장소가 비어 있고 채택 기록이 없을 때만 옛 위치를 대신 읽는다(detail.legacyFallback). --autopilot-dir 를 주면 그 디렉터리만 읽고 폴백은 꺼진다.' },
  { id: 'since-semantics', text: '같은 --since 시각을 창 판독기 전부에 넘기지만 각 판독기가 자기 필드에 적용한다(행 타임스탬프 대 run 시작 시각 등). 창 경계에 걸친 세션은 창 수치에서 잘릴 수 있다.' },
  { id: 'exclusion-scope', text: '--exclude-sessions 는 session-coverage 에만 적용된다. 다른 판독기의 수치에는 제외한 세션의 행이 그대로 들어 있다(런북 1.5: raw 와 병기하고 분모를 깎은 것은 아닌지 본다).' },
  { id: 'existence-audit-inventory', text: 'existence-audit 는 오늘 디스크의 인벤토리(--plugin-root, 기본은 이 스크립트가 든 플러그인)를 이 프로젝트의 원장 이력에 대조한다. modules 는 어떤 이벤트도 싣지 않아 세지 않는다.' },
  { id: 'routing-expected-tier', text: 'model-routing-live 의 기대 티어는 오늘의 설정·로스터·사용자 override 로 계산한다. 스폰 당시 설정과 다를 수 있다.' },
  { id: 'list-price-cost', text: 'usage-cost-table 의 비용은 측정 토큰 x 카탈로그 정가다. 구독은 토큰당 청구하지 않는다.' },
  { id: 'repo-root-cwd', text: '--cwd 는 저장소 루트여야 한다. 하위 디렉터리를 주면 경로 해석기가 위로 올라가지 않아 없는 폴백 경로를 읽고 no-ledger 로 끝난다.' },
  { id: 'not-run-readers', text: 'notRun 의 판독기는 이 census 에 없다. 그 지표(SH-03, SH-04, SH-09, CA-05, CA-08, outcome 게이트)는 런북 3.1 대로 따로 잰다.' },
]);

// ---------------------------------------------------------------------------
// Folds over one reader run: metric rows and consistency checks (pure)
// ---------------------------------------------------------------------------

/**
 * One metric row. `measuredAtFrom` says where `measuredAt` comes from: `reader`
 * (the reader printed its own clock) or `census-run-start` (it printed none, so the
 * run's start stands in, runbook 2.1). A zero denominator is unmeasured with a null
 * ratio, never a measured 0.
 */
function finishRow(partial, run) {
  const numerator = num(partial.numerator);
  const denominator = num(partial.denominator);
  let status = 'measured';
  let reason = null;
  if (numerator === null || denominator === null) [status, reason] = ['unmeasured', 'field-missing'];
  else if (denominator === 0) [status, reason] = ['unmeasured', 'denominator-0'];
  const ratio = status === 'measured' ? (num(partial.ratio) ?? numerator / denominator) : null;
  return {
    id: partial.id,
    axis: run.axis,
    label: partial.label,
    reader: run.reader,
    scope: run.scope,
    unit: partial.unit,
    status,
    reason,
    numerator,
    denominator,
    ratio,
    measuredAt: run.measuredAt ?? run.startedAt,
    measuredAtFrom: run.measuredAt === null ? 'census-run-start' : 'reader',
    input: run.input,
    note: partial.note ?? null,
    detail: partial.detail ?? null,
  };
}

/** A row for a run that printed nothing to read: an error with null numbers, never a zero. */
function errorRow(partial, run) {
  return {
    ...finishRow({ ...partial, numerator: null, denominator: null, ratio: null }, run),
    status: 'error',
    reason: `${run.error.kind}: ${run.error.message}`,
  };
}

/**
 * Metric rows of one run. An extractor that throws is an error entry, not a crash.
 *
 * @param {object} spec a registry entry
 * @param {object} run one run record
 * @param {object[]} errors collects `extract-failed` entries
 * @returns {object[]}
 */
export function metricsOf(spec, run, errors) {
  if (run.status === 'skipped') return [];
  try {
    if (run.status === 'error') return spec.extract({}).map((p) => errorRow(p, run));
    const rows = spec.extract(run.result).map((p) => finishRow(p, run));
    return run.status === 'unmeasured' ? rows.map((r) => ({ ...r, status: 'unmeasured', reason: run.reason, ratio: null })) : rows;
  } catch (err) {
    errors.push({ reader: run.reader, scope: run.scope, kind: 'extract-failed', message: err?.message ?? String(err) });
    return [];
  }
}

/** A reader's line census adds up: raw = blank + nonblank, nonblank = losses + selection + survivors. */
function censusAddsUp(c) {
  const l = c?.lines;
  const d = c?.dropped_total;
  if (![l?.raw, l?.blank, l?.nonblank, d?.loss, d?.selection, c?.survivors].every((v) => num(v) !== null)) return null;
  return l.raw === l.blank + l.nonblank && l.nonblank === d.loss + d.selection + c.survivors;
}

/**
 * The checks that say "this reader read the snapshot". They must be PROVEN: a reader
 * that prints no input path, or no byte count, has shown nothing, and `null` (could
 * not be judged) is not a pass. The other checks (line arithmetic, a reader's own
 * identities) only fail on a violation; a field a reader does not print there is not
 * a claim about the snapshot.
 */
export const SNAPSHOT_CHECKS = Object.freeze([
  'reader-input-is-snapshot', 'reader-bytes-equal-snapshot', 'lines-raw-same-across-readers',
]);

const isProof = (check) => SNAPSHOT_CHECKS.includes(check.id);
const passes = (check) => (isProof(check) ? check.holds === true : check.holds !== false);

/** A consistency block for a census that checked nothing: `ok` is null, not true. */
export const noChecks = () => ({ ok: null, violated: 0, unproven: 0, checks: [] });

/** Checks for one snapshot-fed run that printed a result. */
function runChecks(spec, run, snap) {
  const put = (id, holds, expected, actual) => ({ id, reader: run.reader, scope: run.scope, holds, expected, actual });
  const printed = spec.census(run.result);
  const c = isObj(printed) ? printed : null;
  const bytes = num(c?.file?.bytes);
  const out = [
    put('reader-input-is-snapshot', run.inputIsSnapshot, snap.file, run.inputPath),
    // Always present: a reader that prints no census is an UNPROVEN check, not a missing one.
    put('reader-bytes-equal-snapshot', bytes === null ? null : bytes === snap.bytes, snap.bytes, bytes),
  ];
  if (c !== null) out.push(put('census-lines-add-up', censusAddsUp(c), true, censusAddsUp(c)));
  const own = spec.identities ? spec.identities(run.result) : [];
  return [...out, ...own.map((i) => put(i.id, i.holds, i.expected, i.actual))];
}

/**
 * Every consistency check: per-run path, bytes, line arithmetic and the identities
 * each reader promises, plus one cross-reader check that every reader counted the
 * same number of raw lines. A run that errored printed nothing trustworthy, so it
 * is left out rather than judged on the empty folds it printed.
 *
 * `ok` is true only when at least one check ran, none was violated and every
 * snapshot check was proven; it is null when nothing could be checked (a census
 * with no successful snapshot reader proves nothing, it does not pass).
 *
 * @param {ReadonlyArray<object>} readers the registry in use
 * @param {object[]} runs every run record
 * @param {{file: string, bytes: number}} snap the snapshot
 * @returns {{ok: boolean|null, violated: number, unproven: number, checks: object[]}}
 */
export function consistencyOf(readers, runs, snap) {
  const checks = [];
  const raws = [];
  for (const run of runs) {
    if (run.input !== 'snapshot' || run.result === null || run.status === 'error') continue;
    const spec = readers.find((r) => r.id === run.reader);
    checks.push(...runChecks(spec, run, snap));
    const raw = num(spec.census(run.result)?.lines?.raw);
    if (raw !== null) raws.push(raw);
  }
  const distinct = [...new Set(raws)];
  if (raws.length > 0) {
    checks.push({
      id: 'lines-raw-same-across-readers', reader: '*', scope: '*', holds: distinct.length === 1, expected: distinct[0], actual: distinct,
    });
  }
  return {
    ok: checks.length === 0 ? null : checks.every(passes),
    violated: checks.filter((c) => c.holds === false).length,
    unproven: checks.filter((c) => isProof(c) && c.holds === null).length,
    checks,
  };
}
