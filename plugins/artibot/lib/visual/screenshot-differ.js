/**
 * Pure JS screenshot comparison using SSIM (Structural Similarity Index).
 * Zero runtime dependencies - works with raw RGBA pixel arrays.
 * @module lib/visual/screenshot-differ
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SSIM stability constants (based on L=255 dynamic range) */
const C1 = (0.01 * 255) ** 2; // 6.5025
const C2 = (0.03 * 255) ** 2; // 58.5225

/** Window size for SSIM computation */
const WINDOW_SIZE = 8;

/** Pixel distance threshold for diff region merging */
const MERGE_DISTANCE = 10;

/** Severity thresholds (fraction of window pixels changed) */
const SEVERITY = {
  HIGH: 0.5,
  MEDIUM: 0.2,
};

// ---------------------------------------------------------------------------
// SSIM Implementation
// ---------------------------------------------------------------------------

/**
 * Extract grayscale luminance from RGBA pixel array at a given position.
 * Uses BT.601 luma coefficients.
 * @param {Uint8Array|number[]} pixels - RGBA pixel array
 * @param {number} x - Column index
 * @param {number} y - Row index
 * @param {number} width - Image width in pixels
 * @returns {number} Luminance value 0-255
 */
function getLuminance(pixels, x, y, width) {
  const idx = (y * width + x) * 4;
  const r = pixels[idx] ?? 0;
  const g = pixels[idx + 1] ?? 0;
  const b = pixels[idx + 2] ?? 0;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Extract an 8x8 window of luminance values from a pixel array.
 * Clamps to image boundaries (edge replication).
 * @param {Uint8Array|number[]} pixels - RGBA pixel array
 * @param {number} startX - Window top-left column
 * @param {number} startY - Window top-left row
 * @param {number} imgWidth - Image width in pixels
 * @param {number} imgHeight - Image height in pixels
 * @returns {number[]} Array of WINDOW_SIZE*WINDOW_SIZE luminance values
 */
function extractWindow(pixels, startX, startY, imgWidth, imgHeight) {
  const values = [];
  for (let dy = 0; dy < WINDOW_SIZE; dy++) {
    for (let dx = 0; dx < WINDOW_SIZE; dx++) {
      const x = Math.min(startX + dx, imgWidth - 1);
      const y = Math.min(startY + dy, imgHeight - 1);
      values.push(getLuminance(pixels, x, y, imgWidth));
    }
  }
  return values;
}

/**
 * Compute mean of an array of numbers.
 * @param {number[]} values
 * @returns {number}
 */
function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Compute variance of an array of numbers.
 * @param {number[]} values
 * @param {number} mu - Pre-computed mean
 * @returns {number}
 */
function variance(values, mu) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + (v - mu) ** 2, 0) / values.length;
}

/**
 * Compute covariance between two arrays of numbers.
 * @param {number[]} a
 * @param {number[]} b
 * @param {number} muA - Mean of a
 * @param {number} muB - Mean of b
 * @returns {number}
 */
function covariance(a, b, muA, muB) {
  if (a.length === 0) return 0;
  return a.reduce((sum, ai, i) => sum + (ai - muA) * (b[i] - muB), 0) / a.length;
}

/**
 * Compute SSIM for a single 8x8 window pair.
 * SSIM(x,y) = (2μxμy + C1)(2σxy + C2) / (μx² + μy² + C1)(σx² + σy² + C2)
 * @param {number[]} winA - Window luminance values from image A
 * @param {number[]} winB - Window luminance values from image B
 * @returns {number} SSIM value in range [-1, 1]
 */
function computeWindowSSIM(winA, winB) {
  const muA = mean(winA);
  const muB = mean(winB);
  const varA = variance(winA, muA);
  const varB = variance(winB, muB);
  const cov = covariance(winA, winB, muA, muB);

  const numerator = (2 * muA * muB + C1) * (2 * cov + C2);
  const denominator = (muA ** 2 + muB ** 2 + C1) * (varA + varB + C2);

  if (denominator === 0) return 1; // identical black windows
  return numerator / denominator;
}

/**
 * Calculate SSIM index between two images represented as RGBA pixel arrays.
 * Uses sliding 8x8 windows stepping every 4 pixels for performance.
 * @param {Uint8Array|number[]} img1Data - RGBA pixel array for image 1
 * @param {Uint8Array|number[]} img2Data - RGBA pixel array for image 2
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @returns {number} SSIM score 0-1 (1 = identical, 0 = completely different)
 */
export function calculateSSIM(img1Data, img2Data, width, height) {
  if (width === 0 || height === 0) return 1;

  const step = Math.max(1, Math.floor(WINDOW_SIZE / 2));
  let totalSSIM = 0;
  let count = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const winA = extractWindow(img1Data, x, y, width, height);
      const winB = extractWindow(img2Data, x, y, width, height);
      const ssim = computeWindowSSIM(winA, winB);
      totalSSIM += ssim;
      count++;
    }
  }

  if (count === 0) return 1;
  // Clamp to [0, 1] — SSIM can theoretically go negative
  return Math.max(0, Math.min(1, totalSSIM / count));
}

// ---------------------------------------------------------------------------
// Diff Map Generation
// ---------------------------------------------------------------------------

/**
 * Compute per-pixel difference magnitude between two RGBA images.
 * Returns a 2D boolean map of "significantly different" pixels.
 * @param {Uint8Array|number[]} img1Data - RGBA pixel array
 * @param {Uint8Array|number[]} img2Data - RGBA pixel array
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} [pixelThreshold=10] - Min per-channel diff to flag a pixel
 * @returns {boolean[][]} 2D array [y][x] = true if pixel differs
 */
function buildDiffPixelMap(img1Data, img2Data, width, height, pixelThreshold = 10) {
  const diffMap = Array.from({ length: height }, () => new Array(width).fill(false));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const dr = Math.abs((img1Data[idx] ?? 0) - (img2Data[idx] ?? 0));
      const dg = Math.abs((img1Data[idx + 1] ?? 0) - (img2Data[idx + 1] ?? 0));
      const db = Math.abs((img1Data[idx + 2] ?? 0) - (img2Data[idx + 2] ?? 0));
      diffMap[y][x] = dr + dg + db > pixelThreshold;
    }
  }

  return diffMap;
}

/**
 * BFS context bundled for neighbor-enqueuing.
 * @typedef {object} BfsContext
 * @property {number} width - Image width
 * @property {number} height - Image height
 * @property {boolean[][]} diffMap - 2D diff pixel map
 * @property {boolean[][]} visited - 2D visited map (mutated in place)
 * @property {number[][]} queue - BFS queue (mutated in place)
 */

/**
 * Enqueue unvisited diff neighbors of a pixel into the BFS queue.
 * @param {number} cx - Current pixel column
 * @param {number} cy - Current pixel row
 * @param {BfsContext} ctx - BFS state context
 */
function enqueueNeighbors(cx, cy, ctx) {
  const { width, height, diffMap, visited, queue } = ctx;
  const neighbors = [
    [cx - 1, cy], [cx + 1, cy],
    [cx, cy - 1], [cx, cy + 1],
  ];
  for (const [nx, ny] of neighbors) {
    if (nx >= 0 && nx < width && ny >= 0 && ny < height
      && diffMap[ny][nx] && !visited[ny][nx]) {
      visited[ny][nx] = true;
      queue.push([nx, ny]);
    }
  }
}

/**
 * Find connected regions of differing pixels using flood-fill BFS.
 * @param {boolean[][]} diffMap - 2D boolean diff pixel map
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {Array<{x: number, y: number, width: number, height: number, pixelCount: number}>}
 */
function findConnectedRegions(diffMap, width, height) {
  const visited = Array.from({ length: height }, () => new Array(width).fill(false));
  const regions = [];

  for (let startY = 0; startY < height; startY++) {
    for (let startX = 0; startX < width; startX++) {
      if (!diffMap[startY][startX] || visited[startY][startX]) continue;

      // BFS flood fill
      const queue = [[startX, startY]];
      visited[startY][startX] = true;
      const ctx = { width, height, diffMap, visited, queue };
      let minX = startX, maxX = startX, minY = startY, maxY = startY;
      let pixelCount = 0;

      while (queue.length > 0) {
        const [cx, cy] = queue.shift();
        pixelCount++;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);

        enqueueNeighbors(cx, cy, ctx);
      }

      regions.push({
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        pixelCount,
      });
    }
  }

  return regions;
}

/**
 * Merge nearby regions within MERGE_DISTANCE pixels of each other.
 * Uses iterative nearest-neighbor merging.
 * @param {Array<object>} regions - Raw connected regions
 * @returns {Array<object>} Merged regions
 */
function mergeNearbyRegions(regions) {
  if (regions.length === 0) return [];

  let merged = regions.map((r) => ({ ...r }));
  let changed = true;

  while (changed) {
    changed = false;
    const result = [];
    const used = new Array(merged.length).fill(false);

    for (let i = 0; i < merged.length; i++) {
      if (used[i]) continue;
      let current = merged[i];

      for (let j = i + 1; j < merged.length; j++) {
        if (used[j]) continue;
        const other = merged[j];

        // Check if bounding boxes are within MERGE_DISTANCE
        const hDist = Math.max(0,
          Math.max(current.x, other.x) - Math.min(current.x + current.width, other.x + other.width),
        );
        const vDist = Math.max(0,
          Math.max(current.y, other.y) - Math.min(current.y + current.height, other.y + other.height),
        );

        if (hDist <= MERGE_DISTANCE && vDist <= MERGE_DISTANCE) {
          const newX = Math.min(current.x, other.x);
          const newY = Math.min(current.y, other.y);
          const newMaxX = Math.max(current.x + current.width, other.x + other.width);
          const newMaxY = Math.max(current.y + current.height, other.y + other.height);
          current = {
            x: newX,
            y: newY,
            width: newMaxX - newX,
            height: newMaxY - newY,
            pixelCount: current.pixelCount + other.pixelCount,
          };
          used[j] = true;
          changed = true;
        }
      }
      result.push(current);
    }
    merged = result;
  }

  return merged;
}

/**
 * Assign severity level to a diff region based on pixel density.
 * @param {{width: number, height: number, pixelCount: number}} region
 * @returns {'low'|'medium'|'high'}
 */
function assignSeverity(region) {
  const area = region.width * region.height;
  if (area === 0) return 'low';
  const density = region.pixelCount / area;
  if (density >= SEVERITY.HIGH) return 'high';
  if (density >= SEVERITY.MEDIUM) return 'medium';
  return 'low';
}

/**
 * Generate a diff map with annotated regions from two RGBA pixel arrays.
 * @param {Uint8Array|number[]} img1Data - RGBA pixel array for baseline image
 * @param {Uint8Array|number[]} img2Data - RGBA pixel array for actual image
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @returns {{diffRegions: Array<{x: number, y: number, width: number, height: number, severity: string, pixelCount: number}>}}
 */
export function generateDiffMap(img1Data, img2Data, width, height) {
  if (width === 0 || height === 0) return { diffRegions: [] };

  const diffPixelMap = buildDiffPixelMap(img1Data, img2Data, width, height);
  const rawRegions = findConnectedRegions(diffPixelMap, width, height);
  const mergedRegions = mergeNearbyRegions(rawRegions);

  const diffRegions = mergedRegions
    .filter((r) => r.pixelCount > 0)
    .map((r) => ({
      ...r,
      severity: assignSeverity(r),
    }));

  return { diffRegions };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compare two screenshots and return similarity metrics.
 * Both inputs should be raw RGBA pixel arrays of the same dimensions.
 * @param {{pixels: Uint8Array|number[], width: number, height: number}} baseline - Baseline image data
 * @param {{pixels: Uint8Array|number[], width: number, height: number}} actual - Actual screenshot data
 * @returns {{similarity: number, diffRegions: Array<object>, diffPixelCount: number}}
 */
export function compareScreenshots(baseline, actual) {
  const { pixels: basePixels, width, height } = baseline;
  const { pixels: actualPixels } = actual;

  if (width === 0 || height === 0) {
    return { similarity: 1, diffRegions: [], diffPixelCount: 0 };
  }

  const similarity = calculateSSIM(basePixels, actualPixels, width, height);
  const { diffRegions } = generateDiffMap(basePixels, actualPixels, width, height);
  const diffPixelCount = diffRegions.reduce((sum, r) => sum + r.pixelCount, 0);

  return { similarity, diffRegions, diffPixelCount };
}
