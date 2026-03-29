/**
 * Plugin Marketplace Architecture — one-click install, modular packages,
 * auto-update with diff-based incremental delivery.
 *
 * Handles: package registry, installation profiles, version resolution,
 * dependency conflict detection, and update lifecycle.
 *
 * DATA POLICY: All operations are local-first. The registry is fetched
 * from the Artibot GitHub releases, never from third-party servers.
 *
 * @module lib/core/marketplace
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Installation profiles — predefined domain bundles */
const INSTALL_PROFILES = Object.freeze({
  full: {
    name: 'Full',
    description: 'All agents, commands, skills, and hooks',
    domains: ['engineering', 'marketing', 'security', 'analytics', 'design'],
  },
  engineering: {
    name: 'Engineering',
    description: 'Code agents, TDD, build, CI/CD, refactoring',
    includes: [
      'agents/frontend-developer', 'agents/backend-developer', 'agents/architect',
      'agents/tdd-guide', 'agents/code-reviewer', 'agents/build-error-resolver',
      'agents/refactor-cleaner', 'agents/performance-engineer',
      'commands/implement', 'commands/build', 'commands/test', 'commands/verify',
      'skills/coding-standards', 'skills/tdd-workflow', 'skills/testing-standards',
    ],
  },
  marketing: {
    name: 'Marketing',
    description: 'Content, SEO, CRO, ads, analytics agents',
    includes: [
      'agents/marketing-strategist', 'agents/seo-specialist',
      'agents/content-marketer', 'agents/cro-specialist', 'agents/ad-specialist',
      'commands/mkt', 'commands/seo', 'commands/content', 'commands/analytics',
      'skills/marketing-strategy', 'skills/seo-strategy', 'skills/copywriting',
    ],
  },
  security: {
    name: 'Security',
    description: 'Security review, PII protection, compliance',
    includes: [
      'agents/security-reviewer',
      'skills/security-standards', 'skills/persona-security',
    ],
  },
  analytics: {
    name: 'Analytics',
    description: 'Data analysis, visualization, reporting',
    includes: [
      'agents/data-analyst',
      'commands/analytics', 'commands/excel',
      'skills/data-analysis', 'skills/data-visualization', 'skills/report-generation',
    ],
  },
  design: {
    name: 'Design',
    description: 'System design, architecture, presentations',
    includes: [
      'agents/architect', 'agents/presentation-designer',
      'commands/design', 'commands/ppt',
      'skills/persona-architect', 'skills/presentation-design',
    ],
  },
});

// ---------------------------------------------------------------------------
// Package Manifest
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PackageManifest
 * @property {string} name - Package name (e.g. 'artibot')
 * @property {string} version - Semver version string
 * @property {string[]} files - List of all files in the package
 * @property {Record<string, string>} checksums - SHA-256 per file
 * @property {string} profile - Installation profile used
 * @property {string} installedAt - ISO timestamp
 */

/**
 * Create a package manifest from a list of files and their contents.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.version
 * @param {Record<string, string>} opts.fileContents - { relativePath: content }
 * @param {string} opts.profile
 * @returns {PackageManifest}
 */
export function createManifest({ name, version, fileContents, profile }) {
  const files = Object.keys(fileContents).sort();
  const checksums = {};

  for (const [filePath, content] of Object.entries(fileContents)) {
    checksums[filePath] = createHash('sha256').update(content).digest('hex');
  }

  return {
    name,
    version,
    files,
    checksums,
    profile,
    installedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Diff-based Update
// ---------------------------------------------------------------------------

/**
 * @typedef {object} UpdateDiff
 * @property {string[]} added - New files to create
 * @property {string[]} modified - Changed files to overwrite
 * @property {string[]} removed - Files no longer in the package
 * @property {string[]} unchanged - Files identical in both versions
 */

/**
 * Compute a diff between two package manifests for incremental update.
 *
 * @param {PackageManifest} installed - Currently installed manifest
 * @param {PackageManifest} incoming - New version manifest
 * @returns {UpdateDiff}
 */
export function computeUpdateDiff(installed, incoming) {
  const installedSet = new Set(installed.files);
  const incomingSet = new Set(incoming.files);

  const added = [];
  const modified = [];
  const removed = [];
  const unchanged = [];

  for (const file of incoming.files) {
    if (!installedSet.has(file)) {
      added.push(file);
    } else if (installed.checksums[file] !== incoming.checksums[file]) {
      modified.push(file);
    } else {
      unchanged.push(file);
    }
  }

  for (const file of installed.files) {
    if (!incomingSet.has(file)) {
      removed.push(file);
    }
  }

  return { added, modified, removed, unchanged };
}

// ---------------------------------------------------------------------------
// Dependency Conflict Detection
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ConflictReport
 * @property {boolean} hasConflicts
 * @property {Array<{ file: string, ownedBy: string, conflictsWith: string }>} conflicts
 */

/**
 * Check if installing a package would conflict with already-installed packages.
 *
 * @param {PackageManifest} incoming - Package to install
 * @param {PackageManifest[]} existing - Already installed packages
 * @returns {ConflictReport}
 */
export function detectConflicts(incoming, existing) {
  const conflicts = [];
  const fileOwners = new Map();

  for (const pkg of existing) {
    for (const file of pkg.files) {
      fileOwners.set(file, pkg.name);
    }
  }

  for (const file of incoming.files) {
    const owner = fileOwners.get(file);
    if (owner && owner !== incoming.name) {
      conflicts.push({ file, ownedBy: owner, conflictsWith: incoming.name });
    }
  }

  return { hasConflicts: conflicts.length > 0, conflicts };
}

// ---------------------------------------------------------------------------
// Installation Plan
// ---------------------------------------------------------------------------

/**
 * @typedef {object} InstallPlan
 * @property {string} profile - Selected profile name
 * @property {string[]} components - Components to install
 * @property {number} fileCount - Total files to write
 * @property {ConflictReport} conflicts - Dependency conflicts (if any)
 */

/**
 * Generate an installation plan for a given profile.
 *
 * @param {string} profileName - Profile key from INSTALL_PROFILES
 * @param {PackageManifest[]} [existing=[]] - Already installed packages
 * @returns {InstallPlan}
 */
export function createInstallPlan(profileName, existing = []) {
  const profile = INSTALL_PROFILES[profileName];
  if (!profile) {
    return {
      profile: profileName,
      components: [],
      fileCount: 0,
      conflicts: { hasConflicts: false, conflicts: [] },
    };
  }

  const components = profile.domains
    ? Object.values(INSTALL_PROFILES)
        .filter((p) => p.includes)
        .flatMap((p) => p.includes)
    : profile.includes || [];

  const uniqueComponents = [...new Set(components)];

  // Simulate a manifest to check conflicts
  const pseudoManifest = {
    name: 'artibot',
    files: uniqueComponents,
    checksums: {},
  };

  const conflicts = detectConflicts(pseudoManifest, existing);

  return {
    profile: profileName,
    components: uniqueComponents,
    fileCount: uniqueComponents.length,
    conflicts,
  };
}

// ---------------------------------------------------------------------------
// Version Resolution
// ---------------------------------------------------------------------------

/**
 * Parse a semver string into components.
 *
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number }}
 */
export function parseSemver(version) {
  const cleaned = String(version).replace(/^v/, '').split('-')[0];
  const [major, minor, patch] = cleaned.split('.').map((n) => {
    const num = parseInt(n, 10);
    return Number.isNaN(num) ? 0 : num;
  });
  return { major: major || 0, minor: minor || 0, patch: patch || 0 };
}

/**
 * Check if an update is available.
 *
 * @param {string} current - Installed version
 * @param {string} latest - Latest available version
 * @returns {{ available: boolean, type: 'major' | 'minor' | 'patch' | 'none' }}
 */
export function checkUpdate(current, latest) {
  const c = parseSemver(current);
  const l = parseSemver(latest);

  if (l.major > c.major) return { available: true, type: 'major' };
  if (l.major === c.major && l.minor > c.minor) return { available: true, type: 'minor' };
  if (l.major === c.major && l.minor === c.minor && l.patch > c.patch) {
    return { available: true, type: 'patch' };
  }
  return { available: false, type: 'none' };
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export {
  INSTALL_PROFILES as _INSTALL_PROFILES,
};
