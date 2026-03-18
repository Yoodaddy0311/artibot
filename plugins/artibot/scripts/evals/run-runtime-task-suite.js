#!/usr/bin/env node
/**
 * Run the runtime task evaluation suite and optionally persist the report.
 */

import {
  buildRuntimeEvalComparison,
  evaluateRuntimeSuite,
  formatRuntimeSuiteReport,
  getDefaultRepoRuntimeReportPath,
  loadRuntimeSuiteReport,
  writeRuntimeEvalComparisonArtifacts,
  writeRuntimeSuiteReport,
} from '../../lib/runtime/evaluator.js';

async function main() {
  const reportPath = process.env.ARTIBOT_RUNTIME_EVAL_REPORT_PATH || getDefaultRepoRuntimeReportPath();
  const previousReport = process.env.ARTIBOT_RUNTIME_EVAL_NO_WRITE === '1'
    ? null
    : await loadRuntimeSuiteReport(reportPath);

  const report = await evaluateRuntimeSuite();
  const text = formatRuntimeSuiteReport(report);
  process.stdout.write(text + '\n');

  if (process.env.ARTIBOT_RUNTIME_EVAL_NO_WRITE !== '1') {
    const filePath = await writeRuntimeSuiteReport(report, reportPath);
    const comparison = buildRuntimeEvalComparison(previousReport, report);
    const comparisonArtifacts = await writeRuntimeEvalComparisonArtifacts(comparison, {
      jsonPath: process.env.ARTIBOT_RUNTIME_EVAL_COMPARISON_JSON_PATH,
      markdownPath: process.env.ARTIBOT_RUNTIME_EVAL_COMPARISON_MD_PATH,
    });
    process.stdout.write(`\nSaved report: ${filePath}\n`);
    process.stdout.write(`Saved comparison JSON: ${comparisonArtifacts.jsonPath}\n`);
    process.stdout.write(`Saved comparison Markdown: ${comparisonArtifacts.markdownPath}\n`);
  }

  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`[artibot:runtime-evals] ${error.message || String(error)}\n`);
  process.exit(1);
});
