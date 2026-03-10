/* global beforeEach, afterEach, vi */

describe("google auth url", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.GOOGLE_REDIRECT_URI = "https://appointment-vault.onrender.com/auth/google/callback";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("always includes the OAuth state parameter", async () => {
    const { getGoogleAuthUrl } = require("../src/googleCalendar");
    const authUrl = new URL(getGoogleAuthUrl("signed.state.token"));

    expect(authUrl.searchParams.get("state")).toBe("signed.state.token");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      "https://appointment-vault.onrender.com/auth/google/callback"
    );
  });
});
