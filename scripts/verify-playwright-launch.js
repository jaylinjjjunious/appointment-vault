async function main() {
  const fs = require("node:fs");
  const { ensureChromiumExecutablePath } = require("../src/automation/playwrightExecutable");
  let playwright = null;
  try {
    playwright = require("playwright");
  } catch (error) {
    console.error("[playwright-verify] Playwright is not installed:", error?.message || error);
    process.exit(1);
  }

  const executablePath = ensureChromiumExecutablePath(
    playwright,
    process.env.PLAYWRIGHT_EXECUTABLE_PATH
  );
  const launchOptions = {
    headless: true,
    executablePath
  };

  console.log("[playwright-verify] chromium executable:", executablePath);
  console.log(
    "[playwright-verify] chromium executable exists:",
    fs.existsSync(executablePath)
  );
  console.log("[playwright-verify] launch options:", JSON.stringify(launchOptions));

  const browser = await playwright.chromium.launch(launchOptions);
  const page = await browser.newPage();

  try {
    await page.goto("data:text/html,<title>ok</title><h1>Playwright OK</h1>", {
      waitUntil: "load",
      timeout: 15000
    });
    const title = await page.title();
    console.log("[playwright-verify] browser launch ok");
    console.log("[playwright-verify] title:", title);
  } finally {
    await page.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

main().catch((error) => {
  console.error("[playwright-verify] launch failed:", error?.message || error);
  process.exit(1);
});
