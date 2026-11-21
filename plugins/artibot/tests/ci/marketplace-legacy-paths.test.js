/**
 * plugins/artibot/marketplace.json: every relative document path resolves.
 *
 * -- What broke (review L11, 2026-11-21) ----------------------------------------
 * `licenseFile: "./LICENSE"` pointed into plugins/artibot/, but the only LICENSE
 * is at the repo root. Nothing read the field (grep for `licenseFile` across the
 * repo on 2026-11-21: this manifest and one doc line), and
 * scripts/marketplace-validate.mjs checks "a LICENSE at repo root OR plugin
 * root", not the declared path, so the wrong path passed every gate. The field
 * now says `../../LICENSE`, the same convention `documentation.contributing`
 * already uses for the root CONTRIBUTING.md. A copy was rejected: it would be a
 * second license text that can drift from the real one.
 *
 * -- What this gate cannot see --------------------------------------------------
 *  - `screenshots[].path` and `media.*`: those images do not exist yet
 *    (`_marketplace/screenshots/` holds only a README on 2026-11-21) — a known
 *    pending asset, not a path typo, so they are listed and skipped here.
 *  - Whether a marketplace consumer resolves paths relative to this file. The
 *    manifest is a draft (`_specStatus: draft`); relative-to-file is the
 *    convention its own other fields already follow.
 *  - A plugin cache copy that holds plugins/artibot only: `../../` does not exist
 *    there. That is equally true of `documentation.contributing`.
 *
 * @module tests/ci/marketplace-legacy-paths
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'marketplace.json'), 'utf-8'));

/** [json pointer, value] for every document path the manifest declares. */
const DECLARED = [
  ['licenseFile', manifest.licenseFile],
  ['changelog', manifest.changelog],
  ['safetyCompliance.vulnerabilityDisclosure', manifest.safetyCompliance?.vulnerabilityDisclosure],
  ['installation.documentation', manifest.installation?.documentation],
  ...Object.entries(manifest.documentation ?? {}).map(([k, v]) => [`documentation.${k}`, v]),
  ['entryPoints.manifest', manifest.entryPoints?.manifest],
  ['entryPoints.mcpServer', manifest.entryPoints?.mcpServer],
  ...Object.entries(manifest.entryPoints ?? {})
    .filter(([, v]) => v && typeof v === 'object' && typeof v.directory === 'string')
    .map(([k, v]) => [`entryPoints.${k}.directory`, v.directory]),
];

describe('marketplace.json (plugin): declared document paths', () => {
  it('declares the fields this gate is about (0 checked is not 0 broken)', () => {
    expect(DECLARED.length).toBeGreaterThanOrEqual(12);
    for (const [ptr, value] of DECLARED) {
      expect(typeof value, `${ptr} must be a string path`).toBe('string');
    }
  });

  it.each(DECLARED)('%s resolves to an existing file or directory', (ptr, value) => {
    expect(existsSync(path.resolve(PLUGIN_ROOT, value)), `${ptr} = ${value} does not exist`).toBe(true);
  });

  it('licenseFile is the one repo-root LICENSE, not a second copy in the plugin', () => {
    expect(path.resolve(PLUGIN_ROOT, manifest.licenseFile)).toBe(path.resolve(PLUGIN_ROOT, '..', '..', 'LICENSE'));
    expect(existsSync(path.join(PLUGIN_ROOT, 'LICENSE'))).toBe(false);
  });
});
