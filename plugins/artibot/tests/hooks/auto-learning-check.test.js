/**
 * Unit tests for scripts/hooks/auto-learning-check.js — buildRegistrationLines
 * (B4: install-mode-aware guidance). main() is guarded by isMainEntry(), so
 * importing the module here does not consume stdin.
 */
import { describe, expect, it } from 'vitest';
import { buildRegistrationLines } from '../../scripts/hooks/auto-learning-check.js';

describe('buildRegistrationLines — no marker (never registered)', () => {
  it('legacy → points at install.sh', () => {
    const lines = buildRegistrationLines(null, 'legacy');
    const text = lines.join('\n');
    expect(text).toContain('bash ~/.claude/artibot/install.sh');
    expect(text).not.toContain('/plugin marketplace update');
  });

  it('native → points at /plugin marketplace update (never install.sh)', () => {
    const lines = buildRegistrationLines(null, 'native');
    const text = lines.join('\n');
    expect(text).toContain('/plugin marketplace update artibot');
    expect(text).not.toContain('install.sh');
  });

  it('ambiguous → conservative legacy text', () => {
    const text = buildRegistrationLines(null, 'ambiguous').join('\n');
    expect(text).toContain('bash ~/.claude/artibot/install.sh');
    expect(text).not.toContain('/plugin marketplace update');
  });
});

describe('buildRegistrationLines — hint-only marker (pending activation)', () => {
  const marker = { method: 'hint-only' };

  it('legacy → Option 2 uses the legacy setup script path', () => {
    const text = buildRegistrationLines(marker, 'legacy').join('\n');
    expect(text).toContain('Option 1: Use CronCreate tool');
    expect(text).toContain('node ~/.claude/artibot/scripts/setup-auto-learning.js --schedule');
    expect(text).not.toContain('/plugin marketplace update');
  });

  it('native → Option 2 uses /plugin (not the legacy script path)', () => {
    const text = buildRegistrationLines(marker, 'native').join('\n');
    expect(text).toContain('Option 1: Use CronCreate tool');
    expect(text).toContain('Option 2: /plugin marketplace update artibot');
    expect(text).not.toContain('setup-auto-learning.js');
  });

  it('ambiguous → conservative legacy Option 2', () => {
    const text = buildRegistrationLines(marker, 'ambiguous').join('\n');
    expect(text).toContain('setup-auto-learning.js --schedule');
  });
});

describe('buildRegistrationLines — active marker', () => {
  it('reports the active registration method regardless of install mode', () => {
    for (const mode of ['legacy', 'native', 'ambiguous']) {
      const text = buildRegistrationLines({ method: 'crontab' }, mode).join('\n');
      expect(text).toBe('[auto-learn] Registered via crontab');
    }
  });
});
