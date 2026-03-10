const { randomUUID } = require("node:crypto");

const sessionsById = new Map();
const sessionIdByUser = new Map();

function writeMjpegFrame(target, frameBuffer) {
  if (!target || !frameBuffer) {
    return;
  }
  target.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuffer.length}\r\n\r\n`);
  target.write(frameBuffer);
  target.write("\r\n");
}

function destroySessionStreams(session) {
  if (!session?.clients) {
    return;
  }
  for (const client of session.clients) {
    try {
      client.end();
    } catch (error) {
      // Ignore broken pipe errors while closing streams.
    }
  }
  session.clients.clear();
}

function getViewerStateForUser(userId) {
  const normalizedUserId = Number(userId || 0);
  if (!normalizedUserId) {
    return {
      active: false,
      sessionId: "",
      status: "",
      startedAt: "",
      endedAt: "",
      streamUrl: "",
      lastFrameAt: ""
    };
  }
  const sessionId = sessionIdByUser.get(normalizedUserId);
  const session = sessionId ? sessionsById.get(sessionId) : null;
  if (!session) {
    return {
      active: false,
      sessionId: "",
      status: "",
      startedAt: "",
      endedAt: "",
      streamUrl: "",
      lastFrameAt: ""
    };
  }
  return {
    active: Boolean(session.active),
    sessionId: session.sessionId,
    status: String(session.status || ""),
    startedAt: String(session.startedAt || ""),
    endedAt: String(session.endedAt || ""),
    streamUrl: session.active ? `/automation/viewer/stream?sessionId=${encodeURIComponent(session.sessionId)}` : "",
    lastFrameAt: String(session.lastFrameAt || "")
  };
}

function startViewerSession(userId, metadata = {}) {
  const normalizedUserId = Number(userId || 0);
  if (!normalizedUserId) {
    return null;
  }
  const previousSessionId = sessionIdByUser.get(normalizedUserId);
  if (previousSessionId) {
    stopViewerSession(previousSessionId, { status: "replaced" });
  }
  const sessionId = randomUUID();
  const session = {
    sessionId,
    userId: normalizedUserId,
    status: String(metadata.status || "starting"),
    startedAt: new Date().toISOString(),
    endedAt: "",
    active: true,
    streamActive: false,
    lastFrameAt: "",
    latestFrame: null,
    captureTimer: null,
    captureInFlight: false,
    page: null,
    clients: new Set()
  };
  sessionsById.set(sessionId, session);
  sessionIdByUser.set(normalizedUserId, sessionId);
  return session;
}

function updateViewerSession(sessionId, patch = {}) {
  const session = sessionsById.get(String(sessionId || ""));
  if (!session) {
    return null;
  }
  if (patch.status !== undefined) {
    session.status = String(patch.status || "");
  }
  if (patch.active !== undefined) {
    session.active = Boolean(patch.active);
  }
  if (patch.endedAt !== undefined) {
    session.endedAt = String(patch.endedAt || "");
  }
  return session;
}

function stopViewerSession(sessionId, finalState = {}) {
  const session = sessionsById.get(String(sessionId || ""));
  if (!session) {
    return null;
  }
  if (session.captureTimer) {
    clearInterval(session.captureTimer);
    session.captureTimer = null;
  }
  session.active = false;
  session.streamActive = false;
  session.page = null;
  if (finalState.status !== undefined) {
    session.status = String(finalState.status || "");
  }
  session.endedAt = String(finalState.endedAt || new Date().toISOString());
  destroySessionStreams(session);
  return session;
}

function attachPageToViewer(sessionId, page, config = {}) {
  const session = sessionsById.get(String(sessionId || ""));
  if (!session || !session.active || !page) {
    return null;
  }
  session.page = page;
  session.streamActive = true;
  const intervalMs = Math.max(Number(config.viewerIntervalMs || 800), 250);
  const jpegQuality = Math.min(Math.max(Number(config.viewerJpegQuality || 55), 10), 90);

  const captureFrame = async () => {
    if (!session.active || session.captureInFlight || !session.page) {
      return;
    }
    session.captureInFlight = true;
    try {
      const frameBuffer = await session.page.screenshot({
        type: "jpeg",
        quality: jpegQuality,
        fullPage: false
      });
      session.latestFrame = frameBuffer;
      session.lastFrameAt = new Date().toISOString();
      for (const client of [...session.clients]) {
        try {
          writeMjpegFrame(client, frameBuffer);
        } catch (error) {
          session.clients.delete(client);
          try {
            client.end();
          } catch (endError) {
            // ignore
          }
        }
      }
    } catch (error) {
      // Ignore capture failures while the page is navigating.
    } finally {
      session.captureInFlight = false;
    }
  };

  session.captureTimer = setInterval(captureFrame, intervalMs);
  captureFrame().catch(() => null);
  return session;
}

function addViewerStreamClient(userId, sessionId, res) {
  const normalizedUserId = Number(userId || 0);
  if (!normalizedUserId) {
    return false;
  }
  const currentSessionId = sessionIdByUser.get(normalizedUserId);
  if (!currentSessionId || String(currentSessionId) !== String(sessionId || "")) {
    return false;
  }
  const session = sessionsById.get(currentSessionId);
  if (!session || !session.active) {
    return false;
  }

  res.status(200);
  res.setHeader("Content-Type", "multipart/x-mixed-replace; boundary=frame");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  session.clients.add(res);
  if (session.latestFrame) {
    writeMjpegFrame(res, session.latestFrame);
  }

  res.on("close", () => {
    session.clients.delete(res);
  });

  return true;
}

function resetViewerSessionsForTests() {
  for (const session of sessionsById.values()) {
    if (session.captureTimer) {
      clearInterval(session.captureTimer);
    }
    destroySessionStreams(session);
  }
  sessionsById.clear();
  sessionIdByUser.clear();
}

module.exports = {
  addViewerStreamClient,
  attachPageToViewer,
  getViewerStateForUser,
  resetViewerSessionsForTests,
  startViewerSession,
  stopViewerSession,
  updateViewerSession
};
