#!/usr/bin/env node
/**
 * Bootstrap Learning Script.
 * Runs the full learning pipeline on existing experience data:
 *   1. bootstrapLearn() - Extract patterns from accumulated experiences
 *   2. evaluateResult() - Create initial evaluation entries
 *   3. bootstrapPromote() - Promote patterns to System 1 with relaxed criteria
 *   4. GRPO recording - Create initial GRPO history
 *
 * Usage: node plugins/artibot/scripts/bootstrap-learning.js
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const ARTIBOT_DIR = path.join(os.homedir(), '.claude', 'artibot');

// Manual file:// URL construction for Korean paths on Windows
function toFileUrl(filePath) {
  const forward = filePath.replace(/\\/g, '/');
  if (/^[A-Z]:/i.test(forward)) {
    return `file:///${forward}`;
  }
  return `file://${forward}`;
}

// Resolve plugin root: scripts/bootstrap-learning.js -> scripts/ -> artibot/ -> plugins/ -> repo root
// But we need the plugin root at plugins/artibot/
// import.meta.url gives us the file:// URL with percent-encoded Korean
// We must use process.argv or construct the path manually
const THIS_FILE = process.argv[1];
const PLUGIN_ROOT = path.resolve(path.dirname(THIS_FILE), '..'); // plugins/artibot/

async function main() {
  console.log('=== Artibot Bootstrap Learning ===\n');
  console.log(`Plugin root: ${PLUGIN_ROOT}`);
  console.log(`Data dir: ${ARTIBOT_DIR}\n`);

  // Step 1: Bootstrap batch learning
  console.log('--- Step 1: Bootstrap Batch Learning ---');
  const lifelongPath = path.join(PLUGIN_ROOT, 'lib', 'learning', 'lifelong-learner.js');
  const { bootstrapLearn } = await import(toFileUrl(lifelongPath));

  const learnResult = await bootstrapLearn();
  console.log(`  Experiences processed: ${learnResult.experienceCount}`);
  console.log(`  Groups processed: ${learnResult.groupsProcessed}`);
  console.log(`  Patterns extracted: ${learnResult.patternsExtracted}`);
  if (learnResult.patterns.length > 0) {
    console.log('  Extracted patterns:');
    for (const p of learnResult.patterns) {
      console.log(`    - ${p.key} (confidence: ${p.confidence}, insight: ${p.insight?.slice(0, 80)})`);
    }
  }

  // Step 2: Create initial evaluations
  console.log('\n--- Step 2: Create Initial Evaluations ---');
  const evaluatorPath = path.join(PLUGIN_ROOT, 'lib', 'learning', 'self-evaluator.js');
  const { evaluateResult } = await import(toFileUrl(evaluatorPath));

  const evalResult = await evaluateResult(
    { id: 'bootstrap-session', type: 'bootstrap', description: 'Bootstrap learning session' },
    { success: true, duration: 5000, testsPass: true }
  );
  console.log(`  Evaluation created: ${evalResult.id} (grade: ${evalResult.grade}, overall: ${evalResult.overall})`);

  // Step 3: Bootstrap promote patterns to System 1
  console.log('\n--- Step 3: Bootstrap Promote to System 1 ---');
  const transferPath = path.join(PLUGIN_ROOT, 'lib', 'learning', 'knowledge-transfer.js');
  const { bootstrapPromote, hotSwap, getTransferStats } = await import(toFileUrl(transferPath));

  let promoted = 0;
  let skipped = 0;

  // First try standard hotSwap
  const hotSwapResult = await hotSwap();
  promoted += hotSwapResult.promoted.length;
  console.log(`  hotSwap: promoted=${hotSwapResult.promoted.length}, demoted=${hotSwapResult.demoted.length}`);

  // Then bootstrap promote remaining patterns with relaxed criteria
  if (learnResult.patterns.length > 0) {
    for (const pattern of learnResult.patterns) {
      const result = await bootstrapPromote(pattern);
      if (result.promoted) {
        promoted++;
        console.log(`  Promoted: ${pattern.key} (confidence: ${pattern.confidence})`);
      } else {
        skipped++;
        console.log(`  Skipped: ${pattern.key} - ${result.reason}`);
      }
    }
  }

  // Step 4: Record GRPO round
  console.log('\n--- Step 4: GRPO History Recording ---');
  if (learnResult.patterns.length >= 2) {
    const grpoPath = path.join(PLUGIN_ROOT, 'lib', 'learning', 'grpo-optimizer.js');
    const { evaluateGroup, updateWeights } = await import(toFileUrl(grpoPath));

    const candidates = learnResult.patterns.map((p, i) => ({
      id: `bootstrap-cand-${i}`,
      strategy: p.category ?? 'default',
      result: {
        exitCode: p.bestComposite > 0.5 ? 0 : 1,
        errors: p.bestComposite > 0.5 ? 0 : 1,
        duration: 1000,
        commandLength: 10,
        sideEffects: 0,
      },
    }));

    const groupResult = evaluateGroup(candidates);
    const weights = await updateWeights(groupResult);
    console.log(`  GRPO round recorded: ${candidates.length} candidates`);
    console.log(`  Best strategy: ${groupResult.best?.strategy}`);
    console.log(`  Weights: ${JSON.stringify(weights)}`);
  } else {
    console.log('  Skipped: not enough patterns for GRPO comparison');
  }

  // Step 5: Verification
  console.log('\n--- Step 5: Verification ---');

  // Check patterns directory
  const patternsDir = path.join(ARTIBOT_DIR, 'patterns');
  try {
    const files = await fs.readdir(patternsDir);
    console.log(`  patterns/ directory: ${files.length} files (${files.join(', ')})`);
  } catch {
    console.log('  patterns/ directory: NOT FOUND');
  }

  // Check system1-patterns.json
  try {
    const s1 = JSON.parse(await fs.readFile(path.join(ARTIBOT_DIR, 'system1-patterns.json'), 'utf8'));
    console.log(`  system1-patterns.json: ${s1.patterns?.length ?? 0} patterns`);
  } catch {
    console.log('  system1-patterns.json: NOT FOUND');
  }

  // Check evaluations.json
  try {
    const ev = JSON.parse(await fs.readFile(path.join(ARTIBOT_DIR, 'evaluations.json'), 'utf8'));
    console.log(`  evaluations.json: ${ev.length} evaluations`);
  } catch {
    console.log('  evaluations.json: NOT FOUND');
  }

  // Check grpo-history.json
  try {
    const grpo = JSON.parse(await fs.readFile(path.join(ARTIBOT_DIR, 'grpo-history.json'), 'utf8'));
    console.log(`  grpo-history.json: ${grpo.rounds?.length ?? 0} rounds`);
  } catch {
    console.log('  grpo-history.json: NOT FOUND');
  }

  // Check learning-log.json
  try {
    const log = JSON.parse(await fs.readFile(path.join(ARTIBOT_DIR, 'learning-log.json'), 'utf8'));
    const lastEntry = log[log.length - 1];
    console.log(`  learning-log.json: ${log.length} entries, last patternsExtracted=${lastEntry?.patternsExtracted ?? 0}`);
  } catch {
    console.log('  learning-log.json: NOT FOUND');
  }

  // Check transfer-log.json
  try {
    const tl = JSON.parse(await fs.readFile(path.join(ARTIBOT_DIR, 'transfer-log.json'), 'utf8'));
    console.log(`  transfer-log.json: ${tl.length} entries`);
  } catch {
    console.log('  transfer-log.json: NOT FOUND');
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`  Patterns extracted: ${learnResult.patternsExtracted}`);
  console.log(`  Patterns promoted to System 1: ${promoted}`);
  console.log(`  Patterns skipped: ${skipped}`);

  const stats = await getTransferStats();
  console.log(`  System 1 active patterns: ${stats.system1Count}`);
  console.log(`  Total promotions: ${stats.totalPromotions}`);
  console.log(`  Avg confidence: ${stats.avgConfidence}`);
}

main().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
