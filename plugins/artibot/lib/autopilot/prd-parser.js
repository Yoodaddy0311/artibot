/**
 * PRD parser for autopilot goal-driven mode (v4.6.0).
 *
 * Extracts a machine-readable Goal Contract from a generated PRD's
 * `## 2.5 Goal Contract` section (a ```json fenced block). When the
 * section is absent the parser returns `{ found: false }` and the
 * engine falls back to legacy phase-based behavior — backward compat
 * is preserved for every existing PRD on disk.
 *
 * Pure parser — no I/O. Pass markdown text in, get a validated
 * contract (or a diagnostic) out.
 *
 * @module lib/autopilot/prd-parser
 */

import { validateGoalContract } from './goal-schema.js';

/**
 * Matches the Goal Contract section in a PRD. Tolerates:
 *   - heading variants: "## Goal Contract" or "## 2.5 Goal Contract"
 *     or "### Goal Contract" (any heading level 2 or 3, any leading
 *     section number such as "2.5", "3.1", "10.2", etc).
 *   - whitespace around the fence
 *   - `json` or `JSON` language tag
 *
 * The captured group is the raw JSON body — feed it through JSON.parse.
 *
 * `[\s\S]*?` is non-greedy so we stop at the FIRST closing fence after
 * the heading, not the last fence in the document.
 */
const GOAL_BLOCK_RE =
  /#{2,3}\s+(?:\d+(?:\.\d+)*\s+)?Goal Contract\b[\s\S]*?```(?:json|JSON)\s*\n([\s\S]*?)\n\s*```/;

/**
 * Parse a PRD markdown string and extract its Goal Contract, if present.
 *
 * Three outcomes:
 *   - `{ found: false, contract: null, errors: [] }` — no Goal Contract
 *     section. Legacy PRD; engine should use phase-based termination.
 *   - `{ found: true,  contract: null, errors: [<string>] }` — section
 *     present but malformed (bad JSON or failed schema validation).
 *     Engine should surface to the user, not silently fall back.
 *   - `{ found: true,  contract: <normalized>, errors: [] }` — valid.
 *
 * @param {string} prdMarkdown raw PRD content
 * @returns {{ found: boolean, contract: object|null, errors: string[] }}
 */
export function parseGoalContract(prdMarkdown) {
  if (typeof prdMarkdown !== 'string' || !prdMarkdown) {
    return { found: false, contract: null, errors: [] };
  }

  const m = GOAL_BLOCK_RE.exec(prdMarkdown);
  if (!m) {
    return { found: false, contract: null, errors: [] };
  }

  const rawJson = m[1].trim();
  if (!rawJson) {
    return {
      found: true,
      contract: null,
      errors: ['Goal Contract block is empty'],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return {
      found: true,
      contract: null,
      errors: [`Goal Contract JSON parse error: ${err.message}`],
    };
  }

  const result = validateGoalContract(parsed);
  if (!result.valid) {
    return { found: true, contract: null, errors: result.errors };
  }

  return { found: true, contract: result.contract, errors: [] };
}
