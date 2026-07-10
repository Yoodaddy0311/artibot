/**
 * Tests for scripts/media/watch-ingest.js — the `/watch` YouTube ingest engine.
 *
 * Three layers:
 *   1. Pure-helper unit tests (parseArgs, capFrames, extractVideoId, validateUrl,
 *      isYouTubeHost, sanitizeOutputPath, cleanVtt) — imported directly. The SUT
 *      guards its main() (direct-run check) so importing does NOT run the pipeline.
 *   2. Pipeline tests via dependency injection — ingest({...}, { spawn, exists })
 *      is driven with a mock spawn (no real yt-dlp/ffmpeg, no network) to exercise
 *      transcript success and binary-missing degradation.
 *   3. CLI-contract tests via subprocess — spawn `node watch-ingest.js` with a
 *      PATH that hides yt-dlp/ffmpeg, asserting graceful degradation (exit 0 +
 *      JSON { error, hint } in Korean). No real network or yt-dlp (DATA POLICY: local-only).
 *
 * @module tests/scripts/watch-ingest
 */

import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, '..', '..');
const SCRIPT = join(PLUGIN_ROOT, 'scripts', 'media', 'watch-ingest.js');
const VALIDATE_COMMANDS = join(PLUGIN_ROOT, 'scripts', 'ci', 'validate-commands.js');

// Import the SUT's pure helpers. If the module doesn't export them yet (TDD RED
// window before sl-dev adds the exports), `mod` fields are undefined and the
// pure-helper `it`s below fail with a clear message rather than crashing collect.
let mod = {};
try {
  mod = await import('../../scripts/media/watch-ingest.js');
} catch {
  mod = {};
}

/** Run the CLI in a subprocess. `hideBins` empties PATH so yt-dlp/ffmpeg resolve as missing. */
function runCli(args, { hideBins = false } = {}) {
  const env = { ...process.env };
  if (hideBins) env.PATH = '';
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* leave null */ }
  return { ...r, json };
}

describe('parseArgs (pure)', () => {
  it('defaults to transcript mode and 24 frames', () => {
    expect(typeof mod.parseArgs, 'watch-ingest.js must export parseArgs').toBe('function');
    const p = mod.parseArgs(['node', 'watch-ingest.js', 'https://youtu.be/dQw4w9WgXcQ']);
    expect(p.mode).toBe('transcript');
    expect(p.maxFrames).toBe(24);
    expect(p.url).toBe('https://youtu.be/dQw4w9WgXcQ');
  });

  it('--frames switches to balanced mode', () => {
    expect(typeof mod.parseArgs).toBe('function');
    expect(mod.parseArgs(['n', 's', 'URL', '--frames']).mode).toBe('balanced');
    expect(mod.parseArgs(['n', 's', 'URL', '--mode', 'balanced']).mode).toBe('balanced');
  });

  it('caps --max-frames at the hard cap of 50 and floors invalid values to the default', () => {
    expect(typeof mod.parseArgs).toBe('function');
    expect(mod.parseArgs(['n', 's', 'URL', '--max-frames', '10']).maxFrames).toBe(10);
    expect(mod.parseArgs(['n', 's', 'URL', '--max-frames', '999']).maxFrames).toBe(50);
    expect(mod.parseArgs(['n', 's', 'URL', '--max-frames', '-5']).maxFrames).toBe(24);
    expect(mod.parseArgs(['n', 's', 'URL', '--max-frames', 'abc']).maxFrames).toBe(24);
  });

  it('an unknown --mode falls back to transcript (never a third mode)', () => {
    expect(typeof mod.parseArgs).toBe('function');
    expect(mod.parseArgs(['n', 's', 'URL', '--mode', 'evil; rm -rf /']).mode).toBe('transcript');
  });
});

describe('capFrames (pure)', () => {
  it('defaults invalid/negative/NaN to 24 and clamps at the hard cap of 50', () => {
    expect(typeof mod.capFrames, 'watch-ingest.js must export capFrames').toBe('function');
    expect(mod.capFrames(10)).toBe(10);
    expect(mod.capFrames('10')).toBe(10);
    expect(mod.capFrames(999)).toBe(50);
    expect(mod.capFrames(-5)).toBe(24);
    expect(mod.capFrames('abc')).toBe(24);
    expect(mod.capFrames(0)).toBe(24);
  });
});

describe('extractVideoId (pure)', () => {
  it('extracts the 11-char id from common YouTube URL shapes', () => {
    expect(typeof mod.extractVideoId, 'watch-ingest.js must export extractVideoId').toBe('function');
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'dQw4w9WgXcQ',
    ]) {
      expect(mod.extractVideoId(url), url).toBe('dQw4w9WgXcQ');
    }
  });

  it('rejects garbage and injection strings that contain no valid id token (returns null)', () => {
    expect(typeof mod.extractVideoId).toBe('function');
    for (const bad of [
      'not a url',
      '../../etc/passwd',
      '$(rm -rf /)',
      'https://youtube.com/watch?v=<script>',
      '',
    ]) {
      expect(mod.extractVideoId(bad), bad).toBeNull();
    }
  });

  it('is a host-agnostic token extractor by design — host enforcement lives in validateUrl', () => {
    // Two-layer split: extractVideoId only pulls the 11-char token from a marker
    // (v=/embed/shorts/youtu.be), so it still matches on a non-YouTube host. The
    // host allow-list is enforced one layer up in validateUrl()/isYouTubeHost()
    // (see below), which is the gate the pipeline actually calls. This documents
    // the deliberate separation, not a gap.
    expect(typeof mod.extractVideoId).toBe('function');
    expect(mod.extractVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
});

describe('isYouTubeHost (pure — host allow-list)', () => {
  it('accepts youtube.com, its www/m/music subdomains, youtu.be, and a bare id', () => {
    expect(typeof mod.isYouTubeHost, 'watch-ingest.js must export isYouTubeHost').toBe('function');
    for (const good of [
      'https://youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'dQw4w9WgXcQ',
    ]) {
      expect(mod.isYouTubeHost(good), good).toBe(true);
    }
  });

  it('rejects foreign hosts AND the youtube.com.evil.com suffix-spoof (endsWith .youtube.com guard)', () => {
    expect(typeof mod.isYouTubeHost).toBe('function');
    for (const bad of [
      'https://example.com/watch?v=dQw4w9WgXcQ',
      'https://evil.com/embed/dQw4w9WgXcQ',
      'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
    ]) {
      expect(mod.isYouTubeHost(bad), bad).toBe(false);
    }
  });
});

describe('validateUrl (pure)', () => {
  it('returns { ok:false, error:no_url } for an empty url', () => {
    expect(typeof mod.validateUrl, 'watch-ingest.js must export validateUrl').toBe('function');
    const r = mod.validateUrl('');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_url');
    expect(r.hint).toMatch(/[가-힣]/);
  });

  it('returns { ok:false, error:bad_url } for a non-parseable / injection url', () => {
    expect(typeof mod.validateUrl).toBe('function');
    const r = mod.validateUrl('../../etc/passwd');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bad_url');
    expect(r.hint).toMatch(/[가-힣]/);
  });

  it('returns { ok:true, videoId } for a valid YouTube URL', () => {
    expect(typeof mod.validateUrl).toBe('function');
    const r = mod.validateUrl('https://youtu.be/dQw4w9WgXcQ');
    expect(r.ok).toBe(true);
    expect(r.videoId).toBe('dQw4w9WgXcQ');
  });

  it('rejects a non-YouTube host even when it carries a valid id token (host allow-list)', () => {
    // The gate that closes the host gap: a token-bearing foreign host is bad_url.
    expect(typeof mod.validateUrl).toBe('function');
    for (const foreign of [
      'https://example.com/watch?v=dQw4w9WgXcQ',
      'https://vimeo.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
    ]) {
      const r = mod.validateUrl(foreign);
      expect(r.ok, foreign).toBe(false);
      expect(r.error, foreign).toBe('bad_url');
      expect(r.hint).toMatch(/[가-힣]/);
    }
  });
});

describe('sanitizeOutputPath (pure — path traversal guard)', () => {
  it('accepts only the canonical 11-char id and rejects traversal / Korean / crafted ids', () => {
    expect(typeof mod.sanitizeOutputPath, 'watch-ingest.js must export sanitizeOutputPath').toBe('function');
    const ok = mod.sanitizeOutputPath('dQw4w9WgXcQ', '/base');
    expect(ok).toMatch(/dQw4w9WgXcQ$/);
    for (const bad of ['../../etc', '..', '앞뒤로한글일레', 'short', 'waytoolongvideoid', '../nope', '']) {
      expect(mod.sanitizeOutputPath(bad, '/base'), bad).toBeNull();
    }
  });
});

describe('cleanVtt (pure)', () => {
  it('strips WEBVTT header, cue numbers, timestamps, and inline tags; dedups repeats', () => {
    expect(typeof mod.cleanVtt, 'watch-ingest.js must export cleanVtt').toBe('function');
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      'Language: ko',
      '',
      '1',
      '00:00:01.000 --> 00:00:03.000',
      '<c>안녕하세요</c>',
      '',
      '2',
      '00:00:03.000 --> 00:00:05.000',
      '안녕하세요',
      '',
      '3',
      '00:00:05.000 --> 00:00:07.000',
      'world',
    ].join('\n');
    const out = mod.cleanVtt(vtt);
    expect(out).toBe('안녕하세요\nworld');
    expect(out).not.toContain('-->');
    expect(out).not.toContain('WEBVTT');
    expect(out).not.toContain('<c>');
  });
});

describe('ingest (pipeline via injected spawn — no real binaries, no network)', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'watch-ingest-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  /**
   * Build a fake spawn. `mode: 'ok'` makes yt-dlp "write" a .vtt into the -o dir
   * and print a title; `mode: 'enoent'` makes every spawn fail as if the binary
   * is absent. Returns an EventEmitter child with stdout/stderr, per the contract.
   */
  function fakeSpawn(mode) {
    return (bin, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      if (mode === 'enoent') {
        queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
        return child;
      }
      queueMicrotask(() => {
        // Emulate yt-dlp writing a caption file into the -o template's dir.
        const oIdx = args.indexOf('-o');
        if (oIdx !== -1 && args[oIdx + 1] && args.includes('--write-subs')) {
          const outTpl = args[oIdx + 1];
          const dir = dirname(outTpl);
          try {
            writeFileSync(join(dir, 'vid.ko.vtt'), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n테스트 자막\n');
          } catch { /* dir may not exist in odd cases; ingest handles no_captions */ }
          child.stdout.emit('data', 'Mock Title\n');
        }
        child.emit('close', 0);
      });
      return child;
    };
  }

  it('yt_dlp_missing when the injected spawn reports ENOENT (graceful, no throw)', async () => {
    expect(typeof mod.ingest, 'watch-ingest.js must export ingest').toBe('function');
    const res = await mod.ingest(
      { url: 'https://youtu.be/dQw4w9WgXcQ' },
      { spawn: fakeSpawn('enoent'), exists: () => false },
    );
    expect(res.error).toBe('yt_dlp_missing');
    expect(res.videoId).toBe('dQw4w9WgXcQ');
    expect(res.hint).toMatch(/[가-힣]/);
  });

  it('transcript success: injected spawn writes a caption file → { title, transcriptPath }', async () => {
    expect(typeof mod.ingest).toBe('function');
    const res = await mod.ingest(
      { url: 'https://youtu.be/dQw4w9WgXcQ' },
      { spawn: fakeSpawn('ok'), exists: existsSync },
    );
    expect(res.videoId).toBe('dQw4w9WgXcQ');
    expect(res.title).toBe('Mock Title');
    expect(res.transcriptPath).toBeTruthy();
    // The written transcript is the cleaned caption text (no VTT scaffolding).
    const text = readFileSync(res.transcriptPath, 'utf8');
    expect(text).toContain('테스트 자막');
    expect(text).not.toContain('WEBVTT');
    // Clean up the .artibot/media/<id> dir the pipeline created under cwd.
    rmSync(join(process.cwd(), '.artibot', 'media', res.videoId), { recursive: true, force: true });
  });

  it('rejects a non-YouTube host before ever spawning (returns bad_url)', async () => {
    expect(typeof mod.ingest).toBe('function');
    let spawned = false;
    const res = await mod.ingest(
      { url: 'https://example.com/watch?v=dQw4w9WgXcQ' },
      { spawn: () => { spawned = true; return new EventEmitter(); } },
    );
    expect(res.error).toBe('bad_url');
    expect(spawned, 'must not spawn any binary for a rejected host').toBe(false);
  });
});

describe('CLI contract via subprocess (no network, no real yt-dlp)', () => {
  it('emits { error: no_url } with a Korean hint and exits 0 when no URL is given', () => {
    const r = runCli([]);
    expect(r.status).toBe(0);
    expect(r.json?.error).toBe('no_url');
    expect(r.json?.hint).toMatch(/[가-힣]/);
  });

  it('emits { error: bad_url } for a non-YouTube / injection URL and exits 0', () => {
    const r = runCli(['../../etc/passwd']);
    expect(r.status).toBe(0);
    expect(r.json?.error).toBe('bad_url');
    expect(r.json?.hint).toMatch(/[가-힣]/);
  });

  it('degrades gracefully to { error: yt_dlp_missing } when the binary is absent (PATH hidden)', () => {
    const r = runCli(['https://youtu.be/dQw4w9WgXcQ'], { hideBins: true });
    expect(r.status).toBe(0);
    expect(r.json?.error).toBe('yt_dlp_missing');
    expect(r.json?.videoId).toBe('dQw4w9WgXcQ');
    expect(r.json?.hint).toMatch(/yt-dlp/);
    expect(r.json?.hint).toMatch(/[가-힣]/);
  });

  it('never throws a raw stack — stdout is always parseable JSON', () => {
    const r = runCli(['https://youtu.be/dQw4w9WgXcQ'], { hideBins: true });
    expect(r.json).not.toBeNull();
    expect(r.stderr).not.toMatch(/at .+\(.+:\d+:\d+\)/); // no node stack frames
  });
});

describe('watch.md passes command validation', () => {
  it('watch.md exists with required frontmatter (validate-commands exits 0)', () => {
    const watchMd = join(PLUGIN_ROOT, 'commands', 'watch.md');
    expect(existsSync(watchMd), 'commands/watch.md must exist').toBe(true);
    const r = spawnSync(process.execPath, [VALIDATE_COMMANDS], { encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/PASS: watch\.md/);
  });
});
