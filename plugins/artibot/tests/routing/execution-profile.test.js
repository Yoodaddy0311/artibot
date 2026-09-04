/**
 * lib/routing/execution-profile.js — contract tests.
 *
 * Five claims are under test, in order of how badly a regression would hurt:
 *
 *  (a) G-1 resolved by allowlist, fail-closed for the rest. The five
 *      schema-legal, design-unmapped priorities (`economy`, `quality`, `fast`,
 *      `maximum_performance`, `speed_accuracy`) resolve through
 *      `PRIORITY_ALIASES` to the owner-decided design value (2026-09-04), with
 *      the evidence grade in the reason string. A value with NO alias row still
 *      normalizes to `null` — so a ninth schema value cannot become `balanced`
 *      by accident — and the interpreter's vocabulary and the schema enum are
 *      both checked against the table so neither can drift past it.
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
  PRIORITY_ALIASES,
  SCHEMA_INVALID_CODE,
  SCHEMA_PRIORITIES,
} from '../../lib/routing/execution-profile.js';
import { PERFORMANCE_PRIORITIES as INTERPRETER_PRIORITIES } from '../../lib/intent/interpreter.js';

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

describe('normalizePerformancePriority — G-1 resolved by allowlist (owner 2026-09-04)', () => {
  it.each(DESIGN_PRIORITIES)('maps the design priority %s onto itself', (priority) => {
    expect(normalizePerformancePriority(priority)).toEqual({
      normalized: priority,
      reason: expect.stringContaining('design vocabulary'),
    });
  });

  const nonDesign = SCHEMA_PRIORITIES.filter((value) => !DESIGN_PRIORITIES.includes(value));

  it('aliases exactly the five non-design schema values', () => {
    // If either side of this changes, the schema enum or the design gained a
    // value and the alias table needs an owner decision, not a guess.
    expect(nonDesign).toEqual([
      'economy',
      'quality',
      'fast',
      'maximum_performance',
      'speed_accuracy',
    ]);
    expect(Object.keys(PRIORITY_ALIASES).sort()).toEqual([...nonDesign].sort());
  });

  /** The owner's table (brief ★, 2026-09-04) — spelled out, not derived. */
  const OWNER_TABLE = [
    ['fast', 'maximum', 'attested', false],
    ['speed_accuracy', 'maximum', 'inferred', false],
    ['maximum_performance', 'maximum', 'inferred', false],
    ['quality', 'balanced', 'judgment', false],
    ['economy', 'balanced', 'judgment', true],
  ];

  it.each(OWNER_TABLE)('aliases %s -> %s with grade %s (lossy: %s)', (value, to, grade, lossy) => {
    const result = normalizePerformancePriority(value);
    expect(result).toEqual({ normalized: to, reason: expect.stringMatching(/^alias: /) });
    expect(result.reason).toContain(`alias: ${value} -> ${to} (${grade}`);
    expect(result.reason.includes('lossy')).toBe(lossy);
    expect(PRIORITY_ALIASES[value]).toMatchObject({ to, grade });
    expect(PRIORITY_ALIASES[value].lossy === true).toBe(lossy);
    expect(DESIGN_PRIORITIES).toContain(to);
  });

  it('treats maximum_performance and speed_accuracy as maximum, marked inferred', () => {
    // Once the single most tempting inference in this module; now made, but
    // the reason string admits it is an inference rather than a citation.
    for (const value of ['maximum_performance', 'speed_accuracy']) {
      const result = normalizePerformancePriority(value);
      expect(result.normalized).toBe('maximum');
      expect(result.reason).toMatch(/\(inferred;/);
    }
  });

  it('marks economy as lossy — the design has nothing cheaper than balanced', () => {
    const result = normalizePerformancePriority('economy');
    expect(result.normalized).toBe('balanced');
    expect(result.reason).toMatch(/\(judgment, lossy;/);
    expect(PRIORITY_ALIASES.economy.lossy).toBe(true);
    // The other four are NOT lossy; a second lossy row is a new decision.
    expect(Object.entries(PRIORITY_ALIASES).filter(([, row]) => row.lossy === true).map(([k]) => k))
      .toEqual(['economy']);
  });

  it('keeps the design vocabulary at three — the table adds no directive keys', () => {
    expect(Object.keys(OBJECTIVE_BY_PRIORITY).sort()).toEqual([...DESIGN_PRIORITIES].sort());
    expect(Object.keys(PERFORMANCE_DIRECTIVES).sort()).toEqual([...DESIGN_PRIORITIES].sort());
    for (const row of Object.values(PRIORITY_ALIASES)) expect(DESIGN_PRIORITIES).toContain(row.to);
  });

  it('SCHEMA_PRIORITIES is the JSON schema enum itself, so an enum-only addition is seen', () => {
    // The cross-drift test below walks the JS transcription. Without this
    // equality a ninth value added ONLY to the .schema.json would read as
    // `unknown:` (still null, still fail-closed) and no test would go red.
    expect([...SCHEMA_PRIORITIES]).toEqual(schema.properties.performance.properties.priority.enum);
  });

  it('cross-drift: every interpreter priority and every schema priority resolves', () => {
    // The interpreter can only emit its five; the schema accepts eight. If
    // either list grows past the alias table, this is the test that goes red.
    for (const value of INTERPRETER_PRIORITIES) {
      expect(normalizePerformancePriority(value).normalized, value).not.toBeNull();
    }
    for (const value of SCHEMA_PRIORITIES) {
      expect(normalizePerformancePriority(value).normalized, value).not.toBeNull();
    }
    expect(INTERPRETER_PRIORITIES.every((v) => SCHEMA_PRIORITIES.includes(v))).toBe(true);
  });

  it('stays fail-closed for a schema-legal value with no alias row', async () => {
    // Simulate a ninth enum value landing without a table row: the branch
    // that returns 'G-1 unresolved' must still exist and must still be the
    // one that answers. `SCHEMA_PRIORITIES` is frozen, so the fixture is a
    // copy; the assertion is on the real function's branch order.
    const ninth = 'turbo_v9';
    expect(SCHEMA_PRIORITIES).not.toContain(ninth);
    expect(Object.hasOwn(PRIORITY_ALIASES, ninth)).toBe(false);
    // Today `ninth` is outside the enum, so it reads as unknown, not unresolved…
    expect(normalizePerformancePriority(ninth).reason).toMatch(/^unknown:/);
    // …and the unresolved branch is reachable only for a value that is IN the
    // enum but NOT in the table. There is no such value today (the cross-drift
    // test above proves the set is empty), so pin that the branch still exists
    // in source rather than assert on a value that cannot be produced.
    const source = await readFile(
      path.resolve(__dirname, '..', '..', 'lib', 'routing', 'execution-profile.js'), 'utf8',
    );
    expect(source).toMatch(/SCHEMA_PRIORITIES\.includes\(value\)[\s\S]{0,120}'G-1 unresolved'/);
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

  it('emits the balanced objective and directives for an aliased priority (quality)', () => {
    const result = executionProfile({
      intentFrontmatter: { intent_revision: 1, execution_profile: { performance: { priority: 'quality' } } },
    });
    expect(result.source).toBe('intent');
    expect(result.objective).toBe('cost_per_accepted_outcome');
    expect(result.directives).toMatchObject({ costWeight: 1, downgradeEnabled: true });
    expect(result.objective_reason).toMatch(/^alias: quality -> balanced \(judgment;/);
    // The author's declaration is preserved for the ledger — only the routing
    // behaviour is merged, the record is not rewritten.
    expect(result.profile.performance.priority).toBe('quality');
  });

  it('emits the maximum objective for fast, and records economy as lossy', () => {
    const fast = executionProfile({
      intentFrontmatter: { intent_revision: 1, execution_profile: { performance: { priority: 'fast' } } },
    });
    expect(fast.objective).toBe('time_to_verified_outcome');
    expect(fast.directives).toMatchObject({ costWeight: 0, downgradeEnabled: false, effortFloor: 'xhigh' });
    expect(fast.objective_reason).toMatch(/^alias: fast -> maximum \(attested;/);
    expect(fast.profile.performance.priority).toBe('fast');

    const economy = executionProfile({
      intentFrontmatter: { intent_revision: 1, execution_profile: { performance: { priority: 'economy' } } },
    });
    expect(economy.objective).toBe('cost_per_accepted_outcome');
    expect(economy.directives).toMatchObject({ costWeight: 1, downgradeEnabled: true });
    expect(economy.objective_reason).toMatch(/^alias: economy -> balanced \(judgment, lossy;/);
    expect(economy.profile.performance.priority).toBe('economy');
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
