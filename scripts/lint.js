'use strict';

// Syntax-check every .js file in the project (server, src, scripts, and all
// public/ ES modules). Exits non-zero on the first failure.
//
//   npm run check

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'data', 'uploads', '.git']);

function collect(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.') && entry.name !== 'files') {
        collect(path.join(dir, entry.name), acc);
      }
    } else if (entry.name.endsWith('.js')) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

const files = [];
collect(path.join(ROOT, 'src'), files);
collect(path.join(ROOT, 'public'), files);
collect(path.join(ROOT, 'scripts'), files);
files.push(path.join(ROOT, 'server.js'));

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log('ok   ' + path.relative(ROOT, file));
  } catch (err) {
    failed += 1;
    const msg = err.stdout ? String(err.stdout).trim() : err.stderr ? String(err.stderr).trim() : err.message;
    console.log('FAIL ' + path.relative(ROOT, file));
    console.log('     ' + msg.replace(/\n/g, '\n     '));
  }
}

console.log('');
if (failed) {
  console.log(failed + ' file(s) failed syntax check.');
  process.exitCode = 1;
} else {
  console.log('All ' + files.length + ' JavaScript files pass syntax check.');
}