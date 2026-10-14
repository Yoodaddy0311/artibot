/**
 * `/doctor` Check 10 — Route Bind Residue — and the D9 rewrite of Check 7.
 *
 * ── What these tests DO establish ─────────────────────────────────────────
 * That `checkRouteBindResidue` returns the verdict design §2.3 invariant 3
 * specifies for hand-built counts, that `unmeasured` is returned whenever a
 * count was not supplied (and that `0` is not `undefined`), that an
 * `agent_bound_twice` conflict dated wholly before the v4.71.8 resume fix is
 * counted apart as legacy while every other conflict still fails, and that
 * `commands/doctor.md` says what the code does: ten checks, a `routing`
 * scope, one root for Check 7, S6 gone, `cron-` files counted apart.
 *
 * ── What they CANNOT establish (§9) ───────────────────────────────────────
 * - **Anything about a live ledger or spawn ledger.** Both inputs are
 *   integers built here. The tree that landed this file went from 0/0 and no
 *   spawns.ndjson (02:1x, `unmeasured`) to 3 receipts / 3 binds / 0 unbound
 *   (02:34, `pass`) once its review agents spawned — one live pass, recorded
 *   in `commands/doctor.md` Check 10. The warn and fail rows were each read
 *   once off this repo's ledger (2026-10-14: 6 unbound receipts against 311
 *   unbound spawns, and 5 legacy `agent_bound_twice` conflicts before the
 *   legacy rule existed), through the real ports and not through `/doctor`.
 * - **That the cutoff suits any ledger but this repo's.** `RESUME_REBIND_FIXED_AT`
 *   is read off that one ledger (latest conflicting row 2026-10-13T09:19:38.198Z)
 *   and the v4.71.8 release time; the bounds test pins it against those two
 *   literals, not against a ledger. Nothing here shows the fix works either: a
 *   ledger in which nothing was resumed since the cutoff is conflict-free too.
 * - **That `/doctor` was ever run.** The command is prose the model executes;
 *   these tests assert the prose names the right functions and rows, not that
 *   a run called them.
 * - **That the caller wires the two counts correctly.** `undefined` for an
 *   absent spawn ledger is a rule stated in the prose; a caller that passes
 *   `0` instead produces a green this suite cannot see.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkRouteBindResidue, CheckStatus, RESUME_REBIND_FIXED_AT,
} from '../../lib/project-state/doctor-checks.js';
import { joinRouteBinds } from '../../lib/replay/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const DOCTOR_MD = readFileSync(path.join(PLUGIN_ROOT, 'commands', 'doctor.md'), 'utf-8').replace(/\r\n/g, '\n');

/** The `### Check N` block, to the next level-2/3 heading. */
function section(md, n) {
  const headings = [...md.matchAll(/^#{2,3} .*$/gm)];
  const i = headings.findIndex((h) => h[0].startsWith(`### Check ${n}:`));
  if (i < 0) return null;
  const end = i + 1 < headings.length ? headings[i + 1].index : md.length;
  return md.slice(headings[i].index, end);
}

const codes = (r) => r.findings.map((f) => f.code);

describe('checkRouteBindResidue()', () => {
  it('is unmeasured when either count is missing, and says which', () => {
    const noSpawns = checkRouteBindResidue({ unboundReceipts: 3 });
    expect(noSpawns.status).toBe(CheckStatus.UNMEASURED);
    expect(noSpawns.findings[0].absent).toEqual(['unboundSpawns (spawn ledger)']);
    expect(noSpawns.counts).toEqual({ unboundReceipts: 3, unboundSpawns: null, conflicts: null, legacyConflicts: null });

    const noReceipts = checkRouteBindResidue({ unboundSpawns: 0 });
    expect(noReceipts.status).toBe(CheckStatus.UNMEASURED);
    expect(noReceipts.findings[0].absent).toEqual(['unboundReceipts (ledger join)']);

    const nothing = checkRouteBindResidue();
    expect(nothing.status).toBe(CheckStatus.UNMEASURED);
    expect(nothing.findings[0].absent).toHaveLength(2);
  });

  it('treats a non-integer or negative count as not supplied', () => {
    expect(checkRouteBindResidue({ unboundReceipts: '3', unboundSpawns: 3 }).status).toBe(CheckStatus.UNMEASURED);
    expect(checkRouteBindResidue({ unboundReceipts: -1, unboundSpawns: 3 }).status).toBe(CheckStatus.UNMEASURED);
    expect(checkRouteBindResidue({ unboundReceipts: 1.5, unboundSpawns: 3 }).status).toBe(CheckStatus.UNMEASURED);
  });

  it('passes on zero/zero and on equal non-zero counts', () => {
    expect(checkRouteBindResidue({ unboundReceipts: 0, unboundSpawns: 0 }).status).toBe(CheckStatus.PASS);
    const equal = checkRouteBindResidue({ unboundReceipts: 2, unboundSpawns: 2, conflicts: [] });
    expect(equal.status).toBe(CheckStatus.PASS);
    expect(equal.findings).toEqual([]);
    expect(equal.counts).toEqual({ unboundReceipts: 2, unboundSpawns: 2, conflicts: 0, legacyConflicts: 0 });
  });

  it('passes when only one side is non-zero (a legitimate asymmetry is not a mismatch)', () => {
    expect(checkRouteBindResidue({ unboundReceipts: 0, unboundSpawns: 4 }).status).toBe(CheckStatus.PASS);
    expect(checkRouteBindResidue({ unboundReceipts: 4, unboundSpawns: 0 }).status).toBe(CheckStatus.PASS);
  });

  it('warns when both are non-zero and different (invariant 3)', () => {
    const r = checkRouteBindResidue({ unboundReceipts: 3, unboundSpawns: 2 });
    expect(r.status).toBe(CheckStatus.WARN);
    expect(codes(r)).toEqual(['route-bind-residue-mismatch']);
    expect(r.findings[0]).toMatchObject({ unboundReceipts: 3, unboundSpawns: 2 });
    expect(r.findings[0].detail).toContain('invariant 3');
  });

  it('fails on any invariant-1 conflict, and the conflict list rides on the finding', () => {
    const conflicts = [{ type: 'tool_use_bound_twice', tool_use_id: 'tu-1', agent_ids: ['a', 'b'], count: 2 }];
    const r = checkRouteBindResidue({ unboundReceipts: 0, unboundSpawns: 0, conflicts });
    expect(r.status).toBe(CheckStatus.FAIL);
    expect(codes(r)).toEqual(['route-bind-conflict']);
    expect(r.findings[0].conflicts).toEqual(conflicts);
    expect(r.counts.conflicts).toBe(1);
    expect(r.counts.legacyConflicts).toBe(0);
  });

  it('ranks fail above warn when both apply', () => {
    const r = checkRouteBindResidue({
      unboundReceipts: 3, unboundSpawns: 1, conflicts: [{ type: 'agent_bound_twice' }],
    });
    expect(r.status).toBe(CheckStatus.FAIL);
    expect(codes(r)).toEqual(['route-bind-conflict', 'route-bind-residue-mismatch']);
  });

  it('reports conflicts as not counted (null) when the join was not supplied', () => {
    const r = checkRouteBindResidue({ unboundReceipts: 1, unboundSpawns: 1 });
    expect(r.status).toBe(CheckStatus.PASS);
    expect(r.counts.conflicts).toBeNull();
  });

  it('never throws on garbage', () => {
    expect(() => checkRouteBindResidue(null)).not.toThrow();
    expect(() => checkRouteBindResidue({ conflicts: 'x' })).not.toThrow();
    expect(checkRouteBindResidue(null).status).toBe(CheckStatus.UNMEASURED);
  });
});

describe('checkRouteBindResidue() — legacy conflicts (the v4.71.8 resume fix, 48e85610)', () => {
  const CUTOFF_MS = Date.parse(RESUME_REBIND_FIXED_AT);
  const at = (deltaMs) => new Date(CUTOFF_MS + deltaMs).toISOString();
  /** One `agent_bound_twice` conflict, shaped as `joinRouteBinds` emits it. */
  const rebind = (lastTs, extra = {}) => ({
    type: 'agent_bound_twice', agent_id: 'agent-a', tool_use_ids: ['tu-1', 'tu-2'], count: 2, last_ts: lastTs, ...extra,
  });
  const check = (conflicts, counts = {}) => checkRouteBindResidue({
    unboundReceipts: 0, unboundSpawns: 0, conflicts, ...counts,
  });

  it('sets aside agent_bound_twice conflicts dated wholly before the fix: pass, counted as legacy', () => {
    const r = check([rebind('2026-10-13T09:19:38.198Z'), rebind('2026-09-22T05:28:21.447Z', { agent_id: 'agent-b' })]);
    expect(r.status).toBe(CheckStatus.PASS);
    expect(r.findings).toEqual([]);
    expect(r.counts).toEqual({ unboundReceipts: 0, unboundSpawns: 0, conflicts: 0, legacyConflicts: 2 });
  });

  it('fails on a conflict whose latest row is at or after the cutoff, and not one millisecond earlier', () => {
    expect(check([rebind(at(-1))]).status).toBe(CheckStatus.PASS);
    for (const delta of [0, 1, 3_600_000]) {
      const r = check([rebind(at(delta))]);
      expect(r.status, `delta ${delta}`).toBe(CheckStatus.FAIL);
      expect(r.counts, `delta ${delta}`).toMatchObject({ conflicts: 1, legacyConflicts: 0 });
    }
  });

  it('splits a mixed list: only the live conflict fails, and only it rides on the finding', () => {
    const old = rebind('2026-10-13T09:19:38.198Z');
    const live = rebind(at(60_000), { agent_id: 'agent-b' });
    const r = check([old, live]);
    expect(r.status).toBe(CheckStatus.FAIL);
    expect(codes(r)).toEqual(['route-bind-conflict']);
    expect(r.findings[0].conflicts).toEqual([live]);
    expect(r.findings[0].detail).toContain('1 invariant-1 violation');
    expect(r.counts).toMatchObject({ conflicts: 1, legacyConflicts: 1 });
  });

  it('covers only the kind the fix addressed: any other conflict fails however old', () => {
    const old = '2026-09-22T05:28:21.447Z';
    const toolTwice = { type: 'tool_use_bound_twice', tool_use_id: 'tu-1', agent_ids: ['a', 'b'], count: 2, last_ts: old };
    const dupReceipt = { type: 'receipt_duplicate', tool_use_id: 'tu-1', session_id: 's' };
    expect(check([toolTwice]).status).toBe(CheckStatus.FAIL);
    expect(check([dupReceipt]).status).toBe(CheckStatus.FAIL);
    expect(check([rebind(old, { type: 'a_kind_not_written_yet' })]).status).toBe(CheckStatus.FAIL);
  });

  it('treats a conflict it cannot date, or dates in any form but the join\'s own, as live', () => {
    // Every value below is old if read leniently (`Date.parse(2000)`, `Date.parse('2000')` and the
    // date-only and offset spellings are all valid instants before the cutoff). The join emits
    // `toISOString()` text only, so anything else is a caller's hand-built value, not a measurement.
    const lenientlyOld = [2000, '2000', '2026-09-22', '2026-09-22T05:28:21+00:00'];
    for (const lastTs of [null, undefined, '', 'not-a-time', ...lenientlyOld]) {
      expect(check([rebind(lastTs)]).status, String(lastTs)).toBe(CheckStatus.FAIL);
    }
    expect(check([null]).status).toBe(CheckStatus.FAIL);
  });

  it('does not let a legacy conflict hide a residue mismatch', () => {
    const r = check([rebind('2026-10-13T09:19:38.198Z')], { unboundReceipts: 3, unboundSpawns: 2 });
    expect(r.status).toBe(CheckStatus.WARN);
    expect(codes(r)).toEqual(['route-bind-residue-mismatch']);
    expect(r.counts.legacyConflicts).toBe(1);
  });

  it('keeps the cutoff between the last conflicting row on record and the v4.71.8 release', () => {
    // Lower bound: the latest of the 5 conflicts read off this repo's ledger on 2026-10-14. Move
    // the cutoff earlier and a known legacy row fails again. Upper bound: the release time. Move it
    // later and a row written by an updated install could be set aside as legacy.
    expect(CUTOFF_MS).toBeGreaterThanOrEqual(Date.parse('2026-10-13T09:19:38.198Z'));
    expect(CUTOFF_MS).toBeLessThanOrEqual(Date.parse('2026-10-13T11:21:46Z'));
  });

  it('reads what joinRouteBinds emits: a re-bind written before the fix is legacy, one after it fails', () => {
    const line = (fields, ts) => ({
      v: 1, ts, mission_id: 'M-20261013-001', session_id: 's-seam', source: 'hook', pid: 1, seq: 1, ...fields,
    });
    const receipt = (tu, ts) => line({
      event: 'route.selected', routing_epoch_id: tu, data: { shadow_of: `tool_use:${tu}` },
    }, ts);
    const bind = (tu, agent, ts) => line({
      event: 'route.bound', routing_epoch_id: agent, data: { tool_use_id: tu, agent_id: agent },
    }, ts);
    const verdict = (secondBindTs) => {
      const join = joinRouteBinds([
        receipt('tu-1', at(-7_200_000)), receipt('tu-2', at(-7_200_000)),
        bind('tu-1', 'agent-a', at(-7_100_000)), bind('tu-2', 'agent-a', secondBindTs),
      ]);
      return checkRouteBindResidue({
        unboundReceipts: join.unbound_receipts.length, unboundSpawns: 0, conflicts: join.conflicts,
      });
    };
    const legacy = verdict(at(-3_600_000));
    expect(legacy.status).toBe(CheckStatus.PASS);
    expect(legacy.counts).toMatchObject({ conflicts: 0, legacyConflicts: 1 });
    // The first bind predates the fix and the resume's re-bind does not: the conflict is live.
    const live = verdict(at(3_600_000));
    expect(live.status).toBe(CheckStatus.FAIL);
    expect(live.counts).toMatchObject({ conflicts: 1, legacyConflicts: 0 });
  });
});

describe('commands/doctor.md — Check 10', () => {
  const ten = section(DOCTOR_MD, 10);

  it('exists, is scoped, and has an output line', () => {
    expect(ten).toBeTypeOf('string');
    expect(DOCTOR_MD).toMatch(/^### Check 10: Route Bind Residue$/m);
    expect(DOCTOR_MD).toMatch(/^- `routing`: Check 10 only/m);
    expect(DOCTOR_MD).toMatch(/^- \(no argument\): Run all 10 checks$/m);
    expect(DOCTOR_MD).toMatch(/^\[check-10-icon] Route bind: /m);
  });

  it('names the join, the two counters, the judgement, and the design invariant', () => {
    expect(ten).toContain('route-bind.js#joinRouteBinds');
    expect(ten).toContain('countUnboundSpawns');
    expect(ten).toContain('doctor-checks.js#checkRouteBindResidue');
    expect(ten).toContain('ROUTE-RECEIPT-PRETOOLUSE-DESIGN.md');
    expect(ten).toContain('invariant 3');
    expect(ten).toContain('readLedgerCensus');
    expect(ten).toContain('spawns.ndjson');
  });

  it('states the four status rows in the code\'s order and the undefined-not-zero rule', () => {
    const rows = ['**unmeasured**', '**fail**', '**warn**', '**pass**'];
    let last = -1;
    for (const row of rows) {
      const i = ten.indexOf(row);
      expect(i, row).toBeGreaterThan(last);
      last = i;
    }
    expect(ten).toContain('pass `undefined`, not `0`');
    expect(ten).toContain('unmeasured is not a pass');
    expect(ten).toContain('NOT a `--fix` target');
  });

  it('sets legacy conflicts apart: names the cutoff, the fix, the kind it covers and the count', () => {
    expect(ten).toContain('RESUME_REBIND_FIXED_AT');
    expect(ten).toContain('48e85610');
    expect(ten).toContain('agent_bound_twice');
    expect(ten).toContain('last_ts');
    expect(ten).toContain('legacyConflicts');
    expect(DOCTOR_MD).toMatch(/^\[check-10-icon] Route bind: .*\{n} legacy/m);
  });

  it('is scoped as the tenth check in the summary and the JSON example', () => {
    expect(DOCTOR_MD).toContain('All 10 checks passed');
    expect(DOCTOR_MD).toContain('"routing": { "status": "unmeasured"');
    expect(DOCTOR_MD).toContain('"total": 10');
  });
});

describe('commands/doctor.md — Check 7 after D9 (one root)', () => {
  const seven = section(DOCTOR_MD, 7);

  it('judges the project-root store only and reports the trail as a legacy row', () => {
    expect(seven).toContain('ONE ROOT');
    expect(seven).toContain('<projectRoot>/.artibot/runtime/decisions/');
    expect(seven).toContain('Legacy trail row (informational)');
    expect(seven).toContain('FROZEN');
    expect(seven).not.toContain('Report BOTH resolved roots');
  });

  it('retired S6 and kept S3/S4/S5', () => {
    expect(seven).toContain('S6 ("live records exist but the trail does not") was RETIRED');
    expect(seven).not.toMatch(/^\| S6 — /m);
    expect(seven).toMatch(/^\| S4 — /m);
    expect(seven).toMatch(/^\| S5 — /m);
    expect(seven).toMatch(/^\| S3 — /m);
  });

  it('takes the S3 activity signal from the project root, not the plugin root', () => {
    expect(seven).toContain('.artibot/runtime/ledger.jsonl');
    expect(seven).toContain('.artibot/runtime/decisions/*.events.ndjson');
    expect(seven).not.toContain('runtime/current-effort.json');
  });

  it('counts cron files apart from session files', () => {
    expect(seven).toContain('`cron-`');
    expect(seven).toContain('cronRunId');
  });
});
