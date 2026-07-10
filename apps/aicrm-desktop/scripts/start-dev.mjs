import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageFile = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
const productName = String(packageJson.productName || packageJson.displayName || "AiCRM").trim() || "AiCRM";
const applicationId = String(packageJson.appId || "com.aicrm").trim() || "com.aicrm";
const fileName = productName.replace(/[/:]/g, "-");
const runtimeSchemaVersion = 3;

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function rewriteBundleMetadata(bundlePath, displayName, executableName, bundleId) {
  const infoPlist = join(bundlePath, "Contents", "Info.plist");
  run("/usr/bin/plutil", ["-replace", "CFBundleDisplayName", "-string", displayName, infoPlist]);
  run("/usr/bin/plutil", ["-replace", "CFBundleName", "-string", displayName, infoPlist]);
  run("/usr/bin/plutil", ["-replace", "CFBundleExecutable", "-string", executableName, infoPlist]);
  run("/usr/bin/plutil", ["-replace", "CFBundleIdentifier", "-string", bundleId, infoPlist]);
}

function prepareNamedMacRuntime(electronExecutable) {
  const electronPackage = JSON.parse(readFileSync(require.resolve("electron/package.json"), "utf8"));
  const sourceApp = dirname(dirname(dirname(electronExecutable)));
  const runtimeRoot = join(homedir(), "Library", "Caches", fileName, "electron-runtime");
  const sourceFingerprint = JSON.stringify({
    electronExecutable,
    electronVersion: electronPackage.version,
    sourceMtimeMs: statSync(electronExecutable).mtimeMs,
    runtimeSchemaVersion,
    productName,
    applicationId
  });
  const runtimeKey = createHash("sha256").update(sourceFingerprint).digest("hex").slice(0, 16);
  const cacheRoot = join(runtimeRoot, `${electronPackage.version}-${runtimeKey}`);
  const targetApp = join(cacheRoot, `${fileName}.app`);
  const targetExecutable = join(targetApp, "Contents", "MacOS", fileName);
  const stampFile = join(cacheRoot, "runtime.json");
  const currentFingerprint = existsSync(stampFile) ? readFileSync(stampFile, "utf8") : "";

  if (!existsSync(targetExecutable) || currentFingerprint !== sourceFingerprint) {
    // This keyed directory has never completed successfully, so no launched
    // runtime can depend on it. Completed older identities live in other keys.
    rmSync(cacheRoot, { recursive: true, force: true });
    mkdirSync(cacheRoot, { recursive: true });
    run("/bin/cp", ["-cR", sourceApp, targetApp]);

    const originalExecutable = join(targetApp, "Contents", "MacOS", "Electron");
    const resources = join(targetApp, "Contents", "Resources");
    const infoPlist = join(targetApp, "Contents", "Info.plist");
    const iconFileName = `${fileName}.icns`;

    renameSync(originalExecutable, targetExecutable);
    copyFileSync(join(resources, "electron.icns"), join(resources, iconFileName));
    rewriteBundleMetadata(targetApp, productName, fileName, applicationId);
    const helperSuffixes = ["", " (GPU)", " (Plugin)", " (Renderer)"];
    helperSuffixes.forEach((suffix) => {
      const oldName = `Electron Helper${suffix}`;
      const newName = `${fileName} Helper${suffix}`;
      const oldBundle = join(targetApp, "Contents", "Frameworks", `${oldName}.app`);
      const newBundle = join(targetApp, "Contents", "Frameworks", `${newName}.app`);
      const oldExecutable = join(oldBundle, "Contents", "MacOS", oldName);
      const newExecutable = join(oldBundle, "Contents", "MacOS", newName);
      renameSync(oldExecutable, newExecutable);
      rewriteBundleMetadata(oldBundle, newName, newName, `${applicationId}.helper${suffix.replace(/[^a-zA-Z]+/g, "").toLowerCase()}`);
      renameSync(oldBundle, newBundle);
    });
    run("/usr/bin/plutil", ["-replace", "CFBundleIconFile", "-string", iconFileName, infoPlist]);
    run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", targetApp]);
    writeFileSync(stampFile, sourceFingerprint);
  }

  return targetExecutable;
}

const electronExecutable = require("electron");
const namedElectronExecutable =
  process.platform === "darwin" ? prepareNamedMacRuntime(electronExecutable) : electronExecutable;
const electronVitePackage = require.resolve("electron-vite/package.json");
const electronViteCli = join(dirname(electronVitePackage), "bin", "electron-vite.js");
const command = process.argv[2] || "dev";
const child = spawn(process.execPath, [electronViteCli, command, ...process.argv.slice(3)], {
  detached: process.platform !== "win32",
  env: { ...process.env, ELECTRON_EXEC_PATH: namedElectronExecutable },
  stdio: "inherit"
});

let stopping = false;
function stopProcessTree(signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    stopProcessTree(signal);
  });
}

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  }
  process.exit(code ?? 1);
});
