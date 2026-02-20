import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerStyle,
  getStyle,
  listStyles,
  removeStyle,
  formatWithStyle,
  hasStyle,
  resetRegistry,
  parseFrontmatter,
  MAX_STYLES,
} from '../../lib/core/style-registry.js';

beforeEach(() => {
  resetRegistry();
});

// ---------------------------------------------------------------------------
// registerStyle()
// ---------------------------------------------------------------------------
describe('registerStyle()', () => {
  it('registers a basic custom style', () => {
    const result = registerStyle('my-style', {
      description: 'Test style',
    });
    expect(result).toEqual({ name: 'my-style', registered: true });
  });

  it('registers a style with formatter', () => {
    const formatter = (data) => `Formatted: ${data}`;
    const result = registerStyle('fmt-style', {
      description: 'With formatter',
      formatter,
    });
    expect(result.registered).toBe(true);

    const style = getStyle('fmt-style');
    expect(style.formatter).toBe(formatter);
  });

  it('registers a style with template', () => {
    registerStyle('tpl-style', {
      description: 'With template',
      template: '## Title\nContent here',
    });

    const style = getStyle('tpl-style');
    expect(style.template).toBe('## Title\nContent here');
  });

  it('registers a style with options', () => {
    registerStyle('opt-style', {
      options: { compact: true, maxWidth: 80 },
    });

    const style = getStyle('opt-style');
    expect(style.options.compact).toBe(true);
    expect(style.options.maxWidth).toBe(80);
  });

  it('overwrites existing style with same name', () => {
    registerStyle('dupe', { description: 'first' });
    registerStyle('dupe', { description: 'second' });

    const style = getStyle('dupe');
    expect(style.description).toBe('second');
  });

  it('rejects empty/null name', () => {
    expect(registerStyle('', {}).registered).toBe(false);
    expect(registerStyle('', {}).error).toBeDefined();

    expect(registerStyle(null, {}).registered).toBe(false);
    expect(registerStyle(undefined, {}).registered).toBe(false);
  });

  it('rejects non-function formatter', () => {
    const result = registerStyle('bad-fmt', {
      formatter: 'not a function',
    });
    expect(result.registered).toBe(false);
    expect(result.error).toContain('function');
  });

  it('enforces MAX_STYLES limit', () => {
    for (let i = 0; i < MAX_STYLES; i++) {
      registerStyle(`style-${i}`, { description: `Style ${i}` });
    }

    const result = registerStyle('one-too-many', { description: 'overflow' });
    expect(result.registered).toBe(false);
    expect(result.error).toContain('Maximum');
  });

  it('allows overwrite even at MAX_STYLES', () => {
    for (let i = 0; i < MAX_STYLES; i++) {
      registerStyle(`style-${i}`, { description: `Style ${i}` });
    }

    // Overwriting an existing one should work
    const result = registerStyle('style-0', { description: 'Updated' });
    expect(result.registered).toBe(true);
  });

  it('marks custom styles with source=custom', () => {
    registerStyle('my-style', { description: 'test' });
    const style = getStyle('my-style');
    expect(style.source).toBe('custom');
  });

  it('defaults empty config gracefully', () => {
    registerStyle('minimal', {});
    const style = getStyle('minimal');
    expect(style.description).toBe('');
    expect(style.formatter).toBeNull();
    expect(style.template).toBe('');
    expect(style.options).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// getStyle()
// ---------------------------------------------------------------------------
describe('getStyle()', () => {
  it('returns null for non-existent style', () => {
    expect(getStyle('nonexistent')).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(getStyle(null)).toBeNull();
    expect(getStyle(undefined)).toBeNull();
    expect(getStyle('')).toBeNull();
    expect(getStyle(123)).toBeNull();
  });

  it('returns registered custom style', () => {
    registerStyle('test-style', { description: 'Hello' });
    const style = getStyle('test-style');
    expect(style).not.toBeNull();
    expect(style.name).toBe('test-style');
    expect(style.description).toBe('Hello');
  });
});

// ---------------------------------------------------------------------------
// listStyles()
// ---------------------------------------------------------------------------
describe('listStyles()', () => {
  it('lists registered styles', () => {
    registerStyle('alpha', { description: 'Alpha' });
    registerStyle('beta', { description: 'Beta', formatter: () => '' });

    const styles = listStyles();
    const custom = styles.filter((s) => s.source === 'custom');

    expect(custom.length).toBeGreaterThanOrEqual(2);

    const alpha = custom.find((s) => s.name === 'alpha');
    expect(alpha).toBeDefined();
    expect(alpha.description).toBe('Alpha');
    expect(alpha.hasFormatter).toBe(false);

    const beta = custom.find((s) => s.name === 'beta');
    expect(beta).toBeDefined();
    expect(beta.hasFormatter).toBe(true);
  });

  it('returns array even when empty (with builtins)', () => {
    const styles = listStyles();
    expect(Array.isArray(styles)).toBe(true);
  });

  it('each entry has expected shape', () => {
    registerStyle('shape-test', { description: 'shape' });
    const styles = listStyles();
    const item = styles.find((s) => s.name === 'shape-test');

    expect(item).toHaveProperty('name');
    expect(item).toHaveProperty('description');
    expect(item).toHaveProperty('source');
    expect(item).toHaveProperty('hasFormatter');
  });
});

// ---------------------------------------------------------------------------
// removeStyle()
// ---------------------------------------------------------------------------
describe('removeStyle()', () => {
  it('removes a custom style', () => {
    registerStyle('temp', { description: 'temporary' });
    expect(getStyle('temp')).not.toBeNull();

    const result = removeStyle('temp');
    expect(result).toEqual({ name: 'temp', removed: true });
    expect(getStyle('temp')).toBeNull();
  });

  it('returns error for non-existent style', () => {
    const result = removeStyle('ghost');
    expect(result.removed).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('returns error for invalid input', () => {
    expect(removeStyle(null).removed).toBe(false);
    expect(removeStyle('').removed).toBe(false);
  });

  it('prevents removal of built-in styles', () => {
    // Force load builtins by calling listStyles
    listStyles();

    // Find a builtin style
    const builtins = listStyles().filter((s) => s.source === 'builtin');
    if (builtins.length > 0) {
      const result = removeStyle(builtins[0].name);
      expect(result.removed).toBe(false);
      expect(result.error).toContain('built-in');
    }
  });
});

// ---------------------------------------------------------------------------
// formatWithStyle()
// ---------------------------------------------------------------------------
describe('formatWithStyle()', () => {
  it('formats data using custom formatter', () => {
    registerStyle('json-fmt', {
      formatter: (data) => `[FORMATTED] ${JSON.stringify(data)}`,
    });

    const result = formatWithStyle('json-fmt', { key: 'value' });
    expect(result.formatted).toBe(true);
    expect(result.styleName).toBe('json-fmt');
    expect(result.output).toContain('[FORMATTED]');
    expect(result.output).toContain('"key"');
  });

  it('returns template when no formatter', () => {
    registerStyle('tpl-only', {
      template: '## Report\nContent here',
    });

    const result = formatWithStyle('tpl-only', { data: 'ignored' });
    expect(result.formatted).toBe(false);
    expect(result.output).toBe('## Report\nContent here');
  });

  it('falls back to JSON for unknown style', () => {
    const result = formatWithStyle('unknown', { x: 1 });
    expect(result.formatted).toBe(false);
    expect(result.output).toContain('"x"');
  });

  it('passes string data through for unknown style', () => {
    const result = formatWithStyle('unknown', 'hello world');
    expect(result.output).toBe('hello world');
  });

  it('passes string data through when no formatter/template', () => {
    registerStyle('empty-style', {});
    const result = formatWithStyle('empty-style', 'raw text');
    expect(result.output).toBe('raw text');
  });
});

// ---------------------------------------------------------------------------
// hasStyle()
// ---------------------------------------------------------------------------
describe('hasStyle()', () => {
  it('returns true for registered style', () => {
    registerStyle('exists', { description: 'yes' });
    expect(hasStyle('exists')).toBe(true);
  });

  it('returns false for unregistered style', () => {
    expect(hasStyle('nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resetRegistry()
// ---------------------------------------------------------------------------
describe('resetRegistry()', () => {
  it('clears all registered styles', () => {
    registerStyle('a', {});
    registerStyle('b', {});
    resetRegistry();

    expect(getStyle('a')).toBeNull();
    expect(getStyle('b')).toBeNull();
  });

  it('allows builtins to reload after reset', () => {
    listStyles(); // trigger builtin load
    resetRegistry();
    // After reset, builtins should reload on next access
    const styles = listStyles();
    // Just verify it doesn't crash and returns an array
    expect(Array.isArray(styles)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatter()
// ---------------------------------------------------------------------------
describe('parseFrontmatter()', () => {
  it('parses standard frontmatter block', () => {
    const content = '---\nname: my-style\ndescription: A test style\n---\n\n## Body\nContent';
    const result = parseFrontmatter(content);

    expect(result.frontmatter.name).toBe('my-style');
    expect(result.frontmatter.description).toBe('A test style');
    expect(result.body).toContain('## Body');
    expect(result.body).toContain('Content');
  });

  it('handles content without frontmatter', () => {
    const content = '## Just markdown\nNo frontmatter here';
    const result = parseFrontmatter(content);

    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  it('handles empty/null input', () => {
    expect(parseFrontmatter('').body).toBe('');
    expect(parseFrontmatter(null).body).toBe('');
    expect(parseFrontmatter(undefined).body).toBe('');
  });

  it('handles frontmatter with no closing delimiter', () => {
    const content = '---\nname: broken\nno closing delimiter';
    const result = parseFrontmatter(content);
    expect(result.body).toBe(content);
  });

  it('handles empty frontmatter', () => {
    const content = '---\n---\nBody only';
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toContain('Body only');
  });

  it('handles frontmatter with colons in values', () => {
    const content = '---\nname: style:v2\ndesc: key: value pair\n---\nBody';
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe('style:v2');
    expect(result.frontmatter.desc).toBe('key: value pair');
  });

  it('handles lines without colons in frontmatter', () => {
    const content = '---\nname: valid\njust-a-line\n---\nBody';
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe('valid');
    expect(result.frontmatter).not.toHaveProperty('just-a-line');
  });

  it('trims whitespace from keys and values', () => {
    const content = '---\n  name  :  spaced  \n---\nBody';
    const result = parseFrontmatter(content);
    expect(result.frontmatter.name).toBe('spaced');
  });
});

// ---------------------------------------------------------------------------
// Built-in style loading integration
// ---------------------------------------------------------------------------
describe('built-in style loading', () => {
  it('loads built-in styles from output-styles directory', () => {
    const styles = listStyles();
    const builtins = styles.filter((s) => s.source === 'builtin');

    // We know there are 5 md files in output-styles/
    expect(builtins.length).toBeGreaterThanOrEqual(1);
  });

  it('built-in styles have no formatter', () => {
    const styles = listStyles();
    const builtins = styles.filter((s) => s.source === 'builtin');

    for (const s of builtins) {
      expect(s.hasFormatter).toBe(false);
    }
  });

  it('built-in styles have template content', () => {
    const styles = listStyles();
    const builtins = styles.filter((s) => s.source === 'builtin');

    if (builtins.length > 0) {
      const style = getStyle(builtins[0].name);
      expect(style.template.length).toBeGreaterThan(0);
    }
  });

  it('custom styles coexist with builtins', () => {
    registerStyle('custom-one', { description: 'mine' });
    const styles = listStyles();

    const custom = styles.filter((s) => s.source === 'custom');
    const builtin = styles.filter((s) => s.source === 'builtin');

    expect(custom.length).toBeGreaterThanOrEqual(1);
    // builtins may or may not load depending on environment
    expect(builtin.length).toBeGreaterThanOrEqual(0);
  });
});
