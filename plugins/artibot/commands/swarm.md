---
description: Federated Swarm Intelligence - manage collective learning participation
argument-hint: '[action] e.g. "스웜 동기화 상태 확인"'
allowed-tools: [Read, Bash, TodoWrite]
---

# /sc swarm

Manage participation in the Federated Swarm Intelligence network. Share anonymized learning patterns with the community and benefit from collective intelligence.

## Arguments

Parse $ARGUMENTS:
- `status`: Show current sync status, opt-in state, and pending operations
- `sync`: Force an immediate synchronization (upload local patterns + download global weights)
- `opt-in`: Enable swarm participation (requires explicit user consent)
- `opt-out`: Disable swarm participation and stop all sync activity
- `stats`: Show contribution statistics (uploads, downloads, rank)

## Subcommands

### `/sc swarm status`

Display current swarm intelligence status:

1. Read `~/.claude/artibot/swarm-sync-state.json`
2. Report:
   - **Participation**: opt-in / opt-out
   - **Last Upload**: timestamp or "never"
   - **Last Download**: timestamp or "never"
   - **Pending Uploads**: count of offline-queued items
   - **Current Version**: local weight version
   - **Sync Interval**: session / hourly / daily
   - **Total Syncs**: upload count + download count
3. Check server health and report latency

### `/sc swarm sync`

Force an immediate sync cycle:

1. Verify opt-in status (refuse if not opted in)
2. Flush any offline-queued uploads
3. Package local patterns (tool success rates, error patterns, team compositions)
4. Apply PII scrubbing and differential privacy noise
5. Upload to swarm server
6. Download latest global weights
7. Merge global weights into local patterns (default ratio: local 30%, global 70%)
8. Report results:
   - Patterns uploaded / downloaded
   - New version received
   - Merge statistics

### `/sc swarm opt-in`

Enable swarm participation:

1. Explain what data is shared:
   - Anonymized tool usage success rates
   - Error pattern signatures (hashed, no original messages)
   - Command effectiveness scores
   - Team composition patterns
2. Explain privacy protections:
   - PII scrubbing before upload
   - Differential privacy noise (Laplacian mechanism, epsilon=1.0)
   - SHA-256 anonymization of all identifiers
   - No source code or file paths shared
3. Require explicit confirmation
4. Update `artibot.config.json` -> `swarm.optIn = true`
5. Perform initial download of global weights

### `/sc swarm opt-out`

Disable swarm participation:

1. Cancel any scheduled sync timers
2. Update `artibot.config.json` -> `swarm.optIn = false`
3. Confirm: local patterns are retained, only sync is stopped
4. Optionally purge cached global weights

### `/sc swarm stats`

Show contribution statistics:

1. Read local sync state for upload/download counts
2. Query server for contribution rank (if available)
3. Show local pattern summary:
   - Total patterns by type (tool, error, success, team)
   - Average confidence across patterns
   - Patterns eligible for upload (sample size >= 3, confidence >= 0.4)
4. Show merge statistics from last sync

## Privacy Guarantees

All swarm operations enforce:
- **PII Scrubber**: Strips file paths, usernames, project names, API keys before upload
- **Differential Privacy**: Laplacian noise with configurable epsilon (default 1.0)
- **Anonymization**: All keys hashed with SHA-256 (only first 12 chars used)
- **Size Limit**: Maximum 5MB per upload
- **Opt-in Only**: Never syncs without explicit user consent

## Error Handling

- Network unavailable: Queue upload for later, report offline status
- Server unhealthy: Show degraded status, skip sync
- Checksum mismatch on download: Reject corrupted weights, keep local
- Not opted in: Refuse sync operations with clear message
