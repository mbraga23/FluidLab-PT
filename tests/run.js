// Headless test runner. No framework: the gate is small enough that a dependency
// would cost more than it saves, and this keeps `node tests/run.js` the whole story.

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Suites are discovered, not listed: a new area drops in tests/gate-*.js and runs, with
// no shared file for parallel work to collide on.
const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f === 'gate.js' || (f.startsWith('gate-') && f.endsWith('.js')))
  .sort();

const tests = [];
for (const f of files) {
  const mod = await import(pathToFileURL(join(here, f)).href);
  for (const t of mod.tests ?? []) tests.push({ ...t, suite: f.replace(/\.js$/, '') });
}

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', RESET = '\x1b[0m', BOLD = '\x1b[1m';

let passed = 0, failed = 0;
const failures = [];

console.log(`\n${BOLD}FluidLab — Correctness Gate${RESET} ${DIM}(${files.length} Suiten, ${tests.length} Tests)${RESET}\n`);

let suite = null;

for (const { name, fn, suite: s } of tests) {
  if (s !== suite) { suite = s; console.log(`${DIM}── ${s} ──${RESET}`); }
  const t0 = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    passed++;
    console.log(`${GREEN}✓${RESET} ${name} ${DIM}(${ms} ms)${RESET}`);
    if (detail && typeof detail === 'object') {
      for (const [k, v] of Object.entries(detail)) {
        console.log(`  ${DIM}${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}${RESET}`);
      }
    }
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`${RED}✗${RESET} ${name}`);
    console.log(`  ${RED}${err.message}${RESET}`);
  }
}

console.log(`\n${BOLD}${passed} bestanden, ${failed} fehlgeschlagen${RESET}\n`);
if (failed) {
  for (const { name, err } of failures) {
    console.log(`${RED}${name}${RESET}\n${DIM}${err.stack?.split('\n').slice(1, 3).join('\n')}${RESET}\n`);
  }
  process.exit(1);
}
