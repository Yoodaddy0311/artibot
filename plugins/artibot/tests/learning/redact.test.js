import { describe, expect, it } from 'vitest';
import { redactLines, redactSecrets, SECRET_CATEGORIES } from '../../lib/learning/ledger/redact.js';

// Synthetic secret fixtures assembled at runtime so no recognizable secret
// literal appears in source (avoids the repo's secret-scan write guard while
// still exercising the redactor's regexes).
const FAKE_OPENAI = `sk-${'x'.repeat(32)}`;   // matches /sk-[A-Za-z0-9_-]{20,}/
const FAKE_AWS = `AKIA${'A'.repeat(16)}`;     // matches /AKIA[A-Z0-9]{16}/
// Azure account key = 86 base64 data chars (incl. '+'/'/') + '=='.
const FAKE_AZURE = `${'A'.repeat(40)}+/${'B'.repeat(44)}==`;

describe('redact — secret scrubbing (F-04)', () => {
  it('AC1: removes an sk- API key and leaves a redaction marker', () => {
    const out = redactSecrets(`my key is ${FAKE_OPENAI} ok`);
    expect(out).not.toContain(FAKE_OPENAI);
    expect(out).toMatch(/REDACTED/);
  });

  it('AC2: AWS access key does not survive into the output', () => {
    const out = redactSecrets(`aws ${FAKE_AWS}`);
    expect(out).not.toContain(FAKE_AWS);
  });

  it('AC3: Azure account key inside a JSON-wrapped ledger line is redacted', () => {
    // The real motivating case: ledger lines are JSON.stringify output, so the
    // key sits mid-string (no end-of-line anchor) and contains base64 '+'/'/'.
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: `AccountKey=${FAKE_AZURE}` },
    });
    const out = redactSecrets(line);
    expect(out).not.toContain(FAKE_AZURE);
    expect(out).toContain('[REDACTED_KEY]');
  });

  it('preserves non-secret context (email / IP) — scope = secrets only', () => {
    const out = redactSecrets('contact me@example.com at 10.0.0.5');
    expect(out).toContain('me@example.com');
    expect(out).toContain('10.0.0.5');
  });

  it('redactLines maps over an array and passes non-strings through', () => {
    const [a, b, c] = redactLines([`x ${FAKE_OPENAI}`, 'clean', 42]);
    expect(a).not.toContain(FAKE_OPENAI);
    expect(b).toBe('clean');
    expect(c).toBe(42);
  });

  it('redactLines tolerates non-array input', () => {
    expect(redactLines(null)).toEqual([]);
  });

  it('scope categories are secret-bearing only', () => {
    expect([...SECRET_CATEGORIES].sort()).toEqual(['auth', 'credentials', 'env', 'secrets']);
  });
});
