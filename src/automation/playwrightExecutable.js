const fs = require("node:fs");
const path = require("node:path");

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

module.exports = {
  resolveBundledChromiumExecutable,
  resolveChromiumExecutablePath
};
