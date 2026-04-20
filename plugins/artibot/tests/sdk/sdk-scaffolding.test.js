import { describe, expect, it } from 'vitest';
import {
  createSkill,
  createAgent,
  createHook,
  createMiddleware,
  validatePackage,
} from '../../lib/sdk/artibot-sdk.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_SKILL_SPEC = {
  name: 'api-monitor',
  description: 'Monitor API health',
  category: 'engineering',
  triggers: ['api monitor', 'check api'],
  body: '# API Monitor\n\nMonitors API health endpoints.',
};

const VALID_AGENT_SPEC = {
  name: 'code-reviewer',
  role: 'Code Reviewer',
  model: 'opus',
  tools: ['Read', 'Grep'],
  systemPrompt: 'Review code for quality and correctness.',
  body: '## Instructions\n\nReview all changed files.',
};

const VALID_HOOK_SPEC = {
  event: 'PreToolUse',
  name: 'validate-input',
  description: 'Validates tool input before execution',
  script: 'const data = JSON.parse(process.argv[2]);\nconsole.log(data);',
};

const VALID_MIDDLEWARE_SPEC = {
  name: 'rate-limiter',
  position: 'before',
  target: 'auth',
  factoryCode: 'export default function rateLimiter(ctx) { return ctx; }',
};

// ---------------------------------------------------------------------------
// createSkill
// ---------------------------------------------------------------------------

describe('SDK scaffolding — createSkill', () => {
  it('returns valid result with skillMd and dirName for a valid spec', () => {
    const result = createSkill(VALID_SKILL_SPEC);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.skillMd).toBeTypeOf('string');
    expect(result.dirName).toBe('api-monitor');
  });

  it('generates skillMd with correct YAML frontmatter fields', () => {
    const result = createSkill(VALID_SKILL_SPEC);

    expect(result.skillMd).toContain('name: api-monitor');
    expect(result.skillMd).toContain('description: Monitor API health');
    expect(result.skillMd).toContain('category: "engineering"');
    // Frontmatter delimiters
    expect(result.skillMd).toMatch(/^---\n/);
    expect(result.skillMd).toContain('\n---\n');
  });

  it('includes trigger phrases in frontmatter when provided', () => {
    const result = createSkill(VALID_SKILL_SPEC);

    expect(result.skillMd).toContain('triggers:');
    expect(result.skillMd).toContain('"api monitor"');
    expect(result.skillMd).toContain('"check api"');
  });

  it('rejects a name that is not kebab-case', () => {
    const spec = { ...VALID_SKILL_SPEC, name: 'ApiMonitor' };
    const result = createSkill(spec);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('not valid kebab-case'))).toBe(true);
    expect(result.skillMd).toBeNull();
  });

  it('reports errors for missing required fields', () => {
    const result = createSkill({ name: 'ok-name', body: '# Body' });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"description"'))).toBe(true);
    expect(result.errors.some((e) => e.includes('"category"'))).toBe(true);
  });

  it('rejects a spec with missing body', () => {
    const { body: _, ...noBody } = VALID_SKILL_SPEC;
    const result = createSkill(noBody);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"body"'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createAgent
// ---------------------------------------------------------------------------

describe('SDK scaffolding — createAgent', () => {
  it('returns valid result with agentMd and fileName for a valid spec', () => {
    const result = createAgent(VALID_AGENT_SPEC);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.agentMd).toBeTypeOf('string');
    expect(result.fileName).toBe('code-reviewer.md');
  });

  it('generates agentMd containing model, role, tools, and systemPrompt', () => {
    const result = createAgent(VALID_AGENT_SPEC);

    expect(result.agentMd).toContain('# Code Reviewer');
    expect(result.agentMd).toContain('**Model**: opus');
    expect(result.agentMd).toContain('**Tools**: Read, Grep');
    expect(result.agentMd).toContain('## System Prompt');
    expect(result.agentMd).toContain('Review code for quality and correctness.');
  });

  it('rejects an invalid model tier', () => {
    const spec = { ...VALID_AGENT_SPEC, model: 'gpt-4' };
    const result = createAgent(spec);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Invalid model'))).toBe(true);
    expect(result.agentMd).toBeNull();
  });

  it('reports errors for missing required fields', () => {
    const result = createAgent({ name: 'test-agent', body: '# Body' });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('"role"'))).toBe(true);
    expect(result.errors.some((e) => e.includes('"model"'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createHook
// ---------------------------------------------------------------------------

describe('SDK scaffolding — createHook', () => {
  it('returns valid result with scriptContent and registration for a valid spec', () => {
    const result = createHook(VALID_HOOK_SPEC);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.scriptContent).toBeTypeOf('string');
    expect(result.registration).toBeTypeOf('object');
  });

  it('generates scriptContent with a shebang line', () => {
    const result = createHook(VALID_HOOK_SPEC);

    expect(result.scriptContent).toMatch(/^#!\/usr\/bin\/env node/);
  });

  it('produces registration with correct event and script path', () => {
    const result = createHook(VALID_HOOK_SPEC);

    expect(result.registration).toEqual({
      event: 'PreToolUse',
      script: 'scripts/hooks/validate-input.js',
      description: 'Validates tool input before execution',
    });
  });

  it('rejects an invalid event type', () => {
    const spec = { ...VALID_HOOK_SPEC, event: 'OnBanana' };
    const result = createHook(spec);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Invalid event'))).toBe(true);
    expect(result.scriptContent).toBeNull();
    expect(result.registration).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createMiddleware
// ---------------------------------------------------------------------------

describe('SDK scaffolding — createMiddleware', () => {
  it('returns valid result with moduleContent and registration for a valid spec', () => {
    const result = createMiddleware(VALID_MIDDLEWARE_SPEC);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.moduleContent).toBeTypeOf('string');
    expect(result.registration).toBeTypeOf('object');
  });

  it('generates moduleContent with a JSDoc header', () => {
    const result = createMiddleware(VALID_MIDDLEWARE_SPEC);

    expect(result.moduleContent).toContain('/**');
    expect(result.moduleContent).toContain('* Custom middleware: rate-limiter');
    expect(result.moduleContent).toContain('@module lib/runtime/middleware/rate-limiter');
    expect(result.moduleContent).toContain('*/');
  });

  it('rejects an invalid position value', () => {
    const spec = { ...VALID_MIDDLEWARE_SPEC, position: 'around' };
    const result = createMiddleware(spec);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Invalid position'))).toBe(true);
    expect(result.moduleContent).toBeNull();
    expect(result.registration).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validatePackage
// ---------------------------------------------------------------------------

describe('SDK scaffolding — validatePackage', () => {
  it('validates a package with mixed valid skills and agents', () => {
    const pkg = {
      skills: [VALID_SKILL_SPEC],
      agents: [VALID_AGENT_SPEC],
    };
    const result = validatePackage(pkg);

    expect(result.valid).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].type).toBe('skill');
    expect(result.results[1].type).toBe('agent');
  });

  it('reports correct errorCount when one item is invalid', () => {
    const badSkill = { ...VALID_SKILL_SPEC, name: 'BAD NAME' };
    const pkg = {
      skills: [VALID_SKILL_SPEC, badSkill],
      agents: [VALID_AGENT_SPEC],
    };
    const result = validatePackage(pkg);

    expect(result.valid).toBe(false);
    expect(result.errorCount).toBeGreaterThan(0);
    // The valid items still produce results
    expect(result.results).toHaveLength(3);
    expect(result.results.filter((r) => r.valid)).toHaveLength(2);
  });

  it('returns valid: true with empty results for an empty package', () => {
    const result = validatePackage({});

    expect(result.valid).toBe(true);
    expect(result.results).toEqual([]);
    expect(result.errorCount).toBe(0);
  });
});
