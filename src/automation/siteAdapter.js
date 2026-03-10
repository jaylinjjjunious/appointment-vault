const fs = require("node:fs");
const path = require("node:path");
const { getAutomationConfig, hasAutomationTargetConfig } = require("./config");
const { ensureChromiumExecutablePath } = require("./playwrightExecutable");

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

function buildCeCheckInPayload(config) {
  return {
    payload: {
      questionnaireAnswers: config.questionnaireAnswers || {},
      contact: {
        line1: config.contactLine1 || "",
        line2: config.contactLine2 || "",
        city: config.contactCity || "",
        state: config.contactState || "",
        zip: config.contactZip || ""
      },
      updateMailingAddress: Boolean(config.updateMailingAddress)
    },
    missingFields:
      config.questionnaireAnswers && Object.keys(config.questionnaireAnswers).length > 0
        ? []
        : ["questionnaireAnswers"]
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

async function captureProgressSnapshot(page, config, slug) {
  fs.mkdirSync(config.captureDir, { recursive: true });
  const safeSlug = String(slug || "step")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "step";
  const snapshotPath = path.join(config.captureDir, `${Date.now()}-${safeSlug}.png`);
  await page.screenshot({ fullPage: true, path: snapshotPath });
  return snapshotPath;
}

function buildChromiumLaunchOptions(playwright, config) {
  const executablePath = ensureChromiumExecutablePath(playwright, config.browserExecutablePath);
  const options = {
    headless: config.headless,
    executablePath
  };
  return options;
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
    buildPayloadFromAppointment(source) {
      if (config.siteId === "ce-check-in") {
        return buildCeCheckInPayload(config);
      }
      return buildPayloadFromAppointment(source);
    },
    async login(page, credentials, onProgress = () => {}) {
      onProgress("Opening sign-in page");
      await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
      await ensureVisible(page, config.usernameSelector, config.timeoutMs);
      onProgress("Entering saved website login");
      await page.fill(config.usernameSelector, String(credentials.username || ""));
      await page.fill(config.passwordSelector, String(credentials.password || ""));
      onProgress("Submitting sign-in");
      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: config.timeoutMs }).catch(() => null),
        page.click(config.loginSubmitSelector)
      ]);
      onProgress("Confirming signed-in page");
      await ensureVisible(page, config.authCheckSelector, config.timeoutMs);
    },
    async openForm(page, onProgress = () => {}) {
      onProgress("Opening target form");
      await page.goto(config.formUrl, { waitUntil: "domcontentloaded", timeout: config.timeoutMs });
      await page.waitForLoadState("networkidle", { timeout: config.timeoutMs }).catch(() => null);
    },
    async fillForm(page, payload, onProgress = () => {}) {
      if (config.siteId === "ce-check-in") {
        onProgress("Waiting for CE Check-In report");
        await page.waitForSelector("#client-report", {
          state: "visible",
          timeout: config.timeoutMs
        });

        if (payload?.updateMailingAddress) {
          onProgress("Updating mailing address");
          const rowLocator = page.locator(".contact-information .row").filter({
            hasText: "Mailing Address"
          });
          if ((await rowLocator.count()) > 0) {
            await rowLocator.first().click();
            await ensureVisible(page, "#line1", config.timeoutMs);
            await page.fill("#line1", String(payload.contact?.line1 || ""));
            await page.fill("#line2", String(payload.contact?.line2 || ""));
            if (String(payload.contact?.city || "")) {
              const cityInput = page.locator("#city");
              if ((await cityInput.count()) > 0) {
                await cityInput.fill(String(payload.contact.city || ""));
              }
            }
            if (String(payload.contact?.state || "")) {
              const stateSelect = page.locator("#ddlstate");
              if ((await stateSelect.count()) > 0) {
                await stateSelect.selectOption({ label: String(payload.contact.state || "") }).catch(() => null);
                await stateSelect.selectOption(String(payload.contact.state || "")).catch(() => null);
              }
            }
            if (String(payload.contact?.zip || "")) {
              await page.fill("#zip", String(payload.contact.zip || ""));
            }
            await page.locator(".modal .btn.btn-primary").filter({ hasText: "Done" }).last().click();
            await page.waitForTimeout(500);
          }
        }

        onProgress("Loading questionnaire");
        await page.waitForSelector(".question-text", { timeout: config.timeoutMs });
        const questionItems = page.locator("li:has(.question-text)");
        const count = await questionItems.count();
        const normalizedAnswers = Object.entries(payload?.questionnaireAnswers || {}).reduce(
          (accumulator, [key, value]) => {
            accumulator[String(key || "").trim().toLowerCase()] = String(value || "")
              .trim()
              .toLowerCase();
            return accumulator;
          },
          {}
        );

        for (let index = 0; index < count; index += 1) {
          const item = questionItems.nth(index);
          const text = String((await item.locator(".question-text").textContent()) || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          const answer = normalizedAnswers[text];
          if (!answer) {
            throw new Error(`No configured answer for CE Check-In question: ${text}`);
          }
          const answerLabel = answer === "yes" ? "Yes" : "No";
          onProgress(`Answering question ${index + 1} of ${count}`);
          await item.locator("button", { hasText: answerLabel }).click();
        }
        onProgress("Questionnaire complete");
        return;
      }

      for (const [key, definition] of Object.entries(fieldMap)) {
        if (payload[key] === undefined || payload[key] === null || payload[key] === "") {
          continue;
        }
        onProgress(`Filling ${key}`);
        await ensureVisible(page, definition.selector, config.timeoutMs);
        await applyFieldValue(page, definition, payload[key]);
      }
    },
    async submit(page, onProgress = () => {}) {
      onProgress("Submitting form");
      if (config.siteId === "ce-check-in") {
        await page.locator("a.btn.btn-primary.btn-checkin").click();
        return;
      }
      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: config.timeoutMs }).catch(() => null),
        page.click(config.submitSelector)
      ]);
    },
    async assertSuccess(page, onProgress = () => {}) {
      if (config.siteId === "ce-check-in") {
        onProgress("Waiting for CE Check-In confirmation");
        await page.waitForURL(
          (url) => {
            const value = String(url || "");
            return value.includes("/client") && !value.includes("/report/");
          },
          { timeout: config.timeoutMs }
        );
        return;
      }
      if (config.successSelector) {
        onProgress("Waiting for success confirmation");
        await ensureVisible(page, config.successSelector, config.timeoutMs);
        return;
      }
      if (config.successUrlContains) {
        onProgress("Waiting for success redirect");
        await page.waitForURL(
          (url) => String(url || "").includes(config.successUrlContains),
          { timeout: config.timeoutMs }
        );
      }
    },
    async prepareForPhoto({
      credentials,
      payload,
      onProgress = () => {},
      onSnapshot = () => {}
    }) {
      if (config.siteId !== "ce-check-in") {
        throw new Error("Photo handoff is only supported for CE Check-In.");
      }
      const result = await this.run({
        credentials,
        payload,
        dryRun: true,
        onProgress,
        onSnapshot
      });
      return {
        ok: true,
        checkpoint: "photo_capture_required",
        resumeUrl: config.formUrl,
        snapshotPath: result?.snapshotPath || null
      };
    },
    async run({
      credentials,
      payload,
      dryRun = false,
      onProgress = () => {},
      onSnapshot = () => {},
      onPageReady = () => {},
      onRunFinished = () => {},
      onRunFailed = () => {}
    }) {
      if (!hasAutomationTargetConfig(config)) {
        throw new Error("Automation target is not fully configured.");
      }
      let latestSnapshotPath = "";
      const progress = async (message, snapshotSlug = "") => {
        onProgress(message);
        try {
          latestSnapshotPath = await captureProgressSnapshot(page, config, snapshotSlug || message);
          onSnapshot(latestSnapshotPath);
        } catch (error) {
          // Keep automation running even if a preview snapshot cannot be written.
        }
      };

      onProgress("Launching browser");
      const playwright = await requirePlaywright();
      const browser = await playwright.chromium.launch(
        buildChromiumLaunchOptions(playwright, config)
      );
      const page = await browser.newPage();

      try {
        await onPageReady(page);
        await progress("Creating browser page", "page-created");
        await this.login(page, credentials, async (message) => {
          await progress(message);
        });
        if (!payload || Object.keys(payload).length === 0) {
          await progress("Login test completed", "login-complete");
          await onRunFinished({
            ok: true,
            mode: "login",
            externalReference: null,
            snapshotPath: latestSnapshotPath || null
          });
          return {
            ok: true,
            mode: "login",
            externalReference: null,
            snapshotPath: latestSnapshotPath || null
          };
        }
        await this.openForm(page, async (message) => {
          await progress(message);
        });
        await this.fillForm(page, payload, async (message) => {
          await progress(message);
        });
        if (dryRun) {
          await progress("Dry run completed", "dry-run-complete");
          await onRunFinished({
            ok: true,
            mode: "dry-run",
            externalReference: null,
            snapshotPath: latestSnapshotPath || null
          });
          return {
            ok: true,
            mode: "dry-run",
            externalReference: null,
            snapshotPath: latestSnapshotPath || null
          };
        }
        await this.submit(page, async (message) => {
          await progress(message);
        });
        await this.assertSuccess(page, async (message) => {
          await progress(message);
        });
        await progress("Automation completed successfully", "submit-complete");
        await onRunFinished({
          ok: true,
          mode: "submit",
          externalReference: page.url(),
          snapshotPath: latestSnapshotPath || null
        });
        return {
          ok: true,
          mode: "submit",
          externalReference: page.url(),
          snapshotPath: latestSnapshotPath || null
        };
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
        await onRunFailed(error);
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
  buildChromiumLaunchOptions,
  createSingleSiteAdapter
};
