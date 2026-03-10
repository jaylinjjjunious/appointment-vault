const { resolveBundledChromiumExecutable, resolveChromiumExecutablePath } = require(
  "../src/automation/playwrightExecutable"
);

describe("playwright executable resolution", () => {
  test("finds the bundled chromium executable when present", () => {
    const executablePath = resolveBundledChromiumExecutable();

    expect(executablePath).toContain("chromium-");
    expect(executablePath.toLowerCase()).toContain("chrome");
  });

  test("falls back from a stale configured path to the bundled chromium executable", () => {
    const executablePath = resolveChromiumExecutablePath(
      {
        chromium: {
          executablePath() {
            return "C:/missing-playwright/chrome.exe";
          }
        }
      },
      "C:/missing-configured/chrome.exe"
    );

    expect(executablePath).toContain("chromium-");
    expect(executablePath.toLowerCase()).toContain("chrome");
  });
});
