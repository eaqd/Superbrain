#!/usr/bin/env node
/**
 * Test runner for lib/pdf/tools/{compress,docx,compare}.ts.
 *
 *   node scripts/tools-tests/run.mjs              # all tests
 *   node scripts/tools-tests/run.mjs compress     # tests whose name contains "compress"
 *   KEEP_OUTPUT=1 node scripts/tools-tests/run.mjs   # keep generated files (path printed)
 *
 * The modules are bundled with esbuild (fetched through npx) into a temporary
 * directory (nothing is written inside the repo). They are bundled together with
 * their dependencies (@cantoo/pdf-lib, fflate): tests only exchange bytes with
 * them, so a second pdf-lib instance in the tests is harmless.
 *
 * Test-only dependencies (jpeg-js, pngjs) live outside the repo in
 * $TOOLS_TEST_DEPS (default /tmp/tools-test-deps) and are installed there on
 * first use. Verification also uses poppler (pdftotext/pdftoppm/pdfimages),
 * LibreOffice (soffice) and python3 (xml.etree, python-docx) when available.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const work = mkdtempSync(join(tmpdir(), 'tools-tests-'));
process.env.TOOLS_TEST_WORK = work;

// Test-only deps outside the repo.
const deps = process.env.TOOLS_TEST_DEPS || '/tmp/tools-test-deps';
process.env.TOOLS_TEST_DEPS = deps;
if (!existsSync(join(deps, 'node_modules/jpeg-js')) || !existsSync(join(deps, 'node_modules/pngjs'))) {
  mkdirSync(deps, { recursive: true });
  console.log(`installing test deps into ${deps} …`);
  execFileSync('npm', ['i', '--prefix', deps, '--no-audit', '--no-fund', 'jpeg-js@0.4.4', 'pngjs@7.0.0'], { stdio: 'inherit' });
}

const buildDir = join(work, 'build');
mkdirSync(buildDir, { recursive: true });
for (const name of ['compress', 'docx', 'compare']) {
  execFileSync(
    'npx',
    [
      '-y',
      'esbuild@0.24.0',
      join(root, `lib/pdf/tools/${name}.ts`),
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${join(buildDir, `${name}.mjs`)}`,
      '--log-level=warning',
    ],
    { stdio: 'inherit', cwd: root },
  );
}

const mods = {
  compress: await import(pathToFileURL(join(buildDir, 'compress.mjs')).href),
  docx: await import(pathToFileURL(join(buildDir, 'docx.mjs')).href),
  compare: await import(pathToFileURL(join(buildDir, 'compare.mjs')).href),
};
const suites = [
  ...(await import(pathToFileURL(join(here, 'compare.tests.mjs')).href)).tests,
  ...(await import(pathToFileURL(join(here, 'compress.tests.mjs')).href)).tests,
  ...(await import(pathToFileURL(join(here, 'docx.tests.mjs')).href)).tests,
];

const filter = process.argv[2];
let failed = 0;
let passed = 0;
for (const t of suites) {
  if (filter && !t.name.includes(filter)) continue;
  const started = Date.now();
  try {
    const notes = await t.run(mods);
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
if (process.env.KEEP_OUTPUT) console.log(`output kept in ${work}`);
else rmSync(work, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
