/**
 * Rule sets shared by every ESLint entry point in this repository.
 *
 * Why this file exists: `eslint.config.js` can only lint files at or below its
 * own directory. ESLint resolves a flat config's `files` patterns against a
 * base path, and the base path is the directory the config was found in (or the
 * cwd when `-c` is used) — a pattern cannot climb out with `../`. So
 * `plugins/artibot-cowork/scripts/` was linted by nothing at all until
 * 2026-08-15.
 *
 * The gap was ABSENCE, not a silent pass. ESLint 10.2.1 is loud about this if
 * you ask it (measured 2026-08-15, transcripts in
 * `tests/firewall/cowork-scripts-lint.test.js`): a directory target exits 2, and
 * an explicitly named file reports `File ignored because outside of base path.`
 * Nobody was asking. CI runs `npx eslint .` from `plugins/artibot`
 * (`.github/workflows/ci.yml`, step "Run ESLint"); that examines 890 files and
 * **zero of them are cowork files**, which is why the absence was invisible.
 * `calculateConfigForFile()` on a cowork path returns `undefined`.
 *
 * The gate that closed it (`tests/firewall/cowork-scripts-lint.test.js`) drives
 * ESLint through its Node API with the cwd set to the repository root, which is
 * the only base path that contains both plugins. That gate needs the same rules
 * this config applies to `scripts/**`. Copying them would let the two drift the
 * moment one side is tightened, and a silently looser second copy is the exact
 * shape of gate rot this repo has been bitten by before, so both sides import
 * from here instead.
 *
 * Anything added below applies to BOTH plugins. Rules that are genuinely
 * specific to one of them belong in that side's config, not here.
 *
 * @module eslint.shared-rules
 */

/**
 * Baseline rules for first-party JavaScript (bin, lib, scripts, server, tests,
 * hooks). Extracted verbatim from the inline object this file replaced.
 */
export const BASE_RULES = {
  'no-console': 'warn',
  'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  'consistent-return': 'error',
  'eqeqeq': 'error',
  'max-depth': ['warn', 4],
  // max-params 6 + complexity 30 are the current measured upper bounds
  // for legacy GRPO + middleware functions (neural-policy.runIteration=6,
  // joint-policy.selectJointWith=28, session-capture middleware=25).
  // Refactoring is tracked separately; these caps prevent regression.
  'max-params': ['warn', 6],
  'complexity': ['warn', 30],
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-shadow': 'warn',
  'prefer-const': 'error',
  'no-var': 'error',
  'sort-imports': ['warn', {
    ignoreCase: true,
    ignoreDeclarationSort: true,
    ignoreMemberSort: false,
  }],
};

/**
 * Relaxations for CLI scripts. Printing to stdout is these files' job, and the
 * argument-dispatch shape they share pushes past the complexity cap without
 * being hard to read.
 */
export const SCRIPT_RULE_OVERRIDES = {
  'no-console': 'off',
  'complexity': 'off',
};

/**
 * Effective rule set for a CLI script: baseline with the script relaxations
 * applied. `eslint.config.js` reaches the same result through flat-config
 * cascading (two config objects both matching `scripts/**`); callers that build
 * a config programmatically, such as the cowork firewall gate, need it
 * pre-merged because they declare a single config object.
 */
export const SCRIPT_RULES = { ...BASE_RULES, ...SCRIPT_RULE_OVERRIDES };
