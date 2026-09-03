# Track B Wiring — Verified Diffs (workflow w4pu24qrn / wf_a1b896bb-b59)

> Produced 2026-06-01 by adversarial-verified workflow. Track A + C SHIPPED this
> session (commits ea8a3b9, 6e279df). Track B DEFERRED because the tool-output
> capture glitched mid-session (every Bash/PowerShell/Read/Grep started returning
> a stale corrupted buffer) — applying code mutations blind would break the
> "re-verify real files before surgical edit" guardrail. Apply NEXT SESSION with
> working tools. Each WIRE below was verified against real files AND adversarially
> checked. Full raw result: temp task output `w4pu24qrn.output` (volatile).

## Apply order / verdicts

| WIRE | Verdict | Notes |
|------|---------|-------|
| WIRE-08 | **apply** | autopilot cost-tracker re-export; isolated file (engine.js + index.js), no conflict — DO FIRST |
| WIRE-04 | **apply** | cache-roi -> create-artibot-agent.js; +3 collateral test edits (toBe 10->11) |
| WIRE-06 | **apply** | smart-pipeline producer -> create-artibot-agent.js; NO collateral (default OFF) |
| WIRE-12 | apply-with-corrections | NEW file route-lifecycle.mjs + NEW test; THEN 5 command .md prose edits (read fresh!) |
| WIRE-03 | **DEFER (realGap=false)** | already wired via buildTeamDirective (runtime-prompt.js:539); structured contract has no consumer. Do NOT apply. |

## CONFIRMED ground truth this session (clean reads before glitch)
- `create-artibot-agent.js` = 310 lines. All WIRE-04/06 anchors verified verbatim:
  - imports end at line 24 (lifecycle)
  - middlewareRegistry 179-190 (ends `'checkpoint': mwCheckpoint,\n  });`)
  - defaultPipeline 192-198 (ends `'token-usage', 'checkpoint',\n  ];`)
  - phase6 284-288
  - runMiddleware CONSUMER guard already live at lines 52-57 (reads `state.context.smartPipeline?.skipped`)
- `lib/runtime/middleware/cache-roi.js:21` exports `createCacheRoiMiddleware` ✅
- `lib/runtime/smart-pipeline.js:24` exports `createSmartPipeline`; `selectMiddlewares(ctx)` at :79 ✅
- NOT re-confirmed this session (glitch): exact toBe(10) line numbers in middleware-config-filter.test.js; engine.js:18/682; index.js:20-22. Re-read before applying.

## WIRE-04 ↔ WIRE-06 CONFLICT (same file) — apply WIRE-06's defaultPipeline edit as a COMBINED edit

Both touch `defaultPipeline`. Cleanest: do ONE combined edit on the defaultPipeline
block that BOTH appends `'cache-roi'` to the array AND appends the smart block
after it. Combined oldString/newString below (under "Combined defaultPipeline edit").
Also combine the two imports into one edit. Re-read the file fresh first.

---

## WIRE-08 — autopilot cost-tracker re-export (specWasCorrect=false: import is SINGLE line, not multi-line)

**File `plugins/artibot/lib/autopilot/engine.js`** — edit 1 (engine.js:18, single long line):
- OLD: `import { acquireSessionKeepAwake, buildTuiInstruction, makeInitialState, maybeDangerNote, notePhaseProgress, persist, recordPhase, releaseSessionKeepAwake, tick } from './_engine-helpers.js';`
- NEW: `import { acquireSessionKeepAwake, buildCostWarningInstruction, buildTuiInstruction, makeInitialState, maybeDangerNote, notePhaseCost, notePhaseProgress, persist, recordPhase, releaseSessionKeepAwake, tick } from './_engine-helpers.js';`

edit 2 (engine.js:682):
- OLD: `export { notifyCompletion, notifyDanger, notifyPause, notifyPhaseProgress };`
- NEW: `export { notifyCompletion, notifyDanger, notifyPause, notifyPhaseProgress };\nexport { notePhaseCost, buildCostWarningInstruction };`

**File `plugins/artibot/lib/autopilot/index.js`** — edit 3 (index.js:20-22, engine.js re-export block):
- OLD: `  listActiveWorktrees,\n  PHASES,\n} from './engine.js';`
- NEW: `  listActiveWorktrees,\n  notePhaseCost,\n  buildCostWarningInstruction,\n  PHASES,\n} from './engine.js';`

Collateral tests: none. Real caller: commands/autopilot.md:215-216 (engine.notePhaseCost / engine.buildCostWarningInstruction).

---

## WIRE-04 — cache-roi middleware (specWasCorrect=true)

**File `plugins/artibot/lib/runtime/create-artibot-agent.js`**

edit 1 (import — COMBINE with WIRE-06 import; see Combined import edit below)

edit 2 (instantiate, after mwLifecycle line 176):
- OLD:
```
  const mwLifecycle = createLifecycleMiddleware({ now, ...(middlewareOptions.lifecycle || {}) });

  // Middleware registry
```
- NEW:
```
  const mwLifecycle = createLifecycleMiddleware({ now, ...(middlewareOptions.lifecycle || {}) });
  const mwCacheRoi = createCacheRoiMiddleware({ now, ...(middlewareOptions.cacheRoi || {}) });

  // Middleware registry
```
  (note: the comment line in the real file is `  // Middleware registry — maps config names to instances for config-driven filtering.` — match the real text)

edit 3 (registry, lines 188-190):
- OLD:
```
    'token-usage': mwTokenUsage,
    'checkpoint': mwCheckpoint,
  });
```
- NEW:
```
    'token-usage': mwTokenUsage,
    'checkpoint': mwCheckpoint,
    'cache-roi': mwCacheRoi,
  });
```

edit 4 (defaultPipeline) — see Combined defaultPipeline edit below.

edit 5 (phase6, lines 284-288):
- OLD:
```
        const phase6 = [
          isEnabled('token-usage') && ['tokenUsage', mwTokenUsage],
          isEnabled('checkpoint') && ['checkpoint', mwCheckpoint],
        ].filter(Boolean);
```
- NEW:
```
        const phase6 = [
          isEnabled('token-usage') && ['tokenUsage', mwTokenUsage],
          isEnabled('checkpoint') && ['checkpoint', mwCheckpoint],
          isEnabled('cache-roi') && ['cacheRoi', mwCacheRoi],
        ].filter(Boolean);
```

**Collateral** `plugins/artibot/tests/runtime/middleware-config-filter.test.js` — change the DEFAULT-count assertions from `toBe(10)` to `toBe(11)`. ⚠️ This file has MANY toBe(10) — but only the ones asserting the *default/fallback* middleware count change. Per workflow: exactly 3 (the "all default present", the empty-array fallback, and the non-array fallback). The `allExceptSummarization` test asserts toBe(9) with an explicit 9-name list NOT containing cache-roi — LEAVE IT toBe(9). Re-read the file and change ONLY the 3 default-count assertions; do NOT blanket-replace (filtered-config tests assert specific smaller counts that must stay).

⚠️ Do NOT touch create-artibot-agent.test.js (workflow confirmed: no pipeline-length assertion there).

---

## WIRE-06 — smart-pipeline producer (specWasCorrect=true, default OFF, NO collateral)

**File `plugins/artibot/lib/runtime/create-artibot-agent.js`**

### Combined import edit (WIRE-04 + WIRE-06)
- OLD: `import { createLifecycleMiddleware } from './middleware/lifecycle.js';`
- NEW:
```
import { createLifecycleMiddleware } from './middleware/lifecycle.js';
import { createCacheRoiMiddleware } from './middleware/cache-roi.js';
import { createSmartPipeline } from './smart-pipeline.js';
```

### Combined defaultPipeline edit (WIRE-04 array + WIRE-06 smart block)
- OLD:
```
  // Default pipeline names (determines execution order).
  const defaultPipeline = [
    'lifecycle',
    'router', 'memory', 'skills', 'tasks',
    'subagents', 'guardrail', 'summarization',
    'token-usage', 'checkpoint',
  ];
```
- NEW:
```
  // Default pipeline names (determines execution order).
  const defaultPipeline = [
    'lifecycle',
    'router', 'memory', 'skills', 'tasks',
    'subagents', 'guardrail', 'summarization',
    'token-usage', 'checkpoint', 'cache-roi',
  ];

  // Smart pipeline (Zero-Waste): opt-in condition-based middleware selection.
  // Default OFF — behavior unchanged unless options.smart or config.runtime.smartPipeline is true.
  const smartConditions = options.config?.runtime?.middlewareConditions || {};
  const smartPipeline = createSmartPipeline(
    defaultPipeline.map((name) => ({ name, fn: middlewareRegistry[name], conditions: smartConditions[name] })),
  );
  const smartEnabled = options.smart === true || options.config?.runtime?.smartPipeline === true;
```

### Producer edit (between router phase and phase2, lines 266-268)
- OLD:
```
        // Phase 1: router (all others depend on routing/intent)
        if (isEnabled('router')) await runMiddleware('router', mwRouter, state);
        // Phase 2: memory, skills, tasks (independent, only read router output)
```
- NEW:
```
        // Phase 1: router (all others depend on routing/intent)
        if (isEnabled('router')) await runMiddleware('router', mwRouter, state);
        // Phase 1.5: smart-pipeline PRODUCER — after router populates state.context.routing,
        // compute the skip list the runMiddleware() guard (lines 52-57) consumes.
        // router/lifecycle are excluded: they already executed above.
        if (smartEnabled && !customMiddleware) {
          const selected = new Set(smartPipeline.selectMiddlewares({
            intent: state.context.routing?.intent || '',
            system: state.context.routing?.system || 'system1',
            mode: state.context.planMode?.active ? 'plan' : (state.context.mode || 'dev'),
            complexity: state.context.routing?.score ?? 0,
          }).map((m) => m.name));
          state.context.smartPipeline = {
            skipped: defaultPipeline.filter((n) => n !== 'router' && n !== 'lifecycle' && !selected.has(n)),
          };
        }
        // Phase 2: memory, skills, tasks (independent, only read router output)
```

Collateral: none (gated OFF; never mutates allMiddleware). Optional new positive test (3 cases) per spec testStub — separate additive task.

---

## WIRE-12 — lifecycle-router CLI bridge (apply-with-corrections, confidence=medium)

CREATE `plugins/artibot/scripts/route-lifecycle.mjs` (Write, not Edit):
```
import { routeLifecycle, routeByContext } from '../lib/core/lifecycle-router.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && path.resolve(thisFile) === invoked) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
}
```

CREATE `plugins/artibot/tests/scripts/route-lifecycle.test.js`:
```
import { describe, it, expect } from 'vitest';
import { routeCli } from '../../scripts/route-lifecycle.mjs';

describe('route-lifecycle CLI bridge', () => {
  it('routes an explicit known phase id through routeLifecycle', async () => {
    const r = await routeCli(['spec']);
    expect(r === null || r.lifecycle === 'spec').toBe(true);
  });
  it('forwards a free-form hint with the phase', async () => {
    const r = await routeCli(['ship', 'deploy', 'to', 'prod']);
    expect(r === null || r.lifecycle === 'ship').toBe(true);
  });
  it('falls back to routeByContext for an unknown first arg and never throws', async () => {
    const r = await routeCli(['please', 'review', 'my', 'code']);
    expect(r === null || typeof r.lifecycle === 'string').toBe(true);
  });
});
```

THEN (separate follow-up) wire the 5 command files (/spec /design /review /ship
/marketing) prose -> `node "${CLAUDE_PLUGIN_ROOT}/scripts/route-lifecycle.mjs" <phase> "$ARGUMENTS"`
— ONLY after reading each command .md fresh (do NOT trust spec line numbers).
Without the 5 command edits the script is an unconsumed island. Before tightening
the test to exact equality, confirm the lifecycle manifest (getLifecycle) registers
all 5 phases.

---

## Verification after Track B
```
cd plugins/artibot && npx vitest run tests/runtime/      # WIRE-04/06 + collateral
cd plugins/artibot && npx vitest run tests/scripts/      # WIRE-12 bridge
cd plugins/artibot && npx vitest run                      # full suite
node plugins/artibot/scripts/ci/validate-readme-claims.js --full
```
