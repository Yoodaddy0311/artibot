#!/usr/bin/env node
/**
 * Run the auto-learning pipeline directly.
 * Used by claude schedule, CronCreate, CI, or manual execution.
 *
 * Usage:
 *   node scripts/run-auto-learning.js                # Run full pipeline
 *   node scripts/run-auto-learning.js --dry-run      # Preview without writes
 *   node scripts/run-auto-learning.js --stages self-scan,pattern-extract
 *
 * @module scripts/run-auto-learning
 */

import { runAutoLearningPipeline } from '../lib/learning/auto-learning-runner.js';

async function main() {
  const args = process.argv.slice(2);
  const overrides = {};

  if (args.includes('--dry-run')) {
    overrides.dryRun = true;
  }

  const stagesIdx = args.indexOf('--stages');
  if (stagesIdx !== -1 && args[stagesIdx + 1]) {
    overrides.pipeline = args[stagesIdx + 1].split(',').map((s) => s.trim());
  }

  if (args.includes('--no-commit')) {
    overrides.autoCommit = false;
  }

  if (args.includes('--no-push')) {
    overrides.autoPush = false;
  }

  // Force enabled for direct execution
  overrides.enabled = true;

  const result = await runAutoLearningPipeline(overrides);

  // Output summary
  const lines = [
    'AUTO-LEARNING PIPELINE RESULT',
    '============================',
    `Timestamp: ${result.timestamp}`,
    `Success:   ${result.success}`,
    `Stages:    ${result.stagesRun?.join(', ') || 'none'}`,
  ];

  if (result.errors) {
    lines.push(`Errors:    ${result.errors.join(', ')}`);
  }

  if (result.stages?.selfScan) {
    const s = result.stages.selfScan;
    lines.push('');
    lines.push('--- Self-Scan ---');
    lines.push(`Lint:     ${s.lint?.passed ? 'PASS' : 'FAIL'} (${s.lint?.errorCount ?? '?'} errors, ${s.lint?.warningCount ?? '?'} warnings)`);
    lines.push(`Tests:    ${s.tests?.allPassed ? 'PASS' : 'FAIL'} (${s.tests?.passed ?? '?'}/${s.tests?.total ?? '?'})`);
  }

  if (result.stages?.patternExtract) {
    const p = result.stages.patternExtract;
    lines.push('');
    lines.push('--- Pattern Extract ---');
    lines.push(`Commits:  ${p.commits?.length ?? 0}`);
    lines.push(`Patterns: ${p.patterns?.length ?? 0}`);
    lines.push(`Hot files: ${p.hotFiles?.length ?? 0}`);
  }

  if (result.stages?.knowledgeUpdate) {
    const k = result.stages.knowledgeUpdate;
    lines.push('');
    lines.push('--- Knowledge Update ---');
    lines.push(`Patterns saved: ${k.patternsSaved}`);
    lines.push(`Promoted:       ${k.promoted}`);
    lines.push(`Demoted:        ${k.demoted}`);
  }

  if (result.stages?.skillRefinement) {
    const r = result.stages.skillRefinement;
    lines.push('');
    lines.push('--- Skill Refinement ---');
    lines.push(`Skills analyzed:  ${r.skillsAnalyzed}`);
    lines.push(`Suggestions:      ${r.suggestionsGenerated}`);
    lines.push(`Injections:       ${r.injectionsApplied}`);
  }

  if (result.stages?.autoCommit) {
    const c = result.stages.autoCommit;
    lines.push('');
    lines.push('--- Auto-Commit ---');
    if (c.dryRun) {
      lines.push('Mode: DRY RUN (no changes written)');
    } else if (c.aborted) {
      lines.push(`Aborted: ${c.reason}`);
    } else if (c.skipped) {
      lines.push(`Skipped: ${c.reason ?? 'disabled'}`);
    } else {
      lines.push(`Committed: ${c.committed}`);
      lines.push(`Pushed:    ${c.pushed}`);
      lines.push(`Changes:   ${c.changesCount}`);
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`Auto-learning pipeline failed: ${err.message}\n`);
  process.exit(1);
});
