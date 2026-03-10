/* global afterEach */

const request = require("supertest");

describe("automation viewer session manager", () => {
  const viewer = require("../src/automation/viewerSession");

  afterEach(() => {
    viewer.resetViewerSessionsForTests();
  });

  it("tracks a live session and clears it when stopped", () => {
    const session = viewer.startViewerSession(42, { status: "Launching browser" });

    expect(session).toBeTruthy();
    expect(session.sessionId).toBeTruthy();

    expect(viewer.getViewerStateForUser(42)).toEqual({
      active: true,
      sessionId: session.sessionId,
      status: "Launching browser",
      startedAt: expect.any(String),
      endedAt: "",
      streamUrl: `/automation/viewer/stream?sessionId=${encodeURIComponent(session.sessionId)}`,
      lastFrameAt: ""
    });

    viewer.updateViewerSession(session.sessionId, { status: "Opening sign-in page" });
    expect(viewer.getViewerStateForUser(42).status).toBe("Opening sign-in page");

    viewer.stopViewerSession(session.sessionId, { status: "completed" });

    expect(viewer.getViewerStateForUser(42)).toEqual({
      active: false,
      sessionId: session.sessionId,
      status: "completed",
      startedAt: expect.any(String),
      endedAt: expect.any(String),
      streamUrl: "",
      lastFrameAt: ""
    });
  });

  it("rejects stream clients for inactive sessions", () => {
    const session = viewer.startViewerSession(7, { status: "Starting" });
    viewer.stopViewerSession(session.sessionId, { status: "done" });
    const res = {
      status() {
        throw new Error("should not write response");
      }
    };

    expect(viewer.addViewerStreamClient(7, session.sessionId, res)).toBe(false);
  });
});

describe("automation viewer routes", () => {
  it("protects viewer state behind auth", async () => {
    const app = require("../src/app");
    const response = await request(app).get("/automation/viewer/state");

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("/auth/login");
  });

  it("returns inactive viewer state for an authenticated test profile session", async () => {
    const originalTempProfile = process.env.TEMP_TEST_PROFILE;
    try {
      process.env.TEMP_TEST_PROFILE = "true";
      delete require.cache[require.resolve("../src/routes/authRoutes")];
      delete require.cache[require.resolve("../src/app")];
      const app = require("../src/app");
      const agent = request.agent(app);

      const loginPage = await agent.get("/auth/login");
      expect(loginPage.status).toBe(200);
      const csrfMatch = String(loginPage.text || "").match(/name="_csrf"\s+value="([^"]+)"/);
      expect(csrfMatch).toBeTruthy();

      const bypassResponse = await agent
        .post("/auth/bypass")
        .type("form")
        .send({ _csrf: csrfMatch[1] });
      expect(bypassResponse.status).toBe(302);

      const response = await agent.get("/automation/viewer/state");
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        active: false,
        sessionId: "",
        streamUrl: ""
      });
    } finally {
      process.env.TEMP_TEST_PROFILE = originalTempProfile;
      delete require.cache[require.resolve("../src/routes/authRoutes")];
      delete require.cache[require.resolve("../src/app")];
    }
  });
});
