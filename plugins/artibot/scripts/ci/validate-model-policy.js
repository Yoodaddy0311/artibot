#!/usr/bin/env node
/**
 * CI: Validate model-policy consistency (drift gate).
 *
 * Cross-checks three sources that must agree on "which model for agent X":
 *   1. Each `agents/<name>.md` frontmatter `model:` field.
 *   2. The central policy in `artibot.config.json#/agents/modelPolicy`,
 *      resolved via the FROZEN contract in `lib/core/model-policy.js`.
 *
 * Without this gate, frontmatter, config, and the rules doc can silently drift.
 *
 * Drift classes:
 *   - ERROR  frontmatter↔config mismatch: agent file `model:` ≠ getPolicyModel(name).
 *   - ERROR  policy agent missing file: a name listed in policy has no agents/<name>.md.
 *   - WARN   file not in policy: an agent file whose name is in no policy bucket.
 *
 * Exit 1 only when ERRORS are present; WARNINGS print but exit 0.
 *
 * Korean-path safe (uses fs paths + relative imports, no pathToFileURL).
 * ESM, zero runtime deps.
 *
 * Usage: node scripts/ci/validate-model-policy.js
 *
 * @module scripts/ci/validate-model-policy
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, getPluginRoot } from './ci-utils.js';
import { loadConfig } from '../../lib/core/config.js';
import {
  getPolicyModel,
  listAgentsByModel,
  normalizeAgentType,
  resolveModel,
} from '../../lib/core/model-policy.js';
import { isMainEntry } from '../hooks/_main-entry.js';

/** Files that live under agents/ for discoverability but are NOT agent definitions. */
const NON_AGENT_FILES = new Set(['INDEX.md', 'README.md']);

/**
 * Read agent frontmatter `model:` values from disk.
 * Skips catalog files (INDEX.md, README.md) and files without frontmatter.
 *
 * @param {string} agentsDir - Absolute path to the agents/ directory.
 * @returns {{ name: string, model: string|null }[]} One entry per agent file;
 *   `model` is null when the frontmatter omits the field.
 */
export function readAgentModels(agentsDir) {
  const files = readdirSync(agentsDir).filter(
    (f) => f.endsWith('.md') && !NON_AGENT_FILES.has(f)
  );
  /** @type {{ name: string, model: string|null }[]} */
  const out = [];
  for (const file of files) {
    const content = readFileSync(path.join(agentsDir, file), 'utf-8');
    const frontmatter = extractFrontmatter(content);
    const name = normalizeAgentType(path.basename(file, '.md'));
    const model =
      frontmatter && typeof frontmatter.model === 'string'
        ? frontmatter.model.trim()
        : null;
    out.push({ name, model });
  }
  return out;
}

/**
 * Pure drift comparison — the unit-testable core. Takes already-resolved inputs
 * (no filesystem, no config side effects) so it can be exercised with fixtures.
 *
 * @param {object} params
 * @param {{ name: string, model: string|null }[]} params.agentModels -
 *   Frontmatter models keyed by normalized agent name (from {@link readAgentModels}).
 * @param {(name: string) => (string|null)} params.resolvePolicyModel -
 *   Gate-aware policy lookup: null if unlisted, otherwise the EFFECTIVE model
 *   after the fable opt-in gate/denylist (a denylisted agent in a fable bucket
 *   resolves to opus, matching its frontmatter).
 * @param {string[]} params.policyAgents - Every agent name listed in the policy
 *   (union of all buckets), normalized.
 * @returns {{ errors: string[], warnings: string[] }} Human-readable drift lines.
 */
export function findModelPolicyDrift({ agentModels, resolvePolicyModel, policyAgents }) {
  const errors = [];
  const warnings = [];

  const fileNames = new Set(agentModels.map((a) => a.name));

  // 1 + 3: per-file checks against the policy.
  for (const { name, model } of agentModels) {
    const policyModel = resolvePolicyModel(name);

    if (policyModel === null) {
      // file not in policy → WARNING (not an error: external/new agents allowed).
      warnings.push(
        `file not in policy: agents/${name}.md (model: ${model ?? 'unset'}) is in no policy bucket`
      );
      continue;
    }

    if (model === null) {
      errors.push(
        `frontmatter↔config mismatch: agents/${name}.md has no "model:" field, policy expects "${policyModel}"`
      );
      continue;
    }

    if (model !== policyModel) {
      errors.push(
        `frontmatter↔config mismatch: agents/${name}.md model "${model}" ≠ policy "${policyModel}"`
      );
    }
  }

  // 2: policy agent missing file → ERROR.
  for (const name of policyAgents) {
    if (!fileNames.has(name)) {
      errors.push(
        `policy agent missing file: "${name}" is in the policy but agents/${name}.md does not exist`
      );
    }
  }

  return { errors, warnings };
}

/**
 * Collect the full set of agent names declared anywhere in the policy.
 *
 * @param {object} [config] - Explicit config; falls back to live config.
 * @returns {string[]} Deduped, normalized agent names across all model buckets.
 */
export function collectPolicyAgents(config) {
  const names = new Set();
  for (const model of ['opus', 'sonnet', 'fable']) {
    for (const name of listAgentsByModel(model, config)) names.add(name);
  }
  return [...names];
}

/**
 * Print a human-readable drift report.
 *
 * @param {object} params
 * @param {number} params.fileCount - Number of agent files inspected.
 * @param {number} params.policyCount - Number of agents declared in policy.
 * @param {string[]} params.errors
 * @param {string[]} params.warnings
 */
function printReport({ fileCount, policyCount, errors, warnings }) {
  console.log('Model-Policy Drift Validation');
  console.log('=============================\n');
  console.log(`  Agent files inspected : ${fileCount}`);
  console.log(`  Agents in policy      : ${policyCount}`);
  console.log(`  Errors                : ${errors.length}`);
  console.log(`  Warnings              : ${warnings.length}\n`);

  if (warnings.length > 0) {
    console.log(`Warnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  WARN: ${w}`);
    console.log('');
  }

  if (errors.length > 0) {
    console.log(`Errors (${errors.length}):`);
    for (const e of errors) console.log(`  ERROR: ${e}`);
    console.log('');
  } else {
    console.log('No model-policy drift detected.\n');
  }
}

/**
 * CLI entry: load real-repo inputs, run the drift check, print, and exit.
 * Exit 1 only when ERRORS are present.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const agentsDir = path.join(getPluginRoot(), 'agents');
  if (!existsSync(agentsDir)) {
    console.log('No agents/ directory found. Skipping model-policy drift check.');
    return;
  }

  // Hydrate the config cache so the policy resolver sees the live config rather
  // than its safe-empty fallback. Passed explicitly to every resolver call.
  const config = await loadConfig();

  const agentModels = readAgentModels(agentsDir);
  const policyAgents = collectPolicyAgents(config);
  const { errors, warnings } = findModelPolicyDrift({
    agentModels,
    // Gate-aware: getPolicyModel keeps the strict "unlisted → null" semantics,
    // but the comparison model must be the EFFECTIVE tier after the fable
    // opt-in gate/denylist (e.g. security-reviewer in a fable bucket → opus).
    resolvePolicyModel: (name) =>
      getPolicyModel(name, config) === null
        ? null
        : resolveModel(name, {}, config),
    policyAgents,
  });

  printReport({
    fileCount: agentModels.length,
    policyCount: policyAgents.length,
    errors,
    warnings,
  });

  if (errors.length > 0) process.exit(1);
}

// Only run when invoked directly (allow importing the pure functions in tests).
// Korean-path AND junction/symlink safe: see scripts/hooks/_main-entry.js.
const invokedDirectly = isMainEntry(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[model-policy] unexpected failure: ${err.message}`);
    process.exit(1);
  });
}
