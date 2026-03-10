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

  it("returns the saved photo handoff checkpoint state for the signed-in user", async () => {
    const db = require("../src/db");
    const { getAutomationConfig } = require("../src/automation/config");
    const originalTempProfile = process.env.TEMP_TEST_PROFILE;
    try {
      process.env.TEMP_TEST_PROFILE = "true";
      delete require.cache[require.resolve("../src/routes/authRoutes")];
      delete require.cache[require.resolve("../src/app")];
      const app = require("../src/app");
      const agent = request.agent(app);

      const loginPage = await agent.get("/auth/login");
      const csrfMatch = String(loginPage.text || "").match(/name="_csrf"\s+value="([^"]+)"/);
      expect(csrfMatch).toBeTruthy();

      await agent
        .post("/auth/bypass")
        .type("form")
        .send({ _csrf: csrfMatch[1] });

      const user = db.prepare("SELECT * FROM users WHERE provider = 'test' ORDER BY id DESC LIMIT 1").get();
      expect(user?.id).toBeTruthy();

      const config = getAutomationConfig();
      const nowIso = new Date().toISOString();
      db.prepare("DELETE FROM automation_photo_handoffs WHERE userId = ? AND siteId = ?").run(user.id, config.siteId);
      db.prepare("DELETE FROM automation_integrations WHERE userId = ? AND siteId = ?").run(user.id, config.siteId);
      db.prepare(`
        INSERT INTO automation_integrations (
          userId, siteId, targetName, enabled, monthlyPhotoEnabled, monthlyPhotoDay, createdAt, updatedAt
        ) VALUES (?, ?, ?, 1, 1, 1, ?, ?)
      `).run(user.id, config.siteId, config.targetName, nowIso, nowIso);
      db.prepare(`
        INSERT INTO automation_photo_handoffs (
          userId, siteId, periodKey, scheduledFor, status, checkpoint, checkpointStateJson,
          resumeUrl, failureMessage, notificationSent, createdAt, updatedAt, completedAt
        ) VALUES (?, ?, ?, ?, 'waiting_for_user', ?, ?, ?, NULL, 0, ?, ?, NULL)
      `).run(
        user.id,
        config.siteId,
        "2026-03",
        nowIso,
        "photo_capture_required",
        JSON.stringify({
          siteId: config.siteId,
          checkpoint: "photo_capture_required",
          resumeUrl: "https://www.cecheckin.com/client/en-us/report/demo",
          payload: {
            questionnaireAnswers: { "Are you currently employed?": "No" },
            contact: { line1: "1951 Golden State Ave Apt 11", city: "Bakersfield", state: "CA", zip: "93301" },
            updateMailingAddress: true
          }
        }),
        "https://www.cecheckin.com/client/en-us/report/demo",
        nowIso,
        nowIso
      );

      const response = await agent.get("/automation/photo-handoff/state");
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        ok: true,
        handoff: {
          siteId: config.siteId,
          status: "waiting_for_user",
          checkpoint: "photo_capture_required",
          resumeUrl: "https://www.cecheckin.com/client/en-us/report/demo",
          state: {
            payload: {
              updateMailingAddress: true
            }
          }
        }
      });
    } finally {
      process.env.TEMP_TEST_PROFILE = originalTempProfile;
      delete require.cache[require.resolve("../src/routes/authRoutes")];
      delete require.cache[require.resolve("../src/app")];
    }
  });

  it("creates an assisted photo-step launch URL with a signed handoff token", async () => {
    const db = require("../src/db");
    const { getAutomationConfig } = require("../src/automation/config");
    const originalTempProfile = process.env.TEMP_TEST_PROFILE;
    try {
      process.env.TEMP_TEST_PROFILE = "true";
      delete require.cache[require.resolve("../src/routes/authRoutes")];
      delete require.cache[require.resolve("../src/app")];
      const app = require("../src/app");
      const agent = request.agent(app);

      const loginPage = await agent.get("/auth/login");
      const csrfMatch = String(loginPage.text || "").match(/name="_csrf"\s+value="([^"]+)"/);
      expect(csrfMatch).toBeTruthy();
      await agent.post("/auth/bypass").type("form").send({ _csrf: csrfMatch[1] });

      const user = db.prepare("SELECT * FROM users WHERE provider = 'test' ORDER BY id DESC LIMIT 1").get();
      const config = getAutomationConfig();
      const nowIso = new Date().toISOString();
      db.prepare("DELETE FROM automation_photo_handoffs WHERE userId = ? AND siteId = ?").run(user.id, config.siteId);
      db.prepare("DELETE FROM automation_integrations WHERE userId = ? AND siteId = ?").run(user.id, config.siteId);
      db.prepare(`
        INSERT INTO automation_integrations (
          userId, siteId, targetName, enabled, monthlyPhotoEnabled, monthlyPhotoDay, createdAt, updatedAt
        ) VALUES (?, ?, ?, 1, 1, 1, ?, ?)
      `).run(user.id, config.siteId, config.targetName, nowIso, nowIso);
      db.prepare(`
        INSERT INTO automation_photo_handoffs (
          userId, siteId, periodKey, scheduledFor, status, checkpoint, checkpointStateJson,
          resumeUrl, failureMessage, notificationSent, createdAt, updatedAt, completedAt
        ) VALUES (?, ?, ?, ?, 'waiting_for_user', ?, ?, ?, NULL, 0, ?, ?, NULL)
      `).run(
        user.id,
        config.siteId,
        "2026-03",
        nowIso,
        "photo_capture_required",
        JSON.stringify({ checkpoint: "photo_capture_required" }),
        "https://www.cecheckin.com/client/en-us/report/demo",
        nowIso,
        nowIso
      );

      const response = await agent.get("/automation/photo-handoff/launch");
      expect(response.status).toBe(302);
      expect(response.headers.location).toContain("https://www.cecheckin.com/client/en-us/report/demo");
      expect(response.headers.location).toContain("avHandoffToken=");
      expect(response.headers.location).toContain("avAppOrigin=");
    } finally {
      process.env.TEMP_TEST_PROFILE = originalTempProfile;
      delete require.cache[require.resolve("../src/routes/authRoutes")];
      delete require.cache[require.resolve("../src/app")];
    }
  });
});
