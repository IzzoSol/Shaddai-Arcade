'use strict';
/**
 * hall/tests/run-all.js -- runs every hall/tests/*.test.js as a child process
 * and prints a pass/fail summary. The per-file tests are self-running assert
 * scripts (not node:test suites), so they have to be spawned individually to
 * keep one failure from hiding the rest.
 *
 *   npm test
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let passed = 0;
const failures = [];

for (const file of files) {
  const res = spawnSync(process.execPath, [path.join(dir, file)], {
    encoding: 'utf8',
    timeout: 60000,
  });
  if (res.status === 0) {
    passed++;
    const lastLine = (res.stdout || '').trim().split('\n').filter(Boolean).pop() || 'ok';
    console.log(`PASS  ${file}  (${lastLine.trim()})`);
  } else {
    failures.push({ file, out: (res.stdout || '') + (res.stderr || '') });
    console.log(`FAIL  ${file}`);
  }
}

for (const f of failures) {
  console.log(`\n----- ${f.file} -----\n${f.out.trim()}`);
}

console.log(`\n${passed}/${files.length} test files passed`);
process.exit(failures.length === 0 ? 0 : 1);