/**
 * Federated Averaging (FedAvg) - Server-side weight merging.
 *
 * Implements the core Federated Learning aggregation algorithm.
 * Merges weights from multiple clients into a single global model,
 * weighted by each client's sample size.
 *
 * @module server/merge
 */

// ---------------------------------------------------------------------------
// Federated Averaging
// ---------------------------------------------------------------------------

/**
 * Merge multiple client weight snapshots into a single global weight set.
 *
 * Uses sample-size-weighted averaging (FedAvg algorithm).
 * Clients with more samples have proportionally more influence.
 *
 * @param {object[]} snapshots - Array of { weights, metadata } from clients
 * @returns {object} Merged global weights
 */
export function federatedAverage(snapshots) {
  if (!snapshots || snapshots.length === 0) return {};
  if (snapshots.length === 1) return snapshots[0].weights;

  const categories = ['tools', 'errors', 'commands', 'teams'];
  const merged = {};

  for (const category of categories) {
    merged[category] = {};

    // Collect all keys across all snapshots for this category
    const allKeys = new Set();
    for (const snap of snapshots) {
      const cat = snap.weights?.[category];
      if (cat) {
        for (const key of Object.keys(cat)) {
          allKeys.add(key);
        }
      }
    }

    // For each key, compute weighted average
    for (const key of allKeys) {
      const entries = [];
      let totalSamples = 0;

      for (const snap of snapshots) {
        const entry = snap.weights?.[category]?.[key];
        if (entry) {
          const sampleSize = entry.sampleSize ?? 1;
          entries.push({ entry, sampleSize });
          totalSamples += sampleSize;
        }
      }

      if (entries.length === 0) continue;
      if (totalSamples === 0) totalSamples = entries.length;

      merged[category][key] = weightedAverageEntry(entries, totalSamples);
    }
  }

  return merged;
}

/**
 * Compute weighted average of a single weight entry across clients.
 *
 * @param {{ entry: object, sampleSize: number }[]} entries
 * @param {number} totalSamples
 * @returns {object}
 */
function weightedAverageEntry(entries, totalSamples) {
  const result = {};
  const allFields = new Set();

  for (const { entry } of entries) {
    for (const field of Object.keys(entry)) {
      allFields.add(field);
    }
  }

  for (const field of allFields) {
    if (field === 'sampleSize') {
      // Sum sample sizes
      result.sampleSize = entries.reduce((sum, e) => sum + (e.entry.sampleSize ?? 0), 0);
      continue;
    }

    const numericValues = entries
      .filter((e) => typeof e.entry[field] === 'number')
      .map((e) => ({ value: e.entry[field], weight: e.sampleSize / totalSamples }));

    if (numericValues.length > 0) {
      // Weighted average for numeric fields
      result[field] = round(
        numericValues.reduce((sum, v) => sum + v.value * v.weight, 0),
      );
    } else {
      // Non-numeric: take from the entry with the most samples
      const best = entries.reduce((a, b) => (a.sampleSize >= b.sampleSize ? a : b));
      if (best.entry[field] !== undefined) {
        result[field] = best.entry[field];
      }
    }
  }

  return result;
}

/**
 * Round to 4 decimal places.
 *
 * @param {number} n
 * @returns {number}
 */
function round(n) {
  return Math.round(n * 10000) / 10000;
}
