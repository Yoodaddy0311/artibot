/**
 * Core orchestration engine for visual validation.
 * Compares baseline screenshots against actual renders and suggests CSS fixes.
 * Does NOT directly invoke Playwright — returns structured tool instructions
 * that can be dispatched via MCP at runtime.
 * @module lib/visual/visual-validator
 */

import { compareScreenshots } from './screenshot-differ.js';
import { analyzeDiffRegions, generateFixTasks } from './style-fixer.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default validation options */
const DEFAULTS = {
  maxIterations: 3,
  threshold: 0.95,
  disableAnimations: true,
  excludeSelectors: [],
};

// ---------------------------------------------------------------------------
// Playwright MCP Instruction Builders
// ---------------------------------------------------------------------------

/**
 * Build a Playwright MCP navigate instruction.
 * @param {string} url - Target URL
 * @returns {{tool: string, params: object}}
 */
function buildNavigateInstruction(url) {
  return { tool: 'playwright_navigate', params: { url } };
}

/**
 * Build a Playwright MCP screenshot instruction.
 * @param {string} name - Screenshot name/identifier
 * @param {string} [selector] - Optional CSS selector to scope the screenshot
 * @returns {{tool: string, params: object}}
 */
function buildScreenshotInstruction(name, selector) {
  const params = { name, storeBase64: true };
  if (selector) params.selector = selector;
  return { tool: 'playwright_screenshot', params };
}

/**
 * Build a Playwright MCP evaluate instruction to disable CSS animations.
 * @returns {{tool: string, params: object}}
 */
function buildDisableAnimationsInstruction() {
  return {
    tool: 'playwright_evaluate',
    params: {
      script: [
        'const style = document.createElement("style");',
        'style.textContent = "*, *::before, *::after { animation-duration: 0s !important;',
        ' transition-duration: 0s !important; animation-delay: 0s !important; }";',
        'document.head.appendChild(style);',
      ].join(' '),
    },
  };
}

/**
 * Build a Playwright MCP evaluate instruction to hide excluded selectors.
 * @param {string[]} selectors - CSS selectors to hide
 * @returns {{tool: string, params: object}|null}
 */
function buildHideSelectorsInstruction(selectors) {
  if (!selectors || selectors.length === 0) return null;
  const escaped = selectors.map((s) => s.replace(/"/g, '\\"')).join(', ');
  return {
    tool: 'playwright_evaluate',
    params: {
      script: `document.querySelectorAll("${escaped}").forEach(el => el.style.visibility = 'hidden');`,
    },
  };
}

// ---------------------------------------------------------------------------
// Image Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize image input to a pixel data descriptor.
 * Accepts Buffer, base64 string, or a pre-parsed descriptor.
 * When given Buffer/base64, dimensions must be provided via metadata.
 * @param {Buffer|string|{pixels: Uint8Array|number[], width: number, height: number}} image
 * @param {{width?: number, height?: number}} [meta]
 * @returns {{pixels: Uint8Array|number[], width: number, height: number}}
 */
function normalizeImage(image, meta = {}) {
  if (image && typeof image === 'object' && 'pixels' in image) {
    return image;
  }

  let rawBytes;
  if (Buffer.isBuffer(image)) {
    rawBytes = image;
  } else if (typeof image === 'string') {
    // Assume base64-encoded raw RGBA
    rawBytes = Buffer.from(image, 'base64');
  } else {
    throw new TypeError('Invalid image input: expected Buffer, base64 string, or pixel descriptor');
  }

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  return { pixels: new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength), width, height };
}

// ---------------------------------------------------------------------------
// Core Validation Logic
// ---------------------------------------------------------------------------

/**
 * Run a single validation iteration comparing baseline to actual.
 * @param {{pixels: Uint8Array|number[], width: number, height: number}} baselineData
 * @param {{pixels: Uint8Array|number[], width: number, height: number}} actualData
 * @param {number} threshold - Similarity threshold to pass (0-1)
 * @param {object} [metadata] - Extra context for fix suggestions
 * @returns {{passed: boolean, similarity: number, diffRegions: object[], fixSuggestions: object[]}}
 */
function runValidationIteration(baselineData, actualData, threshold, metadata) {
  const { similarity, diffRegions } = compareScreenshots(baselineData, actualData);
  const passed = similarity >= threshold;
  const fixSuggestions = passed ? [] : analyzeDiffRegions(diffRegions, metadata);

  return { passed, similarity, diffRegions, fixSuggestions };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a UI component against a baseline screenshot.
 *
 * When `baselineImage` and `actualImage` are provided as pixel descriptors,
 * performs the comparison directly. Otherwise returns Playwright MCP tool
 * instructions needed to capture the actual screenshot at runtime.
 *
 * @param {object} options
 * @param {string} [options.url] - URL to navigate to for live capture
 * @param {string} [options.selector] - CSS selector scoping the component
 * @param {Buffer|string|{pixels: Uint8Array|number[], width: number, height: number}} [options.baselineImage] - Baseline image
 * @param {Buffer|string|{pixels: Uint8Array|number[], width: number, height: number}} [options.actualImage] - Actual screenshot
 * @param {number} [options.maxIterations=3] - Max fix-attempt iterations
 * @param {number} [options.threshold=0.95] - Similarity threshold (0-1)
 * @param {boolean} [options.disableAnimations=true] - Disable CSS animations before capture
 * @param {string[]} [options.excludeSelectors=[]] - Selectors to hide before capture
 * @param {{width?: number, height?: number}} [options.imageMeta] - Dimensions when using Buffer/base64
 * @returns {{
 *   passed: boolean,
 *   similarity: number,
 *   diffRegions: object[],
 *   fixSuggestions: object[],
 *   fixTasks: object[],
 *   iterations: number,
 *   playwrightInstructions?: object[]
 * }}
 */
export function validateComponent(options = {}) {
  const {
    url,
    selector,
    baselineImage,
    actualImage,
    maxIterations = DEFAULTS.maxIterations,
    threshold = DEFAULTS.threshold,
    disableAnimations = DEFAULTS.disableAnimations,
    excludeSelectors = DEFAULTS.excludeSelectors,
    imageMeta = {},
  } = options;

  // If no actual image provided, return Playwright instructions for live capture
  if (!actualImage) {
    const instructions = buildCaptureInstructions({ url, selector, disableAnimations, excludeSelectors });
    return {
      passed: false,
      similarity: 0,
      diffRegions: [],
      fixSuggestions: [],
      fixTasks: [],
      iterations: 0,
      playwrightInstructions: instructions,
    };
  }

  if (!baselineImage) {
    throw new Error('baselineImage is required when actualImage is provided');
  }

  const baselineData = normalizeImage(baselineImage, imageMeta);
  const actualData = normalizeImage(actualImage, imageMeta);
  const metadata = { selector, ...imageMeta };

  const result = runValidationIteration(baselineData, actualData, threshold, metadata);
  let iterations = 1;

  // Iteration loop (for future integration where fixes are applied between runs)
  while (!result.passed && iterations < maxIterations) {
    // Without a live browser, we can only re-run the same comparison.
    // In practice, the caller applies fix suggestions between iterations.
    iterations++;
    // Break early if subsequent iterations would be identical
    break;
  }

  const fixTasks = result.passed ? [] : generateFixTasks(result.fixSuggestions);

  return {
    passed: result.passed,
    similarity: result.similarity,
    diffRegions: result.diffRegions,
    fixSuggestions: result.fixSuggestions,
    fixTasks,
    iterations,
  };
}

/**
 * Validate a full page against a baseline screenshot.
 * Equivalent to validateComponent but scoped to the full viewport.
 * @param {object} options - Same options as validateComponent (selector defaults to null)
 * @returns {object} Same return shape as validateComponent
 */
export function validatePage(options = {}) {
  return validateComponent({ ...options, selector: undefined });
}

/**
 * Create a baseline descriptor from a provided image.
 * Returns Playwright instructions to capture a new baseline if no image given.
 * @param {object} options
 * @param {string} [options.url] - URL to capture baseline from
 * @param {string} [options.selector] - CSS selector to scope
 * @param {Buffer|string} [options.image] - Existing baseline image (skip capture)
 * @param {boolean} [options.disableAnimations=true]
 * @param {string[]} [options.excludeSelectors=[]]
 * @returns {{playwrightInstructions?: object[], baseline?: object}}
 */
export function createBaseline(options = {}) {
  const {
    url,
    selector,
    image,
    disableAnimations = DEFAULTS.disableAnimations,
    excludeSelectors = DEFAULTS.excludeSelectors,
  } = options;

  if (image) {
    return {
      baseline: {
        image,
        selector: selector ?? null,
        createdAt: new Date().toISOString(),
      },
    };
  }

  const instructions = buildCaptureInstructions({ url, selector, disableAnimations, excludeSelectors, name: 'baseline' });
  return { playwrightInstructions: instructions };
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Build the ordered list of Playwright MCP instructions needed to capture
 * a screenshot of the target URL/selector with optional animation suppression.
 * @param {object} opts
 * @param {string} [opts.url]
 * @param {string} [opts.selector]
 * @param {boolean} [opts.disableAnimations]
 * @param {string[]} [opts.excludeSelectors]
 * @param {string} [opts.name]
 * @returns {Array<{tool: string, params: object}>}
 */
function buildCaptureInstructions({ url, selector, disableAnimations, excludeSelectors, name = 'actual' }) {
  const instructions = [];

  if (url) {
    instructions.push(buildNavigateInstruction(url));
  }

  if (disableAnimations) {
    instructions.push(buildDisableAnimationsInstruction());
  }

  const hideInstruction = buildHideSelectorsInstruction(excludeSelectors);
  if (hideInstruction) {
    instructions.push(hideInstruction);
  }

  instructions.push(buildScreenshotInstruction(name, selector));

  return instructions;
}
