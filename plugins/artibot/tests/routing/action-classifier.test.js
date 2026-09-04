/**
 * Tests for lib/routing/action-classifier.js (T-27).
 *
 * @module tests/routing/action-classifier
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  ACTION_CLASS_TIERS,
  ACTION_CLASSES,
  AGENT_ACTION_CLASS,
  AGENT_CLASS_EXEMPT,
  classifyAction,
  COMMAND_ACTION_CLASS,
  DEFAULT_ACTION_CLASS,
  derivePhase,
  getActionClassForAgent,
  getActionClassForCommand,
  HOST_BUILTIN_AGENTS,
  isActionClass,
  SOURCE_CONFIDENCE,
} from '../../lib/routing/action-classifier.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '../..');

/** Read the action.type enum straight out of the T-16 receipt schema. */
function schemaActionEnum() {
  const raw = readFileSync(resolve(PLUGIN_ROOT, 'schemas/route-receipt.schema.json'), 'utf8');
  return JSON.parse(raw).properties.action.properties.type.enum;
}

/**
 * Agent names exactly as `agents/` spells them, read from disk at call time so
 * the census measures the roster that exists now, not one restated by hand.
 * `INDEX.md` is included deliberately: it is a roster FILE, and whether it
 * counts as an agent is the exempt list's job to say, not this helper's.
 *
 * @returns {Set<string>} File stems of every `agents/*.md`.
 */
function rosterAgentFiles() {
  return new Set(
    readdirSync(resolve(PLUGIN_ROOT, 'agents'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, '')),
  );
}

// ---------------------------------------------------------------------------
// Vocabulary — pinned against the T-16 schema, not restated by hand
// ---------------------------------------------------------------------------

describe('action class vocabulary', () => {
  it('matches the route-receipt schema action.type enum exactly', () => {
    expect([...ACTION_CLASSES]).toEqual(schemaActionEnum());
  });

  it('has exactly eight classes', () => {
    expect(ACTION_CLASSES).toHaveLength(8);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ACTION_CLASSES)).toBe(true);
    expect(Object.isFrozen(ACTION_CLASS_TIERS)).toBe(true);
    expect(Object.isFrozen(COMMAND_ACTION_CLASS)).toBe(true);
    expect(Object.isFrozen(AGENT_ACTION_CLASS)).toBe(true);
  });

  it.each([...ACTION_CLASSES])('isActionClass accepts %s', (cls) => {
    expect(isActionClass(cls)).toBe(true);
  });

  it.each([null, undefined, 42, '', 'Classify', 'CLASSIFY', 'plan', 'debug'])(
    'isActionClass rejects %p',
    (bad) => {
      expect(isActionClass(bad)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// The trap: complex-debugging is the advisor axis, not an action class
// ---------------------------------------------------------------------------

describe('complex-debugging is never an action class', () => {
  it('isActionClass rejects the advisor trigger spelling', () => {
    expect(isActionClass('complex-debugging')).toBe(false);
    expect(isActionClass('complex-debug')).toBe(true);
  });

  it('is the spelling the repo config actually uses on the other axis', () => {
    const cfg = JSON.parse(readFileSync(resolve(PLUGIN_ROOT, 'artibot.config.json'), 'utf8'));
    const triggers = cfg.agents.modelPolicy.advisorStrategy.triggerConditions;
    expect(triggers).toContain('complex-debugging');
    expect(triggers).not.toContain('complex-debug');
  });

  it('appears in no table as a value', () => {
    const values = [
      ...Object.values(COMMAND_ACTION_CLASS),
      ...Object.values(AGENT_ACTION_CLASS),
      ...Object.keys(ACTION_CLASS_TIERS),
    ];
    expect(values).not.toContain('complex-debugging');
  });

  it('classifyAction never emits it, whatever the text says', () => {
    const out = classifyAction({ text: 'run a complex-debugging advisor pass' });
    expect(out.actionClass).not.toBe('complex-debugging');
    expect(isActionClass(out.actionClass)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tier policy table (exported only, applied by T-29)
// ---------------------------------------------------------------------------

describe('ACTION_CLASS_TIERS', () => {
  it('covers all eight classes and nothing else', () => {
    expect(Object.keys(ACTION_CLASS_TIERS).sort()).toEqual([...ACTION_CLASSES].sort());
  });

  it('maps the eight behaviour aliases as the design fixes them', () => {
    expect(ACTION_CLASS_TIERS).toEqual({
      classify: 'haiku',
      status: 'haiku',
      explore: 'sonnet',
      'edit-routine': 'sonnet',
      implement: 'opus',
      'complex-debug': 'opus',
      architecture: 'fable',
      review: 'fable',
    });
  });

  it('uses only tiers the model catalog knows', async () => {
    const { MODELS } = await import('../../lib/core/model-catalog.js');
    for (const tier of Object.values(ACTION_CLASS_TIERS)) {
      expect(Object.keys(MODELS)).toContain(tier);
    }
  });
});

// ---------------------------------------------------------------------------
// Command table — the first source of truth
// ---------------------------------------------------------------------------

describe('COMMAND_ACTION_CLASS', () => {
  it('maps 48 of the 79 commands', () => {
    expect(Object.keys(COMMAND_ACTION_CLASS)).toHaveLength(48);
  });

  it('every mapped key is a real command file in commands/', () => {
    const commands = new Set(
      readdirSync(resolve(PLUGIN_ROOT, 'commands'))
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, '')),
    );
    const missing = Object.keys(COMMAND_ACTION_CLASS).filter((c) => !commands.has(c));
    expect(missing).toEqual([]);
  });

  it('every mapped value is one of the eight classes', () => {
    for (const cls of Object.values(COMMAND_ACTION_CLASS)) {
      expect(isActionClass(cls)).toBe(true);
    }
  });

  it.each([
    ['code-review', 'review'],
    ['/code-review', 'review'],
    ['implement', 'implement'],
    ['troubleshoot', 'complex-debug'],
    ['build-fix', 'complex-debug'],
    ['design', 'architecture'],
    ['doctor', 'status'],
    ['sc', 'classify'],
    ['document', 'edit-routine'],
    ['analyze', 'explore'],
  ])('getActionClassForCommand(%s) is %s', (cmd, expected) => {
    expect(getActionClassForCommand(cmd)).toBe(expected);
  });

  it.each(['team', 'autopilot', 'split', 'build', 'test', 'verify', 'ppt', 'seo'])(
    'returns null for the intentionally unmapped command %s',
    (cmd) => {
      expect(getActionClassForCommand(cmd)).toBeNull();
    },
  );

  it.each([null, undefined, 42, {}])('returns null for non-string %p', (bad) => {
    expect(getActionClassForCommand(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Agent table
// ---------------------------------------------------------------------------

describe('AGENT_ACTION_CLASS', () => {
  it.each([
    ['code-reviewer', 'review'],
    ['artibot:code-reviewer', 'review'],
    ['artibot-cowork:planner', 'architecture'],
    ['backend-developer', 'implement'],
    ['build-error-resolver', 'complex-debug'],
    ['repo-benchmarker', 'explore'],
    ['doc-updater', 'edit-routine'],
    // Added by the route-coverage limb: the agents live spawns were falling to
    // `source: 'default'` on.
    ['auditor', 'review'],
    ['artibot:investigator', 'explore'],
    ['orchestrator', 'architecture'],
    // Marketing roster — nearest class, mapped on purpose (see the table's
    // divergence note), so a marketing spawn still yields a receipt.
    ['seo-specialist', 'review'],
    ['cro-specialist', 'review'],
    ['marketing-strategist', 'architecture'],
    ['ad-specialist', 'implement'],
    ['content-marketer', 'implement'],
    ['presentation-designer', 'implement'],
    ['data-analyst', 'explore'],
    // Host built-ins, which arrive with no plugin prefix.
    ['Explore', 'explore'],
    ['Plan', 'architecture'],
  ])('getActionClassForAgent(%s) is %s', (agent, expected) => {
    expect(getActionClassForAgent(agent)).toBe(expected);
  });

  it('returns null for an unknown agent', () => {
    expect(getActionClassForAgent('artibot:nobody')).toBeNull();
  });

  it.each([...AGENT_CLASS_EXEMPT])('returns null for the exempt name %s', (agent) => {
    expect(getActionClassForAgent(agent)).toBeNull();
  });

  it('identifies every mapped agent even when the text says nothing', () => {
    // The live gap this limb closes: a spawn whose description carries no
    // keyword must still be classified by the agent, not fall to the default —
    // `route-observe-pre.js#receiptPhase` drops a `default` action entirely.
    for (const agent of Object.keys(AGENT_ACTION_CLASS)) {
      const out = classifyAction({ agentType: `artibot:${agent}`, text: 'aaa bbb ccc' });
      expect(out.factors.source, agent).toBe('agent');
      expect(out.confidence).toBe(SOURCE_CONFIDENCE.agent);
    }
  });
});

// ---------------------------------------------------------------------------
// Roster census — an allowlist in BOTH directions, so the table cannot rot
// ---------------------------------------------------------------------------

describe('AGENT_ACTION_CLASS roster census', () => {
  it('covers every agent definition file, mapped or explicitly exempt', () => {
    const mapped = new Set(Object.keys(AGENT_ACTION_CLASS));
    const exempt = new Set(AGENT_CLASS_EXEMPT);
    const uncovered = [...rosterAgentFiles()].filter((a) => !mapped.has(a) && !exempt.has(a));
    // A new `agents/*.md` lands here until someone decides its class. Leaving
    // it unmapped is a decision too — record it in AGENT_CLASS_EXEMPT.
    expect(uncovered).toEqual([]);
  });

  it('maps no key that is neither a roster agent nor a host built-in', () => {
    const known = new Set([...rosterAgentFiles(), ...HOST_BUILTIN_AGENTS]);
    const orphans = Object.keys(AGENT_ACTION_CLASS).filter((a) => !known.has(a));
    expect(orphans).toEqual([]);
  });

  it('exempts no name that is neither a roster agent nor a host built-in', () => {
    const known = new Set([...rosterAgentFiles(), ...HOST_BUILTIN_AGENTS]);
    expect(AGENT_CLASS_EXEMPT.filter((a) => !known.has(a))).toEqual([]);
  });

  it('never lists a name as both mapped and exempt', () => {
    const mapped = new Set(Object.keys(AGENT_ACTION_CLASS));
    expect(AGENT_CLASS_EXEMPT.filter((a) => mapped.has(a))).toEqual([]);
  });

  it('maps every key to one of the eight classes', () => {
    for (const [agent, cls] of Object.entries(AGENT_ACTION_CLASS)) {
      expect(isActionClass(cls), `${agent} -> ${cls}`).toBe(true);
    }
  });

  it('leaves exactly one roster FILE unclassified, and names which', () => {
    // INDEX.md is the generated index, not an agent. If this list ever grows,
    // the entry is a spawn whose receipts are being dropped — say so out loud.
    const roster = rosterAgentFiles();
    expect(AGENT_CLASS_EXEMPT.filter((a) => roster.has(a))).toEqual(['INDEX']);
  });

  it('pins the host built-ins, so adding one is a deliberate edit', () => {
    expect([...HOST_BUILTIN_AGENTS]).toEqual(['Explore', 'Plan', 'general-purpose']);
  });

  it('freezes both lists', () => {
    expect(Object.isFrozen(AGENT_CLASS_EXEMPT)).toBe(true);
    expect(Object.isFrozen(HOST_BUILTIN_AGENTS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase derivation
// ---------------------------------------------------------------------------

describe('derivePhase', () => {
  it.each(['implementation', 'build', 'impl'])('maps build role %s', (role) => {
    expect(derivePhase(role)).toBe('build');
  });

  it.each(['review', 'inspect', 'crosscheck'])('maps review role %s', (role) => {
    expect(derivePhase(role)).toBe('review');
  });

  it('is case-insensitive', () => {
    expect(derivePhase('CrossCheck')).toBe('review');
  });

  it.each([null, undefined, '', 'planning', 'deploy', 7])(
    'returns null for unknown role %p',
    (role) => {
      expect(derivePhase(role)).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// classifyAction — precedence
// ---------------------------------------------------------------------------

describe('classifyAction precedence', () => {
  it('command wins over agent, text and footprint', () => {
    const out = classifyAction({
      command: 'doctor',
      agentType: 'artibot:backend-developer',
      text: 'implement the whole feature',
      toolsRequested: ['Write', 'Edit'],
      filesTouched: ['a.js', 'b.js', 'c.js'],
    });
    expect(out.actionClass).toBe('status');
    expect(out.factors.source).toBe('command');
    expect(out.confidence).toBe(SOURCE_CONFIDENCE.command);
  });

  it('agent wins over text when there is no command', () => {
    const out = classifyAction({
      agentType: 'artibot:architect',
      text: 'please review this diff',
    });
    expect(out.actionClass).toBe('architecture');
    expect(out.factors.source).toBe('agent');
    expect(out.confidence).toBe(SOURCE_CONFIDENCE.agent);
  });

  it('falls back to text keywords', () => {
    const out = classifyAction({ text: 'find the root cause of this regression' });
    expect(out.actionClass).toBe('complex-debug');
    expect(out.factors.source).toBe('text');
    expect(out.confidence).toBe(SOURCE_CONFIDENCE.text);
  });

  it('falls back to the tool/file footprint', () => {
    const out = classifyAction({ toolsRequested: ['Read', 'Grep'], filesTouched: [] });
    expect(out.actionClass).toBe('explore');
    expect(out.factors.source).toBe('footprint');
    expect(out.confidence).toBe(SOURCE_CONFIDENCE.footprint);
  });

  it('reads a wide write footprint as implement', () => {
    const out = classifyAction({
      toolsRequested: ['Write', 'Edit'],
      filesTouched: ['a.js', 'b.js', 'c.js'],
    });
    expect(out.actionClass).toBe('implement');
  });

  it('reads a single-file write as edit-routine', () => {
    const out = classifyAction({ toolsRequested: ['Edit'], filesTouched: ['README.md'] });
    expect(out.actionClass).toBe('edit-routine');
  });

  it('defaults to implement with the lowest confidence on an empty input', () => {
    const out = classifyAction({});
    expect(out.actionClass).toBe(DEFAULT_ACTION_CLASS);
    expect(out.actionClass).toBe('implement');
    expect(out.factors.source).toBe('default');
    expect(out.confidence).toBe(SOURCE_CONFIDENCE.default);
  });

  it('never throws on garbage input', () => {
    for (const bad of [undefined, null, 'string', 7, []]) {
      expect(() => classifyAction(bad)).not.toThrow();
      expect(isActionClass(classifyAction(bad).actionClass)).toBe(true);
    }
  });

  it('always returns one of the eight classes', () => {
    const inputs = [
      { command: 'nonexistent-command' },
      { agentType: 'ghost' },
      { text: 'ありがとう' },
      { toolsRequested: ['Bash'] },
    ];
    for (const input of inputs) {
      expect(ACTION_CLASSES).toContain(classifyAction(input).actionClass);
    }
  });
});

// ---------------------------------------------------------------------------
// classifyAction — phase
// ---------------------------------------------------------------------------

describe('classifyAction phase', () => {
  it('derives phase from role', () => {
    expect(classifyAction({ command: 'code-review', role: 'crosscheck' }).phase).toBe('review');
    expect(classifyAction({ command: 'implement', role: 'build' }).phase).toBe('build');
  });

  it('lets an explicit phase override the role', () => {
    expect(classifyAction({ role: 'build', phase: 'inspection' }).phase).toBe('inspection');
  });

  it('is null when neither phase nor a known role is given', () => {
    expect(classifyAction({ command: 'implement' }).phase).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyAction — injected complexity port (L2 must not import L4)
// ---------------------------------------------------------------------------

describe('classifyAction complexity port', () => {
  const fakePort = () => ({
    score: 0.42,
    factors: { steps: 0.2, domains: 0.4, uncertainty: 0.6, risk: 0.3, novelty: 0.1 },
  });

  it('surfaces the port score as factors.complexity and the five factors', () => {
    const out = classifyAction({ command: 'implement', text: 'do the thing' }, {
      classifyComplexity: fakePort,
    });
    expect(out.factors).toMatchObject({
      source: 'command',
      complexity: 0.42,
      steps: 0.2,
      domains: 0.4,
      uncertainty: 0.6,
      risk: 0.3,
      novelty: 0.1,
    });
  });

  it('omits complexity factors when no port is injected', () => {
    const out = classifyAction({ command: 'implement', text: 'do the thing' });
    expect(out.factors).toEqual({ source: 'command' });
    expect(out.factors.complexity).toBeUndefined();
  });

  it('passes complexityContext through to the port', () => {
    const seen = [];
    classifyAction(
      { command: 'implement', text: 'x' },
      {
        classifyComplexity: (text, ctx) => { seen.push([text, ctx]); return {}; },
        complexityContext: { sessionDepth: 3 },
      },
    );
    expect(seen).toEqual([['x', { sessionDepth: 3 }]]);
  });

  it('degrades to no factors when the port throws', () => {
    const out = classifyAction({ command: 'implement', text: 'x' }, {
      classifyComplexity: () => { throw new Error('boom'); },
    });
    expect(out.actionClass).toBe('implement');
    expect(out.factors).toEqual({ source: 'command' });
  });

  it('ignores a port that returns a malformed result', () => {
    for (const bad of [null, undefined, 'nope', 7]) {
      const out = classifyAction({ command: 'implement', text: 'x' }, {
        classifyComplexity: () => bad,
      });
      expect(out.factors).toEqual({ source: 'command' });
    }
  });

  it('drops non-numeric factor values', () => {
    const out = classifyAction({ command: 'implement', text: 'x' }, {
      classifyComplexity: () => ({ score: 0.5, factors: { steps: 0.1, junk: 'nope' } }),
    });
    expect(out.factors.steps).toBe(0.1);
    expect(out.factors.junk).toBeUndefined();
  });

  it('accepts the real classifyComplexity as the port without importing it in lib', async () => {
    const { classifyComplexity } = await import('../../lib/cognitive/router.js');
    const out = classifyAction(
      { command: 'implement', text: 'implement login with OAuth then add tests' },
      { classifyComplexity },
    );
    expect(typeof out.factors.complexity).toBe('number');
    expect(typeof out.factors.uncertainty).toBe('number');
    expect(typeof out.factors.risk).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Layer rule: lib/routing (L2) must not import lib/cognitive (L4)
// ---------------------------------------------------------------------------

describe('layer discipline', () => {
  it('imports only lib/core, never a higher layer', () => {
    const src = readFileSync(
      resolve(PLUGIN_ROOT, 'lib/routing/action-classifier.js'),
      'utf8',
    );
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual(['../core/model-policy.js']);
    for (const higher of ['cognitive', 'topology', 'learning', 'handoff', 'runtime']) {
      expect(imports.some((i) => i.includes(`/${higher}/`))).toBe(false);
    }
  });

  it('keeps classifyComplexity out of the import list, port-injected only', () => {
    const src = readFileSync(
      resolve(PLUGIN_ROOT, 'lib/routing/action-classifier.js'),
      'utf8',
    );
    expect(src).not.toMatch(/^\s*import\s[^;]*?from\s+'[^']*cognitive[^']*'/m);
  });
});

// ---------------------------------------------------------------------------
// Role sets come from lib/core, not a local copy
// ---------------------------------------------------------------------------

describe('phase role vocabulary is the model-policy one', () => {
  it('derivePhase agrees with the exported BUILD_ROLES / REVIEW_ROLES', async () => {
    const { BUILD_ROLES, REVIEW_ROLES } = await import('../../lib/core/model-policy.js');
    for (const role of BUILD_ROLES) expect(derivePhase(role)).toBe('build');
    for (const role of REVIEW_ROLES) expect(derivePhase(role)).toBe('review');
  });

  it('re-lists neither role set as a literal in the source', () => {
    const src = readFileSync(
      resolve(PLUGIN_ROOT, 'lib/routing/action-classifier.js'),
      'utf8',
    );
    // A mirrored copy would have to spell these strings; only the import may.
    expect(src).not.toMatch(/new Set\(\[\s*'implementation'/);
    expect(src).not.toMatch(/new Set\(\[\s*'review'/);
    expect(src).toMatch(/import \{ BUILD_ROLES, REVIEW_ROLES \} from '\.\.\/core\/model-policy\.js'/);
  });

  it('never mutates the imported sets', async () => {
    const { BUILD_ROLES, REVIEW_ROLES } = await import('../../lib/core/model-policy.js');
    const buildBefore = [...BUILD_ROLES];
    const reviewBefore = [...REVIEW_ROLES];
    classifyAction({ command: 'implement', role: 'build' });
    classifyAction({ command: 'code-review', role: 'crosscheck' });
    classifyAction({ role: 'not-a-role' });
    expect([...BUILD_ROLES]).toEqual(buildBefore);
    expect([...REVIEW_ROLES]).toEqual(reviewBefore);
  });
});
