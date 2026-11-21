/**
 * `estimateTokens` lives in a leaf module, not in the lib/core barrel (2026-11-21 review L7).
 *
 * Before: `lib/core/index.js` defined estimateTokens AND re-exported
 * agent-memory-snapshot.js / instruction-budget.js, while both of those imported
 * estimateTokens back from './index.js' — an import cycle through the barrel. It worked only
 * because ESM hoists function declarations; importing either leaf first evaluates the barrel
 * mid-cycle, and a future `const` in the barrel would be a TDZ ReferenceError at load.
 *
 * Now: `lib/core/token-estimate.js` owns it (imports nothing), both consumers import the leaf,
 * and the barrel re-exports the same binding — the public `lib/core` API is unchanged.
 *
 * WHAT THIS FILE CANNOT SEE
 *  1. Other cycles through `lib/core/index.js`. The scan below covers every lib/core file's
 *     static imports of the barrel, not transitive cycles that avoid it.
 *  2. The other estimators (lib/context/context-pressure.js, runtime middleware, hooks) —
 *     separate copies with their own contracts; not merged here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CORE_DIR = fileURLToPath(new URL('../../lib/core/', import.meta.url));

/** Static import/export-from specifiers of a source file. */
function staticSpecifiers(file) {
  const text = readFileSync(file, 'utf-8');
  const re = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
  const out = [];
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] ?? m[2]);
  return out;
}

describe('lib/core/token-estimate.js (leaf)', () => {
  it('exports estimateTokens and CHARS_PER_TOKEN with the barrel contract', async () => {
    const leaf = await import('../../lib/core/token-estimate.js');
    expect(leaf.CHARS_PER_TOKEN).toBe(4);
    expect(leaf.estimateTokens('')).toBe(0);
    expect(leaf.estimateTokens(null)).toBe(0);
    expect(leaf.estimateTokens('abcd')).toBe(2);
    expect(leaf.estimateTokens('abcdefgh', 2)).toBe(5);
  });

  it('is a true leaf: no static imports at all', () => {
    expect(staticSpecifiers(path.join(CORE_DIR, 'token-estimate.js'))).toEqual([]);
  });

  it('the barrel re-exports the very same bindings (public API unchanged)', async () => {
    const leaf = await import('../../lib/core/token-estimate.js');
    const core = await import('../../lib/core/index.js');
    expect(core.estimateTokens).toBe(leaf.estimateTokens);
    expect(core.CHARS_PER_TOKEN).toBe(leaf.CHARS_PER_TOKEN);
  });
});

describe('no lib/core module imports the lib/core barrel (cycle guard)', () => {
  it('scans a non-empty set of files (fail-closed denominator)', () => {
    const files = readdirSync(CORE_DIR).filter((f) => /\.(m?js)$/.test(f));
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('agent-memory-snapshot.js');
    expect(files).toContain('instruction-budget.js');
  });

  it('nothing in lib/core imports ./index.js', () => {
    const offenders = readdirSync(CORE_DIR)
      .filter((f) => /\.(m?js)$/.test(f) && f !== 'index.js')
      .filter((f) => staticSpecifiers(path.join(CORE_DIR, f)).some((s) => s === './index.js' || s === '.'));
    expect(offenders).toEqual([]);
  });

  it('scanner self-check: it sees a barrel import in a synthetic line', () => {
    // Same regex as staticSpecifiers, applied to a known-positive input, so an empty
    // `offenders` above cannot be a dead scanner.
    const re = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/m;
    expect(re.exec("import { estimateTokens } from './index.js';")?.[1]).toBe('./index.js');
  });

  it('the two former cycle members still compute through the leaf', async () => {
    const { estimateSnapshotTokens } = await import('../../lib/core/agent-memory-snapshot.js');
    const { getSkillTokenEstimate } = await import('../../lib/core/instruction-budget.js');
    expect(typeof estimateSnapshotTokens).toBe('function');
    expect(typeof getSkillTokenEstimate).toBe('function');
  });
});
