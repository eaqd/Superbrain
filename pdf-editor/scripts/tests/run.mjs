// Bundles a TS test with esbuild (fetched via npx) and runs it in Node.
// Usage: node scripts/tests/run.mjs export
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
const name = process.argv[2] ?? "export";
mkdirSync(".test-out", { recursive: true });
execSync(
  `npx -y esbuild@0.24.0 scripts/tests/${name}.test.ts --bundle --platform=node --format=esm --outfile=.test-out/${name}.mjs --external:pdfjs-dist --external:@napi-rs/canvas --log-level=warning`,
  { stdio: "inherit" },
);
execSync(`node .test-out/${name}.mjs`, { stdio: "inherit" });
