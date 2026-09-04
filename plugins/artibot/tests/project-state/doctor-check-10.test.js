/**
 * `/doctor` Check 10 — Route Bind Residue — and the D9 rewrite of Check 7.
 *
 * ── What these tests DO establish ─────────────────────────────────────────
 * That `checkRouteBindResidue` returns the verdict design §2.3 invariant 3
 * specifies for hand-built counts, that `unmeasured` is returned whenever a
 * count was not supplied (and that `0` is not `undefined`), and that
 * `commands/doctor.md` says what the code does: ten checks, a `routing`
 * scope, one root for Check 7, S6 gone, `cron-` files counted apart.
 *
 * ── What they CANNOT establish (§9) ───────────────────────────────────────
 * - **Anything about a live ledger or spawn ledger.** Both inputs are
 *   integers built here. The tree that landed this file went from 0/0 and no
 *   spawns.ndjson (02:1x, `unmeasured`) to 3 receipts / 3 binds / 0 unbound
 *   (02:34, `pass`) once its review agents spawned — one live pass, recorded
 *   in `commands/doctor.md` Check 10. The warn and fail rows have never been
 *   exercised live.
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
import { checkRouteBindResidue, CheckStatus } from '../../lib/project-state/doctor-checks.js';

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
    expect(noSpawns.counts).toEqual({ unboundReceipts: 3, unboundSpawns: null, conflicts: null });

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
    expect(equal.counts).toEqual({ unboundReceipts: 2, unboundSpawns: 2, conflicts: 0 });
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
    expect(r.findings[0].conflicts).toBe(conflicts);
    expect(r.counts.conflicts).toBe(1);
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
