import { describe, it, expect } from 'vitest';
import {
  detectProjectType,
  generateWelcome,
  getSupportedTypes,
} from '../../lib/core/quickstart.js';

// ---------------------------------------------------------------------------
// detectProjectType()
// ---------------------------------------------------------------------------
describe('detectProjectType()', () => {
  it('detects Node.js from package.json', () => {
    const result = detectProjectType(['package.json', 'README.md']);
    expect(result.type.name).toBe('Node.js');
    expect(result.commands).toContain('/sc load');
    expect(result.commands).toContain('/sc implement');
  });

  it('detects Python from pyproject.toml', () => {
    const result = detectProjectType(['pyproject.toml', 'src/main.py']);
    expect(result.type.name).toBe('Python');
    expect(result.commands).toContain('/sc test');
  });

  it('detects Python from setup.py', () => {
    const result = detectProjectType(['setup.py']);
    expect(result.type.name).toBe('Python (setup.py)');
  });

  it('detects Python from requirements.txt', () => {
    const result = detectProjectType(['requirements.txt']);
    expect(result.type.name).toBe('Python (requirements)');
  });

  it('detects Rust from Cargo.toml', () => {
    const result = detectProjectType(['Cargo.toml', 'src/main.rs']);
    expect(result.type.name).toBe('Rust');
    expect(result.commands).toContain('/sc build');
  });

  it('detects Go from go.mod', () => {
    const result = detectProjectType(['go.mod', 'main.go']);
    expect(result.type.name).toBe('Go');
  });

  it('detects Java Maven from pom.xml', () => {
    const result = detectProjectType(['pom.xml']);
    expect(result.type.name).toBe('Java (Maven)');
  });

  it('detects Java Gradle from build.gradle', () => {
    const result = detectProjectType(['build.gradle']);
    expect(result.type.name).toBe('Java (Gradle)');
  });

  it('detects Ruby from Gemfile', () => {
    const result = detectProjectType(['Gemfile']);
    expect(result.type.name).toBe('Ruby');
  });

  it('detects .NET from .csproj file', () => {
    const result = detectProjectType(['MyApp.csproj', 'Program.cs']);
    expect(result.type.name).toBe('.NET');
  });

  it('detects Docker from Dockerfile', () => {
    const result = detectProjectType(['Dockerfile', 'docker-compose.yml']);
    expect(result.type.name).toBe('Docker');
  });

  it('returns fallback for unknown project type', () => {
    const result = detectProjectType(['README.md', 'LICENSE']);
    expect(result.type).toBeNull();
    expect(result.commands).toHaveLength(3);
    expect(result.description).toContain('Unknown');
  });

  it('returns fallback for empty files array', () => {
    const result = detectProjectType([]);
    expect(result.type).toBeNull();
    expect(result.description).toContain('No project');
  });

  it('returns fallback for null input', () => {
    const result = detectProjectType(null);
    expect(result.type).toBeNull();
  });

  it('returns fallback for non-array input', () => {
    const result = detectProjectType('package.json');
    expect(result.type).toBeNull();
  });

  it('prioritizes first matching type (Node.js over Docker)', () => {
    const result = detectProjectType(['package.json', 'Dockerfile']);
    expect(result.type.name).toBe('Node.js');
  });

  it('is case-insensitive for file matching', () => {
    const result = detectProjectType(['PACKAGE.JSON']);
    expect(result.type.name).toBe('Node.js');
  });

  it('always includes /sc load in commands', () => {
    const types = [
      ['package.json'],
      ['pyproject.toml'],
      ['Cargo.toml'],
      ['go.mod'],
      ['pom.xml'],
    ];
    for (const files of types) {
      const result = detectProjectType(files);
      expect(result.commands[0]).toBe('/sc load');
    }
  });
});

// ---------------------------------------------------------------------------
// generateWelcome()
// ---------------------------------------------------------------------------
describe('generateWelcome()', () => {
  it('generates a welcome message with project type', () => {
    const msg = generateWelcome(['package.json']);
    expect(msg).toContain('Welcome to Artibot');
    expect(msg).toContain('Node.js');
    expect(msg).toContain('/sc load');
  });

  it('includes recommended commands section', () => {
    const msg = generateWelcome(['Cargo.toml']);
    expect(msg).toContain('Recommended commands');
    expect(msg).toContain('1.');
    expect(msg).toContain('2.');
    expect(msg).toContain('3.');
  });

  it('includes quick tips', () => {
    const msg = generateWelcome(['go.mod']);
    expect(msg).toContain('Quick tips');
    expect(msg).toContain('/sc help');
    expect(msg).toContain('/sc orchestrate');
  });

  it('handles unknown project type gracefully', () => {
    const msg = generateWelcome(['README.md']);
    expect(msg).toContain('Welcome to Artibot');
    expect(msg).toContain('not detected');
  });

  it('handles empty files array', () => {
    const msg = generateWelcome([]);
    expect(msg).toContain('Welcome to Artibot');
    expect(msg).toContain('not detected');
  });

  it('shows project name in footer', () => {
    const msg = generateWelcome(['pyproject.toml']);
    expect(msg).toContain('Project: Python');
  });

  it('returns string type', () => {
    const msg = generateWelcome(['package.json']);
    expect(typeof msg).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// getSupportedTypes()
// ---------------------------------------------------------------------------
describe('getSupportedTypes()', () => {
  it('returns array of supported types', () => {
    const types = getSupportedTypes();
    expect(Array.isArray(types)).toBe(true);
    expect(types.length).toBeGreaterThan(0);
  });

  it('each type has name and marker', () => {
    const types = getSupportedTypes();
    for (const t of types) {
      expect(t).toHaveProperty('name');
      expect(t).toHaveProperty('marker');
      expect(typeof t.name).toBe('string');
      expect(typeof t.marker).toBe('string');
    }
  });

  it('includes Node.js type', () => {
    const types = getSupportedTypes();
    expect(types.some((t) => t.name === 'Node.js')).toBe(true);
  });

  it('includes Python type', () => {
    const types = getSupportedTypes();
    expect(types.some((t) => t.name === 'Python')).toBe(true);
  });

  it('does not expose commands (minimal shape)', () => {
    const types = getSupportedTypes();
    expect(types[0]).not.toHaveProperty('commands');
    expect(types[0]).not.toHaveProperty('description');
  });
});
