const path = require("node:path");

const DEFAULT_SITE_ID = "external-form";
const DEFAULT_TARGET_NAME = "External Form";

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseJsonObject(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function getDataDir() {
  const configured = String(process.env.DATA_DIR || "").trim();
  return configured ? path.resolve(configured) : path.join(__dirname, "..", "..", "data");
}

function getAutomationConfig() {
  return {
    siteId: String(process.env.AUTOMATION_TARGET_SITE_ID || DEFAULT_SITE_ID).trim() || DEFAULT_SITE_ID,
    targetName:
      String(process.env.AUTOMATION_TARGET_NAME || DEFAULT_TARGET_NAME).trim() || DEFAULT_TARGET_NAME,
    loginUrl: String(process.env.AUTOMATION_TARGET_LOGIN_URL || "").trim(),
    formUrl: String(process.env.AUTOMATION_TARGET_FORM_URL || "").trim(),
    usernameSelector: String(process.env.AUTOMATION_USERNAME_SELECTOR || "").trim(),
    passwordSelector: String(process.env.AUTOMATION_PASSWORD_SELECTOR || "").trim(),
    loginSubmitSelector: String(process.env.AUTOMATION_LOGIN_SUBMIT_SELECTOR || "").trim(),
    authCheckSelector: String(process.env.AUTOMATION_AUTH_CHECK_SELECTOR || "").trim(),
    submitSelector: String(process.env.AUTOMATION_SUBMIT_SELECTOR || "").trim(),
    successSelector: String(process.env.AUTOMATION_SUCCESS_SELECTOR || "").trim(),
    successUrlContains: String(process.env.AUTOMATION_SUCCESS_URL_CONTAINS || "").trim(),
    fieldMap: parseJsonObject(process.env.AUTOMATION_FIELD_MAP_JSON),
    headless: parseBoolean(process.env.PLAYWRIGHT_HEADLESS, true),
    timeoutMs: Math.max(parseInteger(process.env.AUTOMATION_TIMEOUT_MS, 20000), 5000),
    workerIntervalMs: Math.max(parseInteger(process.env.AUTOMATION_WORKER_INTERVAL_MS, 60000), 10000),
    defaultLeadMinutes: Math.max(parseInteger(process.env.AUTOMATION_DEFAULT_LEAD_MINUTES, 60), 0),
    horizonDays: Math.max(parseInteger(process.env.AUTOMATION_HORIZON_DAYS, 30), 1),
    captureDir: path.join(getDataDir(), "automation-captures")
  };
}

function getMissingAutomationConfigKeys(config = getAutomationConfig()) {
  const required = [
    ["AUTOMATION_TARGET_LOGIN_URL", config.loginUrl],
    ["AUTOMATION_TARGET_FORM_URL", config.formUrl],
    ["AUTOMATION_USERNAME_SELECTOR", config.usernameSelector],
    ["AUTOMATION_PASSWORD_SELECTOR", config.passwordSelector],
    ["AUTOMATION_LOGIN_SUBMIT_SELECTOR", config.loginSubmitSelector],
    ["AUTOMATION_AUTH_CHECK_SELECTOR", config.authCheckSelector],
    ["AUTOMATION_SUBMIT_SELECTOR", config.submitSelector]
  ];

  if (!config.fieldMap || Object.keys(config.fieldMap).length === 0) {
    required.push(["AUTOMATION_FIELD_MAP_JSON", ""]);
  }

  return required.filter((entry) => !String(entry[1] || "").trim()).map((entry) => entry[0]);
}

function hasAutomationTargetConfig(config = getAutomationConfig()) {
  return getMissingAutomationConfigKeys(config).length === 0;
}

module.exports = {
  DEFAULT_SITE_ID,
  DEFAULT_TARGET_NAME,
  getAutomationConfig,
  getDataDir,
  getMissingAutomationConfigKeys,
  hasAutomationTargetConfig,
  parseBoolean,
  parseInteger
};
