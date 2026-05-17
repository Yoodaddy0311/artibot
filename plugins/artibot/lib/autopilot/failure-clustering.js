/**
 * Failure clustering for autopilot self-improvement (v4.10.0 Track G).
 *
 * Groups repeated `error` / `warn` events into stable signature buckets so the
 * engine can detect recurring failures across iterations and sessions and
 * surface deterministic, pattern-matched fix suggestions.
 *
 * DATA POLICY: pure in-memory analytics over locally-stored events.ndjson.
 * No network I/O. No LLM calls. All suggestions are static pattern matches.
 *
 * Public surface:
 *   - extractErrorSignature(event)
 *   - clusterFailures(events, opts?)
 *   - suggestFix(cluster)
 *
 * @module lib/autopilot/failure-clustering
 */

/** @typedef {{ ts?: string, sessionId?: string, level?: string, type?: string, message?: string }} TelemetryEvent */

/**
 * Default minimum cluster size for which `suggestFix` returns a non-null
 * recommendation. Below this threshold the failure is treated as noise.
 */
export const SUGGEST_FIX_MIN_COUNT = 3;

const HEX_RE = /\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b/gi;
const NUMBER_RE = /\b\d+\b/g;
const PATH_RE = /(?:[A-Za-z]:)?[\\/](?:[^\s'":<>|*?]+[\\/])+[^\s'":<>|*?]+/g;
const QUOTED_RE = /(['"])(?:\\.|(?!\1).)*\1/g;
const WHITESPACE_RE = /\s+/g;

/**
 * Pattern → suggested-fix rules. Order matters: first match wins.
 * Each rule is intentionally narrow + deterministic; broad regexes risk
 * surfacing misleading advice.
 */
const FIX_PATTERNS = Object.freeze([
  {
    id: 'enoent-missing-file',
    test: /enoent|no such file|cannot find module|module not found/i,
    title: 'Missing file or module',
    suggestion:
      'Verify the path exists and case matches. Re-run install (npm ci) if a dependency disappeared; check .gitignore for accidentally untracked source files.',
  },
  {
    id: 'permission-denied',
    test: /eacces|eperm|permission denied|operation not permitted/i,
    title: 'Permission denied',
    suggestion:
      'Close any process holding the file (Windows AV / editor lock). On Unix check file ownership; avoid running autopilot as root.',
  },
  {
    id: 'port-in-use',
    test: /eaddrinuse|port .* in use|address already in use/i,
    title: 'Port already bound',
    suggestion:
      'Another process is on that port. Pick a free port or kill the stale dev server before re-running.',
  },
  {
    id: 'syntax-error',
    test: /syntaxerror|unexpected token|unexpected end of/i,
    title: 'JavaScript syntax error',
    suggestion:
      'Re-read the file around the cited line; common causes are stray comma, mismatched brace, or a `*/` inside a JSDoc block.',
  },
  {
    id: 'type-error-undefined',
    test: /typeerror.*(undefined|null)|cannot read prop|reading '[^']+' of (?:undefined|null)/i,
    title: 'Null/undefined dereference',
    suggestion:
      'Add a null-guard or optional chaining at the dereference site. Trace back the producer to confirm it really may return null.',
  },
  {
    id: 'timeout',
    test: /timeout|timed out|deadline exceeded/i,
    title: 'Operation timed out',
    suggestion:
      'Raise the timeout budget for this step, or split the work into smaller chunks. Check for a hung child process.',
  },
  {
    id: 'lint-fail',
    test: /eslint|lint failed|\d+ errors?, \d+ warnings?/i,
    title: 'Lint failure',
    suggestion:
      'Run `npm run lint -- --fix` on the changed files. Address any remaining errors manually before re-running verification.',
  },
  {
    id: 'test-fail',
    test: /test failed|assertion failed|expected .* to (?:equal|be|match)/i,
    title: 'Test assertion failure',
    suggestion:
      'Re-run the failing test in isolation, inspect the diff between expected and actual, and fix either the test or the implementation — never silently update snapshots.',
  },
  {
    id: 'git-conflict',
    test: /merge conflict|conflict in|unmerged path/i,
    title: 'Git merge conflict',
    suggestion:
      'Resolve conflict markers (<<<<<<<, =======, >>>>>>>) manually. Prefer per-file `git checkout --theirs|--ours` over commit-level merge strategies.',
  },
  {
    id: 'network',
    test: /econnrefused|enetunreach|getaddrinfo|fetch failed/i,
    title: 'Network unreachable',
    suggestion:
      'Network operations are not allowed in autopilot DATA POLICY. Confirm the failing step is local-only; if it must reach a service, gate it behind an offline-safe fallback.',
  },
]);

/**
 * Build a stable signature for a telemetry event by stripping volatile tokens
 * (paths, line numbers, hex addresses, quoted strings) so that two errors that
 * differ only in location collapse into the same cluster.
 *
 * Returns `null` for events that carry no usable message text — callers should
 * skip those rather than create an empty bucket.
 *
 * @param {TelemetryEvent} event
 * @returns {string|null}
 */
export function extractErrorSignature(event) {
  if (!event || typeof event !== 'object') return null;
  const msg = typeof event.message === 'string' ? event.message : '';
  if (!msg.trim()) return null;
  const type = typeof event.type === 'string' ? event.type : '';
  const normalized = msg
    .replace(QUOTED_RE, "'?'")
    .replace(PATH_RE, '<PATH>')
    .replace(HEX_RE, '<HEX>')
    .replace(NUMBER_RE, '<N>')
    .replace(WHITESPACE_RE, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 240);
  return type ? `${type}::${normalized}` : normalized;
}

/**
 * Should this event be considered a failure candidate?
 * Defaults to level === 'error' but accepts an `includeWarn` opt for broader
 * scans during retrospective audits.
 *
 * @param {TelemetryEvent} event
 * @param {{ includeWarn?: boolean }} opts
 * @returns {boolean}
 */
function isFailure(event, opts) {
  if (!event || typeof event !== 'object') return false;
  if (event.level === 'error') return true;
  if (opts && opts.includeWarn && event.level === 'warn') return true;
  return false;
}

/**
 * Pick the lexicographically earliest non-empty timestamp; ISO-8601 strings
 * compare correctly via string ordering so we avoid Date allocation.
 *
 * @param {string|undefined|null} a
 * @param {string|undefined|null} b
 * @returns {string|null}
 */
function minTs(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a < b ? a : b;
}

/**
 * Pick the lexicographically latest non-empty timestamp.
 *
 * @param {string|undefined|null} a
 * @param {string|undefined|null} b
 * @returns {string|null}
 */
function maxTs(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return a > b ? a : b;
}

/**
 * Cluster failure events by stable signature.
 *
 * Returns an array of clusters sorted by descending count (ties broken by
 * earliest firstSeen). Each cluster includes:
 *   - signature: stable hash key
 *   - count: occurrences
 *   - firstSeen / lastSeen: ISO timestamps (or null if events lacked ts)
 *   - sampleMessage: raw message of the first occurrence (untouched)
 *   - sessions: distinct sessionIds the signature appeared in (sorted)
 *
 * @param {TelemetryEvent[]} events injectable for tests
 * @param {{ includeWarn?: boolean, minCount?: number }} [opts]
 * @returns {Array<{
 *   signature: string,
 *   count: number,
 *   firstSeen: string|null,
 *   lastSeen: string|null,
 *   sampleMessage: string,
 *   sessions: string[],
 * }>}
 */
export function clusterFailures(events, opts = {}) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const minCount = Number.isInteger(opts.minCount) && opts.minCount > 0 ? opts.minCount : 1;
  /** @type {Map<string, { signature: string, count: number, firstSeen: string|null, lastSeen: string|null, sampleMessage: string, sessions: Set<string> }>} */
  const buckets = new Map();
  for (const ev of events) {
    if (!isFailure(ev, opts)) continue;
    const sig = extractErrorSignature(ev);
    if (!sig) continue;
    const existing = buckets.get(sig);
    if (!existing) {
      buckets.set(sig, {
        signature: sig,
        count: 1,
        firstSeen: ev.ts || null,
        lastSeen: ev.ts || null,
        sampleMessage: ev.message,
        sessions: new Set(ev.sessionId ? [ev.sessionId] : []),
      });
      continue;
    }
    existing.count += 1;
    existing.firstSeen = minTs(existing.firstSeen, ev.ts);
    existing.lastSeen = maxTs(existing.lastSeen, ev.ts);
    if (ev.sessionId) existing.sessions.add(ev.sessionId);
  }
  const clusters = [];
  for (const bucket of buckets.values()) {
    if (bucket.count < minCount) continue;
    clusters.push({
      signature: bucket.signature,
      count: bucket.count,
      firstSeen: bucket.firstSeen,
      lastSeen: bucket.lastSeen,
      sampleMessage: bucket.sampleMessage,
      sessions: [...bucket.sessions].sort(),
    });
  }
  clusters.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (!a.firstSeen) return 1;
    if (!b.firstSeen) return -1;
    return a.firstSeen < b.firstSeen ? -1 : 1;
  });
  return clusters;
}

/**
 * Match a cluster against the static pattern table and return a deterministic
 * fix recommendation. Returns null when the cluster is below the noise
 * threshold or no rule matches.
 *
 * The shape is intentionally small + serializable so callers (engine, report
 * generator, TUI) can render it without extra logic.
 *
 * @param {{ signature?: string, count?: number, sampleMessage?: string }} cluster
 * @param {{ minCount?: number }} [opts]
 * @returns {{ patternId: string, title: string, suggestion: string, count: number }|null}
 */
export function suggestFix(cluster, opts = {}) {
  if (!cluster || typeof cluster !== 'object') return null;
  const minCount = Number.isInteger(opts.minCount) && opts.minCount > 0
    ? opts.minCount
    : SUGGEST_FIX_MIN_COUNT;
  const count = Number.isInteger(cluster.count) ? cluster.count : 0;
  if (count < minCount) return null;
  const haystack = `${cluster.sampleMessage || ''} ${cluster.signature || ''}`;
  for (const rule of FIX_PATTERNS) {
    if (rule.test.test(haystack)) {
      return {
        patternId: rule.id,
        title: rule.title,
        suggestion: rule.suggestion,
        count,
      };
    }
  }
  return null;
}
