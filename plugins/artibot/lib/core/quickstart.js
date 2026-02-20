/**
 * Interactive quickstart guide for new users.
 * Detects project type from config files and suggests relevant commands.
 *
 * Zero dependencies (uses only Node built-ins). ESM only.
 * @module lib/core/quickstart
 */

// ---------------------------------------------------------------------------
// Project Type Definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ProjectType
 * @property {string} name - Human-readable project type name
 * @property {string} marker - Config file that identifies this project type
 * @property {string[]} commands - Recommended /sc commands for this type
 * @property {string} description - Brief explanation of the project type
 */

/** @type {ProjectType[]} */
const PROJECT_TYPES = [
  {
    name: 'Node.js',
    marker: 'package.json',
    commands: ['/sc load', '/sc analyze', '/sc implement'],
    description: 'Node.js project detected (package.json)',
  },
  {
    name: 'Python',
    marker: 'pyproject.toml',
    commands: ['/sc load', '/sc analyze', '/sc test'],
    description: 'Python project detected (pyproject.toml)',
  },
  {
    name: 'Python (setup.py)',
    marker: 'setup.py',
    commands: ['/sc load', '/sc analyze', '/sc test'],
    description: 'Python project detected (setup.py)',
  },
  {
    name: 'Python (requirements)',
    marker: 'requirements.txt',
    commands: ['/sc load', '/sc analyze', '/sc implement'],
    description: 'Python project detected (requirements.txt)',
  },
  {
    name: 'Rust',
    marker: 'Cargo.toml',
    commands: ['/sc load', '/sc analyze', '/sc build'],
    description: 'Rust project detected (Cargo.toml)',
  },
  {
    name: 'Go',
    marker: 'go.mod',
    commands: ['/sc load', '/sc analyze', '/sc test'],
    description: 'Go project detected (go.mod)',
  },
  {
    name: 'Java (Maven)',
    marker: 'pom.xml',
    commands: ['/sc load', '/sc analyze', '/sc build'],
    description: 'Java/Maven project detected (pom.xml)',
  },
  {
    name: 'Java (Gradle)',
    marker: 'build.gradle',
    commands: ['/sc load', '/sc analyze', '/sc build'],
    description: 'Java/Gradle project detected (build.gradle)',
  },
  {
    name: 'Ruby',
    marker: 'Gemfile',
    commands: ['/sc load', '/sc analyze', '/sc test'],
    description: 'Ruby project detected (Gemfile)',
  },
  {
    name: '.NET',
    marker: '*.csproj',
    commands: ['/sc load', '/sc analyze', '/sc build'],
    description: '.NET project detected (*.csproj)',
  },
  {
    name: 'Docker',
    marker: 'Dockerfile',
    commands: ['/sc load', '/sc analyze', '/sc build'],
    description: 'Docker project detected (Dockerfile)',
  },
];

/**
 * Default commands when no project type is detected.
 * @type {string[]}
 */
const FALLBACK_COMMANDS = ['/sc load', '/sc analyze', '/sc explain'];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect the project type from a list of filenames present in the project root.
 *
 * @param {string[]} files - Array of filenames (not full paths) in the project root
 * @returns {{ type: ProjectType | null, commands: string[], description: string }}
 * @example
 * const result = detectProjectType(['package.json', 'tsconfig.json', 'README.md']);
 * // result.type.name === 'Node.js'
 * // result.commands === ['/sc load', '/sc analyze', '/sc implement']
 */
export function detectProjectType(files) {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      type: null,
      commands: FALLBACK_COMMANDS,
      description: 'No project configuration files found',
    };
  }

  const fileSet = new Set(files.map((f) => f.toLowerCase()));

  for (const pt of PROJECT_TYPES) {
    if (pt.marker.startsWith('*')) {
      // Glob pattern: *.csproj
      const ext = pt.marker.slice(1).toLowerCase();
      const hasMatch = files.some((f) => f.toLowerCase().endsWith(ext));
      if (hasMatch) {
        return { type: pt, commands: pt.commands, description: pt.description };
      }
    } else if (fileSet.has(pt.marker.toLowerCase())) {
      return { type: pt, commands: pt.commands, description: pt.description };
    }
  }

  return {
    type: null,
    commands: FALLBACK_COMMANDS,
    description: 'Unknown project type - showing general commands',
  };
}

// ---------------------------------------------------------------------------
// Welcome Message
// ---------------------------------------------------------------------------

/**
 * Generate a formatted quickstart welcome message.
 *
 * @param {string[]} files - Array of filenames in the project root
 * @returns {string} Formatted welcome message with recommended commands
 * @example
 * const msg = generateWelcome(['package.json', 'README.md']);
 * // Returns formatted string with project type and recommended commands
 */
export function generateWelcome(files) {
  const { type, commands, description } = detectProjectType(files);

  const lines = [
    '=======================================',
    '  Welcome to Artibot!',
    '=======================================',
    '',
    `  ${description}`,
    '',
    '  Recommended commands to get started:',
    '',
  ];

  for (let i = 0; i < commands.length; i++) {
    lines.push(`    ${i + 1}. ${commands[i]}`);
  }

  lines.push('');
  lines.push('  Quick tips:');
  lines.push('    - Use /sc help to see all available commands');
  lines.push('    - Use /sc load to analyze your project structure');
  lines.push('    - Use /sc orchestrate to create agent teams');
  lines.push('');

  if (type) {
    lines.push(`  Project: ${type.name}`);
  } else {
    lines.push('  Project: (not detected)');
  }

  lines.push('=======================================');

  return lines.join('\n');
}

/**
 * Get all supported project types.
 *
 * @returns {Array<{ name: string, marker: string }>}
 * @example
 * const types = getSupportedTypes();
 * // types[0]: { name: 'Node.js', marker: 'package.json' }
 */
export function getSupportedTypes() {
  return PROJECT_TYPES.map(({ name, marker }) => ({ name, marker }));
}
