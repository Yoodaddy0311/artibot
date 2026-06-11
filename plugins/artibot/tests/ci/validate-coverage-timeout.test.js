/**
 * Regression guard for scripts/ci/validate-coverage.js (audit 2026-06-10, #4).
 *
 * The coverage gate runs `npx vitest run --coverage` under an execSync timeout.
 * It was previously 120s — below the measured ~146s full-suite + coverage
 * runtime — which aborted a healthy run and produced a false "test suite
 * failed". The timeout was raised to 300s. This guard asserts it never regresses
 * back below the measured runtime envelope.
 *
 * Source-level assertion (not import-and-run): the script invokes vitest at
 * module scope via main(), so importing it would launch the full coverage run.
 * Reading the literal is the safe, zero-side-effect way to lock the contract.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', '..', 'scripts', 'ci', 'validate-coverage.js');

describe('validate-coverage.js coverage-run timeout', () => {
  const source = readFileSync(SRC, 'utf-8');

  it('declares an execSync timeout for the coverage run', () => {
    expect(source).toMatch(/timeout:\s*[\d_]+/);
  });

  it('keeps the timeout safely above the ~146s measured runtime (>= 200s)', () => {
    const m = source.match(/timeout:\s*([\d_]+)/);
    expect(m).not.toBeNull();
    const ms = Number(m[1].replace(/_/g, ''));
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(200_000);
  });
});
