#!/usr/bin/env bun
// Packaged Linux builds: .deb and AppImage from the Electrobun stable build.
//
// Usage:
//   bun scripts/package-linux.ts               # vite build + electrobun build, then package
//   bun scripts/package-linux.ts --skip-build  # package the existing build/ output
//
// Outputs land in artifacts/ next to Electrobun's own release files:
//   resmon24_<version>_amd64.deb
//   Resmon24-<version>-x86_64.AppImage
//   SHA256SUMS

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SKIP_BUILD = process.argv.includes("--skip-build");

const config = (await import(join(ROOT, "electrobun.config.ts"))).default;
const APP_NAME: string = config.app.name;
const VERSION: string = config.app.version;
const LINUX = (config.build as any).linux ?? {};
const DESCRIPTION: string = LINUX.description ?? "resmon24 desktop monitor";
const CATEGORY: string = LINUX.category ?? "Utility";
const PKG = APP_NAME.toLowerCase();
const CHANNEL = "stable";
const ARCH = "amd64";

const BUILD_DIR = join(ROOT, "build", `${CHANNEL}-linux-x64`, APP_NAME);
const OUT_DIR = join(ROOT, "artifacts");
const WORK_DIR = join(ROOT, "build", "package-linux");
const RUNTIME_CACHE = join(ROOT, "build", "tools", "runtime-x86_64");
const RUNTIME_URL =
  "https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64";

function log(message: string) {
  console.log(`[package] ${message}`);
}

function run(cmd: string[], opts: { cwd?: string } = {}): boolean {
  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: opts.cwd ?? ROOT,
    stdio: "inherit",
  });
  return result.status === 0;
}

function fail(message: string): never {
  console.error(`[package] ${message}`);
  process.exit(1);
}

function firstMatch(dir: string, suffix: string): string | null {
  if (!existsSync(dir)) return null;
  const found = readdirSync(dir).filter((entry) => entry.endsWith(suffix));
  return found.length > 0 ? join(dir, found[0]) : null;
}

function makeWrapper(): string {
  return [
    "#!/bin/sh",
    'HERE="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"',
    `cd "$HERE/opt/${PKG}" || exit 1`,
    'exec ./bin/launcher "$@"',
    "",
  ].join("\n");
}

function makeDesktopEntry(exec: string): string {
  return [
    "[Desktop Entry]",
    "Version=1.0",
    "Type=Application",
    `Name=${APP_NAME}`,
    `Comment=${DESCRIPTION}`,
    `Exec=${exec}`,
    `Icon=${PKG}`,
    "Terminal=false",
    `StartupWMClass=${APP_NAME}`,
    `Categories=${CATEGORY};`,
    "",
  ].join("\n");
}

function makeControl(installedSizeKb: number): string {
  const maintainer = process.env.MAINTAINER ?? `${APP_NAME} <${PKG}@users.noreply.github.com>`;
  return [
    `Package: ${PKG}`,
    `Version: ${VERSION}`,
    "Section: utils",
    "Priority: optional",
    `Architecture: ${ARCH}`,
    `Maintainer: ${maintainer}`,
    `Installed-Size: ${installedSizeKb}`,
    `Description: ${APP_NAME} — system monitor for ESP8266 OLED displays`,
    ` ${DESCRIPTION}`,
    " Streams CPU, memory, GPU, network and sensor metrics over a local",
    " WebSocket to resmon24 devices, discovered over mDNS.",
    "",
  ].join("\n");
}

function installIcon(path: string): boolean {
  const source = join(ROOT, "assets", "icon.png");
  if (!existsSync(source)) return false;
  cpSync(source, path);
  return existsSync(path);
}

function ensureRuntime(): string {
  if (existsSync(RUNTIME_CACHE) && statSync(RUNTIME_CACHE).size > 1024) {
    return RUNTIME_CACHE;
  }
  mkdirSync(dirname(RUNTIME_CACHE), { recursive: true });
  log(`downloading AppImage type2 runtime`);
  const ok = run(["curl", "-fsSL", "-o", RUNTIME_CACHE, RUNTIME_URL]);
  if (!ok || !existsSync(RUNTIME_CACHE)) {
    fail("could not download the AppImage runtime (network required for the first run)");
  }
  return RUNTIME_CACHE;
}

function cleanWork() {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(join(WORK_DIR, "extract"), { recursive: true });
  mkdirSync(join(WORK_DIR, "stage"), { recursive: true });
}

function extractPayload() {
  const packed = firstMatch(join(BUILD_DIR, "Resources"), ".tar.zst");
  if (!packed) fail(`no packed app bundle in ${BUILD_DIR}/Resources (run a stable build first)`);
  log(`extracting ${packed}`);
  if (!run(["tar", "--zstd", "-xf", packed, "-C", join(WORK_DIR, "extract")])) {
    fail("tar extraction failed (zstd support required)");
  }
  const payload = join(WORK_DIR, "extract", APP_NAME);
  if (!existsSync(join(payload, "bin", "launcher"))) {
    fail(`extracted payload has no bin/launcher in ${payload}`);
  }
  return payload;
}

function buildStage(payload: string) {
  const stage = join(WORK_DIR, "stage");
  cpSync(payload, join(stage, "opt", PKG), { recursive: true });
  rmSync(join(stage, "opt", PKG, `${APP_NAME}.desktop`), { force: true });

  const wrapperPath = join(stage, "usr", "bin", PKG);
  mkdirSync(dirname(wrapperPath), { recursive: true });
  writeFileSync(wrapperPath, makeWrapper());
  chmodSync(wrapperPath, 0o755);

  const desktopPath = join(stage, "usr", "share", "applications", `${PKG}.desktop`);
  mkdirSync(dirname(desktopPath), { recursive: true });
  writeFileSync(desktopPath, makeDesktopEntry(PKG));

  const iconPath = join(stage, "usr", "share", "icons", "hicolor", "256x256", "apps", `${PKG}.png`);
  mkdirSync(dirname(iconPath), { recursive: true });
  if (!installIcon(iconPath)) {
    log("warning: assets/icon.png missing; desktop entry has no artwork");
    const desktop = readFileSync(desktopPath, "utf8").replace(`Icon=${PKG}\n`, "");
    writeFileSync(desktopPath, desktop);
  }
  return stage;
}

function packageDeb(stage: string) {
  const controlDir = join(stage, "DEBIAN");
  mkdirSync(controlDir, { recursive: true });
  const sizeResult = spawnSync("du", ["-sk", join(stage, "opt"), join(stage, "usr")]);
  const installedSize = Number(
    String(sizeResult.stdout ?? "")
      .split("\n")
      .reduce((sum, line) => sum + (Number.parseInt(line, 10) || 0), 0)
  );
  writeFileSync(join(controlDir, "control"), makeControl(Math.max(1, Math.round(installedSize))));

  const outPath = join(OUT_DIR, `${PKG}_${VERSION}_${ARCH}.deb`);
  rmSync(outPath, { force: true });
  log(`building ${outPath}`);
  if (!run(["dpkg-deb", "--root-owner-group", "--build", stage, outPath])) {
    fail("dpkg-deb failed");
  }
  rmSync(controlDir, { recursive: true, force: true });
  return outPath;
}

function packageAppImage(stage: string) {
  const appDir = join(WORK_DIR, "AppDir");
  cpSync(stage, appDir, { recursive: true });

  const appRun = join(appDir, "AppRun");
  writeFileSync(appRun, `#!/bin/sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/usr/bin/${PKG}" "$@"\n`);
  chmodSync(appRun, 0o755);

  writeFileSync(join(appDir, `${PKG}.desktop`), makeDesktopEntry("AppRun"));

  const iconSource = join(appDir, "usr", "share", "icons", "hicolor", "256x256", "apps", `${PKG}.png`);
  if (existsSync(iconSource)) {
    cpSync(iconSource, join(appDir, `${PKG}.png`));
  }

  const squashFs = join(WORK_DIR, "payload.squashfs");
  rmSync(squashFs, { force: true });
  log("building squashfs (zstd)");
  const zstdOk = run([
    "mksquashfs",
    appDir,
    squashFs,
    "-comp",
    "zstd",
    "-all-root",
    "-noappend",
    "-no-xattrs",
    "-quiet",
  ]);
  if (!zstdOk) {
    log("zstd unavailable, retrying with gzip");
    if (!run(["mksquashfs", appDir, squashFs, "-comp", "gzip", "-all-root", "-noappend", "-no-xattrs", "-quiet"])) {
      fail("mksquashfs failed");
    }
  }

  const runtime = ensureRuntime();
  const outPath = join(OUT_DIR, `${APP_NAME}-${VERSION}-x86_64.AppImage`);
  rmSync(outPath, { force: true });

  const outFd = openSync(outPath, "w");
  writeSync(outFd, readFileSync(runtime));
  writeSync(outFd, readFileSync(squashFs));
  closeSync(outFd);
  chmodSync(outPath, 0o755);
  log(`building ${outPath}`);
  return outPath;
}

function writeChecksums(paths: string[]) {
  const lines = paths.map((path) => {
    const result = spawnSync("sha256sum", [path]);
    return String(result.stdout ?? "").trim();
  }).filter(Boolean);
  writeFileSync(join(OUT_DIR, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

function humanSize(path: string): string {
  const bytes = statSync(path).size;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

async function main() {
  if (!SKIP_BUILD) {
    log("building renderer bundle (vite)");
    if (!run(["bunx", "vite", "build"])) fail("vite build failed");
    log(`building ${CHANNEL} app bundle (electrobun)`);
    if (!run(["bunx", "electrobun", "build", `--env=${CHANNEL}`])) fail("electrobun build failed");
  }

  if (!existsSync(BUILD_DIR)) fail(`missing build output: ${BUILD_DIR}`);
  mkdirSync(OUT_DIR, { recursive: true });
  cleanWork();

  const payload = extractPayload();
  const stage = buildStage(payload);
  const debPath = packageDeb(stage);
  const appImagePath = packageAppImage(stage);
  writeChecksums([debPath, appImagePath]);

  log(`done`);
  log(`  deb:      ${debPath} (${humanSize(debPath)})`);
  log(`  appimage: ${appImagePath} (${humanSize(appImagePath)})`);
  log(`  sums:     ${join(OUT_DIR, "SHA256SUMS")}`);
}

await main();
