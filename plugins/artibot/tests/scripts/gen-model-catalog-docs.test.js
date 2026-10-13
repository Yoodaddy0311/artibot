/**
 * Tests for scripts/gen-model-catalog-docs.js — the CLAUDE-MODEL-CATALOG.md
 * generator. The doc is GENERATED output; these tests pin the renderer so a
 * catalog data change cannot silently produce a stale or malformed doc.
 *
 * WHAT THIS FILE CANNOT SEE
 *  1. Whether the per-model thinking notes (`thinkingNote` on the catalog rows) are
 *     still true on the official thinking page, or were read on the day they say.
 *     This file pins that the doc says what the rows say; the catalog test
 *     (tests/core/model-catalog-thinking-note.test.js) pins that a note was read for
 *     its row's current id. A page that changed under the same id is invisible to both.
 *  2. Whether the receipt writer really counts requests over a price band, and
 *     where the boundary falls. The footnote repeats the catalog's account of that;
 *     tests/economics/usage-receipt-price-band.test.js is what pins it.
 *  3. Whether the committed doc is what a reader sees installed: the drift test
 *     reads the working tree's docs/ file only.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as catalog from '../../lib/core/model-catalog.js';
import {
  checkDoc,
  renderDoc,
  specTable,
  THINKING_LEGEND,
  toFileUrl,
} from '../../scripts/gen-model-catalog-docs.js';

const DOC_PATH = fileURLToPath(new URL('../../docs/CLAUDE-MODEL-CATALOG.md', import.meta.url));
const catalogSrc = await readFile(
  fileURLToPath(new URL('../../lib/core/model-catalog.js', import.meta.url)),
  'utf-8',
);

/**
 * The catalog with every tier's spec overridden by `patch(tier)`, for what-if
 * renders. The generator reads specs through `getModel`, so one override is enough.
 *
 * @param {(tier: string) => object} patch - Fields to override for that tier.
 * @returns {object} A catalog-shaped object (the real exports, `getModel` replaced).
 */
function catalogWith(patch) {
  return {
    ...catalog,
    getModel: (tier) => {
      const spec = catalog.getModel(tier);
      return spec === null ? null : { ...spec, ...patch(tier) };
    },
  };
}

/** One tier's `thinkingNote` with some fields replaced, as a `catalogWith` patch value. */
function noteOf(tier, fields) {
  return { thinkingNote: { ...catalog.getModel(tier).thinkingNote, ...fields } };
}

/**
 * The per-model note lines of a rendered doc, read back as data: the bullets that
 * follow the "Per-model details" paragraph. A bullet of another shape fails here.
 *
 * @param {string} doc - A rendered document.
 * @returns {Array<{tier: string, id: string, mode: string, readOn: string, text: string}>}
 */
function renderedNotes(doc) {
  const lines = doc.split('\n');
  const at = lines.findIndex((line) => line.startsWith('Per-model details'));
  if (at === -1) return [];
  const bullets = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith('- ')) break;
    const m = line.match(/^- `(\w+)` \(`([^`]+)`, `([^`]+)`, read (\d{4}-\d{2}-\d{2})\): (.+)\.$/);
    expect(m, `a note line of the expected shape: ${line}`).not.toBeNull();
    bullets.push({ tier: m[1], id: m[2], mode: m[3], readOn: m[4], text: m[5] });
  }
  return bullets;
}

/**
 * What the rows of `cat` say the doc must carry, in the order of the doc's own
 * table: each tier whose note was read for the id the row has now.
 *
 * @param {object} cat - A catalog-shaped object.
 * @returns {Array<{tier: string, id: string, mode: string, readOn: string, text: string}>}
 */
function notesOf(cat) {
  const order = specTable(cat).slice(2).map((row) => row.match(/^\| `(\w+)`/)[1]);
  return order.flatMap((tier) => {
    const model = cat.getModel(tier);
    const note = model.thinkingNote;
    return note && note.readFor === model.id
      ? [{ tier, id: model.id, mode: model.thinkingMode, readOn: note.readOn, text: note.text }]
      : [];
  });
}

describe('gen-model-catalog-docs', () => {
  describe('checkDoc (--check mode, write-free)', () => {
    const rendered = renderDoc(catalog);

    it('reports match when disk equals the render', () => {
      expect(checkDoc(rendered, rendered)).toEqual({ upToDate: true, reason: 'match' });
    });

    it('treats a CRLF checkout of the same content as up to date', () => {
      expect(checkDoc(rendered, rendered.replace(/\n/g, '\r\n')).upToDate).toBe(true);
    });

    it('reports stale when content differs', () => {
      expect(checkDoc(rendered, rendered + '\nextra')).toEqual({ upToDate: false, reason: 'stale' });
    });

    it('reports missing when the doc is absent', () => {
      expect(checkDoc(rendered, null)).toEqual({ upToDate: false, reason: 'missing' });
    });
  });

  describe('fable heading', () => {
    it('derives the fable heading from the catalog id, with no hand-typed generation number', () => {
      const doc = renderDoc(catalog);
      const id = catalog.getModel('fable').id;
      expect(doc).toContain(`## Claude Fable (\`${id}\`)`);
      expect(doc).not.toMatch(/^## Claude Fable \d/m);
    });
  });

  describe('toFileUrl', () => {
    it('builds file:/// URLs for Windows drive paths without percent-encoding', () => {
      const url = toFileUrl('C:\\Users\\nowhe\\바탕 화면\\AI\\artibot\\lib\\x.js');
      expect(url).toBe('file:///C:/Users/nowhe/바탕 화면/AI/artibot/lib/x.js');
      expect(url).not.toContain('%');
    });

    it('builds file:// URLs for POSIX paths', () => {
      expect(toFileUrl('/home/user/lib/x.js')).toBe('file:///home/user/lib/x.js');
    });
  });

  describe('specTable', () => {
    it('renders one row per catalog tier plus a 2-line header', () => {
      const lines = specTable(catalog);
      expect(lines.length).toBe(2 + catalog.listTiers().length);
    });

    it('renders each tier row with its catalog thinkingMode (opus always-on since 2026-09-28, haiku adaptive since 2026-10-12)', () => {
      const lines = specTable(catalog);
      for (const tier of catalog.listTiers()) {
        const row = lines.find((l) => l.startsWith(`| \`${tier}\``));
        expect(row).toMatch(new RegExp(`\\| ${catalog.getModel(tier).thinkingMode} \\|$`));
      }
      expect(lines.find((l) => l.startsWith('| `opus`'))).toMatch(/\| always-on \|$/);
      expect(lines.find((l) => l.startsWith('| `haiku`'))).toMatch(/\| adaptive \|$/);
    });

    it('renders the Max output column from catalog outLimit (Sonnet 5 = 128K)', () => {
      const sonnet = specTable(catalog).find((l) => l.startsWith('| `sonnet`'));
      expect(sonnet.split(' | ')[3]).toBe('128K');
    });

    it('includes every tier id from the catalog', () => {
      const body = specTable(catalog).join('\n');
      for (const tier of catalog.listTiers()) {
        expect(body).toContain(`\`${catalog.getModel(tier).id}\``);
      }
    });
  });

  describe('renderDoc', () => {
    const doc = renderDoc(catalog);

    it('carries the GENERATED do-not-hand-edit header', () => {
      expect(doc).toContain('GENERATED by scripts/gen-model-catalog-docs.js');
      expect(doc).toContain('lib/core/model-catalog.js');
    });

    it('documents the fable constraints from catalog data', () => {
      expect(doc).toContain('claude-fable-5');
      expect(doc).toContain('always-on');
      expect(doc).toContain('refusal');
      for (const key of catalog.getModel('fable').constraints) {
        expect(doc).toContain(key);
      }
    });

    it('derives the effective cost factor from the catalog (no hardcode drift)', () => {
      expect(doc).toContain(`~${catalog.getCostFactor('fable')}×`);
    });

    it('every "price × tokenizer" breakdown multiplies back to getCostFactor(fable)', () => {
      // The headline factor above was catalog-derived while its breakdown was
      // typed by hand ("price 2×"), so after the 2026-09-28 re-price the doc
      // read "~3.25× (price 2× × tokenizer 1.3×)" — a sum that does not add
      // up. Pin the breakdown to the same catalog numbers as the headline.
      const baseline = catalog.getModel(catalog.BASELINE_TIER);
      const fable = catalog.getModel('fable');
      const parts = [...doc.matchAll(/price ([\d.]+)× × tokenizer ([\d.]+)×/g)];
      expect(parts.length).toBe(2); // fable section + routing cost warning
      for (const [, price, tokenizer] of parts) {
        expect(Number(price)).toBe(fable.priceInPerMTok / baseline.priceInPerMTok);
        expect(Number(tokenizer)).toBe(fable.tokenizerCoeff);
        expect(Number(price) * Number(tokenizer))
          .toBeCloseTo(catalog.getCostFactor('fable'), 10);
      }
    });

    it('names the baseline from the catalog, never a retired model name', () => {
      const id = catalog.getModel(catalog.BASELINE_TIER).id;
      expect(doc).toContain(`the \`${catalog.BASELINE_TIER}\` baseline, \`${id}\``);
      expect(doc).not.toContain('Opus 4.8');
      // The label is set off by commas, not a parenthesis, so it never nests
      // inside the parentheses the prose already opens around it.
      expect(doc).not.toContain(`baseline (\`${id}\`)`);
    });

    it('states the routing policy: fable is opt-in, default stays opus', () => {
      expect(doc).toContain('opt-in');
      expect(doc).toContain('Default routing stays **Opus**');
      expect(doc).toContain('deep-async→fable');
    });

    it('contains no stale "fable cannot be a subagent" phrasing', () => {
      expect(doc).not.toMatch(/cannot be a subagent tier/i);
      expect(doc).not.toMatch(/API-only/i);
    });
  });

  describe('price band footnote (derived from the catalog)', () => {
    const banded = catalog
      .listTiers()
      .filter((tier) => catalog.getModel(tier).priceMaxPromptTokens !== null);
    const priceCell = (rows, tier) =>
      rows.find((l) => l.startsWith(`| \`${tier}\``)).split(' | ')[4];

    it('has a banded tier to check, or the assertions below prove nothing', () => {
      expect(banded.length).toBeGreaterThan(0);
    });

    it('marks the price cell of the banded tiers only and lists each with its catalog id and size', () => {
      const rows = specTable(catalog);
      const doc = renderDoc(catalog);
      for (const tier of catalog.listTiers()) {
        const model = catalog.getModel(tier);
        const line = `- \`${tier}\` (\`${model.id}\`): up to `;
        if (banded.includes(tier)) {
          const size = model.priceMaxPromptTokens.toLocaleString('en-US');
          expect(priceCell(rows, tier), tier).toMatch(/ †$/);
          expect(doc, tier).toContain(`${line}${size} tokens.`);
        } else {
          expect(priceCell(rows, tier), tier).not.toContain('†');
          expect(doc, tier).not.toContain(line);
        }
      }
    });

    it('says what a request over the band costs, in the catalog\'s and the receipt writer\'s terms', () => {
      const doc = renderDoc(catalog);
      expect(doc).toContain('input, cache-read and cache-write tokens together');
      expect(doc).toContain('exactly that size is inside the band');
      expect(doc).toContain('its cost is understated');
      expect(doc).toContain('`meta.overPriceBandRequests`');
      expect(doc).toContain(`\`${catalog.PRICING_SOURCE}\``);
    });

    it('what-if: a catalog with no banded tier renders no marker and no note', () => {
      const doc = renderDoc(catalogWith(() => ({ priceMaxPromptTokens: null })));
      expect(doc).not.toContain('†');
      expect(doc).not.toContain('Price band');
      expect(doc).not.toContain('overPriceBandRequests');
    });

    it('what-if: a band on a tier that has none today shows up for that tier, with its own id and size', () => {
      const wider = catalogWith((tier) => (tier === 'sonnet' ? { priceMaxPromptTokens: 200_000 } : {}));
      const doc = renderDoc(wider);
      expect(priceCell(specTable(wider), 'sonnet')).toMatch(/ †$/);
      expect(doc).toContain(`- \`sonnet\` (\`${catalog.getModel('sonnet').id}\`): up to 200,000 tokens.`);
      // The tiers that are banded today keep their own lines.
      for (const tier of banded) {
        const model = catalog.getModel(tier);
        const size = model.priceMaxPromptTokens.toLocaleString('en-US');
        expect(doc).toContain(`- \`${tier}\` (\`${model.id}\`): up to ${size} tokens.`);
      }
    });
  });

  describe('Thinking column legend and per-model notes', () => {
    const noteLine = (doc, tier) =>
      doc.split('\n').find((l) => l.startsWith(`- \`${tier}\` (\`${catalog.getModel(tier).id}\`, `));

    it('THINKING_LEGEND defines exactly the closed vocabulary that the typedef in model-catalog.js names', () => {
      const typedef = catalogSrc.match(/^\s*\*\s+thinkingMode: ('[^']+'(?:\|'[^']+')*),$/m);
      expect(typedef).not.toBeNull();
      const vocabulary = typedef[1].split('|').map((s) => s.slice(1, -1));
      expect(Object.keys(THINKING_LEGEND).sort()).toEqual([...vocabulary].sort());
    });

    it('defines in the doc each value some tier uses, and none that no tier uses', () => {
      const doc = renderDoc(catalog);
      const used = new Set(catalog.listTiers().map((tier) => catalog.getModel(tier).thinkingMode));
      expect(used.size).toBeGreaterThan(0);
      for (const [mode, meaning] of Object.entries(THINKING_LEGEND)) {
        expect(doc.includes(`- \`${mode}\`: ${meaning}.`), mode).toBe(used.has(mode));
      }
    });

    it('what-if: a tier on another value brings that value into the legend', () => {
      const doc = renderDoc(catalogWith((tier) => (tier === 'haiku' ? { thinkingMode: 'extended' } : {})));
      expect(doc).toContain(`- \`extended\`: ${THINKING_LEGEND.extended}.`);
      expect(renderDoc(catalog)).not.toContain('- `extended`: ');
    });

    it('adaptive promises the adaptive shape only: disabling is not in its definition, in the doc or the typedef', () => {
      expect(THINKING_LEGEND.adaptive).toContain('varies per tier');
      expect(THINKING_LEGEND.adaptive).not.toMatch(/can be disabled/);
      // The typedef used to define adaptive as "... and thinking can be disabled",
      // which its own sonnet row contradicted (that row rejects {type:'disabled'}).
      const paragraph = catalogSrc
        .match(/`thinkingMode` names the request shape[\s\S]*?(?=\r?\n \*\r?\n)/)?.[0]
        ?.replace(/\r?\n \* ?/g, ' ');
      expect(paragraph).toBeTruthy();
      expect(paragraph).not.toContain('thinking can be disabled');
      expect(paragraph).toContain('varies per tier');
    });

    it('states the sonnet detail: disabled is rejected and between_tools is the lowest setting', () => {
      const line = noteLine(renderDoc(catalog), 'sonnet');
      expect(line, 'a note for the current sonnet id').toBeDefined();
      expect(line).toContain("rejects `{type:'disabled'}` (400)");
      expect(line).toContain("`{type:'between_tools'}` as its lowest setting");
      expect(line).toContain(`\`${catalog.getModel('sonnet').thinkingMode}\``);
    });

    it('states the haiku detail: disabled is accepted at effort high or below only', () => {
      const line = noteLine(renderDoc(catalog), 'haiku');
      expect(line, 'a note for the current haiku id').toBeDefined();
      expect(line).toContain("accepts `{type:'disabled'}` at effort `high` or below");
      expect(line).toContain('(400 at `xhigh` or `max`)');
    });

    it('what-if: a note is dropped when its tier is on a model id the note was not read for', () => {
      const doc = renderDoc(catalogWith((tier) => (tier === 'sonnet' ? { id: 'claude-sonnet-next' } : {})));
      expect(doc).not.toContain('between_tools');
      // The haiku id did not move, so its note stays.
      expect(doc).toContain("accepts `{type:'disabled'}` at effort `high` or below");
    });

    it('what-if: with no note left the details heading goes too', () => {
      const doc = renderDoc(catalogWith((tier) => ({ id: `${tier}-moved` })));
      expect(doc).not.toContain('Per-model details');
      expect(doc).toContain("The `Thinking` column is each tier's `thinkingMode`");
    });
  });

  describe("per-model thinking notes are the catalog rows' own (one source of truth)", () => {
    it('every note line in the doc reads back equal to its row: tier, id, mode, day and text, in table order', () => {
      const expected = notesOf(catalog);
      // The denominator: with no note on any row the comparison below proves nothing.
      expect(expected.length).toBeGreaterThan(0);
      expect(renderedNotes(renderDoc(catalog))).toEqual(expected);
    });

    it('what-if: with every note null the doc carries none of the real notes and no details heading', () => {
      // A copy typed in the generator survives this, which is the failure it guards.
      const bare = renderDoc(catalogWith(() => ({ thinkingNote: null })));
      expect(bare).not.toContain('Per-model details');
      for (const { tier, text } of notesOf(catalog)) {
        expect(bare, tier).not.toContain(text);
      }
    });

    it('what-if: a replaced note text replaces the line, and the old text is gone', () => {
      const old = catalog.getModel('sonnet').thinkingNote.text;
      const edited = catalogWith((tier) => (tier === 'sonnet' ? noteOf(tier, { text: 'is described by this test instead' }) : {}));
      const doc = renderDoc(edited);
      expect(renderedNotes(doc)).toEqual(notesOf(edited));
      expect(renderedNotes(doc).find((n) => n.tier === 'sonnet').text).toBe('is described by this test instead');
      expect(doc).not.toContain(old);
    });

    it("what-if: a note on a tier that has none appears under that tier's own id, mode and day, in table order", () => {
      const opus = catalog.getModel('opus');
      const added = catalogWith((tier) => (tier === 'opus'
        ? { thinkingNote: { readFor: opus.id, readOn: '2026-01-02', text: 'takes nothing this test knows of' } }
        : {}));
      const notes = renderedNotes(renderDoc(added));
      expect(notes).toEqual(notesOf(added));
      expect(notes.map((n) => n.tier)).toEqual(['opus', 'sonnet', 'haiku']);
      expect(notes[0]).toEqual({
        tier: 'opus', id: opus.id, mode: opus.thinkingMode, readOn: '2026-01-02', text: 'takes nothing this test knows of',
      });
    });

    it('what-if: each line carries the day of its own row', () => {
      const dated = catalogWith((tier) => (tier === 'sonnet' ? noteOf(tier, { readOn: '2026-03-04' }) : {}));
      const days = Object.fromEntries(renderedNotes(renderDoc(dated)).map((n) => [n.tier, n.readOn]));
      expect(days).toEqual({ sonnet: '2026-03-04', haiku: catalog.getModel('haiku').thinkingNote.readOn });
    });

    it("what-if: a note whose readFor is not the row's id is not stated, though the id itself did not move", () => {
      const stale = catalogWith((tier) => (tier === 'haiku' ? noteOf(tier, { readFor: 'claude-haiku-4-5' }) : {}));
      expect(renderedNotes(renderDoc(stale)).map((n) => n.tier)).toEqual(['sonnet']);
    });
  });

  describe('the committed doc', () => {
    it('equals the render of the current catalog, line endings aside', async () => {
      // The generator's --check mode is the same comparison, but as of 2026-10-13
      // nothing else in the repo runs it, so without this an edit to the catalog
      // that forgets to regenerate the doc is green everywhere.
      const onDisk = await readFile(DOC_PATH, 'utf-8');
      expect(checkDoc(renderDoc(catalog), onDisk)).toEqual({ upToDate: true, reason: 'match' });
    });
  });
});
