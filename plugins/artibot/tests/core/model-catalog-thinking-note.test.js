/**
 * `thinkingNote` in `lib/core/model-catalog.js`: the per-model thinking facts that
 * the closed `thinkingMode` vocabulary has no value for. Sonnet 5.5 rejects
 * `{type:'disabled'}` and takes `{type:'between_tools'}` as its lowest setting; Haiku
 * 5.5 accepts `{type:'disabled'}` only at effort `high` or below. They were typed
 * into the doc generator, where an edit of the catalog could not reach them; each
 * row owns its own note now and the generated doc renders it.
 *
 * WHY A FILE OF ITS OWN. `tests/core/model-catalog.test.js` is past the repo's
 * 800-line standard; the field's shape and its id fence are owned here. What the
 * generated doc says about the notes is pinned in
 * `tests/scripts/gen-model-catalog-docs.test.js`.
 *
 * WHAT THIS FILE CANNOT SEE
 *  1. WHETHER A NOTE IS TRUE. Nothing here re-reads the thinking page (data policy:
 *     nothing in the catalog's tests fetches anything), so a text is as true as the
 *     reading that wrote it, and `readOn` is a date somebody typed.
 *  2. A PAGE THAT CHANGED UNDER THE SAME ID. The fence notices a tier moving to
 *     another id, not an edit of the page.
 *  3. A TEXT EDITED UNDER AN OLD DATE. `readOn` later than `CATALOG_VERSION` is red
 *     (the stamp was not moved for a new reading); the same text re-worded without
 *     touching `readOn` is not.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CATALOG_VERSION,
  getModel,
  getPricing,
  ID_PRICES,
  listTiers,
  PRICING_VERSION,
  tierForModelId,
} from '../../lib/core/model-catalog.js';
import { PRICING_HISTORY } from '../../lib/core/pricing-history.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const catalogSrc = await readFile(path.join(HERE, '..', '..', 'lib', 'core', 'model-catalog.js'), 'utf8');

const NOTE_KEYS = ['readFor', 'readOn', 'text'];
const rows = listTiers().map((tier) => [tier, getModel(tier)]);

describe('thinkingNote (the per-model thinking facts thinkingMode has no value for)', () => {
  it('is declared by every tier row, as null or a frozen { readFor, readOn, text } of strings', () => {
    expect(rows).toHaveLength(4);
    for (const [tier, row] of rows) {
      expect(Object.hasOwn(row, 'thinkingNote'), tier).toBe(true);
      const note = row.thinkingNote;
      if (note === null) continue;
      expect(Object.keys(note).sort(), tier).toEqual(NOTE_KEYS);
      expect(Object.isFrozen(note), tier).toBe(true);
      for (const key of NOTE_KEYS) expect(typeof note[key], `${tier}.${key}`).toBe('string');
    }
  });

  it('is set on the sonnet and haiku rows only; opus and fable are always-on and carry none', () => {
    expect(Object.fromEntries(rows.map(([tier, row]) => [tier, row.thinkingNote !== null])))
      .toEqual({ haiku: true, sonnet: true, opus: false, fable: false });
    for (const tier of ['opus', 'fable']) {
      expect(getModel(tier).thinkingMode, tier).toBe('always-on');
    }
  });

  it('every adaptive row carries one: the doc legend leaves "whether disabled is accepted" to it', () => {
    // `adaptive` promises the adaptive shape only and says disabling "varies per tier",
    // so a row on it with no note would leave that question unanswered in the doc.
    for (const [tier, row] of rows) {
      if (row.thinkingMode === 'adaptive') {
        expect(row.thinkingNote, `${tier} is adaptive: write its thinkingNote`).not.toBeNull();
      }
    }
  });

  it('text is one trimmed line with no full stop (the doc adds it) and no URL scheme', () => {
    for (const [tier, row] of rows) {
      const note = row.thinkingNote;
      if (note === null) continue;
      expect(note.text.length, tier).toBeGreaterThan(0);
      expect(note.text, tier).toBe(note.text.trim());
      expect(note.text, tier).not.toMatch(/[\r\n]/);
      expect(note.text.endsWith('.'), `${tier} text ends with a full stop`).toBe(false);
      // The outbound guard fails model-catalog.js on any URL literal, strings included.
      expect(note.text, tier).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//i);
    }
  });

  it("readFor is the id the row carries now, and an id the row's own tier resolves", () => {
    // The fence. When a tier moves to another id the generated doc stops stating its
    // note and this goes red: read the thinking page for the new model, then update
    // readFor, readOn and text, or delete the note.
    for (const [tier, row] of rows) {
      const note = row.thinkingNote;
      if (note === null) continue;
      expect(note.readFor, `${tier}: the note was read for ${note.readFor}, the row is ${row.id}`).toBe(row.id);
      expect(tierForModelId(note.readFor), tier).toBe(tier);
    }
  });

  it('readOn is a real calendar date, and not later than CATALOG_VERSION', () => {
    for (const [tier, row] of rows) {
      const note = row.thinkingNote;
      if (note === null) continue;
      expect(note.readOn, tier).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${note.readOn}T00:00:00Z`).toISOString().slice(0, 10), tier).toBe(note.readOn);
      // Any non-price edit of MODELS moves the stamp (rule at CATALOG_VERSION), so a
      // note read after the stamp means the stamp was not moved for it.
      expect(
        note.readOn <= CATALOG_VERSION,
        `${tier}: readOn ${note.readOn} is after CATALOG_VERSION ${CATALOG_VERSION}`,
      ).toBe(true);
    }
  });

  it('is typed once, in the MODELS typedef, and is on no other surface', () => {
    expect(catalogSrc.match(/^\s*\*\s+thinkingNote: /gm) ?? []).toHaveLength(1);
    for (const [id, row] of Object.entries(ID_PRICES)) {
      expect(Object.hasOwn(row, 'thinkingNote'), id).toBe(false);
    }
    for (const key of [...listTiers(), 'claude-haiku-5-5', 'claude-haiku-4-5']) {
      expect(getPricing(key), key).not.toHaveProperty('thinkingNote');
    }
    // A note is not a price column: the frozen price history carries prices and nothing else.
    expect(Object.keys(PRICING_HISTORY[PRICING_VERSION].tiers.haiku)).not.toContain('thinkingNote');
  });
});
