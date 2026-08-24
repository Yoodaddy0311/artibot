/**
 * CLI bridge for the lifecycle router (WIRE-12).
 *
 * lib/core/lifecycle-router.js exports routeLifecycle/routeByContext but had no
 * runnable consumer. This bridge lets the lifecycle phase commands
 * (/spec /design /review /ship /marketing) invoke the router from a shell step.
 *
 * Usage: node scripts/route-lifecycle.mjs <phase> [free-form hint...]
 *   - known phase id  -> routeLifecycle(phase, { hint })
 *   - anything else   -> routeByContext(joined args)
 * Prints the routing result as a single JSON line (or null).
 */
import { routeByContext, routeLifecycle } from '../lib/core/lifecycle-router.js';
import { isMainEntry } from './hooks/_main-entry.js';

const KNOWN = new Set(['build', 'verify', 'review', 'ship', 'marketing', 'design', 'plan', 'spec']);

export async function routeCli(argv) {
  const [phase, ...rest] = argv; // argv = process.argv.slice(2)
  const hint = rest.join(' ').trim();
  return (phase && KNOWN.has(phase))
    ? routeLifecycle(phase, hint ? { hint } : {})
    : routeByContext([phase, hint].filter(Boolean).join(' '));
}

async function main() {
  const result = await routeCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result ?? null)}\n`);
}

// CLI-only guard (same convention as scripts/ci/*.mjs and scripts/learning-diag.js)
if (isMainEntry(import.meta.url)) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
}
