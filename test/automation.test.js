/* global afterEach */

describe("automation helpers", () => {
  const originalSecret = process.env.AUTOMATION_SECRET_KEY;

  afterEach(() => {
    process.env.AUTOMATION_SECRET_KEY = originalSecret;
  });

  it("encrypts and decrypts target-site credentials", () => {
    process.env.AUTOMATION_SECRET_KEY = "test-automation-secret";
    const { encryptSecret, decryptSecret } = require("../src/automation/crypto");
    const encrypted = encryptSecret("super-secret-password");

    expect(encrypted).toBeTruthy();
    expect(encrypted).not.toBe("super-secret-password");
    expect(decryptSecret(encrypted)).toBe("super-secret-password");
  });

  it("builds a payload from appointment data and reports missing required fields", () => {
    const { buildPayloadFromAppointment } = require("../src/automation/siteAdapter");
    const { payload, missingFields } = buildPayloadFromAppointment({
      title: "Court appearance",
      date: "2026-03-15",
      time: "",
      location: "123 Main St",
      notes: "Bring paperwork"
    });

    expect(payload.title).toBe("Court appearance");
    expect(payload.location).toBe("123 Main St");
    expect(missingFields).toEqual(["time"]);
  });

  it("treats questionnaire answers as required config for ce check-in", () => {
    const { getMissingAutomationConfigKeys } = require("../src/automation/config");
    const missing = getMissingAutomationConfigKeys({
      siteId: "ce-check-in",
      loginUrl: "https://www.cecheckin.com/client/account/signin",
      formUrl: "https://www.cecheckin.com/client/en-us/report/demo",
      usernameSelector: 'input[name="Pin"]',
      passwordSelector: 'input[name="Password"]',
      loginSubmitSelector: "button.btn.btn-primary.btn-lg.btn-block",
      authCheckSelector: "#signOutForm",
      submitSelector: "a.btn.btn-primary.btn-checkin",
      questionnaireAnswers: {}
    });

    expect(missing).toContain("AUTOMATION_QUESTIONNAIRE_ANSWERS_JSON");
    expect(missing).not.toContain("AUTOMATION_FIELD_MAP_JSON");
  });

  it("uses built-in auth selector defaults for ce check-in", () => {
    const { getAutomationConfig } = require("../src/automation/config");
    const previous = {
      AUTOMATION_TARGET_SITE_ID: process.env.AUTOMATION_TARGET_SITE_ID,
      AUTOMATION_AUTH_CHECK_SELECTOR: process.env.AUTOMATION_AUTH_CHECK_SELECTOR,
      AUTOMATION_LOGIN_SUBMIT_SELECTOR: process.env.AUTOMATION_LOGIN_SUBMIT_SELECTOR
    };

    process.env.AUTOMATION_TARGET_SITE_ID = "ce-check-in";
    delete process.env.AUTOMATION_AUTH_CHECK_SELECTOR;
    delete process.env.AUTOMATION_LOGIN_SUBMIT_SELECTOR;

    const config = getAutomationConfig();

    expect(config.authCheckSelector).toBe("#signOutForm");
    expect(config.loginSubmitSelector).toBe("button.btn.btn-primary.btn-lg.btn-block");

    process.env.AUTOMATION_TARGET_SITE_ID = previous.AUTOMATION_TARGET_SITE_ID;
    process.env.AUTOMATION_AUTH_CHECK_SELECTOR = previous.AUTOMATION_AUTH_CHECK_SELECTOR;
    process.env.AUTOMATION_LOGIN_SUBMIT_SELECTOR = previous.AUTOMATION_LOGIN_SUBMIT_SELECTOR;
  });

  it("uses saved ce check-in payload for dry runs without an appointment", () => {
    const { createSingleSiteAdapter } = require("../src/automation/siteAdapter");
    const adapter = createSingleSiteAdapter({
      siteId: "ce-check-in",
      targetName: "Ce Check-In",
      questionnaireAnswers: {
        "Are you currently employed?": "No"
      },
      contactLine1: "1951 Golden State Ave Apt 11",
      contactLine2: "",
      contactCity: "Bakersfield",
      contactState: "CA",
      contactZip: "93301",
      updateMailingAddress: true
    });

    const { payload, missingFields } = adapter.buildPayloadFromAppointment({});

    expect(missingFields).toEqual([]);
    expect(payload).toMatchObject({
      updateMailingAddress: true,
      contact: {
        line1: "1951 Golden State Ave Apt 11",
        city: "Bakersfield",
        state: "CA",
        zip: "93301"
      },
      questionnaireAnswers: {
        "Are you currently employed?": "No"
      }
    });
  });
});
