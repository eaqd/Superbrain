#!/usr/bin/env node
/**
 * Test runner for lib/pdf/engine/redact.ts.
 *
 *   node scripts/redact-tests/run.mjs            # all tests
 *   node scripts/redact-tests/run.mjs image      # tests whose name contains "image"
 *   KEEP_OUTPUT=1 node scripts/redact-tests/run.mjs   # keep generated PDFs in scripts/redact-tests/.out
 *
 * The engine is bundled with esbuild (fetched through npx) into
 * scripts/redact-tests/.build, with @cantoo/pdf-lib and fflate kept external so
 * the tests and the engine share the same pdf-lib module instance.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const buildDir = join(here, '.build');
mkdirSync(buildDir, { recursive: true });

execFileSync(
  'npx',
  [
    '-y',
    'esbuild@0.24.0',
    join(root, 'lib/pdf/engine/redact.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--external:@cantoo/pdf-lib',
    '--external:fflate',
    `--outfile=${join(buildDir, 'engine.mjs')}`,
    '--log-level=warning',
  ],
  { stdio: 'inherit', cwd: root },
);

const engine = await import(pathToFileURL(join(buildDir, 'engine.mjs')).href);
const { tests } = await import(pathToFileURL(join(here, 'tests.mjs')).href);

const filter = process.argv[2];
let failed = 0;
let passed = 0;
for (const t of tests) {
  if (filter && !t.name.includes(filter)) continue;
  const started = Date.now();
  try {
    const notes = await t.run(engine);
    passed++;
    console.log(`PASS  ${t.name}  (${Date.now() - started} ms)`);
    for (const n of notes ?? []) console.log(`        ${n}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${t.name}`);
    console.log('        ' + String(err && err.stack ? err.stack : err).split('\n').join('\n        '));
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (!process.env.KEEP_BUILD) rmSync(buildDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
