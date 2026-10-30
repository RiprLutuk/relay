import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../apps/extension", import.meta.url));
const { buildSync } = require(require.resolve("esbuild", { paths: [root] }));
mkdirSync(resolve(root, "build"), { recursive: true });
buildSync({
  absWorkingDir: root,
  entryPoints: { conversation: "src/conversation-entry.ts", transport: "src/transport-entry.ts", controls: "src/controls-entry.ts", document: "src/document-entry.ts" },
  outdir: "build", bundle: true, platform: "browser", format: "iife", target: "chrome120",
  legalComments: "none", minifyWhitespace: true, logLevel: "info",
});
