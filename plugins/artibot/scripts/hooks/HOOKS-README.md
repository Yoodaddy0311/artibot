# Artibot hook scripts — author notes

This directory holds every script referenced by `plugins/artibot/hooks/hooks.json` and `plugins/artibot/hooks/dispatch-table.json`.

## Output contract

Every script registered in either of those files MUST emit **at most one** JSON object on stdout (no NDJSON, no concatenated objects). The dispatcher `parseHookStdout()` parses the stream as a single JSON value — multi-line outputs are silently dropped.

## `nightly-*.mjs` policy — DO NOT register in dispatch-table.json

The two `nightly-*.mjs` scripts:

- `nightly-dream-consolidate.mjs`
- `nightly-session-rollup.mjs`

are NDJSON entry points (one JSON object per line, e.g. `process.stdout.write(JSON.stringify(res) + '\n')`). They are designed to be invoked by cron / scheduler / manual operator, **not** by any dispatcher. Adding them to `dispatch-table.json` slot `handlers[]` would cause `parseHookStdout()` to silently drop their output (NDJSON ≠ single JSON), which the dispatcher cannot recover from.

If you ever need a nightly-* script to participate in a dispatcher slot, first convert it to single-JSON output (collect intermediate lines internally and emit one terminal envelope).

## `single-hook` strategy slots (PreCompact)

`dispatch-table.json` v3 introduces `singleHookCommand` + `singleHookTimeoutMs` on `single-hook` strategy slots. These fields MUST stay in sync with the matching entry in `hooks.json` — they are the drift tripwire. When you change either side, update the other in the same PR.
