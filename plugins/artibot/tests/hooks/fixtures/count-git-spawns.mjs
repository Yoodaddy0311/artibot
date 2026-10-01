// Preload for a hook process under test (`node --import <this file> <hook>`):
// records every git process the hook starts, one JSON line of arguments per spawn,
// in the file named by GIT_SPAWN_LOG. Nothing else about the hook changes.
//
// It patches the CommonJS child_process exports BEFORE the hook's own imports run
// and then re-syncs the ESM facade, so `import { execFileSync } from
// 'node:child_process'` inside the hook binds to the counting wrappers. Calls the
// module makes to itself internally (execFileSync -> spawnSync) are not routed
// through the patched exports, so one spawn is counted once.
import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const log = process.env.GIT_SPAWN_LOG;

const isGit = (file) => /(^|[\\/])git(\.exe)?$/i.test(String(file));

function note(args) {
  try {
    appendFileSync(log, `${JSON.stringify(args)}\n`);
  } catch {
    /* counting must never break the hook */
  }
}

for (const name of ['execFileSync', 'execFile', 'spawnSync', 'spawn']) {
  const original = cp[name];
  cp[name] = function counted(file, args, ...rest) {
    if (isGit(file)) note(Array.isArray(args) ? args : []);
    return original.call(this, file, args, ...rest);
  };
}

const execSyncOriginal = cp.execSync;
cp.execSync = function counted(command, ...rest) {
  if (/^\s*git(\.exe)?\s/i.test(String(command))) note(String(command).trim().split(/\s+/).slice(1));
  return execSyncOriginal.call(this, command, ...rest);
};

syncBuiltinESMExports();
