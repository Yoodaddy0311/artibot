#!/usr/bin/env node
// Artibot StatusLine - Shows current team/agent status
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.HOME || process.env.USERPROFILE;
const teamsDir = join(home, '.claude', 'teams');

// Check for active teams
let status = 'Artibot v1.4.0';
try {
  // Find active team configs
  if (existsSync(teamsDir)) {
    const dirs = readdirSync(teamsDir);
    if (dirs.length > 0) {
      status += ` | Team: ${dirs[0]}`;
    }
  }
} catch { /* ignore */ }

console.log(JSON.stringify({ content: status }));
