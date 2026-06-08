/**
 * DATA POLICY regression: swarm must be opt-in off by default.
 * Task #10 — F-01: artibot.config.json swarm.enabled/optIn default-off.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..',
);

describe('DATA POLICY: swarm defaults', () => {
  it('artibot.config.json has swarm.enabled=false', () => {
    const cfg = JSON.parse(
      readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'),
    );
    expect(cfg.swarm.enabled).toBe(false);
  });

  it('artibot.config.json has swarm.optIn=false', () => {
    const cfg = JSON.parse(
      readFileSync(path.join(PLUGIN_ROOT, 'artibot.config.json'), 'utf-8'),
    );
    expect(cfg.swarm.optIn).toBe(false);
  });

  it('swarm-config SWARM_DEFAULTS has enabled=false', async () => {
    const { SWARM_DEFAULTS } = await import('../../lib/swarm/swarm-config.js');
    expect(SWARM_DEFAULTS.enabled).toBe(false);
  });

  it('swarm-config SWARM_DEFAULTS has optIn=false', async () => {
    const { SWARM_DEFAULTS } = await import('../../lib/swarm/swarm-config.js');
    expect(SWARM_DEFAULTS.optIn).toBe(false);
  });
});

describe('DATA POLICY: swarm-client ARTIBOT_SWARM_SERVER env warning', () => {
  it('resolveServerUrl source contains env-override warning log', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      path.join(PLUGIN_ROOT, 'lib', 'swarm', 'swarm-client.js'),
      'utf-8',
    );
    expect(src).toMatch(/ARTIBOT_SWARM_SERVER.*overrides swarm endpoint/s);
    expect(src).toMatch(/DATA POLICY/);
  });
});
