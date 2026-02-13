/**
 * File system utilities with safe defaults.
 * @module lib/core/file
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Check if a file or directory exists.
 * @param {string} filePath - Absolute path to check
 * @returns {Promise<boolean>}
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
 * Returns null if the file doesn't exist or is invalid JSON.
 * @param {string} filePath - Absolute path to the JSON file
 * @returns {Promise<object|null>}
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
 * @param {string} filePath - Absolute path
 * @param {object} data - Data to serialize
 * @param {number} [indent=2] - JSON indentation
 */
export async function writeJsonFile(filePath, data, indent = 2) {
  await ensureDir(path.dirname(filePath));
  const content = JSON.stringify(data, null, indent) + '\n';
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Read a file as a UTF-8 string.
 * Returns null if the file doesn't exist.
 * @param {string} filePath
 * @returns {Promise<string|null>}
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
 * @param {string} dirPath - Absolute directory path
 */
export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * List files in a directory matching an optional extension filter.
 * @param {string} dirPath
 * @param {string} [ext] - Extension filter (e.g. '.md')
 * @returns {Promise<string[]>} Array of absolute paths
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
 * @param {string} dirPath
 * @returns {Promise<string[]>} Array of absolute paths
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
