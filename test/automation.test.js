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
});
