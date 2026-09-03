/**
 * lib/routing/execution-profile.js — contract tests.
 *
 * Five claims are under test, in order of how badly a regression would hurt:
 *
 *  (a) G-1 fail-closed. The five schema-legal but design-unmapped priorities
 *      (`economy`, `quality`, `fast`, `maximum_performance`, `speed_accuracy`)
 *      normalize to `null`, never to a plausible-looking synonym. This is the
 *      test that would catch someone "helpfully" adding a mapping table the
 *      corpus does not contain.
 *  (b) The three design priorities map onto their objectives and onto the
 *      routing-weight changes ARTIBOT-5.0-DESIGN.md §3.2 assigns.
 *  (c) The flag adapter produces a profile that the REAL T-18 schema accepts.
 *      A synthesized profile that fails validation would be worse than no
 *      adapter at all, so this is checked against the schema file on disk.
 *  (d) An intent-declared profile is passed through byte-for-byte.
 *  (e) The version counter advances on an `intent_revision` change and holds
 *      when nothing changed.
 *
 * The ajv layer is imported defensively for the same reason
 * tests/schemas/execution-profile.test.js does — ajv resolves only
 * transitively (eslint -> ajv; package.json declares no `ajv`, package-lock
 * pins 6.15.0 and the installed tree resolves 6.12.6, both measured
 * 2026-09-03) — but a missing ajv is a FAILURE here, not a skip. Claim (c) is
 * about the REAL schema on disk, and ajv is the only thing in this file that
 * can read one; without it that claim is not weaker, it is ABSENT, and a
 * skipped block reports the same green as a satisfied one. The fix when the
 * oracle disappears is to declare ajv as a devDependency.
 *
 * WHAT THIS FILE CANNOT SEE (write it next to the gate, per repo rule):
 *  - WHICH ajv enforces claim (c). See the version note above; a future ajv 8
 *    would read `$defs` and `format` differently from the 6.x measured here.
 *  - Whether any caller actually injects a validate port in production. The
 *    module performs no validation without one, and that wiring is not tested
 *    here — only that the port contract is honoured when a port is supplied.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DESIGN_PRIORITIES,
  executionProfile,
  normalizePerformancePriority,
  OBJECTIVE_ATTESTATION,
  OBJECTIVE_BY_PRIORITY,
  PERFORMANCE_DIRECTIVES,
  SCHEMA_INVALID_CODE,
  SCHEMA_PRIORITIES,
} from '../../lib/routing/execution-profile.js';

let Ajv = null;
try {
  Ajv = (await import('ajv')).default;
} catch {
  Ajv = null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '..', '..', 'schemas', 'execution-profile.schema.json');
const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'artibot.config.json');

const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'));
const repoConfig = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

/**
 * What a reader sees when the schema oracle is gone. Written as guidance, not
 * as a bare failure: the correct response is to DECLARE the dependency, and
 * the wrong one — restoring the skip — is the one that looks easiest at 2am.
 * @type {string}
 */
const AJV_MISSING = [
  'ajv could not be resolved, so the real T-18 schema on disk cannot be enforced and this gate',
  'proves nothing. ajv is only a TRANSITIVE dependency here (eslint -> ajv);',
  "package.json declares no 'ajv'.",
  'FIX: add ajv to devDependencies. Do NOT skip or delete these assertions —',
  'a skipped conformance test reports the same green as a passing one.',
].join(' ');

/**
 * The validate port, backed by ajv. When ajv is absent this is a THROWING STUB
 * rather than null: a null port would make `describe.skipIf` plausible again,
 * and every call site below would otherwise fail with "ajvValidate is not a
 * function", which buries the real cause. The stub fails with the fix instead.
 */
const ajvValidate = (() => {
  if (!Ajv) {
    return () => {
      throw new Error(AJV_MISSING);
    };
  }
  const ajv = new Ajv({ allErrors: true });
  const compiled = ajv.compile(schema);
  return (data) => ({ valid: compiled(data) === true, errors: compiled.errors ?? null });
})();

describe('normalizePerformancePriority — G-1 fail-closed', () => {
  it.each(DESIGN_PRIORITIES)('maps the design priority %s onto itself', (priority) => {
    expect(normalizePerformancePriority(priority)).toEqual({
      normalized: priority,
      reason: expect.stringContaining('design vocabulary'),
    });
  });

  const unmapped = SCHEMA_PRIORITIES.filter((value) => !DESIGN_PRIORITIES.includes(value));

  it('leaves exactly five schema values unmapped', () => {
    // If this count changes, either the schema enum or the design gained a
    // value and the G-1 gap description needs re-reading before code changes.
    expect(unmapped).toEqual([
      'economy',
      'quality',
      'fast',
      'maximum_performance',
      'speed_accuracy',
    ]);
  });

  it.each(unmapped)('refuses to guess a mapping for %s', (value) => {
    expect(normalizePerformancePriority(value)).toEqual({
      normalized: null,
      reason: 'G-1 unresolved',
    });
  });

  it('does not treat maximum_performance or speed_accuracy as maximum', () => {
    // The single most tempting inference in this module. Named explicitly so a
    // future edit has to delete an assertion that says why, not just a line.
    expect(normalizePerformancePriority('maximum_performance').normalized).not.toBe('maximum');
    expect(normalizePerformancePriority('speed_accuracy').normalized).not.toBe('maximum');
  });

  it('treats an absent priority as balanced, with a distinguishable reason', () => {
    const absent = normalizePerformancePriority(undefined);
    expect(absent.normalized).toBe('balanced');
    expect(absent.reason).toMatch(/^default:/);
    // "not said" and "said balanced" must stay tellable apart in the record.
    expect(absent.reason).not.toBe(normalizePerformancePriority('balanced').reason);
  });

  it('rejects a non-string and an out-of-enum string without normalizing', () => {
    expect(normalizePerformancePriority(42).normalized).toBeNull();
    expect(normalizePerformancePriority('turbo')).toEqual({
      normalized: null,
      reason: expect.stringContaining('unknown'),
    });
  });
});

describe('objective mapping', () => {
  it('maps the three design priorities onto the three objectives', () => {
    expect(OBJECTIVE_BY_PRIORITY).toEqual({
      balanced: 'cost_per_accepted_outcome',
      maximum: 'time_to_verified_outcome',
      split: 'wallclock_throughput',
    });
  });

  it('records that wallclock_throughput is unattested in the corpus', () => {
    // Guards the honesty of the record, not the behaviour: two of these tokens
    // are quoted from design documents and one is a coinage. A consumer that
    // writes objectives into the ledger needs to be able to tell which.
    expect(OBJECTIVE_ATTESTATION.cost_per_accepted_outcome).toMatch(/^ATTESTED/);
    expect(OBJECTIVE_ATTESTATION.time_to_verified_outcome).toMatch(/^ATTESTED/);
    expect(OBJECTIVE_ATTESTATION.wallclock_throughput).toMatch(/^UNATTESTED/);
  });

  it('emits no objective and no directives when the priority is G-1 unmapped', () => {
    const result = executionProfile({
      intentFrontmatter: { intent_revision: 1, execution_profile: { performance: { priority: 'quality' } } },
    });
    expect(result.source).toBe('intent');
    expect(result.objective).toBeNull();
    expect(result.directives).toBeNull();
    expect(result.objective_reason).toBe('G-1 unresolved');
    // The profile itself still survives — the gap is in the mapping, not the
    // author's declaration, so the declaration is preserved for the ledger.
    expect(result.profile.performance.priority).toBe('quality');
  });
});

describe('performance directives (ARTIBOT-5.0-DESIGN.md §3.2)', () => {
  it('balanced optimizes cost and keeps downgrade enabled', () => {
    const { directives, objective } = executionProfile({ flags: {} });
    expect(objective).toBe('cost_per_accepted_outcome');
    expect(directives).toMatchObject({
      costWeight: 1,
      contextAffinityWeight: 1,
      downgradeEnabled: true,
      effortFloor: null,
      budgetCeiling: null,
    });
  });

  it('maximum zeroes cost, floors effort at xhigh and disables downgrade', () => {
    const { directives, objective, profile } = executionProfile({ flags: { fast: true } });
    expect(objective).toBe('time_to_verified_outcome');
    expect(directives).toMatchObject({
      costWeight: 0,
      contextAffinityWeight: 1,
      downgradeEnabled: false,
      effortFloor: 'xhigh',
      accuracySecondaryObjective: true,
    });
    expect(profile.performance.budget).toBe('generous');
  });

  it('split additionally zeroes context affinity and resolves the budget ceiling', () => {
    const { directives, objective } = executionProfile({
      flags: { split: true },
      config: repoConfig,
    });
    expect(objective).toBe('wallclock_throughput');
    expect(directives).toMatchObject({
      costWeight: 0,
      contextAffinityWeight: 0,
      downgradeEnabled: false,
      effortFloor: 'xhigh',
      budgetCeilingPath: 'split.dispatch.budget',
    });
    // Read from the repo config rather than pinned to a literal, so a config
    // change moves the ceiling instead of turning this test red for nothing.
    expect(directives.budgetCeiling).toBe(repoConfig.split.dispatch.budget);
    expect(Number.isFinite(directives.budgetCeiling)).toBe(true);
  });

  it('follows the declared dispatchBudgetRef indirection rather than the literal path', () => {
    const relocated = {
      split: { dispatch: { budget: 600000 } },
      topology: { split: { dispatchBudgetRef: 'custom.budget' } },
      custom: { budget: 123456 },
    };
    const { directives } = executionProfile({ flags: { split: true }, config: relocated });
    expect(directives.budgetCeilingPath).toBe('custom.budget');
    expect(directives.budgetCeiling).toBe(123456);
  });

  it('yields a null ceiling instead of a guess when the config has no budget key', () => {
    const { directives } = executionProfile({ flags: { split: true }, config: {} });
    expect(directives.budgetCeiling).toBeNull();
  });

  it('exposes the directive table frozen', () => {
    expect(Object.isFrozen(PERFORMANCE_DIRECTIVES)).toBe(true);
    expect(Object.isFrozen(PERFORMANCE_DIRECTIVES.split)).toBe(true);
  });
});

describe('flag adapter (intent.md absent)', () => {
  it('reports source=default and balanced when no flag is set', () => {
    const result = executionProfile({});
    expect(result.source).toBe('default');
    expect(result.profile.performance.priority).toBe('balanced');
    expect(result.profile.performance.budget).toBeUndefined();
    expect(result.profile.parallelism.strategy).toBe('net_gain');
  });

  it('maps --fast onto maximum and the autopilot_fast topology', () => {
    const result = executionProfile({ flags: { fast: true } });
    expect(result.source).toBe('flags');
    expect(result.profile.performance.priority).toBe('maximum');
    expect(result.profile.topology).toBe('autopilot_fast');
    expect(result.profile.parallelism.strategy).toBe('aggressive');
  });

  it('maps /split onto split, and split outranks --fast when both are set', () => {
    expect(executionProfile({ flags: { split: true } }).profile.performance.priority).toBe('split');
    const both = executionProfile({ flags: { fast: true, split: true } });
    // split is maximum PLUS a ceiling and ContextAffinity 0; taking fast here
    // would silently drop the ceiling.
    expect(both.profile.performance.priority).toBe('split');
    expect(both.directives.budgetCeilingPath).toBe('split.dispatch.budget');
  });

  it('takes the default topology from config and rejects an out-of-enum value', () => {
    expect(executionProfile({ config: repoConfig }).profile.topology).toBe(
      repoConfig.topology.default,
    );
    expect(
      executionProfile({ config: { topology: { default: 'quantum' } } }).profile.topology,
    ).toBe('auto');
  });

  it('ignores an unrecognized flag rather than inventing a priority', () => {
    const result = executionProfile({ flags: { turbo: true, fast: false } });
    expect(result.source).toBe('default');
    expect(result.profile.performance.priority).toBe('balanced');
  });

  it('omits the keys a flag cannot determine', () => {
    // reasoning / autonomy / context / completion are statements about what the
    // operator wants verified and how much autonomy to grant. A CLI flag says
    // nothing about any of them, so they must be absent, not defaulted.
    const { profile } = executionProfile({ flags: { fast: true } });
    for (const key of ['reasoning', 'autonomy', 'context', 'completion']) {
      expect(profile).not.toHaveProperty(key);
    }
    // review.model likewise: the corpus writes `fable-5.1`, which is not a
    // catalog id, and model ids may not be hardcoded outside model-catalog.js.
    expect(profile.review).toEqual({ independent: true });
  });

  it('carries no derived_from when there is no intent revision to derive from', () => {
    expect(executionProfile({ flags: { fast: true } }).derived_from).toBeNull();
  });
});

describe('intent frontmatter path', () => {
  const frontmatter = {
    intent_revision: 3,
    explicit_requests: [{ text: 'irrelevant to this module' }],
    execution_profile: {
      reasoning: { depth: 'deep' },
      autonomy: { level: 'full' },
      performance: { priority: 'balanced', budget: 'generous' },
      parallelism: { strategy: 'auto' },
      planning: { mode: 'auto' },
      context: { strategy: 'minimal_sufficient' },
      review: { independent: true },
      completion: { verified_outcome_required: true },
    },
  };

  it('passes the declared profile through verbatim', () => {
    const { profile, source } = executionProfile({ intentFrontmatter: frontmatter });
    expect(source).toBe('intent');
    expect(profile).toEqual(frontmatter.execution_profile);
  });

  it('records derived_from.intent_revision', () => {
    expect(executionProfile({ intentFrontmatter: frontmatter }).derived_from).toEqual({
      intent_revision: 3,
    });
  });

  it('ignores flags once the frontmatter declares a profile', () => {
    const result = executionProfile({ intentFrontmatter: frontmatter, flags: { fast: true } });
    expect(result.profile.performance.priority).toBe('balanced');
    expect(result.objective).toBe('cost_per_accepted_outcome');
  });

  it('falls back to the flag adapter when the frontmatter has no execution_profile', () => {
    const result = executionProfile({
      intentFrontmatter: { intent_revision: 2 },
      flags: { fast: true },
    });
    expect(result.source).toBe('flags');
    // No profile was derived from the intent, so nothing claims to be.
    expect(result.derived_from).toBeNull();
  });

  it('does not alias the caller frontmatter object', () => {
    const mutable = JSON.parse(JSON.stringify(frontmatter));
    const { profile } = executionProfile({ intentFrontmatter: mutable });
    mutable.execution_profile.performance.priority = 'split';
    expect(profile.performance.priority).toBe('balanced');
    expect(Object.isFrozen(profile.performance)).toBe(true);
  });
});

describe('version', () => {
  const at = (revision) => ({
    intent_revision: revision,
    execution_profile: { performance: { priority: 'balanced' } },
  });

  it('starts at 1', () => {
    expect(executionProfile({ intentFrontmatter: at(1) }).version).toBe(1);
  });

  it('holds when a recompute changes nothing', () => {
    const first = executionProfile({ intentFrontmatter: at(1) });
    const again = executionProfile({ intentFrontmatter: at(1), previous: first });
    expect(again.version).toBe(1);
  });

  it('advances when intent_revision changes', () => {
    const v1 = executionProfile({ intentFrontmatter: at(1) });
    const v2 = executionProfile({ intentFrontmatter: at(2), previous: v1 });
    const v3 = executionProfile({ intentFrontmatter: at(3), previous: v2 });
    expect([v2.version, v3.version]).toEqual([2, 3]);
    expect(v3.derived_from).toEqual({ intent_revision: 3 });
  });

  it('advances when the profile changes at the same revision', () => {
    const v1 = executionProfile({ intentFrontmatter: at(1) });
    const changed = executionProfile({
      intentFrontmatter: {
        intent_revision: 1,
        execution_profile: { performance: { priority: 'maximum' } },
      },
      previous: v1,
    });
    expect(changed.version).toBe(2);
  });
});

describe('schema validation port', () => {
  it('passes the schema view — profile plus version and derived_from — to the port', () => {
    let seen = null;
    executionProfile({
      intentFrontmatter: { intent_revision: 7, execution_profile: { planning: { mode: 'auto' } } },
      validate: (data) => {
        seen = data;
        return true;
      },
    });
    expect(seen).toEqual({
      planning: { mode: 'auto' },
      version: 1,
      derived_from: { intent_revision: 7 },
    });
  });

  it('throws with a stable code when the port rejects', () => {
    expect(() =>
      executionProfile({ flags: { fast: true }, validate: () => ({ valid: false, errors: ['x'] }) }),
    ).toThrowError(
      expect.objectContaining({ code: SCHEMA_INVALID_CODE, errors: ['x'] }),
    );
  });

  it('treats a bare false as a rejection', () => {
    expect(() => executionProfile({ validate: () => false })).toThrow(/schema validation/);
  });

  it('performs no validation when no port is injected', () => {
    // The module reads no files; validation is the caller's to wire.
    expect(() => executionProfile({})).not.toThrow();
  });
});

describe('against the real T-18 schema (ajv)', () => {
  it('has a real oracle — present, and able to say NO as well as YES', () => {
    // The assertion IS the fail-closed statement: when ajv is gone this block
    // goes red with the fix, instead of the suite quietly running three fewer
    // assertions against the real schema.
    expect(Ajv === null ? AJV_MISSING : 'oracle present').toBe('oracle present');

    // A port that returns `valid: true` for everything would make the three
    // tests below vacuous, so both directions are demanded of it here.
    const { profile, version } = executionProfile({ flags: {}, config: repoConfig });
    expect(ajvValidate({ ...profile, version }).valid).toBe(true);
    expect(ajvValidate({ performance: { priority: 'turbo' } }).valid).toBe(false);
  });

  it.each(['default', 'fast', 'split'])(
    'the %s flag-adapter profile validates',
    (mode) => {
      const flags = mode === 'default' ? {} : { [mode]: true };
      const { profile, version } = executionProfile({ flags, config: repoConfig });
      const verdict = ajvValidate({ ...profile, version });
      expect(verdict.errors ?? []).toEqual([]);
      expect(verdict.valid).toBe(true);
    },
  );

  it('validates through the port on the intent path, including derived_from', () => {
    const result = executionProfile({
      intentFrontmatter: {
        intent_revision: 4,
        execution_profile: {
          reasoning: { depth: 'deep' },
          autonomy: { level: 'full' },
          performance: { priority: 'balanced', budget: 'generous' },
          parallelism: { strategy: 'auto' },
          planning: { mode: 'auto' },
          context: { strategy: 'minimal_sufficient' },
          review: { independent: true, strictness: 'high' },
          completion: { verified_outcome_required: true },
        },
      },
      validate: ajvValidate,
    });
    expect(result.version).toBe(1);
    // Conformance level 2 (versionedProfile) needs both fields present.
    expect(result.derived_from).toEqual({ intent_revision: 4 });
  });

  it('rejects a profile carrying an out-of-enum priority', () => {
    expect(() =>
      executionProfile({
        intentFrontmatter: {
          intent_revision: 1,
          execution_profile: { performance: { priority: 'turbo' } },
        },
        validate: ajvValidate,
      }),
    ).toThrowError(expect.objectContaining({ code: SCHEMA_INVALID_CODE }));
  });
});
