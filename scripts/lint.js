'use strict';

// Syntax-check every .js file in the project: the CommonJS server/CLI sources and
// the ES modules the browser loads. Exits non-zero if any file fails to parse.
//
//   npm run check
//
// The two module systems are checked differently on purpose. `node --check`
// parses a file using the package's module type, and this package is CommonJS
// (no "type": "module"), so a browser file containing `import`/`export` would be
// reported as a syntax error even though it is perfectly valid ESM. Those files
// are therefore copied to a temporary `.mjs` file first so Node parses them with
// the correct goal symbol.

const fs = require('fs');
const os = require('os');
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

// The browser bundle is ESM; everything else is CommonJS.
function isBrowserModule(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  return rel.startsWith('public/');
}

let tempDir = null;
function checkEsm(file) {
  if (!tempDir) tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmic-check-'));
  // A unique name per file keeps parallel/sequential runs from colliding.
  const target = path.join(tempDir, path.basename(file, '.js') + '-' + files.indexOf(file) + '.mjs');
  fs.writeFileSync(target, fs.readFileSync(file));
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
  } finally {
    try { fs.unlinkSync(target); } catch (err) { /* best effort */ }
  }
}

function check(file) {
  if (isBrowserModule(file)) checkEsm(file);
  else execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

let failed = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file);
  try {
    check(file);
    console.log('ok   ' + rel);
  } catch (err) {
    failed += 1;
    const msg = err.stdout ? String(err.stdout).trim() : (err.stderr ? String(err.stderr).trim() : err.message);
    console.log('FAIL ' + rel);
    console.log('     ' + msg.replace(/\n/g, '\n     '));
  }
}

if (tempDir) {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (err) { /* best effort */ }
}

console.log('');
if (failed) {
  console.log(failed + ' file(s) failed syntax check.');
  process.exitCode = 1;
} else {
  console.log('All ' + files.length + ' JavaScript files pass syntax check.');
}
