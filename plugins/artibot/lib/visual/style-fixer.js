/**
 * Analyze diff regions and generate CSS fix suggestions.
 * Categorizes visual differences and produces actionable remediation tasks.
 * @module lib/visual/style-fixer
 */

// ---------------------------------------------------------------------------
// Category Detection
// ---------------------------------------------------------------------------

/** Aspect ratio thresholds for shape classification */
const ASPECT_RATIO = {
  THIN_STRIP: 5, // width/height or height/width > 5 → strip
  LARGE_AREA: 100 * 100, // area threshold for "large" blocks
};

/**
 * Determine the category of a visual diff region based on its geometry.
 * @param {{x: number, y: number, width: number, height: number, pixelCount: number, severity: string}} region
 * @returns {'spacing'|'color'|'typography'|'alignment'|'size'|'visibility'}
 */
export function categorizeIssue(region) {
  const { x, y, width, height, pixelCount } = region;
  const area = width * height;
  const aspectRatio = height === 0 ? Infinity : width / height;
  const inverseRatio = width === 0 ? Infinity : height / width;

  // Thin horizontal strip → spacing or alignment issue
  if (aspectRatio >= ASPECT_RATIO.THIN_STRIP) return 'spacing';

  // Thin vertical strip → alignment issue
  if (inverseRatio >= ASPECT_RATIO.THIN_STRIP) return 'alignment';

  // Large solid color block → color or background change
  if (area >= ASPECT_RATIO.LARGE_AREA && pixelCount / area > 0.6) return 'color';

  // Small scattered changes → typography / font rendering
  if (area < 500 && pixelCount < 200) return 'typography';

  // Edge regions (within 20px of a border) → border, shadow, or overflow
  const isEdge = x < 20 || y < 20;
  if (isEdge) return 'alignment';

  // Default: size / layout difference
  return 'size';
}

// ---------------------------------------------------------------------------
// Fix Suggestion Generation
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable description for a fix suggestion.
 * @param {'spacing'|'color'|'typography'|'alignment'|'size'|'visibility'} category
 * @param {{x: number, y: number, width: number, height: number}} region
 * @returns {string}
 */
function describeIssue(category, region) {
  const loc = `at (${region.x}, ${region.y})`;
  switch (category) {
    case 'spacing':
      return `Unexpected spacing or padding difference ${loc} — check margin/padding values`;
    case 'color':
      return `Color or background mismatch in ${region.width}×${region.height}px block ${loc}`;
    case 'typography':
      return `Font rendering or text content difference ${loc} — check font-family, size, or weight`;
    case 'alignment':
      return `Alignment offset detected ${loc} — check flexbox, grid, or position values`;
    case 'size':
      return `Element size difference in ${region.width}×${region.height}px area ${loc}`;
    case 'visibility':
      return `Visibility or opacity difference ${loc} — check display, visibility, or z-index`;
    default:
      return `Visual difference detected ${loc}`;
  }
}

/**
 * Infer a plausible CSS selector for a diff region based on its position.
 * Returns a generic positional selector when no metadata is available.
 * @param {{x: number, y: number, width: number, height: number}} region
 * @param {object} [metadata]
 * @param {string} [metadata.selector] - Known CSS selector for the component under test
 * @returns {string}
 */
function inferSelector(region, metadata) {
  if (metadata?.selector) return metadata.selector;

  // Positional heuristic: top 10% of typical viewport → header region
  const viewportHeight = metadata?.viewportHeight ?? 800;
  const viewportWidth = metadata?.viewportWidth ?? 1280;

  if (region.y < viewportHeight * 0.1) return 'header, [role="banner"]';
  if (region.y > viewportHeight * 0.9) return 'footer, [role="contentinfo"]';
  if (region.x < viewportWidth * 0.15) return 'nav, aside, [role="navigation"]';
  if (region.x > viewportWidth * 0.85) return 'aside, [role="complementary"]';
  return 'main, [role="main"]';
}

/**
 * Analyze diff regions and produce an array of fix suggestions.
 * @param {Array<{x: number, y: number, width: number, height: number, severity: string, pixelCount: number}>} diffRegions
 * @param {object} [metadata] - Optional context for selector inference
 * @param {string} [metadata.selector] - CSS selector for the tested component
 * @param {number} [metadata.viewportHeight] - Viewport height in pixels
 * @param {number} [metadata.viewportWidth] - Viewport width in pixels
 * @returns {Array<{selector: string, category: string, description: string, severity: string, region: object}>}
 */
export function analyzeDiffRegions(diffRegions, metadata = {}) {
  if (!Array.isArray(diffRegions) || diffRegions.length === 0) return [];

  return diffRegions.map((region) => {
    const category = categorizeIssue(region);
    return {
      selector: inferSelector(region, metadata),
      category,
      description: describeIssue(category, region),
      severity: region.severity ?? 'low',
      region: {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Task Generation
// ---------------------------------------------------------------------------

/** Priority mapping from severity to numeric task priority */
const PRIORITY = {
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Convert fix suggestions into actionable task objects for the agent queue.
 * Groups suggestions by category and severity for efficient remediation.
 * @param {Array<{selector: string, category: string, description: string, severity: string, region: object}>} fixSuggestions
 * @returns {Array<{id: string, title: string, selector: string, category: string, severity: string, description: string, priority: number, regions: object[]}>}
 */
export function generateFixTasks(fixSuggestions) {
  if (!Array.isArray(fixSuggestions) || fixSuggestions.length === 0) return [];

  // Group by category + severity for deduplication
  const groups = new Map();
  for (const suggestion of fixSuggestions) {
    const key = `${suggestion.category}::${suggestion.severity}::${suggestion.selector}`;
    if (!groups.has(key)) {
      groups.set(key, {
        ...suggestion,
        regions: [suggestion.region],
      });
    } else {
      const existing = groups.get(key);
      groups.set(key, {
        ...existing,
        regions: [...existing.regions, suggestion.region],
      });
    }
  }

  const tasks = [...groups.values()].map((group, index) => ({
    id: `fix_${group.category}_${index}_${Date.now()}`,
    title: `Fix ${group.category} issue in ${group.selector}`,
    selector: group.selector,
    category: group.category,
    severity: group.severity,
    description: group.description,
    priority: PRIORITY[group.severity] ?? 3,
    regions: group.regions,
  }));

  // Sort by priority (high → low)
  return tasks.sort((a, b) => a.priority - b.priority);
}
