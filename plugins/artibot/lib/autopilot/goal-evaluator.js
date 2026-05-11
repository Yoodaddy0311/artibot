/**
 * Goal evaluator for autopilot goal-driven mode (v4.6.0 Phase 2).
 *
 * Determines whether a Goal Contract's stopping condition is met by
 * running the contract's `validationCommand` and inspecting the exit
 * code. NO LLM-style judgment — the v4.6.0 design explicitly rules out
 * evaluator hallucination by trusting only the validation command's
 * exit code. Hallucination would cause false "met" results, leading to
 * premature termination of the iteration loop.
 *
 * @module lib/autopilot/goal-evaluator
 */

import { execSync } from 'node:child_process';

/**
 * Default validation runner. Executes the command via the shell and
 * captures stdout/stderr/exit code. Throws are caught and translated
 * to a result object (exit code 1 for non-spawned failures).
 *
 * @param {string} command shell command line (e.g. "npm run ci")
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
function defaultRunCommand(command) {
  try {
    const stdout = execSync(command, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout: String(stdout || ''), stderr: '' };
  } catch (err) {
    return {
      exitCode: typeof err?.status === 'number' ? err.status : 1,
      stdout: String(err?.stdout ?? ''),
      stderr: String(err?.stderr ?? err?.message ?? ''),
    };
  }
}

/**
 * Evaluate whether a goal's stopping condition is met.
 *
 * Decision rules (in priority order):
 *   1. Invalid contract → `met=false, confidence=0` (cannot evaluate)
 *   2. No `validationCommand` → `met=false, confidence=0` with reason
 *      `'no validationCommand — manual evaluation required'`. The
 *      engine should surface this to the user queue rather than
 *      auto-iterate.
 *   3. Run command via `runCommand` (DI). Exit 0 → `met=true,
 *      confidence=1.0`. Non-zero exit → `met=false, confidence=1.0`
 *      (we are confident it is NOT met).
 *   4. Runner exception → `met=false, confidence=0` with the error
 *      message preserved on stderr.
 *
 * @param {{ contract: object|null|undefined, runCommand?: (cmd: string) => { exitCode: number, stdout: string, stderr: string } }} args
 * @returns {{ met: boolean, confidence: number, exitCode: number|null, stdout: string, stderr: string, reason: string }}
 */
export function evaluateGoal({ contract, runCommand } = {}) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    return {
      met: false,
      confidence: 0,
      exitCode: null,
      stdout: '',
      stderr: '',
      reason: 'invalid contract',
    };
  }

  if (!contract.validationCommand || typeof contract.validationCommand !== 'string') {
    return {
      met: false,
      confidence: 0,
      exitCode: null,
      stdout: '',
      stderr: '',
      reason: 'no validationCommand — manual evaluation required',
    };
  }

  const exec = typeof runCommand === 'function' ? runCommand : defaultRunCommand;
  let result;
  try {
    result = exec(contract.validationCommand);
  } catch (err) {
    return {
      met: false,
      confidence: 0,
      exitCode: null,
      stdout: '',
      stderr: err?.message || 'runCommand threw',
      reason: 'runCommand exception',
    };
  }

  if (!result || typeof result !== 'object') {
    return {
      met: false,
      confidence: 0,
      exitCode: null,
      stdout: '',
      stderr: '',
      reason: 'runCommand returned non-object',
    };
  }

  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : 1;
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');

  if (exitCode === 0) {
    return {
      met: true,
      confidence: 1.0,
      exitCode: 0,
      stdout,
      stderr,
      reason: 'validationCommand exit code 0',
    };
  }

  return {
    met: false,
    confidence: 1.0,
    exitCode,
    stdout,
    stderr,
    reason: `validationCommand exit code ${exitCode}`,
  };
}
