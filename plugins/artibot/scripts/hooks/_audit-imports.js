import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const dirs = ['plugins/artibot/lib', 'plugins/artibot/scripts'];
const importPattern = /from\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]/g;
const broken = [];

function scanDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { scanDir(full); continue; }
    if (!entry.name.endsWith('.js')) continue;
    const content = readFileSync(full, 'utf-8');
    let match;
    importPattern.lastIndex = 0;
    while ((match = importPattern.exec(content)) !== null) {
      const specifier = match[1] || match[2];
      if (!specifier || !specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(full), specifier);
      const candidates = [resolved, resolved + '.js', resolved + '/index.js'];
      const exists = candidates.some(c => existsSync(c));
      if (!exists) broken.push({ file: full.replace(/\\/g, '/'), imp: specifier });
    }
  }
}

dirs.forEach(d => scanDir(d));
if (broken.length === 0) console.log('No broken imports found');
else broken.forEach(b => console.log('BROKEN: ' + b.file + ' -> ' + b.imp));
