/**
 * Truth-alignment contract for the 3-layer (hierarchical) memory flag.
 *
 * The shipped config must not claim the feature is live: no production code
 * reads `learning.hierarchicalMemory.*`, and the capture/promotion path is not
 * wired. Dispatch is decided only by env HIERARCHICAL_MEMORY=1|0 (or the test
 * seam). This file pins that state so config and behavior cannot drift apart.
 *
 * Does NOT prove: that the layers work end to end (see retriever tests) or that
 * production ever populates them (it does not - that is the point).
 *
 * @module tests/learning/hierarchical-memory-config
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isHierarchicalEnabled } from '../../lib/learning/memory-manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(here, '..', '..', 'artibot.config.json'), 'utf8'));

describe('hierarchical memory truth alignment', () => {
  let saved;
  beforeEach(() => { saved = process.env.HIERARCHICAL_MEMORY; });
  afterEach(() => {
    if (saved === undefined) delete process.env.HIERARCHICAL_MEMORY;
    else process.env.HIERARCHICAL_MEMORY = saved;
  });

  it('ships learning.hierarchicalMemory disabled at the documented rollback stage', () => {
    expect(config.learning.hierarchicalMemory.enabled).toBe(false);
    expect(config.learning.hierarchicalMemory.rolloutStage).toBe('phase-c');
  });

  it('keeps the design values intact for a later re-enable', () => {
    const hm = config.learning.hierarchicalMemory;
    expect(hm.weights).toEqual({ working: 0.5, episodic: 0.3, semantic: 0.2 });
    expect(hm.promotion.minOccurrences).toBe(3);
  });

  it('is off when HIERARCHICAL_MEMORY is unset', () => {
    delete process.env.HIERARCHICAL_MEMORY;
    expect(isHierarchicalEnabled()).toBe(false);
  });

  it('HIERARCHICAL_MEMORY=1 is still the explicit on switch and =0 the off switch', () => {
    process.env.HIERARCHICAL_MEMORY = '1';
    expect(isHierarchicalEnabled()).toBe(true);
    process.env.HIERARCHICAL_MEMORY = '0';
    expect(isHierarchicalEnabled()).toBe(false);
  });
});
