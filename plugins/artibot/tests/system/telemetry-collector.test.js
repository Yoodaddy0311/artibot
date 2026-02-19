import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getCpuUsage,
  getMemoryUsage,
  getDiskUsage,
  getNetworkPorts,
  getSystemErrors,
  getDockerStatus,
  getGitContext,
  getFullSnapshot,
} from '../../lib/system/telemetry-collector.js';

// Mock child_process execSync to avoid real system calls
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
}));

// Mock node:os to return predictable values
vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    cpus: vi.fn(() => [
      { model: 'Test CPU', speed: 2400, times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
    ]),
    totalmem: vi.fn(() => 8 * 1024 * 1024 * 1024), // 8 GB
    freemem: vi.fn(() => 3 * 1024 * 1024 * 1024),  // 3 GB free
    platform: vi.fn(() => 'linux'),
  };
});

vi.mock('../core/platform.js', () => ({
  getPlatform: vi.fn(() => ({
    os: 'linux',
    arch: 'x64',
    isWindows: false,
    isMac: false,
    isLinux: true,
    nodeVersion: 'v20.0.0',
  })),
}));

const { execSync } = await import('node:child_process');
const { totalmem, freemem } = await import('node:os');

beforeEach(() => {
  vi.clearAllMocks();
  execSync.mockReturnValue('');
});

describe('getMemoryUsage()', () => {
  it('returns memory stats object with required fields', () => {
    const mem = getMemoryUsage();
    expect(mem).toHaveProperty('total');
    expect(mem).toHaveProperty('used');
    expect(mem).toHaveProperty('free');
    expect(mem).toHaveProperty('usage');
    expect(mem).toHaveProperty('totalBytes');
    expect(mem).toHaveProperty('usedBytes');
    expect(mem).toHaveProperty('freeBytes');
  });

  it('calculates usage percentage correctly', () => {
    const mem = getMemoryUsage();
    const expectedUsage = Math.round(((8 - 3) / 8) * 100); // 5/8 = 62.5% -> 63
    expect(mem.usage).toBe(expectedUsage);
  });

  it('returns human-readable strings for total, used, free', () => {
    const mem = getMemoryUsage();
    expect(mem.total).toMatch(/\d+(\.\d+)?\s+(B|KB|MB|GB|TB)/);
    expect(mem.used).toMatch(/\d+(\.\d+)?\s+(B|KB|MB|GB|TB)/);
    expect(mem.free).toMatch(/\d+(\.\d+)?\s+(B|KB|MB|GB|TB)/);
  });

  it('returns 0 usage when totalmem returns 0', () => {
    totalmem.mockReturnValueOnce(0);
    freemem.mockReturnValueOnce(0);
    const mem = getMemoryUsage();
    expect(mem.usage).toBe(0);
  });

  it('totalBytes equals totalmem() return value', () => {
    const mem = getMemoryUsage();
    expect(mem.totalBytes).toBe(8 * 1024 * 1024 * 1024);
  });
});

describe('getCpuUsage()', () => {
  it('returns object with usage and topProcesses', () => {
    const result = getCpuUsage();
    expect(result).toHaveProperty('usage');
    expect(result).toHaveProperty('topProcesses');
    expect(Array.isArray(result.topProcesses)).toBe(true);
  });

  it('returns usage >= 0 and <= 100', () => {
    const result = getCpuUsage();
    expect(result.usage).toBeGreaterThanOrEqual(0);
    expect(result.usage).toBeLessThanOrEqual(100);
  });

  it('parses Linux /proc/stat output', () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('/proc/stat')) return 'cpu  100 0 50 850 0 0 0 0';
      if (cmd.includes('ps aux')) return 'USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND\nroot 1 15.5 0.1 1000 500 ? Ss 00:00 0:01 /sbin/init';
      return '';
    });
    const result = getCpuUsage();
    expect(result.usage).toBeGreaterThanOrEqual(0);
  });

  it('handles execSync throwing without crashing', () => {
    execSync.mockImplementation(() => { throw new Error('Permission denied'); });
    const result = getCpuUsage();
    expect(result.usage).toBe(0);
    expect(result.topProcesses).toEqual([]);
  });
});

describe('getDiskUsage()', () => {
  it('returns array', () => {
    const result = getDiskUsage();
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns empty array when execSync returns empty string', () => {
    execSync.mockReturnValue('');
    const result = getDiskUsage();
    expect(result).toEqual([]);
  });

  it('parses Unix df output correctly', () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('df')) {
        return '/dev/sda1       50G   20G   30G  40% /';
      }
      return '';
    });
    const result = getDiskUsage();
    if (result.length > 0) {
      expect(result[0]).toHaveProperty('mount');
      expect(result[0]).toHaveProperty('usage');
    }
  });

  it('each disk entry has required fields', () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('df')) return '/dev/sda1       50G   20G   30G  40% /';
      return '';
    });
    const result = getDiskUsage();
    for (const disk of result) {
      expect(disk).toHaveProperty('mount');
      expect(disk).toHaveProperty('total');
      expect(disk).toHaveProperty('used');
      expect(disk).toHaveProperty('free');
      expect(disk).toHaveProperty('usage');
    }
  });
});

describe('getNetworkPorts()', () => {
  it('returns array', () => {
    const result = getNetworkPorts();
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns empty array when no output', () => {
    execSync.mockReturnValue('');
    const result = getNetworkPorts();
    expect(result).toEqual([]);
  });

  it('deduplicates ports', () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('ss')) {
        return [
          'State  Recv-Q Send-Q  Local Address:Port  Peer Address:Port',
          'LISTEN 0      128     0.0.0.0:3000         0.0.0.0:*       users:(("node",pid=123,fd=4))',
          'LISTEN 0      128     0.0.0.0:3000         0.0.0.0:*       users:(("node",pid=124,fd=4))',
        ].join('\n');
      }
      return '';
    });
    const result = getNetworkPorts();
    const port3000 = result.filter((p) => p.port === 3000);
    expect(port3000.length).toBeLessThanOrEqual(1);
  });

  it('each port entry has required fields', () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('ss')) {
        return 'State  Recv-Q Send-Q  Local Address:Port\nLISTEN 0      0       0.0.0.0:8080  users:(("node",pid=1,fd=4))';
      }
      return '';
    });
    const result = getNetworkPorts();
    for (const entry of result) {
      expect(entry).toHaveProperty('port');
      expect(entry).toHaveProperty('pid');
      expect(entry).toHaveProperty('state');
    }
  });
});

describe('getSystemErrors()', () => {
  it('returns array', () => {
    const result = getSystemErrors();
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns at most 10 entries', () => {
    const manyLines = Array.from({ length: 20 }, (_, i) =>
      `2024-01-01T00:${String(i).padStart(2, '0')}:00 hostname kernel[1]: Error occurred`,
    ).join('\n');
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('journalctl')) return manyLines;
      return '';
    });
    const result = getSystemErrors();
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it('returns empty array on execSync failure', () => {
    execSync.mockImplementation(() => { throw new Error('journalctl failed'); });
    const result = getSystemErrors();
    expect(result).toEqual([]);
  });
});

describe('getDockerStatus()', () => {
  it('returns array', () => {
    const result = getDockerStatus();
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns empty array when docker not available', () => {
    execSync.mockReturnValue(''); // no docker version
    const result = getDockerStatus();
    expect(result).toEqual([]);
  });

  it('parses docker ps output correctly', () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('docker --version')) return 'Docker version 24.0.0';
      if (cmd.includes('docker ps')) return 'mycontainer||Up 2 hours||0.0.0.0:3000->3000/tcp';
      return '';
    });
    const result = getDockerStatus();
    if (result.length > 0) {
      expect(result[0]).toHaveProperty('name');
      expect(result[0]).toHaveProperty('status');
      expect(result[0]).toHaveProperty('ports');
    }
  });

  it('returns empty array when docker ps returns nothing', () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('docker --version')) return 'Docker version 24.0.0';
      return '';
    });
    const result = getDockerStatus();
    expect(result).toEqual([]);
  });
});

describe('getGitContext()', () => {
  it('returns null when not in git repo', () => {
    execSync.mockReturnValue('');
    const result = getGitContext();
    expect(result).toBeNull();
  });

  it('returns git context object when in git repo', () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('rev-parse --abbrev-ref')) return 'master';
      if (cmd.includes('status --short')) return ' M file.js\n?? newfile.js';
      if (cmd.includes('git log')) return 'abc1234 First commit\ndef5678 Second commit';
      return '';
    });
    const result = getGitContext();
    expect(result).not.toBeNull();
    expect(result.branch).toBe('master');
    expect(result.recentCommits).toHaveLength(2);
    expect(result.recentCommits[0].hash).toBe('abc1234');
    expect(result.recentCommits[0].message).toBe('First commit');
  });

  it('returns clean status when no changed files', () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('rev-parse --abbrev-ref')) return 'main';
      if (cmd.includes('status --short')) return '';
      if (cmd.includes('git log')) return '';
      return '';
    });
    const result = getGitContext();
    expect(result.status).toBe('clean');
  });

  it('shows changed file count in status', () => {
    execSync.mockImplementation((cmd) => {
      if (cmd.includes('rev-parse --abbrev-ref')) return 'main';
      if (cmd.includes('status --short')) return ' M a.js\n M b.js\nA  c.js';
      if (cmd.includes('git log')) return '';
      return '';
    });
    const result = getGitContext();
    expect(result.status).toContain('3');
    expect(result.status).toContain('changed');
  });
});

describe('getFullSnapshot()', () => {
  it('returns object with all required keys', () => {
    const snapshot = getFullSnapshot();
    expect(snapshot).toHaveProperty('timestamp');
    expect(snapshot).toHaveProperty('platform');
    expect(snapshot).toHaveProperty('cpu');
    expect(snapshot).toHaveProperty('memory');
    expect(snapshot).toHaveProperty('disk');
    expect(snapshot).toHaveProperty('network');
    expect(snapshot).toHaveProperty('errors');
    expect(snapshot).toHaveProperty('docker');
    expect(snapshot).toHaveProperty('git');
  });

  it('timestamp is a valid ISO string', () => {
    const snapshot = getFullSnapshot();
    expect(() => new Date(snapshot.timestamp)).not.toThrow();
    expect(new Date(snapshot.timestamp).toISOString()).toBe(snapshot.timestamp);
  });

  it('memory field has usage property', () => {
    const snapshot = getFullSnapshot();
    expect(snapshot.memory).toHaveProperty('usage');
  });

  it('accepts cwd option for git context', () => {
    execSync.mockImplementation(() => '');
    const snapshot = getFullSnapshot({ cwd: '/some/path' });
    expect(snapshot).toHaveProperty('git');
  });
});

// ---------------------------------------------------------------------------
// Windows and macOS platform branch tests
// ---------------------------------------------------------------------------
// Since the module reads PLATFORM at import time (Linux), we test the
// platform-specific parsing logic by dynamically re-importing the module
// with different getPlatform mocks.

describe('Platform-specific branches via re-import', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Windows platform', () => {
    let winModule;
    let winExecSync;

    beforeEach(async () => {
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        execSync: vi.fn(() => ''),
      }));
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual('node:os');
        return {
          ...actual,
          cpus: vi.fn(() => [{ model: 'Test CPU', speed: 2400, times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }]),
          totalmem: vi.fn(() => 16 * 1024 * 1024 * 1024),
          freemem: vi.fn(() => 8 * 1024 * 1024 * 1024),
          platform: vi.fn(() => 'win32'),
        };
      });
      vi.doMock('../core/platform.js', () => ({
        getPlatform: vi.fn(() => ({
          os: 'win32',
          arch: 'x64',
          isWindows: true,
          isMac: false,
          isLinux: false,
          nodeVersion: 'v20.0.0',
        })),
      }));
      winModule = await import('../../lib/system/telemetry-collector.js');
      const cp = await import('node:child_process');
      winExecSync = cp.execSync;
      winExecSync.mockReturnValue('');
    });

    it('getCpuUsage parses Windows wmic output', () => {
      winExecSync.mockImplementation((cmd) => {
        if (cmd.includes('wmic cpu')) return 'LoadPercentage=42';
        if (cmd.includes('powershell')) return '1234,chrome,55.2\n5678,node,12.3';
        return '';
      });
      const result = winModule.getCpuUsage();
      expect(result.usage).toBe(42);
      expect(result.topProcesses.length).toBeGreaterThanOrEqual(1);
      expect(result.topProcesses[0].name).toBe('chrome');
      expect(result.topProcesses[0].pid).toBe(1234);
    });

    it('getDiskUsage parses Windows wmic logicaldisk output', () => {
      winExecSync.mockImplementation((cmd) => {
        if (cmd.includes('wmic logicaldisk')) {
          return 'DeviceID=C:\nFreeSpace=50000000000\nSize=250000000000\n\nDeviceID=D:\nFreeSpace=100000000000\nSize=500000000000';
        }
        return '';
      });
      const result = winModule.getDiskUsage();
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].mount).toBe('C:');
      expect(result[0]).toHaveProperty('usage');
      expect(result[0]).toHaveProperty('total');
    });

    it('getNetworkPorts parses Windows netstat output', () => {
      winExecSync.mockImplementation((cmd) => {
        if (cmd.includes('netstat')) {
          return '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234\n  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       5678';
        }
        return '';
      });
      const result = winModule.getNetworkPorts();
      expect(result.length).toBeGreaterThanOrEqual(1);
      const p3000 = result.find((p) => p.port === 3000);
      expect(p3000).toBeDefined();
      expect(p3000.pid).toBe(1234);
    });

    it('getSystemErrors parses Windows PowerShell EventLog output', () => {
      winExecSync.mockImplementation((cmd) => {
        if (cmd.includes('Get-EventLog')) {
          return '2024-01-15T10:30:00||Error||The service failed to start';
        }
        return '';
      });
      const result = winModule.getSystemErrors();
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].timestamp).toBe('2024-01-15T10:30:00');
      expect(result[0].level).toBe('Error');
      expect(result[0].message).toContain('service failed');
    });

    it('getCpuUsage handles empty wmic output gracefully', () => {
      winExecSync.mockReturnValue('');
      const result = winModule.getCpuUsage();
      expect(result.usage).toBe(0);
      expect(result.topProcesses).toEqual([]);
    });
  });

  describe('macOS platform', () => {
    let macModule;
    let macExecSync;

    beforeEach(async () => {
      vi.resetModules();
      vi.doMock('node:child_process', () => ({
        execSync: vi.fn(() => ''),
      }));
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual('node:os');
        return {
          ...actual,
          cpus: vi.fn(() => [{ model: 'Apple M1', speed: 3200, times: { user: 200, nice: 0, sys: 100, idle: 700, irq: 0 } }]),
          totalmem: vi.fn(() => 16 * 1024 * 1024 * 1024),
          freemem: vi.fn(() => 6 * 1024 * 1024 * 1024),
          platform: vi.fn(() => 'darwin'),
        };
      });
      vi.doMock('../core/platform.js', () => ({
        getPlatform: vi.fn(() => ({
          os: 'darwin',
          arch: 'arm64',
          isWindows: false,
          isMac: true,
          isLinux: false,
          nodeVersion: 'v20.0.0',
        })),
      }));
      macModule = await import('../../lib/system/telemetry-collector.js');
      const cp = await import('node:child_process');
      macExecSync = cp.execSync;
      macExecSync.mockReturnValue('');
    });

    it('getCpuUsage parses macOS top output', () => {
      macExecSync.mockImplementation((cmd) => {
        if (cmd.includes('top -l 1')) {
          return [
            'Processes: 350 total, 3 running',
            'CPU usage: 25.5% user, 10.3% sys, 64.2% idle',
            'PID    COMMAND          %CPU',
            '1234   node             15.5',
            '5678   Safari           8.2',
          ].join('\n');
        }
        return '';
      });
      const result = macModule.getCpuUsage();
      expect(result.usage).toBe(36); // 25.5 + 10.3 rounded
      expect(result.topProcesses.length).toBeGreaterThanOrEqual(1);
      expect(result.topProcesses[0].name).toBe('node');
    });

    it('getNetworkPorts parses macOS lsof output', () => {
      macExecSync.mockImplementation((cmd) => {
        if (cmd.includes('lsof')) {
          return 'COMMAND   PID   USER   FD   TYPE    DEVICE SIZE/OFF NODE NAME\nnode      1234  user   22u  IPv4   12345      0t0  TCP *:3000 (LISTEN)';
        }
        return '';
      });
      const result = macModule.getNetworkPorts();
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].port).toBe(3000);
      expect(result[0].pid).toBe(1234);
    });

    it('getSystemErrors parses macOS log show output', () => {
      macExecSync.mockImplementation((cmd) => {
        if (cmd.includes('log show')) {
          return '2024-01-15 10:30:00 kernel[0]: disk I/O error detected';
        }
        return '';
      });
      const result = macModule.getSystemErrors();
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].level).toBe('error');
    });

    it('getCpuUsage returns 0 when top output has no CPU line', () => {
      macExecSync.mockImplementation((cmd) => {
        if (cmd.includes('top -l 1')) return 'some unrelated output';
        return '';
      });
      const result = macModule.getCpuUsage();
      expect(result.usage).toBe(0);
    });

    it('getDiskUsage parses Unix df output on macOS', () => {
      macExecSync.mockImplementation((cmd) => {
        if (cmd.includes('df')) return '/dev/disk1s1     466G  200G  260G    44% /';
        return '';
      });
      const result = macModule.getDiskUsage();
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].mount).toBe('/');
      expect(result[0].usage).toBe(44);
    });
  });
});
