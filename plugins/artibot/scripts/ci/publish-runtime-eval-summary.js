#!/usr/bin/env node
/**
 * CI: Publish the runtime eval comparison markdown into the GitHub job summary.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { getDefaultRuntimeComparisonMarkdownPath } from '../../lib/runtime/evaluator.js';

function main() {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    console.log('GITHUB_STEP_SUMMARY is not set. Skipping runtime eval summary publish.');
    return;
  }

  const reportPath =
    process.env.ARTIBOT_RUNTIME_EVAL_COMPARISON_MD_PATH ||
    getDefaultRuntimeComparisonMarkdownPath();

  if (!existsSync(reportPath)) {
    appendFileSync(
      summaryPath,
      '## Runtime Eval Comparison\n\nRuntime eval comparison report was not generated.\n',
      'utf-8',
    );
    console.log(`Runtime eval comparison report not found at ${reportPath}`);
    return;
  }

  const markdown = readFileSync(reportPath, 'utf-8').trim();
  appendFileSync(summaryPath, `${markdown}\n`, 'utf-8');
  console.log(`Published runtime eval summary from ${reportPath}`);
}

main();
