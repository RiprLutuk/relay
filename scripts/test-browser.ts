import { resolve } from "node:path";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../apps/extension", import.meta.url));
const { buildSync } = require(require.resolve("esbuild", { paths: [root] }));
const directory = mkdtempSync(resolve(tmpdir(), "relay-browser-tests-"));
try {
  for (const file of readdirSync(resolve(root, "test")).filter(file => file.endsWith(".test.ts"))) {
    const output = resolve(directory, file.replace(/\.ts$/, ".cjs"));
    buildSync({ entryPoints: [resolve(root, "test", file)], outfile: output, platform: "node", format: "cjs", bundle: true, legalComments: "none" });
    const result = spawnSync(process.execPath, [output], { stdio: "inherit" });
    if (result.status !== 0) process.exitCode = result.status || 1;
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
