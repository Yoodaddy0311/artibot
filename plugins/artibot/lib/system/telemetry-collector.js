/**
 * System telemetry collector for LAM OS Awareness.
 * Collects cross-platform system information using only Node.js built-in modules.
 * @module lib/system/telemetry-collector
 */

import { cpus, totalmem, freemem, platform as osPlatform } from 'node:os';
import { execSync } from 'node:child_process';
import { getPlatform } from '../core/platform.js';

/** @type {{ os: string, isWindows: boolean, isMac: boolean, isLinux: boolean }} */
const PLATFORM = getPlatform();

/** Maximum exec output buffer size (2 MB) */
const MAX_BUFFER = 2 * 1024 * 1024;

/** Default exec timeout (5 seconds) */
const EXEC_TIMEOUT_MS = 5_000;

/**
 * Safely execute a shell command and return trimmed stdout.
 * Returns empty string on any failure.
 *
 * @param {string} command - Shell command to execute
 * @param {object} [opts] - Additional execSync options
 * @returns {string} Trimmed stdout or empty string
 */
function safeExec(command, opts = {}) {
  try {
    const result = execSync(command, {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...opts,
    });
    return (result || '').trim();
  } catch {
    return '';
  }
}

/**
 * Parse a numeric string, returning 0 on failure.
 *
 * @param {string} value
 * @returns {number}
 */
function safeParseFloat(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse an integer string, returning 0 on failure.
 *
 * @param {string} value
 * @returns {number}
 */
function safeParseInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Format bytes into a human-readable string.
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// CPU Usage
// ---------------------------------------------------------------------------

/**
 * Get CPU usage and top processes by CPU consumption.
 *
 * @returns {{ usage: number, topProcesses: Array<{ name: string, pid: number, cpu: number }> }}
 */
export function getCpuUsage() {
  const result = { usage: 0, topProcesses: [] };

  try {
    if (PLATFORM.isWindows) {
      // Overall CPU usage via wmic
      const loadOutput = safeExec(
        'wmic cpu get loadpercentage /value',
      );
      const loadMatch = loadOutput.match(/LoadPercentage=(\d+)/i);
      if (loadMatch) {
        result.usage = safeParseInt(loadMatch[1]);
      }

      // Top processes via PowerShell (sorted by CPU)
      const psCmd = [
        'powershell -NoProfile -Command',
        '"Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 |',
        'ForEach-Object { $_.Id, $_.ProcessName, [math]::Round($_.CPU, 1) -join \',\' }"',
      ].join(' ');
      const psOutput = safeExec(psCmd);
      if (psOutput) {
        for (const line of psOutput.split('\n')) {
          const parts = line.trim().split(',');
          if (parts.length >= 3) {
            result.topProcesses.push({
              name: parts[1],
              pid: safeParseInt(parts[0]),
              cpu: safeParseFloat(parts[2]),
            });
          }
        }
      }
    } else if (PLATFORM.isMac) {
      // macOS: top in logging mode, 1 sample
      const topOutput = safeExec('top -l 1 -n 5 -stats pid,command,cpu');
      const lines = topOutput.split('\n');

      // Find CPU usage line: "CPU usage: X% user, Y% sys, Z% idle"
      for (const line of lines) {
        const cpuMatch = line.match(/CPU usage:\s*([\d.]+)%\s*user.*?([\d.]+)%\s*sys/i);
        if (cpuMatch) {
          result.usage = Math.round(safeParseFloat(cpuMatch[1]) + safeParseFloat(cpuMatch[2]));
          break;
        }
      }

      // Parse process lines (after header section)
      let inProcesses = false;
      for (const line of lines) {
        if (line.match(/^\s*PID\s/i)) {
          inProcesses = true;
          continue;
        }
        if (inProcesses && result.topProcesses.length < 5) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3) {
            result.topProcesses.push({
              name: parts[1],
              pid: safeParseInt(parts[0]),
              cpu: safeParseFloat(parts[2]),
            });
          }
        }
      }
    } else {
      // Linux: read /proc/stat for overall, ps for top processes
      const statOutput = safeExec('cat /proc/stat | head -1');
      if (statOutput) {
        const parts = statOutput.split(/\s+/).slice(1).map(Number);
        const idle = parts[3] || 0;
        const total = parts.reduce((a, b) => a + b, 0);
        if (total > 0) {
          result.usage = Math.round(((total - idle) / total) * 100);
        }
      }

      const psOutput = safeExec('ps aux --sort=-%cpu | head -6');
      if (psOutput) {
        const lines = psOutput.split('\n').slice(1); // skip header
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 11) {
            result.topProcesses.push({
              name: parts[10],
              pid: safeParseInt(parts[1]),
              cpu: safeParseFloat(parts[2]),
            });
          }
        }
      }
    }
  } catch {
    // Return partial result on failure
  }

  return result;
}

// ---------------------------------------------------------------------------
// Memory Usage
// ---------------------------------------------------------------------------

/**
 * Get memory usage information.
 *
 * @returns {{ total: string, used: string, free: string, usage: number, totalBytes: number, usedBytes: number, freeBytes: number }}
 */
export function getMemoryUsage() {
  const totalBytes = totalmem();
  const freeBytes = freemem();
  const usedBytes = totalBytes - freeBytes;
  const usage = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

  return {
    total: formatBytes(totalBytes),
    used: formatBytes(usedBytes),
    free: formatBytes(freeBytes),
    usage,
    totalBytes,
    usedBytes,
    freeBytes,
  };
}

// ---------------------------------------------------------------------------
// Disk Usage
// ---------------------------------------------------------------------------

/**
 * Get disk usage for primary partitions.
 *
 * @returns {Array<{ mount: string, total: string, used: string, free: string, usage: number }>}
 */
export function getDiskUsage() {
  const disks = [];

  try {
    if (PLATFORM.isWindows) {
      const output = safeExec(
        'wmic logicaldisk where "DriveType=3" get DeviceID,Size,FreeSpace /value',
      );
      // Parse blocks separated by blank lines
      const blocks = output.split(/\n\s*\n/).filter(Boolean);
      for (const block of blocks) {
        const deviceMatch = block.match(/DeviceID=(.+)/i);
        const freeMatch = block.match(/FreeSpace=(\d+)/i);
        const sizeMatch = block.match(/Size=(\d+)/i);

        if (deviceMatch && sizeMatch) {
          const totalBytes = safeParseFloat(sizeMatch[1]);
          const freeBytes = safeParseFloat(freeMatch?.[1] || '0');
          const usedBytes = totalBytes - freeBytes;
          const usage = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

          disks.push({
            mount: deviceMatch[1].trim(),
            total: formatBytes(totalBytes),
            used: formatBytes(usedBytes),
            free: formatBytes(freeBytes),
            usage,
          });
        }
      }
    } else {
      // macOS and Linux: df
      const output = safeExec('df -h 2>/dev/null | grep -E "^/"');
      if (output) {
        for (const line of output.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 6) {
            const usageStr = parts[4].replace('%', '');
            disks.push({
              mount: parts[5],
              total: parts[1],
              used: parts[2],
              free: parts[3],
              usage: safeParseInt(usageStr),
            });
          }
        }
      }
    }
  } catch {
    // Return empty on failure
  }

  return disks;
}

// ---------------------------------------------------------------------------
// Network Ports
// ---------------------------------------------------------------------------

/**
 * Get listening network ports.
 *
 * @returns {Array<{ port: number, pid: number, state: string }>}
 */
export function getNetworkPorts() {
  const ports = [];

  try {
    if (PLATFORM.isWindows) {
      const output = safeExec('netstat -ano -p tcp | findstr LISTENING');
      if (output) {
        for (const line of output.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5) {
            const addrParts = parts[1].split(':');
            const port = safeParseInt(addrParts[addrParts.length - 1]);
            if (port > 0) {
              ports.push({
                port,
                pid: safeParseInt(parts[4]),
                state: 'LISTEN',
              });
            }
          }
        }
      }
    } else if (PLATFORM.isLinux) {
      // Linux: ss is preferred
      const output = safeExec('ss -tlnp 2>/dev/null');
      if (output) {
        for (const line of output.split('\n').slice(1)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5) {
            const addrParts = parts[3].split(':');
            const port = safeParseInt(addrParts[addrParts.length - 1]);
            const pidMatch = (parts[5] || parts[6] || '').match(/pid=(\d+)/);
            if (port > 0) {
              ports.push({
                port,
                pid: pidMatch ? safeParseInt(pidMatch[1]) : 0,
                state: 'LISTEN',
              });
            }
          }
        }
      }
    } else {
      // macOS: lsof
      const output = safeExec('lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null');
      if (output) {
        for (const line of output.split('\n').slice(1)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 9) {
            const addrParts = parts[8].split(':');
            const port = safeParseInt(addrParts[addrParts.length - 1]);
            if (port > 0) {
              ports.push({
                port,
                pid: safeParseInt(parts[1]),
                state: 'LISTEN',
              });
            }
          }
        }
      }
    }
  } catch {
    // Return empty on failure
  }

  // Deduplicate by port
  const seen = new Set();
  return ports.filter((p) => {
    if (seen.has(p.port)) return false;
    seen.add(p.port);
    return true;
  });
}

// ---------------------------------------------------------------------------
// System Errors
// ---------------------------------------------------------------------------

/**
 * Get recent system error log entries (last 10).
 *
 * @returns {Array<{ timestamp: string, level: string, message: string }>}
 */
export function getSystemErrors() {
  const errors = [];

  try {
    if (PLATFORM.isWindows) {
      const psCmd = [
        'powershell -NoProfile -Command',
        '"Get-EventLog -LogName System -EntryType Error -Newest 10 2>$null |',
        'ForEach-Object { $_.TimeGenerated.ToString(\'yyyy-MM-ddTHH:mm:ss\'), $_.EntryType, $_.Message.Split([char]10)[0] -join \'||\' }"',
      ].join(' ');
      const output = safeExec(psCmd);
      if (output) {
        for (const line of output.split('\n')) {
          const parts = line.trim().split('||');
          if (parts.length >= 3) {
            errors.push({
              timestamp: parts[0],
              level: parts[1],
              message: parts[2].slice(0, 200),
            });
          }
        }
      }
    } else if (PLATFORM.isLinux) {
      // journalctl for recent errors
      const output = safeExec(
        'journalctl --priority=err --no-pager -n 10 --output=short-iso 2>/dev/null',
      );
      if (output) {
        for (const line of output.split('\n')) {
          const match = line.match(/^(\S+)\s+\S+\s+(\S+?)(?:\[\d+\])?:\s*(.+)/);
          if (match) {
            errors.push({
              timestamp: match[1],
              level: 'error',
              message: match[3].slice(0, 200),
            });
          }
        }
      }
    } else {
      // macOS: log show
      const output = safeExec(
        'log show --predicate \'eventType == logEvent AND messageType == error\' --last 1m --style compact 2>/dev/null | tail -10',
      );
      if (output) {
        for (const line of output.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3) {
            errors.push({
              timestamp: parts[0] + 'T' + (parts[1] || ''),
              level: 'error',
              message: parts.slice(2).join(' ').slice(0, 200),
            });
          }
        }
      }
    }
  } catch {
    // Return empty on failure
  }

  return errors.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Docker Status
// ---------------------------------------------------------------------------

/**
 * Get Docker container status. Returns empty array if Docker is not available.
 *
 * @returns {Array<{ name: string, status: string, ports: string }>}
 */
export function getDockerStatus() {
  const containers = [];

  try {
    // Check if docker is available
    const versionCheck = safeExec('docker --version');
    if (!versionCheck) return containers;

    const output = safeExec(
      'docker ps --format "{{.Names}}||{{.Status}}||{{.Ports}}" 2>/dev/null',
    );
    if (output) {
      for (const line of output.split('\n')) {
        const parts = line.trim().split('||');
        if (parts.length >= 2) {
          containers.push({
            name: parts[0],
            status: parts[1],
            ports: parts[2] || '',
          });
        }
      }
    }
  } catch {
    // Docker not available
  }

  return containers;
}

// ---------------------------------------------------------------------------
// Git Context
// ---------------------------------------------------------------------------

/**
 * Get current Git repository context.
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {{ branch: string, status: string, recentCommits: Array<{ hash: string, message: string }> } | null}
 */
export function getGitContext(cwd) {
  const execOpts = cwd ? { cwd } : {};

  try {
    const branch = safeExec('git rev-parse --abbrev-ref HEAD', execOpts);
    if (!branch) return null;

    const status = safeExec('git status --short', execOpts);

    const logOutput = safeExec(
      'git log --oneline -5 --no-decorate',
      execOpts,
    );
    const recentCommits = [];
    if (logOutput) {
      for (const line of logOutput.split('\n')) {
        const spaceIdx = line.indexOf(' ');
        if (spaceIdx > 0) {
          recentCommits.push({
            hash: line.slice(0, spaceIdx),
            message: line.slice(spaceIdx + 1),
          });
        }
      }
    }

    const changedCount = status
      ? status.split('\n').filter(Boolean).length
      : 0;

    return {
      branch,
      status: changedCount > 0 ? `${changedCount} changed files` : 'clean',
      recentCommits,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Full Snapshot
// ---------------------------------------------------------------------------

/**
 * Collect a full system telemetry snapshot.
 * Aggregates all collectors into a single object.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] - Working directory for Git context
 * @returns {{
 *   timestamp: string,
 *   platform: object,
 *   cpu: object,
 *   memory: object,
 *   disk: Array,
 *   network: Array,
 *   errors: Array,
 *   docker: Array,
 *   git: object | null
 * }}
 */
export function getFullSnapshot(options = {}) {
  return {
    timestamp: new Date().toISOString(),
    platform: PLATFORM,
    cpu: getCpuUsage(),
    memory: getMemoryUsage(),
    disk: getDiskUsage(),
    network: getNetworkPorts(),
    errors: getSystemErrors(),
    docker: getDockerStatus(),
    git: getGitContext(options.cwd),
  };
}
