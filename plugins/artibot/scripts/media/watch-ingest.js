#!/usr/bin/env node
/**
 * `/watch` engine — ingest a YouTube video into a locally-readable form.
 *
 * Two modes, both LOCAL-ONLY (YouTube → disk inbound; never uploads or calls a
 * third-party API — DATA POLICY):
 *   - transcript (default): pull public captions via yt-dlp (manual > auto,
 *     ko > en), clean the VTT into plain text at
 *     `.artibot/media/<id>/transcript.txt`. No video download.
 *   - balanced: the above + a lowest-quality temp download, ffmpeg scene-cut
 *     keyframes (default 24, hard cap 50) to `.artibot/media/<id>/frames/NNN.jpg`,
 *     then the temp video is deleted.
 *
 * Output (stdout): a single JSON object the /watch command reads, then Claude
 * reads transcript.txt / frames with the Read tool to interpret the video.
 *
 * Zero runtime deps. System binaries (yt-dlp, ffmpeg) are spawned; if either is
 * missing the script degrades gracefully (exit 0 + `{ error, hint }`) and never
 * throws, so the command surfaces a friendly install note instead of a stack.
 * The spawn/exists effects are injectable (`deps`) so tests exercise the
 * pipeline without real binaries — matching the theme-apply.js DI pattern.
 *
 * Usage: node watch-ingest.js <youtube-url> [--mode transcript|balanced]
 *                             [--frames] [--max-frames N]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, cwd } from 'node:process';
import { isMainEntry } from '../hooks/_main-entry.js';

const DEFAULT_MAX_FRAMES = 24;
const HARD_CAP_FRAMES = 50;
const SCENE_THRESHOLD = 0.3;

/** Clamp a requested frame count to (0, HARD_CAP_FRAMES]; fall back to the default. */
export function capFrames(requested, def = DEFAULT_MAX_FRAMES) {
  const n = typeof requested === 'number' ? requested : parseInt(requested, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, HARD_CAP_FRAMES);
}

/** Parse argv into { url, mode, maxFrames }. `--frames` is an alias for balanced mode. */
export function parseArgs(argvArr) {
  const args = argvArr.slice(2);
  const url = args.find((a) => !a.startsWith('--')) || '';
  let mode = 'transcript';
  const modeIdx = args.indexOf('--mode');
  if (modeIdx !== -1 && args[modeIdx + 1]) mode = args[modeIdx + 1];
  if (args.includes('--frames')) mode = 'balanced';
  const mfIdx = args.indexOf('--max-frames');
  const maxFrames = mfIdx !== -1 && args[mfIdx + 1] ? capFrames(args[mfIdx + 1]) : DEFAULT_MAX_FRAMES;
  return { url, mode: mode === 'balanced' ? 'balanced' : 'transcript', maxFrames };
}

/** Extract a YouTube video id from common URL shapes; null if unrecognizable. */
export function extractVideoId(url) {
  const m = String(url).match(/(?:v=|\/shorts\/|youtu\.be\/|\/embed\/)([A-Za-z0-9_-]{11})/) ||
    String(url).match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}

/**
 * True if a URL's host is YouTube (youtube.com + www/m/music subdomains, youtu.be).
 * A bare 11-char id (no `://`) is host-less and allowed. /watch is YouTube-only,
 * so this keeps yt-dlp's broad site support from opening a non-YouTube fetch path.
 */
export function isYouTubeHost(url) {
  const s = String(url);
  if (!/:\/\//.test(s)) return true; // bare id or path — no host to reject
  let host;
  try { host = new URL(s).hostname.toLowerCase(); } catch { return false; }
  return host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com');
}

/** Validate a YouTube URL/ID. Returns { ok, videoId } or { ok:false, error, hint }. */
export function validateUrl(url) {
  if (!url) return { ok: false, error: 'no_url', hint: '사용법: node watch-ingest.js <youtube-url> [--mode transcript|balanced] [--max-frames N]' };
  if (!isYouTubeHost(url)) return { ok: false, error: 'bad_url', hint: '유튜브 URL만 지원합니다(youtube.com / youtu.be). 다른 사이트 주소는 처리하지 않습니다.' };
  const videoId = extractVideoId(url);
  if (!videoId) return { ok: false, error: 'bad_url', hint: '유튜브 URL에서 영상 ID를 찾지 못했습니다. https://youtube.com/watch?v=... 형태를 사용하세요.' };
  return { ok: true, videoId };
}

/**
 * Build the on-disk output dir for a video id, rejecting anything that isn't the
 * canonical 11-char id so a crafted "id" can never escape `.artibot/media/`.
 * @returns {string|null} absolute-ish dir path, or null if the id is unsafe.
 */
export function sanitizeOutputPath(videoId, base = join(cwd(), '.artibot', 'media')) {
  if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  return join(base, videoId);
}

/** Strip a WebVTT/SRT caption blob to deduped plain text (drops cues, tags, timing). */
export function cleanVtt(vtt) {
  const lines = String(vtt).split(/\r?\n/);
  const out = [];
  let prev = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === 'WEBVTT' || /^\d+$/.test(line)) continue;
    if (line.includes('-->') || /^(Kind|Language|NOTE|STYLE):/i.test(line)) continue;
    const text = line.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (text && text !== prev) { out.push(text); prev = text; }
  }
  return out.join('\n');
}

/** Spawn a binary, resolving { code, stdout, stderr }. Rejects only on ENOENT (binary absent). */
function run(bin, args, deps) {
  const spawnFn = deps.spawn ?? spawn;
  return new Promise((resolve, reject) => {
    const child = spawnFn(bin, args, {});
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** True if a binary is resolvable (spawn without ENOENT). */
async function hasBinary(bin, deps) {
  try {
    await run(bin, ['--version'], deps);
    return true;
  } catch {
    return false;
  }
}

/** Find the caption file yt-dlp wrote (ko preferred, else en, else any *.vtt). */
function pickCaptionFile(dir) {
  const vtts = readdirSync(dir).filter((f) => f.endsWith('.vtt'));
  if (vtts.length === 0) return null;
  return vtts.find((f) => /\.ko\./.test(f)) || vtts.find((f) => /\.en\./.test(f)) || vtts[0];
}

/** yt-dlp captions (manual + auto, ko/en). Returns { transcriptPath, title } or { error }. */
async function ingestTranscript(url, videoId, outDir, deps) {
  const existsFn = deps.exists ?? existsSync;
  const subDir = join(outDir, '_subs');
  mkdirSync(subDir, { recursive: true });
  const res = await run('yt-dlp', [
    '--skip-download', '--write-subs', '--write-auto-subs',
    '--sub-langs', 'ko,en,ko-orig,en-orig', '--sub-format', 'vtt',
    '--print', 'title', '--no-warnings',
    '-o', join(subDir, '%(id)s.%(ext)s'), url,
  ], deps);
  const title = (res.stdout || '').trim().split(/\r?\n/)[0] || videoId;
  const capFile = existsFn(subDir) ? pickCaptionFile(subDir) : null;
  if (!capFile) {
    rmSync(subDir, { recursive: true, force: true });
    return { title, error: 'no_captions', hint: '이 영상에는 공개 자막(수동/자동)이 없습니다. 다른 영상을 시도하거나 --frames 모드로 화면만 분석하세요.' };
  }
  const transcriptPath = join(outDir, 'transcript.txt');
  writeFileSync(transcriptPath, cleanVtt(readFileSync(join(subDir, capFile), 'utf8')));
  rmSync(subDir, { recursive: true, force: true });
  return { title, transcriptPath };
}

/** Lowest-quality temp download + ffmpeg scene-cut keyframes. Returns { frames, error? }. */
async function ingestFrames(url, videoId, outDir, maxFrames, deps) {
  const existsFn = deps.exists ?? existsSync;
  const dl = await run('yt-dlp', [
    '-f', 'worst[ext=mp4]/worst', '--no-warnings',
    '-o', join(outDir, `_tmp_${videoId}.%(ext)s`), url,
  ], deps);
  const tmpVideo = readdirSync(outDir).find((f) => f.startsWith(`_tmp_${videoId}.`));
  if (dl.code !== 0 || !tmpVideo) {
    return { frames: [], error: 'download_failed', hint: '영상 다운로드에 실패했습니다(비공개/연령제한/지역제한 가능). 자막만 추출됩니다.' };
  }
  const tmpPath = join(outDir, tmpVideo);
  const framesDir = join(outDir, 'frames');
  mkdirSync(framesDir, { recursive: true });
  const ff = await run('ffmpeg', [
    '-i', tmpPath, '-vf', `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
    '-vsync', 'vfr', '-frames:v', String(maxFrames), '-q:v', '3', join(framesDir, '%03d.jpg'),
  ], deps);
  rmSync(tmpPath, { force: true });
  const frames = existsFn(framesDir)
    ? readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort().map((f) => join(framesDir, f))
    : [];
  if (frames.length === 0) return { frames: [], error: ff.code === 0 ? 'no_scene_changes' : 'ffmpeg_failed', hint: '장면 전환 키프레임을 추출하지 못했습니다.' };
  return { frames };
}

/**
 * Full ingest pipeline. Effects are injectable via `deps` ({ spawn, exists }) so
 * tests drive it without real binaries. Returns the result object (also the
 * stdout JSON shape). Never throws — failures surface as `error`/`*Error` fields.
 */
export async function ingest({ url, mode = 'transcript', maxFrames = DEFAULT_MAX_FRAMES }, deps = {}) {
  const v = validateUrl(url);
  if (!v.ok) return { error: v.error, hint: v.hint };
  const { videoId } = v;

  if (!(await hasBinary('yt-dlp', deps))) {
    return { videoId, error: 'yt_dlp_missing', hint: 'yt-dlp가 설치되어 있지 않습니다. 설치: winget install yt-dlp.yt-dlp (또는 pip install yt-dlp). 설치 후 다시 시도하세요.' };
  }
  if (mode === 'balanced' && !(await hasBinary('ffmpeg', deps))) {
    return { videoId, error: 'ffmpeg_missing', hint: 'ffmpeg가 설치되어 있지 않습니다(--frames 모드에 필요). 설치: winget install Gyan.FFmpeg. 자막만 원하면 --mode transcript를 쓰세요.' };
  }

  const outDir = sanitizeOutputPath(videoId);
  if (!outDir) return { videoId, error: 'bad_url', hint: '영상 ID 형식이 올바르지 않습니다.' };
  mkdirSync(outDir, { recursive: true });

  const result = { videoId, mode, title: videoId, transcriptPath: null, frames: [], durations: {} };
  const t0 = Date.now();
  const tr = await ingestTranscript(url, videoId, outDir, deps);
  result.title = tr.title || videoId;
  if (tr.transcriptPath) result.transcriptPath = tr.transcriptPath;
  else result.transcriptError = { error: tr.error, hint: tr.hint };
  result.durations.transcriptMs = Date.now() - t0;

  if (mode === 'balanced') {
    const t1 = Date.now();
    const fr = await ingestFrames(url, videoId, outDir, maxFrames, deps);
    result.frames = fr.frames;
    if (fr.error) result.framesError = { error: fr.error, hint: fr.hint };
    result.durations.framesMs = Date.now() - t1;
  }
  return result;
}

async function main() {
  const result = await ingest(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

// Run only as a CLI entry point; importing (tests) gets the exported helpers
// without triggering ingestion.
const isDirectRun = isMainEntry(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    // Absolute last resort — never let /watch die on a stack trace.
    process.stdout.write(`${JSON.stringify({ error: 'unexpected', hint: String((err && err.message) || err) }, null, 2)}\n`);
  });
}
