const PORT = Number.parseInt(String(process.env.SMOKE_PORT || process.env.PORT || "3000"), 10);
const BASE_URL = String(process.env.SMOKE_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");

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

  const home = await fetch(`${BASE_URL}/`);
  ensure(home.ok, "Home route failed.");
  const homeText = await home.text();
  ensure(homeText.includes("All Appointments"), "Home page missing expected heading.");

  const settings = await fetch(`${BASE_URL}/settings`);
  ensure(settings.ok, "Settings route failed.");
  const settingsText = await settings.text();
  ensure(settingsText.includes("View History Log"), "Settings missing history log trigger.");
  ensure(settingsText.includes('id="historyModal"'), "Settings missing history modal markup.");

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

  console.log(`Smoke test passed against ${BASE_URL}.`);
}

run().catch((error) => {
  console.error(`Smoke test failed: ${error.message}`);
  process.exit(1);
});
