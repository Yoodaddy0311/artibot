/**
 * File system utilities with safe defaults.
 * @module lib/core/file
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Check if a file or directory exists.
 *
 * @param {string} filePath - Absolute path to check.
 * @returns {Promise<boolean>} `true` if the path exists and is accessible, `false` otherwise.
 * @example
 * if (await exists('/path/to/config.json')) {
 *   const config = await readJsonFile('/path/to/config.json');
 * }
 */
export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse a JSON file.
 * Returns `null` if the file does not exist or contains invalid JSON.
 *
 * @param {string} filePath - Absolute path to the JSON file.
 * @returns {Promise<object|null>} Parsed JSON object, or `null` on failure.
 * @example
 * const config = await readJsonFile('/path/to/artibot.config.json');
 * if (config) {
 *   console.log(config.team.engine);
 * }
 */
export async function readJsonFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write an object as JSON to a file, creating parent directories if needed.
 *
 * @param {string} filePath - Absolute path to write to.
 * @param {object} data - Data to serialize as JSON.
 * @param {number} [indent=2] - Number of spaces for JSON indentation.
 * @returns {Promise<void>}
 * @example
 * await writeJsonFile('/path/to/output.json', { key: 'value' });
 * await writeJsonFile('/path/to/compact.json', data, 0); // no indentation
 */
export async function writeJsonFile(filePath, data, indent = 2) {
  await ensureDir(path.dirname(filePath));
  const content = JSON.stringify(data, null, indent) + '\n';
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Read a file as a UTF-8 string.
 * Returns `null` if the file does not exist.
 *
 * @param {string} filePath - Absolute path to the text file.
 * @returns {Promise<string|null>} File contents as a string, or `null` on failure.
 * @example
 * const content = await readTextFile('/path/to/SKILL.md');
 * if (content) {
 *   console.log(content.length, 'characters');
 * }
 */
export async function readTextFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 *
 * @param {string} dirPath - Absolute directory path to create.
 * @returns {Promise<void>}
 * @example
 * await ensureDir('/home/user/.claude/artibot/patterns');
 */
export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * List files in a directory matching an optional extension filter.
 * Returns an empty array if the directory does not exist.
 *
 * @param {string} dirPath - Absolute path to the directory to scan.
 * @param {string} [ext] - Extension filter (e.g. `'.md'`, `'.js'`).
 * @returns {Promise<string[]>} Array of absolute file paths matching the filter.
 * @example
 * const mdFiles = await listFiles('/path/to/agents', '.md');
 * // ['/path/to/agents/orchestrator.md', '/path/to/agents/architect.md', ...]
 *
 * const allFiles = await listFiles('/path/to/lib/core');
 * // ['/path/to/lib/core/platform.js', '/path/to/lib/core/cache.js', ...]
 */
export async function listFiles(dirPath, ext) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let files = entries
      .filter((e) => e.isFile())
      .map((e) => path.join(dirPath, e.name));
    if (ext) {
      files = files.filter((f) => f.endsWith(ext));
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * List subdirectories in a directory.
 * Returns an empty array if the directory does not exist.
 *
 * @param {string} dirPath - Absolute path to the parent directory.
 * @returns {Promise<string[]>} Array of absolute paths to subdirectories.
 * @example
 * const skillDirs = await listDirs('/path/to/skills');
 * // ['/path/to/skills/orchestration', '/path/to/skills/persona-architect', ...]
 */
export async function listDirs(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dirPath, e.name));
  } catch {
    return [];
  }
}
