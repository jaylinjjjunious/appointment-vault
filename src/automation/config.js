const path = require("node:path");

const DEFAULT_SITE_ID = "external-form";
const DEFAULT_TARGET_NAME = "External Form";
const CE_CHECK_IN_SITE_ID = "ce-check-in";
const CE_CHECK_IN_DEFAULTS = {
  targetName: "Ce Check-In",
  loginUrl: "https://www.cecheckin.com/client/account/signin",
  usernameSelector: 'input[name="Pin"]',
  passwordSelector: 'input[name="Password"]',
  loginSubmitSelector: "button.btn.btn-primary.btn-lg.btn-block",
  authCheckSelector: "#signOutForm",
  submitSelector: "a.btn.btn-primary.btn-checkin",
  successUrlContains: "/client"
};

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
  const siteId =
    String(process.env.AUTOMATION_TARGET_SITE_ID || DEFAULT_SITE_ID).trim() || DEFAULT_SITE_ID;
  const ceDefaults = siteId === CE_CHECK_IN_SITE_ID ? CE_CHECK_IN_DEFAULTS : null;

  return {
    siteId,
    targetName:
      String(process.env.AUTOMATION_TARGET_NAME || ceDefaults?.targetName || DEFAULT_TARGET_NAME).trim() ||
      ceDefaults?.targetName ||
      DEFAULT_TARGET_NAME,
    loginUrl: String(process.env.AUTOMATION_TARGET_LOGIN_URL || ceDefaults?.loginUrl || "").trim(),
    formUrl: String(process.env.AUTOMATION_TARGET_FORM_URL || "").trim(),
    usernameSelector: String(
      process.env.AUTOMATION_USERNAME_SELECTOR || ceDefaults?.usernameSelector || ""
    ).trim(),
    passwordSelector: String(
      process.env.AUTOMATION_PASSWORD_SELECTOR || ceDefaults?.passwordSelector || ""
    ).trim(),
    loginSubmitSelector: String(
      process.env.AUTOMATION_LOGIN_SUBMIT_SELECTOR || ceDefaults?.loginSubmitSelector || ""
    ).trim(),
    authCheckSelector: String(
      process.env.AUTOMATION_AUTH_CHECK_SELECTOR || ceDefaults?.authCheckSelector || ""
    ).trim(),
    submitSelector: String(process.env.AUTOMATION_SUBMIT_SELECTOR || ceDefaults?.submitSelector || "").trim(),
    successSelector: String(process.env.AUTOMATION_SUCCESS_SELECTOR || "").trim(),
    successUrlContains: String(
      process.env.AUTOMATION_SUCCESS_URL_CONTAINS || ceDefaults?.successUrlContains || ""
    ).trim(),
    fieldMap: parseJsonObject(process.env.AUTOMATION_FIELD_MAP_JSON),
    questionnaireAnswers: parseJsonObject(process.env.AUTOMATION_QUESTIONNAIRE_ANSWERS_JSON),
    contactLine1: String(process.env.AUTOMATION_CONTACT_LINE1 || "").trim(),
    contactLine2: String(process.env.AUTOMATION_CONTACT_LINE2 || "").trim(),
    contactCity: String(process.env.AUTOMATION_CONTACT_CITY || "").trim(),
    contactState: String(process.env.AUTOMATION_CONTACT_STATE || "").trim(),
    contactZip: String(process.env.AUTOMATION_CONTACT_ZIP || "").trim(),
    updateMailingAddress: parseBoolean(process.env.AUTOMATION_UPDATE_MAILING_ADDRESS, false),
    headless: parseBoolean(process.env.PLAYWRIGHT_HEADLESS, true),
    browserExecutablePath: String(process.env.PLAYWRIGHT_EXECUTABLE_PATH || "").trim(),
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

  if (
    config.siteId === "ce-check-in" &&
    (!config.questionnaireAnswers || Object.keys(config.questionnaireAnswers).length === 0)
  ) {
    required.push(["AUTOMATION_QUESTIONNAIRE_ANSWERS_JSON", ""]);
  } else if (config.siteId !== "ce-check-in" && (!config.fieldMap || Object.keys(config.fieldMap).length === 0)) {
    required.push(["AUTOMATION_FIELD_MAP_JSON", ""]);
  }

  return required.filter((entry) => !String(entry[1] || "").trim()).map((entry) => entry[0]);
}

function hasAutomationTargetConfig(config = getAutomationConfig()) {
  return getMissingAutomationConfigKeys(config).length === 0;
}

module.exports = {
  CE_CHECK_IN_DEFAULTS,
  CE_CHECK_IN_SITE_ID,
  DEFAULT_SITE_ID,
  DEFAULT_TARGET_NAME,
  getAutomationConfig,
  getDataDir,
  getMissingAutomationConfigKeys,
  hasAutomationTargetConfig,
  parseBoolean,
  parseInteger
};
