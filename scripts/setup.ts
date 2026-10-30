import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run setup through npm run setup.");
for (const directory of ["../apps/extension", "../apps/vscode-extension"]) {
  const result = spawnSync(process.execPath, [npm, "ci"], { cwd: fileURLToPath(new URL(directory, import.meta.url)), stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
