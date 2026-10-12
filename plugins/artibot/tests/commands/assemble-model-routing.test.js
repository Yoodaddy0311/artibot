/**
 * /assemble spawns its five representatives on the model the model-routing CLI
 * resolves - never a hardcoded name, never an omitted `model`.
 *
 * WHY: until 2026-10-12 `commands/assemble.md` spawned architect, code-reviewer,
 * backend-developer, security-reviewer and tdd-guide with a literal
 * `model="sonnet"`. The owner's routing rule is design/review on the strong tier
 * and implementation on the fast tier, decided by
 * `scripts/model-routing/model-routing.mjs resolve <plugin:name>` - so the three
 * design/review spawns ran one tier below the rule.
 *
 * `raw-model-names.test.js` already blocks the bad literal. It cannot see the
 * other failure: deleting the `model` argument outright passes that gate, and a
 * spawn without `model` follows the agent frontmatter, so the user's
 * `/model-routing` setting never reaches it (commands/team.md "Teammate Rules &
 * Model Policy"). This file pins the PRESENCE of the intended behaviour.
 *
 * What this gate cannot see (rules 9: written next to the gate):
 *  1. Whether the leader really runs the CLI and passes its output. Nothing here
 *     runs a model; the command text is all that is read.
 *  2. What the CLI prints. That is gated by the model-routing suites.
 *  3. A sixth spawn added without a resolve line is caught only because the
 *     spawn count is pinned (EXPECTED_SPAWNS); changing the roster means editing
 *     that list on purpose.
 *
 * @module tests/commands/assemble-model-routing
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeToolName, parseCommandTools } from '../firewall/frontmatter-tools.js';

const ASSEMBLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'commands', 'assemble.md',
);

/** The five representatives, in the order the command spawns them. */
const EXPECTED_SPAWNS = ['architect', 'code-reviewer', 'backend-developer', 'security-reviewer', 'tdd-guide'];

/**
 * Read the command file, or throw. Fail-closed: a vanished file is RED, not a
 * silent "0 violations".
 *
 * @param {string} file
 * @returns {string}
 */
function read(file) {
  if (!existsSync(file)) throw new Error(`missing canonical file: ${file}`);
  return readFileSync(file, 'utf-8');
}

/**
 * Split the command text into one block per `Agent(<type>, ...` call. The last
 * block ends at the closing fence.
 *
 * @param {string} markdown
 * @returns {Array<{ type: string, body: string }>}
 */
function spawnBlocks(markdown) {
  const text = markdown.replace(/\r\n/g, '\n');
  const starts = [...text.matchAll(/^Agent\(([a-z][a-z0-9-]*),/gm)];
  return starts.map((match, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.indexOf('\n```', match.index);
    return { type: match[1], body: text.slice(match.index, end === -1 ? undefined : end) };
  });
}

/** A `model=...` argument inside a call, literal or computed. */
function hasModelAssignment(body) {
  return /\bmodel\s*=/.test(body);
}

/** The call carries the resolve line for its OWN agent type (not a neighbour's). */
function hasOwnResolveLine(type, body) {
  return new RegExp(`scripts/model-routing/model-routing\\.mjs resolve artibot:${type}(?![\\w-])`).test(body);
}

describe('commands/assemble.md - spawn model comes from the routing CLI', () => {
  const doc = read(ASSEMBLE);
  const blocks = spawnBlocks(doc);

  it('spawns exactly the five representatives, in order (0 violations is not 0 checked)', () => {
    expect(blocks.map((block) => block.type)).toEqual(EXPECTED_SPAWNS);
  });

  it.each(EXPECTED_SPAWNS)('%s: the spawn carries its own resolve line and no model assignment', (type) => {
    const block = blocks.find((candidate) => candidate.type === type);
    expect(block, `no Agent(${type}, ...) call found`).toBeDefined();
    expect(hasOwnResolveLine(type, block.body), `${type}: resolve line missing`).toBe(true);
    expect(hasModelAssignment(block.body), `${type}: hardcoded model argument`).toBe(false);
  });

  it('frontmatter declares Bash - the body tells the leader to run the CLI', () => {
    const parsed = parseCommandTools(doc);
    expect(parsed.ok, parsed.ok ? '' : parsed.reason).toBe(true);
    const declared = parsed.tools
      .map((tool) => normalizeToolName(tool))
      .filter((name) => !name.skip)
      .map((name) => name.base);
    expect(declared).toContain('Bash');
  });

  it('the shared step states the procedure once: CLI, pass-through, no omission, fallback', () => {
    const text = doc.replace(/\r\n/g, '\n');
    expect(text).toContain('model-routing.mjs resolve artibot:<agent-type>');
    expect(text).toContain('Agent 호출의 `model` 파라미터에 **그대로 넘긴다**');
    expect(text).toContain('`model` 을 생략하지 않는다');
    expect(text).toContain('lib/core/model-policy.js#resolveModel');
  });
});

describe('scanner self-checks - the detectors are not blind', () => {
  const PRE_FIX = [
    'Agent(architect, name="a", model="sonnet",',
    '  prompt="x")',
    '',
    'Agent(tdd-guide, name="t", model="sonnet",',
    '  prompt="y")',
    '```',
    'trailing text that is not part of a call',
  ].join('\n');

  it('splits into one block per call and ends the last block at the fence', () => {
    const blocks = spawnBlocks(PRE_FIX);
    expect(blocks.map((block) => block.type)).toEqual(['architect', 'tdd-guide']);
    expect(blocks[1].body).not.toContain('trailing text');
  });

  it('flags the pre-fix shape: literal model arguments and no resolve line', () => {
    const blocks = spawnBlocks(PRE_FIX);
    expect(blocks.every((block) => hasModelAssignment(block.body))).toBe(true);
    expect(blocks.some((block) => hasOwnResolveLine(block.type, block.body))).toBe(false);
  });

  it('flags a spawn that dropped `model` without adding the resolve line', () => {
    const [block] = spawnBlocks('Agent(architect, name="a",\n  prompt="x")\n```');
    expect(hasModelAssignment(block.body)).toBe(false);
    expect(hasOwnResolveLine('architect', block.body)).toBe(false);
  });

  it("another agent's resolve line does not satisfy this one", () => {
    const body = 'Agent(code-reviewer, name="c",\n  /* model: node <pluginRoot>/scripts/model-routing/model-routing.mjs resolve artibot:code-reviewer-x */';
    expect(hasOwnResolveLine('code-reviewer', body)).toBe(false);
    expect(hasOwnResolveLine('code-reviewer', body.replace('-x', ''))).toBe(true);
  });

  it('an empty document yields no blocks, so the denominator test can go RED', () => {
    expect(spawnBlocks('')).toEqual([]);
  });
});
