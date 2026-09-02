/**
 * `lib/supervisor/event-types` — allowlist matches the design and the
 * telemetry module it consumes.
 *
 * Not covered: whether any emitter writes these types (nothing does yet —
 * observe mode ships with zero producers besides `run-store.js#appendEvent`).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  isKnownEvent,
  isSupervisorEvent,
  isTelemetryEvent,
  SOURCES,
  SUPERVISOR_EVENT_TYPES,
  TELEMETRY_EVENT_TYPES,
} from '../../lib/supervisor/event-types.js';
import {
  PHASE_END, PHASE_START, WALL_CLOCK_END, WALL_CLOCK_START,
} from '../../lib/observability/split-telemetry.js';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DESIGN = path.resolve(PLUGIN_ROOT, '..', '..', 'docs', 'artibot-vnext-autonomous-runtime-design-v1.0', 'artibot-vnext-design');

describe('supervisor event allowlist', () => {
  it('lists the 20 design §05 event types, frozen', () => {
    expect(SUPERVISOR_EVENT_TYPES).toHaveLength(20);
    expect(Object.isFrozen(SUPERVISOR_EVENT_TYPES)).toBe(true);
    expect(new Set(SUPERVISOR_EVENT_TYPES).size).toBe(20);
    for (const t of SUPERVISOR_EVENT_TYPES) expect(t).toMatch(/^[a-z][a-z0-9-]+$/);
  });

  it('matches the envelope schema source enum', () => {
    const schemaPath = path.join(DESIGN, 'contracts', 'event-envelope.schema.json');
    let schema;
    try {
      schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    } catch {
      return; // design docs absent in this checkout — nothing to compare against
    }
    expect([...SOURCES]).toEqual(schema.properties.source.enum);
  });

  it('telemetry types cover the four exported constants plus the two fast-profile literals', () => {
    for (const c of [PHASE_START, PHASE_END, WALL_CLOCK_START, WALL_CLOCK_END]) {
      expect(TELEMETRY_EVENT_TYPES).toContain(c);
    }
    const src = readFileSync(path.join(PLUGIN_ROOT, 'lib', 'observability', 'split-telemetry.js'), 'utf-8');
    expect(src).toContain("'fast-profile-planned'");
    expect(src).toContain("'fast-profile-reused'");
    expect(TELEMETRY_EVENT_TYPES).toContain('fast-profile-planned');
    expect(TELEMETRY_EVENT_TYPES).toContain('fast-profile-reused');
  });

  it('predicates: known = supervisor ∪ telemetry; anything else false', () => {
    expect(isSupervisorEvent('lane-heartbeat')).toBe(true);
    expect(isTelemetryEvent('lane-heartbeat')).toBe(false);
    expect(isTelemetryEvent('phase-start')).toBe(true);
    expect(isKnownEvent('phase-start')).toBe(true);
    expect(isKnownEvent('lane-blocked')).toBe(false); // design §03 mentions it, §05 vocabulary does not
    expect(isKnownEvent(null)).toBe(false);
    expect(isKnownEvent(42)).toBe(false);
  });
});
