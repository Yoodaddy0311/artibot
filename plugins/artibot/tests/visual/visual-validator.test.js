import { describe, expect, it } from 'vitest';
import {
  createBaseline,
  validateComponent,
  validatePage,
} from '../../lib/visual/visual-validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a solid-color RGBA pixel descriptor.
 */
function solidDescriptor(width, height, [r, g, b, a = 255]) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = a;
  }
  return { pixels, width, height };
}

/**
 * Copy a descriptor's pixels and flip a patch region to a different color.
 * @param {object} opts
 * @param {object} opts.descriptor - Image descriptor with pixels, width, height
 * @param {number} opts.patchX - Patch top-left column
 * @param {number} opts.patchY - Patch top-left row
 * @param {number} opts.patchW - Patch width
 * @param {number} opts.patchH - Patch height
 * @param {[number,number,number]} opts.color - RGB replacement color
 */
function withPatch({ descriptor, patchX, patchY, patchW, patchH, color: [r, g, b] }) {
  const { pixels, width, height } = descriptor;
  const patched = new Uint8Array(pixels);
  for (let y = patchY; y < patchY + patchH; y++) {
    for (let x = patchX; x < patchX + patchW; x++) {
      const idx = (y * width + x) * 4;
      patched[idx] = r;
      patched[idx + 1] = g;
      patched[idx + 2] = b;
    }
  }
  return { pixels: patched, width, height };
}

// ---------------------------------------------------------------------------
// validateComponent — no actual image (returns Playwright instructions)
// ---------------------------------------------------------------------------

describe('validateComponent() — no actualImage', () => {
  it('returns playwrightInstructions when no actualImage provided', () => {
    const result = validateComponent({ url: 'https://example.com' });
    expect(result).toHaveProperty('playwrightInstructions');
    expect(Array.isArray(result.playwrightInstructions)).toBe(true);
    expect(result.playwrightInstructions.length).toBeGreaterThan(0);
  });

  it('includes navigate instruction when url is provided', () => {
    const result = validateComponent({ url: 'https://example.com' });
    const navInstr = result.playwrightInstructions.find((i) => i.tool === 'playwright_navigate');
    expect(navInstr).toBeDefined();
    expect(navInstr.params.url).toBe('https://example.com');
  });

  it('includes screenshot instruction', () => {
    const result = validateComponent({ url: 'https://example.com' });
    const ssInstr = result.playwrightInstructions.find((i) => i.tool === 'playwright_screenshot');
    expect(ssInstr).toBeDefined();
  });

  it('includes disable-animations evaluate instruction by default', () => {
    const result = validateComponent({ url: 'https://example.com' });
    const evalInstr = result.playwrightInstructions.find((i) => i.tool === 'playwright_evaluate');
    expect(evalInstr).toBeDefined();
  });

  it('omits disable-animations instruction when disableAnimations=false', () => {
    const result = validateComponent({ url: 'https://example.com', disableAnimations: false });
    const evalInstr = result.playwrightInstructions.find((i) => i.tool === 'playwright_evaluate');
    expect(evalInstr).toBeUndefined();
  });

  it('includes hide-selectors evaluate instruction when excludeSelectors provided', () => {
    const result = validateComponent({
      url: 'https://example.com',
      disableAnimations: false,
      excludeSelectors: ['.ad', '#dynamic'],
    });
    const evalInstr = result.playwrightInstructions.find(
      (i) => i.tool === 'playwright_evaluate' && i.params.script.includes('.ad'),
    );
    expect(evalInstr).toBeDefined();
  });

  it('scopes screenshot to selector when provided', () => {
    const result = validateComponent({
      url: 'https://example.com',
      selector: '.sidebar',
    });
    const ssInstr = result.playwrightInstructions.find((i) => i.tool === 'playwright_screenshot');
    expect(ssInstr.params.selector).toBe('.sidebar');
  });

  it('returns passed: false and empty similarity when no actual image', () => {
    const result = validateComponent({ url: 'https://example.com' });
    expect(result.passed).toBe(false);
    expect(result.similarity).toBe(0);
    expect(result.iterations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// validateComponent — with pixel descriptors (comparison mode)
// ---------------------------------------------------------------------------

describe('validateComponent() — with pixel images', () => {
  it('returns passed: true for identical images above default threshold', () => {
    const img = solidDescriptor(32, 32, [128, 128, 128, 255]);
    const result = validateComponent({
      baselineImage: img,
      actualImage: img,
      threshold: 0.95,
    });
    expect(result.passed).toBe(true);
    expect(result.similarity).toBeGreaterThanOrEqual(0.95);
    expect(result.diffRegions).toHaveLength(0);
    expect(result.fixSuggestions).toHaveLength(0);
    expect(result.fixTasks).toHaveLength(0);
  });

  it('returns passed: false for completely different images', () => {
    const baseline = solidDescriptor(32, 32, [0, 0, 0, 255]);
    const actual = solidDescriptor(32, 32, [255, 255, 255, 255]);
    const result = validateComponent({
      baselineImage: baseline,
      actualImage: actual,
      threshold: 0.95,
    });
    expect(result.passed).toBe(false);
    expect(result.similarity).toBeLessThan(0.95);
    expect(result.diffRegions.length).toBeGreaterThan(0);
    expect(result.fixSuggestions.length).toBeGreaterThan(0);
    expect(result.fixTasks.length).toBeGreaterThan(0);
  });

  it('passes with lower threshold on slightly different images', () => {
    const baseline = solidDescriptor(32, 32, [200, 200, 200, 255]);
    const actual = withPatch({ descriptor: baseline, patchX: 5, patchY: 5, patchW: 3, patchH: 3, color: [0, 0, 0] });
    const result = validateComponent({
      baselineImage: baseline,
      actualImage: actual,
      threshold: 0.80,
    });
    expect(result.passed).toBe(true);
  });

  it('fails with high threshold on slightly different images', () => {
    const baseline = solidDescriptor(32, 32, [200, 200, 200, 255]);
    const actual = withPatch({ descriptor: baseline, patchX: 5, patchY: 5, patchW: 10, patchH: 10, color: [0, 0, 0] });
    const result = validateComponent({
      baselineImage: baseline,
      actualImage: actual,
      threshold: 0.9999,
    });
    expect(result.passed).toBe(false);
  });

  it('returns iterations: 1 on first comparison', () => {
    const img = solidDescriptor(16, 16, [100, 100, 100, 255]);
    const result = validateComponent({ baselineImage: img, actualImage: img });
    expect(result.iterations).toBe(1);
  });

  it('returns result object with all required fields', () => {
    const img = solidDescriptor(16, 16, [100, 100, 100, 255]);
    const result = validateComponent({ baselineImage: img, actualImage: img });
    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('similarity');
    expect(result).toHaveProperty('diffRegions');
    expect(result).toHaveProperty('fixSuggestions');
    expect(result).toHaveProperty('fixTasks');
    expect(result).toHaveProperty('iterations');
  });

  it('throws when actualImage is provided but baselineImage is not', () => {
    const img = solidDescriptor(16, 16, [100, 100, 100, 255]);
    expect(() => validateComponent({ actualImage: img })).toThrow(/baselineImage is required/);
  });

  it('accepts Buffer input and normalizes it with imageMeta', () => {
    const descriptor = solidDescriptor(8, 8, [50, 100, 150, 255]);
    const buf = Buffer.from(descriptor.pixels.buffer);
    expect(() => validateComponent({
      baselineImage: buf,
      actualImage: buf,
      imageMeta: { width: 8, height: 8 },
    })).not.toThrow();
  });

  it('accepts base64 string input and normalizes it with imageMeta', () => {
    const descriptor = solidDescriptor(8, 8, [80, 160, 200, 255]);
    const b64 = Buffer.from(descriptor.pixels.buffer).toString('base64');
    expect(() => validateComponent({
      baselineImage: b64,
      actualImage: b64,
      imageMeta: { width: 8, height: 8 },
    })).not.toThrow();
  });

  it('throws TypeError for invalid image input type', () => {
    expect(() => validateComponent({
      baselineImage: 12345,
      actualImage: 12345,
      imageMeta: { width: 8, height: 8 },
    })).toThrow(TypeError);
  });

  it('returns passed: false with fix suggestions and tasks when images differ', () => {
    const baseline = solidDescriptor(32, 32, [0, 0, 0, 255]);
    const actual = solidDescriptor(32, 32, [255, 255, 255, 255]);
    const result = validateComponent({
      baselineImage: baseline,
      actualImage: actual,
      threshold: 0.95,
    });
    expect(result.passed).toBe(false);
    expect(result.fixTasks.length).toBeGreaterThan(0);
    expect(result.fixTasks[0]).toHaveProperty('priority');
  });
});

// ---------------------------------------------------------------------------
// validatePage
// ---------------------------------------------------------------------------

describe('validatePage()', () => {
  it('behaves identically to validateComponent for identical images', () => {
    const img = solidDescriptor(32, 32, [60, 60, 60, 255]);
    const result = validatePage({ baselineImage: img, actualImage: img });
    expect(result.passed).toBe(true);
  });

  it('returns playwrightInstructions without selector when no actualImage', () => {
    const result = validatePage({ url: 'https://example.com' });
    const ssInstr = result.playwrightInstructions.find((i) => i.tool === 'playwright_screenshot');
    expect(ssInstr).toBeDefined();
    expect(ssInstr.params.selector).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createBaseline
// ---------------------------------------------------------------------------

describe('createBaseline()', () => {
  it('returns playwrightInstructions when no image provided', () => {
    const result = createBaseline({ url: 'https://example.com' });
    expect(result).toHaveProperty('playwrightInstructions');
    expect(Array.isArray(result.playwrightInstructions)).toBe(true);
    expect(result.playwrightInstructions.length).toBeGreaterThan(0);
  });

  it('returns baseline object when image is provided', () => {
    const result = createBaseline({ image: Buffer.from([0, 0, 0, 255]), selector: '.foo' });
    expect(result).toHaveProperty('baseline');
    expect(result.baseline.selector).toBe('.foo');
    expect(result.baseline).toHaveProperty('createdAt');
  });

  it('includes navigate instruction in capture flow', () => {
    const result = createBaseline({ url: 'https://example.com' });
    const navInstr = result.playwrightInstructions.find((i) => i.tool === 'playwright_navigate');
    expect(navInstr).toBeDefined();
  });

  it('includes screenshot instruction named "baseline"', () => {
    const result = createBaseline({ url: 'https://example.com' });
    const ssInstr = result.playwrightInstructions.find((i) => i.tool === 'playwright_screenshot');
    expect(ssInstr).toBeDefined();
    expect(ssInstr.params.name).toBe('baseline');
  });

  it('does not include playwrightInstructions when image is provided', () => {
    const result = createBaseline({ image: Buffer.from([0]) });
    expect(result).not.toHaveProperty('playwrightInstructions');
  });
});
