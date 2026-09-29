/**
 * Unit contract for `parseSessionIdList()` (`lib/replay/session-coverage.js`).
 *
 * Split out of `session-coverage.test.js` for the 800-line standard (V5-BACKLOG section 3);
 * the cases moved verbatim. `scripts/ledger/session-coverage.mjs` runs its
 * `--exclude-sessions` argument through this parser, and every case here is about what
 * the parser COUNTS as ignored instead of dropping it silently. Pure: text in,
 * `{ ids, ignored }` out, so none of the fold fixtures are needed.
 *
 * @module tests/replay/session-coverage-parse
 */

import { describe, expect, it } from 'vitest';
import { parseSessionIdList } from '../../lib/replay/session-coverage.js';

describe('parseSessionIdList()', () => {
  it('reads one id per line, sorted and unique', () => {
    expect(parseSessionIdList('b\na\nc\na\n')).toEqual({ ids: ['a', 'b', 'c'], ignored: 0 });
  });

  it('accepts list bullets, backticks, quotes, CRLF and surrounding blanks', () => {
    const text = ['- a', '* b', '+ c', '- `d`', '"e"', "'f'", '   g   ', ''].join('\r\n');
    expect(parseSessionIdList(text)).toEqual({ ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], ignored: 0 });
  });

  it('skips blank lines and # comments without counting them as ignored', () => {
    expect(parseSessionIdList('# a heading\n\n   \n## sub\nx')).toEqual({ ids: ['x'], ignored: 0 });
  });

  it('counts every entry that is not a session id instead of silently dropping it', () => {
    const text = ['has space', 'a,b', '../../etc/passwd', 'C:\\temp\\x', '-', `z${'y'.repeat(128)}`, 'ok'].join('\n');
    expect(parseSessionIdList(text)).toEqual({ ids: ['ok'], ignored: 6 });
  });

  it('reads the exclusion document the way the leader wrote it', () => {
    // Same line kinds as `ledger-exclusions-20260929.md`: a heading, prose,
    // a bulleted id list, prose again. 4 prose lines, 6 ids.
    const doc = [
      '# Ledger contamination to exclude from live census (2026-09-29)',
      '',
      'Source: limb W1-6 `ca04-host-ask-probe` (commit 6094ed98). Six empty runs.',
      '',
      'Exclude these session_ids from Observe \u2463 (session coverage):',
      '',
      '- 3eb8466c-6df6-4193-b880-a30529776aa0',
      '- fd7bc579-aa62-4bc6-a93d-cfc93ef2d2e5',
      '- b5369386-eee6-4a70-b486-cdf0876149bf',
      '- 65a342a1-c4f1-4746-b5b4-f7a57dccbc99',
      '- 860c8b93-6e48-4b16-8725-6801dfe42355',
      '- a5d7a7b8-bc73-4f41-aceb-f0747c13c1a0',
      '',
      "The limb's positive control (04:44:12Z): these 6 ids have 18 rows.",
      '',
      'M0 T1 must report coverage both with and without these ids.',
      '',
    ].join('\n');
    const parsed = parseSessionIdList(doc);
    expect(parsed.ids).toHaveLength(6);
    expect(parsed.ids).toContain('3eb8466c-6df6-4193-b880-a30529776aa0');
    expect(parsed.ids).toContain('a5d7a7b8-bc73-4f41-aceb-f0747c13c1a0');
    expect(parsed.ignored).toBe(4);
  });

  it('reads a comma-separated list in csv mode, skipping empty pieces', () => {
    expect(parseSessionIdList('a, b ,,c,', 'csv')).toEqual({ ids: ['a', 'b', 'c'], ignored: 0 });
    expect(parseSessionIdList('a,b c', 'csv')).toEqual({ ids: ['a'], ignored: 1 });
  });

  it('does not split a line on commas in line mode', () => {
    // A prose line with commas must stay ONE ignored entry, not a handful of
    // fragments some of which happen to look like ids.
    expect(parseSessionIdList('done, ok, fine')).toEqual({ ids: [], ignored: 1 });
  });

  it.each([[undefined], [null], [42], [{}], [['a']]])('treats %j as an empty list', (input) => {
    expect(parseSessionIdList(input)).toEqual({ ids: [], ignored: 0 });
  });
});
