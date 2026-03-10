const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function getPlatformExecutableParts() {
  if (process.platform === "win32") {
    return ["chrome-win64", "chrome.exe"];
  }
  if (process.platform === "darwin") {
    return ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"];
  }
  return ["chrome-linux64", "chrome"];
}

function listChromiumDirectories(baseDir) {
  try {
    return fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+/.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch (error) {
    return [];
  }
}

function resolveBundledChromiumExecutable() {
  const browsersRoot = path.join(
    process.cwd(),
    "node_modules",
    "playwright-core",
    ".local-browsers"
  );
  const platformParts = getPlatformExecutableParts();
  for (const directory of listChromiumDirectories(browsersRoot)) {
    const candidate = path.join(browsersRoot, directory, ...platformParts);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "";
}

function resolveChromiumExecutablePath(playwright, configuredPath = "") {
  const explicit = String(configuredPath || "").trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const playwrightResolved = String(playwright?.chromium?.executablePath?.() || "").trim();
  if (playwrightResolved && fs.existsSync(playwrightResolved)) {
    return playwrightResolved;
  }

  return resolveBundledChromiumExecutable();
}

function installChromiumBrowser() {
  const isWindows = process.platform === "win32";
  const command = "npx";
  const args = ["playwright", "install", "chromium"];
  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: String(process.env.PLAYWRIGHT_BROWSERS_PATH || "0")
  };
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: isWindows,
    env
  });

  if (result.error) {
    throw new Error(`Unable to launch Playwright installer: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Playwright installer exited with status ${result.status || 1}.`);
  }
}

function ensureChromiumExecutablePath(playwright, configuredPath = "") {
  const resolvedPath = resolveChromiumExecutablePath(playwright, configuredPath);
  if (resolvedPath && fs.existsSync(resolvedPath)) {
    return resolvedPath;
  }

  installChromiumBrowser();

  const installedPath = resolveChromiumExecutablePath(playwright, configuredPath);
  if (installedPath && fs.existsSync(installedPath)) {
    return installedPath;
  }

  throw new Error("Playwright Chromium executable could not be resolved after install.");
}

module.exports = {
  ensureChromiumExecutablePath,
  installChromiumBrowser,
  resolveBundledChromiumExecutable,
  resolveChromiumExecutablePath
};
