import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  checkAutopilotAllowed,
  DEFAULT_ALLOWLIST,
  isAutopilotAllowed,
  isRepoInAllowlist,
  loadAllowlist,
  normalizeRepoId,
} from '../../lib/autopilot/repo-identity.js';

describe('repo-identity', () => {
  describe('normalizeRepoId', () => {
    it('strips https origin and .git suffix', () => {
      expect(normalizeRepoId('https://github.com/Yoodaddy0311/artibot.git')).toBe(
        'Yoodaddy0311/artibot'
      );
    });

    it('strips https with embedded credentials', () => {
      expect(
        normalizeRepoId('https://user:tok@github.com/Yoodaddy0311/artibot.git')
      ).toBe('Yoodaddy0311/artibot');
    });

    it('strips ssh git@ form', () => {
      expect(normalizeRepoId('git@github.com:Yoodaddy0311/artibot.git')).toBe(
        'Yoodaddy0311/artibot'
      );
    });

    it('strips ssh:// form', () => {
      expect(
        normalizeRepoId('ssh://git@github.com/Yoodaddy0311/artibot.git')
      ).toBe('Yoodaddy0311/artibot');
    });

    it('handles missing .git suffix', () => {
      expect(normalizeRepoId('https://github.com/Yoodaddy0311/artibot')).toBe(
        'Yoodaddy0311/artibot'
      );
    });

    it('handles trailing slash', () => {
      expect(normalizeRepoId('https://github.com/Yoodaddy0311/artibot/')).toBe(
        'Yoodaddy0311/artibot'
      );
    });

    it('returns empty for empty input', () => {
      expect(normalizeRepoId('')).toBe('');
      expect(normalizeRepoId(null)).toBe('');
      expect(normalizeRepoId(undefined)).toBe('');
    });

    it('returns empty for non-string input', () => {
      expect(normalizeRepoId(123)).toBe('');
      expect(normalizeRepoId({})).toBe('');
    });
  });

  describe('isRepoInAllowlist', () => {
    const allowlist = {
      version: 1,
      repos: ['Yoodaddy0311/artibot', 'Yoodaddy0311/artibot-swarm'],
    };

    it('returns true for allowlisted https URL', () => {
      expect(
        isRepoInAllowlist(
          'https://github.com/Yoodaddy0311/artibot.git',
          allowlist
        )
      ).toBe(true);
    });

    it('returns true for allowlisted ssh URL', () => {
      expect(
        isRepoInAllowlist('git@github.com:Yoodaddy0311/artibot.git', allowlist)
      ).toBe(true);
    });

    it('returns true for second allowlisted repo', () => {
      expect(
        isRepoInAllowlist(
          'https://github.com/Yoodaddy0311/artibot-swarm.git',
          allowlist
        )
      ).toBe(true);
    });

    it('returns false for non-allowlisted repo (Carib)', () => {
      expect(
        isRepoInAllowlist(
          'https://github.com/Yoodaddy0311/carib-website.git',
          allowlist
        )
      ).toBe(false);
    });

    it('returns false for empty URL', () => {
      expect(isRepoInAllowlist('', allowlist)).toBe(false);
    });

    it('returns false when allowlist has empty repos array', () => {
      expect(
        isRepoInAllowlist(
          'https://github.com/Yoodaddy0311/artibot.git',
          { version: 1, repos: [] }
        )
      ).toBe(false);
    });

    it('returns false when allowlist is malformed', () => {
      expect(
        isRepoInAllowlist(
          'https://github.com/Yoodaddy0311/artibot.git',
          { version: 1 }
        )
      ).toBe(false);
    });
  });

  describe('loadAllowlist', () => {
    it('returns DEFAULT_ALLOWLIST when file path does not exist', () => {
      const result = loadAllowlist('/nonexistent/path/allowlist.json');
      expect(result).toBe(DEFAULT_ALLOWLIST);
    });

    it('DEFAULT_ALLOWLIST contains the artibot repos', () => {
      expect(DEFAULT_ALLOWLIST.repos).toContain('Yoodaddy0311/artibot');
      expect(DEFAULT_ALLOWLIST.repos).toContain('Yoodaddy0311/artibot-swarm');
    });

    it('DEFAULT_ALLOWLIST is frozen (immutable)', () => {
      expect(Object.isFrozen(DEFAULT_ALLOWLIST)).toBe(true);
    });
  });

  describe('checkAutopilotAllowed (the verdict plus what it computed)', () => {
    // A remote on NO allowlist, so the verdict does not depend on whatever
    // `~/.claude/artibot/autopilot-allowlist.json` the machine running this has.
    let root;
    let withRemote;
    let withoutRemote;
    let notARepo;

    const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });

    beforeAll(() => {
      root = mkdtempSync(path.join(os.tmpdir(), 'artibot-gate-'));
      withRemote = path.join(root, 'with-remote');
      withoutRemote = path.join(root, 'without-remote');
      notARepo = path.join(root, 'plain');
      for (const dir of [withRemote, withoutRemote, notARepo]) mkdirSync(dir, { recursive: true });
      git(['init', '-q', '-b', 'main', '.'], withRemote);
      git(['remote', 'add', 'origin', 'git@github.com:Example/Not-Listed.git'], withRemote);
      git(['init', '-q', '-b', 'main', '.'], withoutRemote);
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('hands over the raw remote and its canonical owner/name, case kept', () => {
      const gate = checkAutopilotAllowed(withRemote);
      expect(gate.remote).toBe('git@github.com:Example/Not-Listed.git');
      // The case of the URL is kept; lib/git/repo-identity.js lower-cases it.
      expect(gate.repoId).toBe('Example/Not-Listed');
      expect(gate.allowed).toBe(false);
    });

    it('answers empty strings, not undefined, for a repo with no origin and for a non-repo', () => {
      expect(checkAutopilotAllowed(withoutRemote)).toEqual({ allowed: false, remote: '', repoId: '' });
      expect(checkAutopilotAllowed(notARepo)).toEqual({ allowed: false, remote: '', repoId: '' });
    });

    it('is exactly what isAutopilotAllowed answers, which is now a thin wrapper', () => {
      for (const dir of [withRemote, withoutRemote, notARepo]) {
        expect(isAutopilotAllowed(dir)).toBe(checkAutopilotAllowed(dir).allowed);
      }
    });
  });
});
