/**
 * Refactoring script for 3 CRITICAL function length violations.
 * Transforms factory functions by extracting inner methods to module-level.
 * Run: node plugins/artibot/lib/core/_refactor-critical.js
 * Self-deletes after execution.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 1. metrics-collector.js: extract getSummary KPI helpers ──

function refactorMetricsCollector() {
  const p = path.join(__dirname, 'metrics-collector.js');
  let src = readFileSync(p, 'utf-8');

  // Extract the getSummary KPI extraction into a module-level helper
  const kpiHelper = `
/**
 * Extract KPI summary from a collected snapshot's sources.
 * @param {object} s - snapshot.sources object
 * @returns {object} KPI entries to merge into summary
 */
function extractKpis(s) {
  const kpis = {};

  if (s.eventBus && !s.eventBus.error) {
    kpis.eventBus = Object.freeze({
      eventTypes: s.eventBus.eventTypes ?? 0,
      totalListeners: s.eventBus.totalListeners ?? 0,
      cachedEvents: s.eventBus.cachedEvents ?? 0,
    });
  }

  if (s.cognitiveRouter && !s.cognitiveRouter.error) {
    kpis.cognitiveRouter = Object.freeze({
      totalRouted: s.cognitiveRouter.totalRouted ?? 0,
      system1Ratio: s.cognitiveRouter.system1Ratio ?? 0,
      successRate: s.cognitiveRouter.successRate ?? { system1: 0, system2: 0 },
      recentTrend: s.cognitiveRouter.recentTrend ?? 'stable',
    });
  }

  if (s.grpo && !s.grpo.error) {
    kpis.grpo = Object.freeze({
      totalRounds: s.grpo.totalRounds ?? 0,
      weights: s.grpo.weights ?? {},
      teamWeights: s.grpo.teamWeights ?? {},
    });
  }

  if (s.evalCalibrator && !s.evalCalibrator.error) {
    kpis.evalCalibrator = Object.freeze({
      avgDelta: s.evalCalibrator.avgDelta ?? 0,
      avgAbsDelta: s.evalCalibrator.avgAbsDelta ?? 0,
      totalOverrides: s.evalCalibrator.totalOverrides ?? 0,
    });
  }

  if (s.guards && !s.guards.error) kpis.guards = Object.freeze({ ...s.guards });
  if (s.hooks && !s.hooks.error) kpis.hooks = Object.freeze({ ...s.hooks });
  if (s.toolCalls && !s.toolCalls.error) kpis.toolCalls = Object.freeze({ ...s.toolCalls });

  return kpis;
}
`;

  // Replace getSummary body with call to extractKpis
  const oldGetSummary = `  async function getSummary() {
    const snapshot = await collect();
    const s = snapshot.sources;

    const summary = {
      timestamp: snapshot.timestamp,
      sourceCount: Object.keys(s).length,
    };

    // Event bus KPIs
    if (s.eventBus && !s.eventBus.error) {
      summary.eventBus = Object.freeze({
        eventTypes: s.eventBus.eventTypes ?? 0,
        totalListeners: s.eventBus.totalListeners ?? 0,
        cachedEvents: s.eventBus.cachedEvents ?? 0,
      });
    }

    // Cognitive router KPIs
    if (s.cognitiveRouter && !s.cognitiveRouter.error) {
      summary.cognitiveRouter = Object.freeze({
        totalRouted: s.cognitiveRouter.totalRouted ?? 0,
        system1Ratio: s.cognitiveRouter.system1Ratio ?? 0,
        successRate: s.cognitiveRouter.successRate ?? { system1: 0, system2: 0 },
        recentTrend: s.cognitiveRouter.recentTrend ?? 'stable',
      });
    }

    // GRPO KPIs
    if (s.grpo && !s.grpo.error) {
      summary.grpo = Object.freeze({
        totalRounds: s.grpo.totalRounds ?? 0,
        weights: s.grpo.weights ?? {},
        teamWeights: s.grpo.teamWeights ?? {},
      });
    }

    // Eval calibrator KPIs
    if (s.evalCalibrator && !s.evalCalibrator.error) {
      summary.evalCalibrator = Object.freeze({
        avgDelta: s.evalCalibrator.avgDelta ?? 0,
        avgAbsDelta: s.evalCalibrator.avgAbsDelta ?? 0,
        totalOverrides: s.evalCalibrator.totalOverrides ?? 0,
      });
    }

    // Guard KPIs
    if (s.guards && !s.guards.error) {
      summary.guards = Object.freeze({ ...s.guards });
    }

    // Hook execution KPIs
    if (s.hooks && !s.hooks.error) {
      summary.hooks = Object.freeze({ ...s.hooks });
    }

    // Tool call KPIs
    if (s.toolCalls && !s.toolCalls.error) {
      summary.toolCalls = Object.freeze({ ...s.toolCalls });
    }

    return Object.freeze(summary);
  }`;

  const newGetSummary = `  async function getSummary() {
    const snapshot = await collect();
    const s = snapshot.sources;

    const summary = {
      timestamp: snapshot.timestamp,
      sourceCount: Object.keys(s).length,
      ...extractKpis(s),
    };

    return Object.freeze(summary);
  }`;

  // Insert kpiHelper before createMetricsCollector
  src = src.replace('export function createMetricsCollector()', kpiHelper + 'export function createMetricsCollector()');
  src = src.replace(oldGetSummary, newGetSummary);

  writeFileSync(p, src);
  console.log('metrics-collector.js: refactored. Lines:', src.split('\n').length);
}

// ── 2. auto-fixer.js: extract runIteration + buildResult helpers ──

function refactorAutoFixer() {
  const p = path.join(__dirname, 'auto-fixer.js');
  let src = readFileSync(p, 'utf-8');

  // Add helpers before autoFix
  const helpers = `/**
 * Run a single fix iteration (eslint + vitest).
 * @param {object} opts - Options with eslintFix, vitestRun, targetPath
 * @returns {{ eslint: object, vitest: object }}
 */
function runIteration(opts) {
  let eslintResult;
  let vitestResult;

  if (opts.eslintFix) {
    const { output } = runStep('npx eslint --fix .', opts.targetPath);
    eslintResult = parseEslintOutput(output);
  } else {
    eslintResult = { errors: 0, warnings: 0, total: 0, clean: true };
  }

  if (opts.vitestRun) {
    const { output } = runStep('npx vitest run', opts.targetPath);
    vitestResult = parseVitestOutput(output);
  } else {
    vitestResult = { passed: 0, failed: 0, total: 0, success: true };
  }

  return { eslint: eslintResult, vitest: vitestResult };
}

/**
 * Build a fix loop result object.
 * @param {boolean} success
 * @param {number} iterations
 * @param {Array} history
 * @param {object} finalStatus
 * @param {string} reason
 * @param {string|null} error
 * @returns {object}
 */
function buildFixResult(success, iterations, history, finalStatus, reason, error = null) {
  return { success, iterations, history, finalStatus, reason, error };
}

`;

  // Replace autoFix body
  const oldAutoFix = `export function autoFix(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { maxIterations, eslintFix, vitestRun, targetPath } = opts;

  const history = [];
  let lastEslint = { errors: 0, warnings: 0, total: 0, clean: true };
  let lastVitest = { passed: 0, failed: 0, total: 0, success: true };

  for (let i = 0; i < maxIterations; i++) {
    let eslintResult;
    let vitestResult;

    try {
      // Step 1: ESLint --fix
      if (eslintFix) {
        const { output } = runStep('npx eslint --fix .', targetPath);
        eslintResult = parseEslintOutput(output);
      } else {
        eslintResult = { errors: 0, warnings: 0, total: 0, clean: true };
      }

      // Step 2: Vitest run
      if (vitestRun) {
        const { output } = runStep('npx vitest run', targetPath);
        vitestResult = parseVitestOutput(output);
      } else {
        vitestResult = { passed: 0, failed: 0, total: 0, success: true };
      }
    } catch (err) {
      // Unexpected error (e.g., ENOENT - tool not found)
      return {
        success: false,
        iterations: i + 1,
        history,
        finalStatus: { eslint: lastEslint, vitest: lastVitest },
        reason: 'Unexpected error',
        error: err.message,
      };
    }

    lastEslint = eslintResult;
    lastVitest = vitestResult;
    history.push({ eslint: eslintResult, vitest: vitestResult });

    // Check convergence after at least 1 iteration
    if (history.length >= 2) {
      const convergence = checkConvergence(history);

      if (convergence.converged) {
        return {
          success: true,
          iterations: i + 1,
          history,
          finalStatus: { eslint: lastEslint, vitest: lastVitest },
          reason: convergence.reason,
          error: null,
        };
      }

      if (convergence.stalled) {
        return {
          success: false,
          iterations: i + 1,
          history,
          finalStatus: { eslint: lastEslint, vitest: lastVitest },
          reason: \`Fix loop stalled: \${convergence.reason}\`,
          error: null,
        };
      }

      if (convergence.regressed) {
        return {
          success: false,
          iterations: i + 1,
          history,
          finalStatus: { eslint: lastEslint, vitest: lastVitest },
          reason: \`Fix loop regressed: \${convergence.reason}\`,
          error: null,
        };
      }
    }

    // First iteration with clean state = success
    if (eslintResult.clean && vitestResult.success) {
      return {
        success: true,
        iterations: i + 1,
        history,
        finalStatus: { eslint: lastEslint, vitest: lastVitest },
        reason: 'All checks passed',
        error: null,
      };
    }
  }

  // Reached max iterations without convergence
  return {
    success: false,
    iterations: maxIterations,
    history,
    finalStatus: { eslint: lastEslint, vitest: lastVitest },
    reason: 'Max iterations reached without convergence',
    error: null,
  };
}`;

  const newAutoFix = `export function autoFix(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { maxIterations } = opts;

  const history = [];
  let lastEslint = { errors: 0, warnings: 0, total: 0, clean: true };
  let lastVitest = { passed: 0, failed: 0, total: 0, success: true };

  for (let i = 0; i < maxIterations; i++) {
    let iterResult;
    try {
      iterResult = runIteration(opts);
    } catch (err) {
      return buildFixResult(false, i + 1, history, { eslint: lastEslint, vitest: lastVitest }, 'Unexpected error', err.message);
    }

    lastEslint = iterResult.eslint;
    lastVitest = iterResult.vitest;
    history.push(iterResult);

    if (history.length >= 2) {
      const convergence = checkConvergence(history);
      const status = { eslint: lastEslint, vitest: lastVitest };

      if (convergence.converged) return buildFixResult(true, i + 1, history, status, convergence.reason);
      if (convergence.stalled) return buildFixResult(false, i + 1, history, status, \`Fix loop stalled: \${convergence.reason}\`);
      if (convergence.regressed) return buildFixResult(false, i + 1, history, status, \`Fix loop regressed: \${convergence.reason}\`);
    }

    if (iterResult.eslint.clean && iterResult.vitest.success) {
      return buildFixResult(true, i + 1, history, { eslint: lastEslint, vitest: lastVitest }, 'All checks passed');
    }
  }

  return buildFixResult(false, maxIterations, history, { eslint: lastEslint, vitest: lastVitest }, 'Max iterations reached without convergence');
}`;

  src = src.replace('export function autoFix', helpers + 'export function autoFix');
  src = src.replace(oldAutoFix, newAutoFix);

  writeFileSync(p, src);
  console.log('auto-fixer.js: refactored. Lines:', src.split('\n').length);
}

// ── 3. extension.js: already has methods under 50 lines each ──
// The factory function `createExtensionRegistry` is 164 lines but
// each inner function is individually <50 lines. The "violation" is
// the outer wrapper. We extract registerSkill and registerHook validators.

function refactorExtension() {
  const p = path.join(__dirname, 'extension.js');
  let src = readFileSync(p, 'utf-8');

  // Extract validation into module-level helpers
  const validators = `/**
 * Validate skill registration parameters.
 * @param {string} name
 * @param {object} config
 * @param {Map} existingSkills
 */
function validateSkillParams(name, config, existingSkills) {
  if (!name || typeof name !== 'string') {
    throw new Error('Skill name must be a non-empty string');
  }
  if (!config || typeof config !== 'object') {
    throw new Error('Skill config must be an object');
  }
  for (const field of REQUIRED_SKILL_FIELDS) {
    if (!config[field]) {
      throw new Error(\`Skill config missing required field: "\${field}"\`);
    }
  }
  if (config.name !== name) {
    throw new Error(\`Skill config.name ("\${config.name}") must match the registered name ("\${name}")\`);
  }
  if (existingSkills.has(name)) {
    throw new Error(\`Skill "\${name}" is already registered\`);
  }
}

/**
 * Validate hook registration parameters.
 * @param {string} event
 * @param {Function} handler
 */
function validateHookParams(event, handler) {
  if (!event || typeof event !== 'string') {
    throw new Error('Hook event must be a non-empty string');
  }
  if (typeof handler !== 'function') {
    throw new Error('Hook handler must be a function');
  }
}

`;

  // Replace registerSkill body
  const oldRegisterSkill = `  function registerSkill(name, config) {
    if (!name || typeof name !== 'string') {
      throw new Error('Skill name must be a non-empty string');
    }

    if (!config || typeof config !== 'object') {
      throw new Error('Skill config must be an object');
    }

    for (const field of REQUIRED_SKILL_FIELDS) {
      if (!config[field]) {
        throw new Error(\`Skill config missing required field: "\${field}"\`);
      }
    }

    if (config.name !== name) {
      throw new Error(\`Skill config.name ("\${config.name}") must match the registered name ("\${name}")\`);
    }

    if (skills.has(name)) {
      throw new Error(\`Skill "\${name}" is already registered\`);
    }

    const entry = {
      name,
      config: { ...config },
      registeredAt: new Date().toISOString(),
    };
    skills.set(name, entry);
    return { ...entry, config: { ...entry.config } };
  }`;

  const newRegisterSkill = `  function registerSkill(name, config) {
    validateSkillParams(name, config, skills);
    const entry = {
      name,
      config: { ...config },
      registeredAt: new Date().toISOString(),
    };
    skills.set(name, entry);
    return { ...entry, config: { ...entry.config } };
  }`;

  // Replace registerHook body
  const oldRegisterHook = `  function registerHook(event, handler) {
    if (!event || typeof event !== 'string') {
      throw new Error('Hook event must be a non-empty string');
    }

    if (typeof handler !== 'function') {
      throw new Error('Hook handler must be a function');
    }

    const id = \`hook-\${++hookIdCounter}\`;`;

  const newRegisterHook = `  function registerHook(event, handler) {
    validateHookParams(event, handler);
    const id = \`hook-\${++hookIdCounter}\`;`;

  src = src.replace('export function createExtensionRegistry()', validators + 'export function createExtensionRegistry()');
  src = src.replace(oldRegisterSkill, newRegisterSkill);
  src = src.replace(oldRegisterHook, newRegisterHook);

  writeFileSync(p, src);
  console.log('extension.js: refactored. Lines:', src.split('\n').length);
}

// ── Execute all ──

try {
  refactorMetricsCollector();
  refactorAutoFixer();
  refactorExtension();
  console.log('\nAll 3 files refactored successfully.');
} catch (err) {
  console.error('Refactoring failed:', err.message);
  process.exit(1);
}

// Self-delete
unlinkSync(path.join(__dirname, '_refactor-critical.js'));
console.log('Temp script deleted.');
