/**
 * Tests for adaptive-model-router — receipt shape, the policy ceiling, the
 * injected effort/budget ports, the routing epoch, and source purity.
 *
 * WHAT THESE TESTS CANNOT SEE (per PRD R-05):
 *  - THE WEIGHTS ARE UNCALIBRATED. Every ranking assertion below proves the
 *    router honours `route-scorer.js`, and `route-scorer.js` says in its own
 *    header that `TIER_QUALITY` and `TIER_LATENCY_INDEX` are estimates with no
 *    benchmark behind them. A green run says fable outranks opus UNDER THOSE
 *    TABLES; it says nothing about which tier is actually better at anything.
 *  - ZERO LIVE RECEIPTS. Nothing here produces or appends a ledger line. There
 *    is no writer and no consumer as of 2026-09-02, so the divergence rate the
 *    Phase 0 metric depends on has a denominator of zero — not a small number.
 *  - The schema case is a fixture. Passing ajv proves this receipt conforms,
 *    not that a receipt built from live runtime inputs will.
 *  - `measured: false` is asserted as PRESENT and correct-by-construction. No
 *    test here can tell a measured value from an invented one.
 *  - WHICH ajv enforces the schema block. ajv reaches this file only as a
 *    TRANSITIVE dependency (eslint -> ajv; package.json declares no `ajv`,
 *    package-lock pins 6.15.0, the installed tree resolves 6.12.6 — both
 *    measured 2026-09-03), so an eslint bump can remove the oracle with nothing
 *    else changing. The block is NOT skipped when that happens: it goes red
 *    with the fix instruction, matching `tests/schemas/receipts.test.js`.
 *
 * @module tests/routing/adaptive-router
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MODELS } from '../../lib/core/model-catalog.js';
import { allowedTiers, resolveModel } from '../../lib/core/model-policy.js';
import {
  modelIdentity,
  RECEIPT_SCHEMA_VERSION,
  RECEIPT_SOURCE,
  REQUIRED_EVIDENCE,
  resolveCandidateTiers,
  routeModel,
  ROUTER_DECISIONS,
} from '../../lib/routing/adaptive-model-router.js';
import { COST_TERMS } from '../../lib/routing/route-hysteresis.js';
import { DEFAULT_CATALOG } from '../../lib/routing/route-scorer.js';

let Ajv = null;
try {
  Ajv = (await import('ajv')).default;
} catch {
  Ajv = null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_SOURCE = path.resolve(__dirname, '../../lib/routing/adaptive-model-router.js');
const SCHEMA_PATH = path.resolve(__dirname, '../../schemas/route-receipt.schema.json');

const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf-8'));

/** Router source with comments stripped, for the purity greps. */
const ROUTER_CODE = stripComments(await readFile(ROUTER_SOURCE, 'utf-8'));

/**
 * Explicit policy fixture. Every test passes it so no assertion depends on the
 * repo's live `artibot.config.json` — a config edit must not turn these red.
 * `architect` is fable-allowlisted, `backend-developer` is not.
 */
const CONFIG = Object.freeze({
  agents: {
    modelPolicy: {
      fable: { enabled: true, allowlist: ['architect'] },
      high: { model: 'opus', agents: ['architect', 'backend-developer'] },
      medium: { model: 'opus', agents: [] },
      phaseRoles: { build: 'opus', review: 'fable' },
    },
  },
});

/** Complexity port, so `action.complexity` is filled rather than null. */
const COMPLEXITY_PORT = {
  classifyComplexity: () => ({ score: 0.7, factors: { uncertainty: 0.4, risk: 0.2 } }),
};

/** Identity a caller must supply; nothing here can be derived from a clock. */
const EVIDENCE = Object.freeze({
  route_receipt_id: 'rr-1',
  mission_id: 'mission-1',
  session_id: 'session-1',
  execution_profile_version: 1,
  timestamp: '2026-09-02T00:00:00.000Z',
  shadow_of: 'seq-42',
});

/**
 * A fully-specified routing input: every schema-required field has a source.
 *
 * @param {object} [over] - Overrides merged over the base.
 * @returns {object} Router input.
 */
function completeInput(over = {}) {
  return {
    agentType: 'architect',
    role: 'build',
    input: { text: 'design the module boundary and dependency strategy', phase: 'build' },
    classifierOptions: COMPLEXITY_PORT,
    config: CONFIG,
    catalog: DEFAULT_CATALOG,
    currentTier: 'opus',
    actionsSinceSwitch: 9,
    epoch: 'run-1',
    evidence: EVIDENCE,
    ...over,
  };
}

/**
 * Strip comments before grepping source, so a header that NAMES a banned API
 * in prose is not mistaken for a call to it.
 *
 * @param {string} source - File text.
 * @returns {string} Code with block and line comments removed.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * ajv 6 reports `dataPath`; ajv 7+ reports `instancePath`.
 *
 * @param {object} error - One ajv error object.
 * @returns {string} JSON pointer-ish path.
 */
function errorPath(error) {
  return error.instancePath ?? error.dataPath ?? '';
}

describe('exported contract', () => {
  it('writes schema_version 1 as a shadow line, never a production one', () => {
    expect(RECEIPT_SCHEMA_VERSION).toBe(schema.properties.schema_version.const);
    expect(RECEIPT_SOURCE).toBe('shadow');
    expect(schema.properties.source.enum).toContain(RECEIPT_SOURCE);
  });

  it('permits only route and pin — the three Canary-gated values are absent', () => {
    expect([...ROUTER_DECISIONS]).toEqual(['route', 'pin']);
    for (const gated of ['switch', 'escalate', 'downgrade']) {
      expect(schema.properties.decision.properties.type.enum).toContain(gated);
      expect(ROUTER_DECISIONS).not.toContain(gated);
    }
  });

  it('names exactly the identity the schema requires but a clock cannot supply', () => {
    for (const field of REQUIRED_EVIDENCE) {
      const required = field === 'shadow_of'
        ? schema.allOf[0].then.required
        : schema.required;
      expect(required).toContain(field);
    }
  });
});

describe('receipt shape', () => {
  it('fills every schema-required key from a complete input', () => {
    const receipt = routeModel(completeInput());
    for (const key of schema.required) {
      expect(receipt[key], `missing ${key}`).not.toBeUndefined();
      expect(receipt[key], `null ${key}`).not.toBeNull();
    }
    expect(receipt.source).toBe('shadow');
    expect(receipt.shadow_of).toBe(EVIDENCE.shadow_of);
  });

  it('carries the seven cost terms under the hysteresis key names, and no others', () => {
    const receipt = routeModel(completeInput());
    expect(Object.keys(receipt.terms).sort()).toEqual([...COST_TERMS].sort());
    expect(Object.keys(schema.properties.terms.properties).sort()).toEqual([...COST_TERMS].sort());
    for (const name of COST_TERMS) {
      expect(Object.keys(receipt.terms[name]).sort()).toEqual(['measured', 'value']);
    }
  });

  it('reports handoff in TOKENS as an integer, never a byte count', () => {
    const receipt = routeModel(completeInput({ currentTier: 'opus', handoffTokens: 1234.6 }));
    expect(Number.isInteger(receipt.transition.handoff_tokens)).toBe(true);
    expect(Number.isInteger(receipt.transition.context_rebuild_tokens)).toBe(true);
    expect(receipt.transition).not.toHaveProperty('handoff_bytes');
  });

  it('names the model identity exactly, id and catalog version included', () => {
    const identity = modelIdentity('fable', DEFAULT_CATALOG);
    expect(identity.model_id).toBe(MODELS.fable.id);
    expect(identity.tier).toBe('fable');
    expect(identity.catalog_version).toBe(DEFAULT_CATALOG.version);
    // The catalog exposes no per-model snapshot string, so version falls back
    // to the dated id rather than being invented.
    expect(identity.version).toBe(MODELS.fable.id);
  });

  it('returns no identity for a tier the catalog cannot name', () => {
    expect(modelIdentity('gpt-9', DEFAULT_CATALOG)).toBeNull();
    expect(modelIdentity(null, DEFAULT_CATALOG)).toBeNull();
  });
});

describe('policy ceiling', () => {
  it('never recommends a tier outside allowedTiers, even when it scores best', () => {
    // fable outranks opus for `architecture` under the scorer's tables, and the
    // catalog knows fable — but backend-developer is not fable-allowlisted.
    const ceiling = allowedTiers('backend-developer', { role: 'review' }, CONFIG);
    expect([...ceiling]).toEqual(['opus']);

    const receipt = routeModel(completeInput({
      agentType: 'backend-developer',
      role: 'review',
      actionClass: 'architecture',
    }));
    expect(receipt.models.recommended.tier).toBe('opus');
    expect(receipt.reason).toContain('route:opus');
  });

  it('lets a caller narrow the ceiling but never widen it', () => {
    expect(resolveCandidateTiers({ agentType: 'architect', role: 'build', config: CONFIG }))
      .toEqual(['opus', 'fable']);
    // Asking for a tier outside the ceiling yields the empty set, not the tier.
    expect(resolveCandidateTiers({
      agentType: 'backend-developer', config: CONFIG, allowedTiers: ['fable'],
    })).toEqual([]);
    // Narrowing inside the ceiling works.
    expect(resolveCandidateTiers({
      agentType: 'architect', role: 'build', config: CONFIG, allowedTiers: ['opus'],
    })).toEqual(['opus']);
  });

  it('recommends nothing rather than something plausible when the set is empty', () => {
    const receipt = routeModel(completeInput({
      agentType: 'backend-developer', allowedTiers: ['fable'],
    }));
    expect(receipt.models.recommended).toBeNull();
    expect(receipt.reason).toContain('route:no-candidate');
    expect(receipt.predicted).toEqual({
      success: 0, cost: 0, latency: 0, retry_probability: 0,
    });
  });

  it('records the divergence between the recommendation and what policy selects', () => {
    const receipt = routeModel(completeInput({ actionClass: 'architecture' }));
    expect(receipt.models.recommended.tier).toBe('fable');
    expect(receipt.models.selected.tier).toBe(resolveModel('architect', { role: 'build' }, CONFIG));
    expect(receipt.models.selected.tier).toBe('opus');
    expect(receipt.reason).toContain('divergence');
  });
});

describe('decision vocabulary', () => {
  it('pins when policy keeps the incumbent seat', () => {
    const receipt = routeModel(completeInput({ currentTier: 'opus', role: 'build' }));
    expect(receipt.decision.type).toBe('pin');
  });

  it('routes on the first decision of a session, where there is no incumbent', () => {
    const receipt = routeModel(completeInput({ currentTier: undefined }));
    expect(receipt.models.current).toBeNull();
    expect(receipt.decision.type).toBe('route');
  });

  it('routes when policy itself moves off the incumbent', () => {
    const receipt = routeModel(completeInput({ currentTier: 'haiku', role: 'build' }));
    expect(receipt.decision.type).toBe('route');
  });

  it('emits only route or pin across every action class and both roles', () => {
    const classes = schema.properties.action.properties.type.enum;
    for (const actionClass of classes) {
      for (const role of ['build', 'review']) {
        for (const currentTier of [undefined, 'haiku', 'opus', 'fable']) {
          const receipt = routeModel(completeInput({ actionClass, role, currentTier }));
          expect(ROUTER_DECISIONS).toContain(receipt.decision.type);
        }
      }
    }
  });
});

describe('injected effort and budget ports', () => {
  it('emits a receipt with no ports injected, and names both as unavailable', () => {
    const receipt = routeModel(completeInput({ ports: undefined }));
    expect(receipt.reason).toContain('effort:unavailable');
    expect(receipt.reason).toContain('budget:unavailable');
  });

  it('leaves every cost term measured:false on a real transition with no ports', () => {
    // A cross-tier move: `same-tier` is the one case where four terms are an
    // honest measured zero (route-hysteresis.js), so it would not test this.
    const receipt = routeModel(completeInput({ actionClass: 'architecture' }));
    expect(receipt.models.recommended.tier).not.toBe(receipt.models.current.tier);
    for (const name of COST_TERMS) {
      expect(receipt.terms[name].measured, name).toBe(false);
    }
  });

  it('reports the effort level a port returns without computing one', () => {
    const receipt = routeModel(completeInput({ ports: { resolveEffort: () => 'xhigh' } }));
    expect(receipt.reason).toContain('effort:xhigh');
    expect(receipt.reason).not.toContain('effort:unavailable');
  });

  it('treats a throwing or empty port exactly as an absent one', () => {
    const thrown = routeModel(completeInput({
      ports: {
        resolveEffort: () => { throw new Error('resolver exploded'); },
        budgetFor: () => undefined,
      },
    }));
    expect(thrown.reason).toContain('effort:unavailable');
    expect(thrown.reason).toContain('budget:unavailable');
  });

  it('feeds the budget port into the economics instead of looking a budget up', () => {
    const base = completeInput({ actionClass: 'architecture', actionsSinceSwitch: 9 });
    const withoutBudget = routeModel(base);
    const withBudget = routeModel({ ...base, ports: { budgetFor: () => 500_000 } });
    expect(withoutBudget.reason).toContain('budget:unavailable');
    expect(withBudget.reason).not.toContain('budget:unavailable');
    // The projected future-cost saving only exists once a remaining-token
    // figure is injected; nothing in this module can produce that number.
    expect(withBudget.transition.predicted_cost)
      .toBeGreaterThanOrEqual(withoutBudget.transition.predicted_cost);
  });
});

describe('routing epoch (G1 unresolved)', () => {
  it('uses the caller-supplied epoch verbatim', () => {
    expect(routeModel(completeInput({ epoch: 'spawn-abc' })).routing_epoch_id).toBe('spawn-abc');
  });

  it('nulls the epoch and says so rather than inventing a joinable id', () => {
    const receipt = routeModel(completeInput({ epoch: undefined }));
    expect(receipt.routing_epoch_id).toBeNull();
    expect(receipt.reason).toContain('epoch:unavailable');
  });

  it('names every missing identity field instead of filling it', () => {
    const receipt = routeModel(completeInput({ evidence: {} }));
    for (const field of REQUIRED_EVIDENCE) {
      expect(receipt[field], field).toBeNull();
      expect(receipt.reason).toContain(`evidence:missing:${field}`);
    }
  });

  it('reports an absent residency counter rather than reading 0 as "just switched"', () => {
    const receipt = routeModel(completeInput({ actionsSinceSwitch: undefined }));
    expect(receipt.actionsSinceSwitch).toBe(0);
    expect(receipt.reason).toContain('residency:unavailable');
  });
});

describe('purity', () => {
  it('reads no filesystem and holds no clock or random source', () => {
    expect(ROUTER_CODE).not.toMatch(/node:fs/);
    expect(ROUTER_CODE).not.toMatch(/Date\s*\.\s*now/);
    expect(ROUTER_CODE).not.toMatch(/new\s+Date\b/);
    expect(ROUTER_CODE).not.toMatch(/Math\s*\.\s*random/);
    expect(ROUTER_CODE).not.toMatch(/process\s*\.\s*env/);
  });

  it('imports only the four routing peers and core model-policy', () => {
    const specifiers = [...ROUTER_CODE.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specifiers.sort()).toEqual([
      '../core/model-policy.js',
      './action-classifier.js',
      './route-hysteresis.js',
      './route-scorer.js',
    ]);
  });

  it('returns the same receipt for the same input, twice', () => {
    const first = routeModel(completeInput());
    const second = routeModel(completeInput());
    expect(first).toEqual(second);
  });

  it('never throws on hostile input', () => {
    for (const bad of [undefined, null, 'string', 42, [], { agentType: 7, evidence: 'no' }]) {
      expect(() => routeModel(bad)).not.toThrow();
    }
  });
});

/**
 * What a reader sees when the schema oracle is gone. Written as guidance, not
 * as a bare failure: the correct response is to DECLARE the dependency, and
 * the wrong one — restoring the skip — is the one that looks easiest at 2am.
 * @type {string}
 */
const AJV_MISSING = [
  'ajv could not be resolved, so schemas/route-receipt.schema.json cannot be enforced and this gate',
  'proves nothing. ajv is only a TRANSITIVE dependency here (eslint -> ajv);',
  "package.json declares no 'ajv'.",
  'FIX: add ajv to devDependencies. Do NOT skip or delete these assertions —',
  'a skipped conformance test reports the same green as a passing one.',
].join(' ');

describe('route-receipt schema conformance', () => {
  // A THROWING STUB when ajv is absent, not null: a null validator turns every
  // assertion below into "validate is not a function", which buries the real
  // cause. The stub makes each test fail with the fix instruction instead.
  const validate = Ajv === null
    ? () => {
      throw new Error(AJV_MISSING);
    }
    : new Ajv({ allErrors: true }).compile(schema);

  it('accepts a receipt built from a complete input', () => {
    const receipt = routeModel(completeInput());
    const ok = validate(receipt);
    expect(validate.errors ?? [], JSON.stringify(validate.errors)).toEqual([]);
    expect(ok).toBe(true);
  });

  it('accepts receipts for every action class the schema allows', () => {
    for (const actionClass of schema.properties.action.properties.type.enum) {
      const receipt = routeModel(completeInput({ actionClass, phase: 'build' }));
      validate(receipt);
      expect(validate.errors ?? [], `${actionClass}: ${JSON.stringify(validate.errors)}`)
        .toEqual([]);
    }
  });

  it('fails on routing_epoch_id ALONE when no epoch was injected', () => {
    // The one deliberate deviation. It is pinned here so it stays a single,
    // visible point: the day a second field starts failing, this test says so.
    const receipt = routeModel(completeInput({ epoch: undefined }));
    expect(validate(receipt)).toBe(false);
    const paths = [...new Set((validate.errors ?? []).map(errorPath))];
    expect(paths).toEqual(['.routing_epoch_id']);
  });

  it('rejects a receipt whose identity the caller never supplied', () => {
    expect(validate(routeModel(completeInput({ evidence: {} })))).toBe(false);
  });

  it('has a real oracle — present, and able to say NO as well as YES', () => {
    // The assertion IS the fail-closed statement: when ajv is gone this test
    // fails and prints the fix, instead of the suite quietly running four
    // fewer assertions. The compared value carries the guidance so the failure
    // diff is the instruction.
    expect(Ajv === null ? AJV_MISSING : 'oracle present').toBe('oracle present');

    // Without this, every `validate(x) === true` above would also pass against
    // a vacuous or mis-compiled validator. Proving the oracle can say NO is
    // what makes its YES worth anything.
    expect(validate(routeModel(completeInput()))).toBe(true);
    const broken = { ...routeModel(completeInput()) };
    delete broken.reason;
    expect(validate(broken)).toBe(false);
  });
});
