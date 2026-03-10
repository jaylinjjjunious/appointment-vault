const fs = require("node:fs");
const path = require("node:path");
const { getAutomationConfig, hasAutomationTargetConfig } = require("./config");

function normalizeFieldDefinition(definition) {
  if (typeof definition === "string") {
    return { selector: definition, type: "text" };
  }
  if (!definition || typeof definition !== "object") {
    return null;
  }
  const selector = String(definition.selector || "").trim();
  if (!selector) {
    return null;
  }
  return {
    selector,
    type: String(definition.type || "text").trim() || "text",
    trueValue: definition.trueValue === undefined ? "true" : String(definition.trueValue)
  };
}

function buildPayloadFromAppointment(source) {
  const appointment = source || {};
  const payload = {
    title: String(appointment.title || "").trim(),
    date: String(appointment.date || "").trim(),
    time: String(appointment.time || "").trim(),
    location: String(appointment.location || "").trim(),
    notes: String(appointment.notes || "").trim(),
    tags: String(appointment.tags || "").trim(),
    reminderMinutes:
      appointment.reminderMinutes === null || appointment.reminderMinutes === undefined
        ? ""
        : String(appointment.reminderMinutes),
    timezone: String(appointment.timezone || "").trim()
  };

  return {
    payload,
    missingFields: ["title", "date", "time"].filter((key) => !payload[key])
  };
}

async function requirePlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    throw new Error("Playwright is not installed. Run npm install to enable automation.");
  }
}

async function ensureVisible(page, selector, timeoutMs) {
  await page.waitForSelector(selector, { state: "visible", timeout: timeoutMs });
}

async function applyFieldValue(page, definition, value) {
  const locator = page.locator(definition.selector).first();
  if (definition.type === "select") {
    await locator.selectOption(String(value || ""));
    return;
  }
  if (definition.type === "checkbox") {
    const checked =
      value === true ||
      String(value || "").toLowerCase() === "true" ||
      String(value || "") === definition.trueValue;
    if (checked) {
      await locator.check();
    } else {
      await locator.uncheck();
    }
    return;
  }
  await locator.fill(String(value || ""));
}

function createFailureArtifacts(config, slug, pageContent, screenshotBuffer) {
  fs.mkdirSync(config.captureDir, { recursive: true });
  const stamp = `${Date.now()}-${slug}`;
  const htmlPath = path.join(config.captureDir, `${stamp}.html`);
  const screenshotPath = path.join(config.captureDir, `${stamp}.png`);
  fs.writeFileSync(htmlPath, pageContent, "utf8");
  if (screenshotBuffer) {
    fs.writeFileSync(screenshotPath, screenshotBuffer);
  }
  return { htmlPath, screenshotPath };
}

function createSingleSiteAdapter(config = getAutomationConfig()) {
  const fieldMap = Object.entries(config.fieldMap || {}).reduce((accumulator, [key, value]) => {
    const normalized = normalizeFieldDefinition(value);
    if (normalized) {
      accumulator[key] = normalized;
    }
    return accumulator;
  }, {});

  return {
    siteId: config.siteId,
    targetName: config.targetName,
    buildPayloadFromAppointment,
    async login(page, credentials) {
      await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
      await ensureVisible(page, config.usernameSelector, config.timeoutMs);
      await page.fill(config.usernameSelector, String(credentials.username || ""));
      await page.fill(config.passwordSelector, String(credentials.password || ""));
      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: config.timeoutMs }).catch(() => null),
        page.click(config.loginSubmitSelector)
      ]);
      await ensureVisible(page, config.authCheckSelector, config.timeoutMs);
    },
    async openForm(page) {
      await page.goto(config.formUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
      await page.waitForLoadState("networkidle", { timeout: config.timeoutMs }).catch(() => null);
    },
    async fillForm(page, payload) {
      for (const [key, definition] of Object.entries(fieldMap)) {
        if (payload[key] === undefined || payload[key] === null || payload[key] === "") {
          continue;
        }
        await ensureVisible(page, definition.selector, config.timeoutMs);
        await applyFieldValue(page, definition, payload[key]);
      }
    },
    async submit(page) {
      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: config.timeoutMs }).catch(() => null),
        page.click(config.submitSelector)
      ]);
    },
    async assertSuccess(page) {
      if (config.successSelector) {
        await ensureVisible(page, config.successSelector, config.timeoutMs);
        return;
      }
      if (config.successUrlContains) {
        await page.waitForURL(
          (url) => String(url || "").includes(config.successUrlContains),
          { timeout: config.timeoutMs }
        );
      }
    },
    async run({ credentials, payload, dryRun = false }) {
      if (!hasAutomationTargetConfig(config)) {
        throw new Error("Automation target is not fully configured.");
      }
      const playwright = await requirePlaywright();
      const browser = await playwright.chromium.launch({ headless: config.headless });
      const page = await browser.newPage();

      try {
        await this.login(page, credentials);
        if (!payload || Object.keys(payload).length === 0) {
          return { ok: true, mode: "login", externalReference: null };
        }
        await this.openForm(page);
        await this.fillForm(page, payload);
        if (dryRun) {
          return { ok: true, mode: "dry-run", externalReference: null };
        }
        await this.submit(page);
        await this.assertSuccess(page);
        return { ok: true, mode: "submit", externalReference: page.url() };
      } catch (error) {
        let screenshotBuffer = null;
        try {
          screenshotBuffer = await page.screenshot({ fullPage: true });
        } catch (screenshotError) {
          screenshotBuffer = null;
        }
        error.artifacts = createFailureArtifacts(
          config,
          config.siteId,
          await page.content(),
          screenshotBuffer
        );
        throw error;
      } finally {
        await page.close().catch(() => null);
        await browser.close().catch(() => null);
      }
    }
  };
}

module.exports = {
  buildPayloadFromAppointment,
  createSingleSiteAdapter
};
