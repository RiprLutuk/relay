import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

type Target = { name: string; os: "darwin" | "linux" | "win32"; arch: "arm64" | "x64"; rust: string };
const targets: Target[] = [
  { name: "darwin-arm64", os: "darwin", arch: "arm64", rust: "aarch64-apple-darwin" },
  { name: "darwin-x64", os: "darwin", arch: "x64", rust: "x86_64-apple-darwin" },
  { name: "linux-x64", os: "linux", arch: "x64", rust: "x86_64-unknown-linux-musl" },
  { name: "linux-arm64", os: "linux", arch: "arm64", rust: "aarch64-unknown-linux-musl" },
  { name: "win32-x64", os: "win32", arch: "x64", rust: process.platform === "win32" ? "x86_64-pc-windows-msvc" : "x86_64-pc-windows-gnu" },
];
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("npm run package [-- --all | --target <platform>]\nPlatforms: " + targets.map(target => target.name).join(", ") + "\nRequires installed Rust targets. Linux builds use cargo-zigbuild; Windows cross-builds use MinGW-w64; macOS builds require its SDK.");
  process.exit(0);
}
const requested = args.length === 0 ? [`${process.platform}-${process.arch}`]
  : args.length === 1 && args[0] === "--all" ? targets.map(target => target.name)
  : args.length === 2 && args[0] === "--target" ? [args[1]] : [];
const selected = requested.map(name => {
  const target = targets.find(target => target.name === name);
  if (!target) throw new Error(`Unsupported platform: ${name}. Run npm run package -- --help.`);
  return target;
});
if (!selected.length) throw new Error("Invalid arguments. Run npm run package -- --help.");

const root = fileURLToPath(new URL("../", import.meta.url));
const companion = resolve(root, "apps/vscode-extension");
const browser = resolve(root, "apps/extension");
const runtime = resolve(companion, "runtime");
const output = resolve(root, "target/packages");
const version = JSON.parse(readFileSync(resolve(companion, "package.json"), "utf8")).version as string;
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run packaging through npm run package.");
for (const file of ["package.json", "apps/extension/package.json", "apps/extension/manifest.json"]) {
  if (JSON.parse(readFileSync(resolve(root, file), "utf8")).version !== version) throw new Error(`Version mismatch: ${file}`);
}
if (!readFileSync(resolve(root, "Cargo.toml"), "utf8").includes(`version = "${version}"`)) throw new Error("Native runtime version mismatch.");

function command(program: string, argumentsList: string[], cwd = root, env = process.env): void {
  const result = spawnSync(program, argumentsList, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed with status ${result.status}`);
}

function verifyBinary(file: string, target: Target): void {
  const bytes = readFileSync(file);
  if (bytes.length < 64) throw new Error(`Truncated binary: ${file}`);
  let matches = false;
  if (target.os === "darwin") matches = bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === (target.arch === "arm64" ? 0x100000c : 0x1000007);
  if (target.os === "linux") matches = bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === (target.arch === "arm64" ? 183 : 62);
  if (target.os === "win32" && bytes.readUInt16LE(0) === 0x5a4d) {
    const offset = bytes.readUInt32LE(60);
    matches = offset <= bytes.length - 6 && bytes.readUInt32LE(offset) === 0x4550 && bytes.readUInt16LE(offset + 4) === 0x8664;
  }
  if (!matches) throw new Error(`Wrong binary architecture for ${target.name}: ${file}`);
}

command(process.execPath, [npm, "--prefix", browser, "run", "build"]);
command(process.execPath, [npm, "--prefix", companion, "run", "compile"]);
mkdirSync(output, { recursive: true });
for (const target of selected) {
  console.log(`Building ${target.name} (${target.rust})`);
  const env = { ...process.env };
  if (target.os === "win32" && process.platform !== "win32") env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = "x86_64-w64-mingw32-gcc";
  command("cargo", [target.os === "linux" ? "zigbuild" : "build", "--release", "--locked", "--bins", "--target", target.rust], root, env);
  rmSync(runtime, { force: true, recursive: true });
  mkdirSync(resolve(runtime, "browser"), { recursive: true });
  for (const name of ["relayctl", "relay-bridge", "relay-workspace"]) {
    const filename = name + (target.os === "win32" ? ".exe" : "");
    const source = resolve(root, "target", target.rust, "release", filename);
    verifyBinary(source, target);
    const destination = resolve(runtime, filename);
    copyFileSync(source, destination);
    if (target.os !== "win32") chmodSync(destination, 0o755);
  }
  for (const name of ["manifest.json", "control-popup.html", "icon.png", "relay-mark.svg"]) copyFileSync(resolve(browser, name), resolve(runtime, "browser", name));
  cpSync(resolve(browser, "build"), resolve(runtime, "browser/build"), { recursive: true });
  const fingerprint = createHash("sha256");
  for (const name of readdirSync(resolve(browser, "build")).sort()) fingerprint.update(readFileSync(resolve(browser, "build", name)));
  for (const name of ["manifest.json", "control-popup.html", "icon.png", "relay-mark.svg"]) fingerprint.update(readFileSync(resolve(browser, name)));
  writeFileSync(resolve(runtime, "browser/build-id"), fingerprint.digest("hex"));
  for (const name of ["LICENSE", "PROVENANCE.md"]) copyFileSync(resolve(root, name), resolve(runtime, "browser", name));
  command(process.execPath, [npm, "exec", "--yes", "--package", "@vscode/vsce", "--", "vsce", "package", "--allow-star-activation", "--target", target.name, "--out", resolve(output, `relay-workspace-${version}-${target.name}.vsix`)], companion);
}
const packages = readdirSync(output).filter(name => name.startsWith(`relay-workspace-${version}-`) && name.endsWith(".vsix")).sort();
writeFileSync(resolve(output, "SHA256SUMS.txt"), packages.map(name => `${createHash("sha256").update(readFileSync(resolve(output, name))).digest("hex")}  ${name}\n`).join(""));
console.log(`Relay ${version}: ${selected.length} platform package(s) built; SHA256SUMS.txt updated.`);
