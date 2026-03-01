const PORT = Number.parseInt(String(process.env.SMOKE_PORT || process.env.PORT || "3000"), 10);
const BASE_URL = String(process.env.SMOKE_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const db = require("../src/db");
const { processRequest } = require("../src/ai");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) {
        return true;
      }
    } catch (error) {
      // service not up yet
    }
    await sleep(500);
  }
  return false;
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run() {
  const ready = await waitForHealth();
  ensure(
    ready,
    `Service is not reachable at ${BASE_URL}. Start the app first, then run smoke tests.`
  );

  await checkRedirectOrContent(
    "/",
    [["Calendar", "Google Calendar Panel"]],
    "Home route failed."
  );

  await checkRedirectOrContent(
    "/dashboard",
    [["Dashboard", "Quick Add"]],
    "Dashboard route failed.",
    [["Google Calendar Panel", "Open Calendar Page"]]
  );

  await checkRedirectOrContent(
    "/settings",
    ["View History Log", 'id="historyModal"'],
    "Settings route failed."
  );

  const conflictResponse = await fetch(`${BASE_URL}/api/appointments/validate-conflict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Smoke Conflict Check",
      date: "2026-02-23",
      time: "10:00",
      location: "QA",
      notes: "",
      tags: "qa",
      reminderMinutes: "30",
      isRecurring: "false",
      rrule: ""
    })
  });
  ensure(conflictResponse.ok, "Conflict validation API failed.");
  const conflictJson = await conflictResponse.json();
  ensure(conflictJson.ok === true, "Conflict validation API did not return ok=true.");

  const activityResponse = await fetch(`${BASE_URL}/api/reminders/activity`);
  ensure(activityResponse.ok, "Reminder activity API failed.");
  const activityJson = await activityResponse.json();
  ensure(activityJson.ok === true, "Reminder activity API did not return ok=true.");

  await runAiConflictSmoke();
  await runAiInfoNeededSmoke();
  await runCalendarRouteSmoke();

  console.log(`Smoke test passed against ${BASE_URL}.`);
}

async function runCalendarRouteSmoke() {
  await checkRedirectOrContent(
    "/calendar",
    [["Google Calendar Panel", "Connect Google Calendar"]],
    "Calendar route failed."
  );
}

async function checkRedirectOrContent(path, requiredSnippets, failureMessage, extraSnippets = []) {
  const response = await fetch(`${BASE_URL}${path}`, { redirect: "manual" });
  if (response.status === 302 || response.status === 303) {
    const location = String(response.headers.get("location") || "");
    if (location.includes("/auth/login")) {
      return;
    }
    if (location) {
      const redirectUrl = location.startsWith("http")
        ? location
        : `${BASE_URL}${location.startsWith("/") ? "" : "/"}${location}`;
      const follow = await fetch(redirectUrl);
      ensure(follow.ok, failureMessage);
      const followText = await follow.text();
      assertContentIncludes(path, followText, requiredSnippets, extraSnippets);
      return;
    }
  }

  ensure(response.ok, failureMessage);
  const text = await response.text();
  assertContentIncludes(path, text, requiredSnippets, extraSnippets);
}

function assertContentIncludes(path, text, requiredSnippets, extraSnippets) {
  const required = [...requiredSnippets, ...extraSnippets];
  for (const entry of required) {
    if (Array.isArray(entry)) {
      const hit = entry.some((snippet) => text.includes(snippet));
      ensure(
        hit,
        `Expected content missing on ${path}: ${entry.join(" or ")}`
      );
    } else {
      ensure(
        text.includes(entry),
        `Expected content missing on ${path}: ${entry}`
      );
    }
  }
}

function getOrCreateSmokeUserId() {
  const existing = db.prepare("SELECT id FROM users ORDER BY id ASC LIMIT 1").get();
  if (existing?.id) {
    return { id: existing.id, created: false };
  }

  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO users
      (provider, providerUserId, email, displayName, phoneNumber, timezone, voiceEnabled, smsEnabled, quietHoursStart, quietHoursEnd, reminderStrategy, createdAt, updatedAt)
     VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = insert.run(
    "smoke",
    "smoke-user",
    "smoke@example.local",
    "Smoke User",
    null,
    "America/Los_Angeles",
    1,
    1,
    null,
    null,
    "voice_primary_sms_fallback",
    now,
    now
  );
  return { id: Number(info.lastInsertRowid), created: true };
}

async function runAiConflictSmoke() {
  const user = getOrCreateSmokeUserId();
  const now = new Date().toISOString();
  const slotDate = "2026-02-23";
  const slotTime = "10:00";
  const appointmentTitle = `Smoke AI Conflict ${Date.now()}`;

  const inserted = db.prepare(
    `INSERT INTO appointments
      (userId, title, date, time, location, notes, tags, reminderMinutes, isRecurring, rrule, seriesId, occurrenceStart, occurrenceEnd, completedAt, createdAt, updatedAt)
     VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user.id,
    appointmentTitle,
    slotDate,
    slotTime,
    "QA",
    null,
    "smoke,ai",
    null,
    0,
    null,
    null,
    `${slotDate}T${slotTime}:00`,
    null,
    null,
    now,
    now
  );

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("/api/chat")) {
      return {
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              thought: "Need to verify availability first.",
              appointment: {
                title: "Meeting with Sarah",
                date: slotDate,
                time: slotTime,
                location: "Office",
                notes: null,
                tags: "work",
                reminderMinutes: 30
              },
              tool_call: {
                name: "check_availability",
                arguments: { date: slotDate, time: slotTime }
              },
              needs_info: []
            })
          }
        })
      };
    }

    return originalFetch(url);
  };

  try {
    const result = await processRequest("Book meeting with Sarah at 10am", [], { userId: user.id });
    ensure(result && typeof result === "object", "AI smoke: processRequest returned invalid result.");
    ensure(result.status === "conflict", "AI smoke: expected conflict status.");
    ensure(typeof result.message === "string" && result.message.length > 0, "AI smoke: missing message.");
    ensure(result.data && typeof result.data === "object", "AI smoke: missing data object.");
    ensure(Array.isArray(result.data.suggestions), "AI smoke: suggestions missing.");
    ensure(result.data.suggestions.length === 2, "AI smoke: expected exactly two slot suggestions.");
  } finally {
    global.fetch = originalFetch;
    db.prepare("DELETE FROM appointments WHERE id = ?").run(Number(inserted.lastInsertRowid));
    if (user.created) {
      db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    }
  }
}

async function runAiInfoNeededSmoke() {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("/api/chat")) {
      return {
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              thought: "I need missing required fields before confirming.",
              appointment: {
                title: "",
                date: "",
                time: "16:00",
                location: null,
                notes: null,
                tags: null,
                reminderMinutes: null
              },
              tool_call: null,
              needs_info: ["title", "date"]
            })
          }
        })
      };
    }

    return originalFetch(url);
  };

  try {
    const result = await processRequest("Nevermind, move that to 4 PM", [], { userId: null });
    ensure(result && typeof result === "object", "AI info-needed smoke: processRequest returned invalid result.");
    ensure(result.status === "needs_info", "AI info-needed smoke: expected needs_info status.");
    ensure(typeof result.message === "string" && result.message.length > 0, "AI info-needed smoke: missing message.");
    ensure(result.data && typeof result.data === "object", "AI info-needed smoke: missing data object.");
    ensure(Array.isArray(result.data.missingFields), "AI info-needed smoke: missingFields missing.");
    ensure(
      result.data.missingFields.includes("title") && result.data.missingFields.includes("date"),
      "AI info-needed smoke: expected missing title and date."
    );
  } finally {
    global.fetch = originalFetch;
  }
}

run().catch((error) => {
  console.error(`Smoke test failed: ${error.message}`);
  process.exit(1);
});
