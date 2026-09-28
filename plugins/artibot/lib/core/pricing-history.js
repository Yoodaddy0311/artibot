/**
 * Pricing history — the price table as it stood under each
 * `PRICING_VERSION` stamp, so a stored cost record can be re-read against the
 * prices that produced it instead of today's.
 *
 * The CURRENT version's row is derived from `model-catalog.js`
 * (`MODELS` + `ID_PRICES`) at load time, so the live price literals still
 * exist in exactly one place. Only PAST versions are literals here, each one
 * frozen from git with the commit that recorded it. When the catalog prices
 * change: append the new stamp to {@link PRICING_VERSIONS} and copy the
 * outgoing row into `FROZEN_ROWS` in the same commit
 * (`tests/core/pricing-history.test.js` goes red on either omission).
 *
 * A row mirrors the RECEIPT resolver (`usage-receipt.js#priceUsage`): tier
 * price rows, the exact ids that resolved to each tier under the stamp, and
 * per-id price rows. It does not record cache-roi's own id heuristics.
 *
 * Design constraints (mirror lib/core/model-catalog.js):
 *   - Imports only `model-catalog.js`; pure lookup, no I/O, no console output
 *   - Never throws; an unknown version is null, never today's prices
 *   - Every exported object is deep-frozen
 *
 * @module lib/core/pricing-history
 */

import {
  getPricing,
  ID_PRICES,
  MODELS,
  PRICING_VERSION,
  ROLE_ALIASES,
} from './model-catalog.js';

/** Catalog field names of one price row (five columns + measured flag). */
const PRICE_FIELDS = Object.freeze([
  'priceInPerMTok',
  'priceOutPerMTok',
  'priceCacheReadPerMTok',
  'priceCacheWrite5mPerMTok',
  'priceCacheWrite1hPerMTok',
  'priceMeasured',
]);

/**
 * Every `PRICING_VERSION` stamp ever issued, oldest first. The last entry is
 * always the current {@link PRICING_VERSION}.
 *
 * @type {readonly string[]}
 */
export const PRICING_VERSIONS = Object.freeze(['2026-09-12', '2026-09-28']);

/**
 * Past rows, frozen from git. Never holds the current version.
 *
 * 2026-09-12: stamp introduced by ebfce23c and replaced by 5820948d. The tier
 * price columns are identical at ebfce23c, f3f2be19, f2947713 and 43a50018,
 * so the stamp names one price set. Its id set moved twice: f2947713 swapped
 * claude-sonnet-4-6 for claude-sonnet-5, and 43a50018 made claude-opus-5-5
 * the opus id with claude-opus-5 as legacy — both still billed at the tier
 * rows below (5 / 25 for opus-5-5 was the live rate, not its official one).
 * Receipts priced by tier only, so there are no per-id rows.
 *
 * Price rows are columns in {@link PRICE_FIELDS} order: in, out, cache read,
 * cache write 5m, cache write 1h (USD per MTok), then the measured flag.
 */
const FROZEN_ROWS = {
  '2026-09-12': {
    tiers: {
      haiku: [1, 5, 0.1, 1.25, 2, true],
      sonnet: [3, 15, 0.3, 3.75, 6, true],
      opus: [5, 25, 0.5, 6.25, 10, true],
      fable: [10, 50, 0.25, 12.5, 20, true],
    },
    ids: {
      'claude-haiku-4-5': 'haiku',
      'claude-sonnet-4-6': 'sonnet',
      'claude-sonnet-5': 'sonnet',
      'claude-opus-5': 'opus',
      'claude-opus-5-5': 'opus',
      'claude-fable-5-1': 'fable',
    },
    idPrices: {},
  },
};

/**
 * Recursively freeze an object and everything under it.
 *
 * @param {*} obj - Value to deep-freeze (non-objects pass through).
 * @returns {*} The same reference, now deeply frozen.
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  for (const value of Object.values(obj)) {
    deepFreeze(value);
  }
  return Object.freeze(obj);
}

/**
 * @param {object} obj
 * @param {unknown} key
 * @returns {boolean} True when `key` is an own property of `obj`.
 */
function own(obj, key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * @param {Record<string, *>} obj
 * @param {Function} fn - Maps one value to its replacement.
 * @returns {Record<string, *>} A new object with the same keys.
 */
function mapValues(obj, fn) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}

/** @param {object} src - A MODELS or ID_PRICES row. */
function pickPrices(src) {
  return Object.fromEntries(PRICE_FIELDS.map((field) => [field, src[field]]));
}

/** @param {Array<number|boolean>} values - Columns in {@link PRICE_FIELDS} order. */
function fromColumns(values) {
  return Object.fromEntries(PRICE_FIELDS.map((field, i) => [field, values[i]]));
}

/** The current version's row, read off the catalog. */
function catalogRow() {
  const tiers = Object.entries(MODELS);
  return {
    tiers: mapValues(MODELS, pickPrices),
    ids: Object.fromEntries(
      tiers.flatMap(([tier, spec]) => [spec.id, ...spec.legacyIds].map((id) => [id, tier])),
    ),
    idPrices: mapValues(ID_PRICES, pickPrices),
  };
}

/** @param {string} version */
function rowFor(version) {
  if (version === PRICING_VERSION) return catalogRow();
  const frozen = FROZEN_ROWS[version];
  if (!frozen) return null;
  return {
    tiers: mapValues(frozen.tiers, fromColumns),
    ids: { ...frozen.ids },
    idPrices: mapValues(frozen.idPrices, fromColumns),
  };
}

/**
 * Version stamp → that version's price row: `{ tiers, ids, idPrices }`, in
 * catalog field names. A listed version with no row maps to null (the gate
 * test turns that red).
 *
 * @type {Readonly<Record<string, Readonly<{
 *   tiers: Readonly<Record<string, Readonly<object>>>,
 *   ids: Readonly<Record<string, string>>,
 *   idPrices: Readonly<Record<string, Readonly<object>>>
 * }>|null>>}
 */
export const PRICING_HISTORY = deepFreeze(
  Object.fromEntries(PRICING_VERSIONS.map((version) => [version, rowFor(version)])),
);

/**
 * Tier named by `key` in a past row: one of the row's OWN tiers, or a role
 * alias. Never the current `MODELS`, so a tier the catalog later drops still
 * resolves for its past rows. Aliases are read live: `ROLE_ALIASES` is the same
 * at ebfce23c, 43a50018 and 5820948d, and an alias whose tier the row lacks
 * resolves to nothing below.
 *
 * @param {object} row - A {@link PRICING_HISTORY} entry.
 * @param {unknown} key
 * @returns {string|null}
 */
function pastTierName(row, key) {
  if (own(row.tiers, key)) return key;
  return own(ROLE_ALIASES, key) ? ROLE_ALIASES[key] : null;
}

/**
 * Price a key against a frozen past row. Same resolution order as
 * `getPricing`: a tier or role first, then an exact id of that stamp. A tier
 * lookup reports `id: null` — a past row records prices per tier, not which
 * id the tier pointed at (that moved within the 2026-09-12 stamp).
 *
 * @param {string} version
 * @param {object} row - A {@link PRICING_HISTORY} entry.
 * @param {unknown} key
 * @returns {Readonly<object>|null}
 */
function pastPricing(version, row, key) {
  const namedTier = pastTierName(row, key);
  const tier = namedTier ?? (own(row.ids, key) ? row.ids[key] : null);
  if (!own(row.tiers, tier)) return null;
  const id = namedTier === null ? key : null;
  const prices = own(row.idPrices, id) ? row.idPrices[id] : row.tiers[tier];
  return Object.freeze({
    tier,
    id,
    input: prices.priceInPerMTok,
    output: prices.priceOutPerMTok,
    cacheRead: prices.priceCacheReadPerMTok,
    cacheWrite5m: prices.priceCacheWrite5mPerMTok,
    cacheWrite1h: prices.priceCacheWrite1hPerMTok,
    measured: prices.priceMeasured,
    version,
  });
}

/**
 * `getPricing` as of a given `PRICING_VERSION`. At the current version it IS
 * `getPricing(key)`. At a past version it prices from that stamp's frozen
 * row. Any version the history does not hold — including `'unresolved'`, a
 * non-string, or a date that was never a stamp — returns null: falling back to
 * today's prices would make the history lie. Never throws.
 *
 * @param {unknown} version - A `PRICING_VERSION` stamp.
 * @param {unknown} key - A ROLE_ALIASES key, a tier key, or an exact model id.
 * @returns {Readonly<{
 *   tier: string, id: string|null, input: number, output: number,
 *   cacheRead: number, cacheWrite5m: number, cacheWrite1h: number,
 *   measured: boolean, version: string
 * }>|null} Frozen pricing record, or null.
 *
 * @example
 * getPricingAt('2026-09-12', 'claude-opus-5-5'); // { tier: 'opus', input: 5, ... }
 * getPricingAt('unresolved', 'opus'); // null
 */
export function getPricingAt(version, key) {
  if (!own(PRICING_HISTORY, version) || PRICING_HISTORY[version] === null) return null;
  if (version === PRICING_VERSION) return getPricing(key);
  return pastPricing(version, PRICING_HISTORY[version], key);
}

/**
 * The price row a stored usage receipt was billed with, looked up by its own
 * `cost.pricing_version`. Mirrors `usage-receipt.js#priceUsage`: the model
 * id's row when that id belongs to the receipt's tier under the stamp, the
 * tier's row otherwise. null for an unpriced (`'unresolved'`), unknown,
 * missing or malformed stamp or tier — never today's prices. Never throws.
 *
 * @param {unknown} receipt - A usage receipt (`cost`, `model_identity`).
 * @returns {Readonly<object>|null} Frozen pricing record, or null.
 */
export function pricingForReceipt(receipt) {
  const version = receipt?.cost?.pricing_version;
  const tier = receipt?.model_identity?.tier;
  const modelId = receipt?.model_identity?.model_id;
  if (typeof tier !== 'string' || tier.length === 0) return null;
  const byId = typeof modelId === 'string' ? getPricingAt(version, modelId) : null;
  if (byId !== null && byId.tier === tier && byId.id === modelId) return byId;
  return getPricingAt(version, tier);
}
