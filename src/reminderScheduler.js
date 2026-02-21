const cron = require("node-cron");
const twilio = require("twilio");
const db = require("./db");

const REMINDER_OFFSETS_MINUTES = [60, 30];
const LOOKAHEAD_MINUTES = 61;

let schedulerStarted = false;
let loggedMissingEnv = false;
let loggedBaseUrlWarning = false;

const insertPendingReminderStmt = db.prepare(
  `INSERT OR IGNORE INTO reminder_calls
    (appointmentId, remindAt, status, twilioCallSid, errorMessage, createdAt, updatedAt)
   VALUES (?, ?, 'pending', NULL, NULL, ?, ?)`
);

const markReminderFailedStmt = db.prepare(
  `UPDATE reminder_calls
   SET status = 'failed',
       errorMessage = ?,
       updatedAt = ?
   WHERE id = ?`
);

const markReminderSentStmt = db.prepare(
  `UPDATE reminder_calls
   SET status = 'sent',
       twilioCallSid = ?,
       errorMessage = NULL,
       updatedAt = ?
   WHERE id = ?`
);

function getTwilioConfig() {
  return {
    accountSid: String(process.env.TWILIO_ACCOUNT_SID || "").trim(),
    authToken: String(process.env.TWILIO_AUTH_TOKEN || "").trim(),
    fromNumber: String(process.env.TWILIO_FROM_NUMBER || "").trim(),
    toNumber: String(process.env.CALL_TO_NUMBER || "").trim(),
    publicBaseUrl: String(process.env.PUBLIC_BASE_URL || "").trim()
  };
}

function getMissingTwilioVars(config) {
  const missing = [];
  if (!config.accountSid) missing.push("TWILIO_ACCOUNT_SID");
  if (!config.authToken) missing.push("TWILIO_AUTH_TOKEN");
  if (!config.fromNumber) missing.push("TWILIO_FROM_NUMBER");
  if (!config.toNumber) missing.push("CALL_TO_NUMBER");
  return missing;
}

function logTwilioEnvStatus() {
  const config = getTwilioConfig();
  const missing = getMissingTwilioVars(config);
  if (missing.length > 0) {
    console.error(
      `[Twilio Reminders] Missing environment variables: ${missing.join(
        ", "
      )}. Outbound reminder calls are disabled.`
    );
    return false;
  }

  if (!config.publicBaseUrl) {
    console.warn(
      "[Twilio Reminders] PUBLIC_BASE_URL is not set. Twilio webhook URL will default to local host and may fail without ngrok."
    );
  }

  return true;
}

function normalizePublicBaseUrl() {
  const config = getTwilioConfig();
  if (config.publicBaseUrl) {
    return config.publicBaseUrl.replace(/\/+$/, "");
  }

  const host = String(process.env.APP_HOST || "localhost").trim();
  const port = String(process.env.APP_PORT || process.env.PORT || "3000").trim();
  return `http://${host}:${port}`;
}

function parseAppointmentDateTime(appointment) {
  const combined = `${appointment.date}T${appointment.time}:00`;
  const parsed = new Date(combined);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function markReminderFailed(reminderId, message) {
  const nowIso = new Date().toISOString();
  markReminderFailedStmt.run(
    String(message || "Unknown error").slice(0, 500),
    nowIso,
    reminderId
  );
}

function markReminderSent(reminderId, twilioCallSid) {
  const nowIso = new Date().toISOString();
  markReminderSentStmt.run(twilioCallSid || null, nowIso, reminderId);
}

function formatLocalDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

function getUpcomingAppointments(now) {
  const horizon = new Date(now.getTime() + LOOKAHEAD_MINUTES * 60 * 1000);
  const lowerDate = formatLocalDate(now);
  const upperDate = formatLocalDate(horizon);

  const appointments = db
    .prepare(
      `SELECT id, title, date, time, location
       FROM appointments
       WHERE completedAt IS NULL
         AND date >= ?
         AND date <= ?
       ORDER BY date ASC, time ASC, id ASC`
    )
    .all(lowerDate, upperDate);

  return appointments.filter((appointment) => {
    const startDateTime = parseAppointmentDateTime(appointment);
    if (!startDateTime) {
      return false;
    }

    return startDateTime > now && startDateTime <= horizon;
  });
}

function getReminderDueState(now, appointmentDateTime, offsetMinutes) {
  const remindAt = new Date(appointmentDateTime.getTime() - offsetMinutes * 60 * 1000);
  const nowMs = now.getTime();
  const remindAtMs = remindAt.getTime();
  const appointmentMs = appointmentDateTime.getTime();
  return {
    remindAt,
    // If the app starts late or the appointment is created within the offset window
    // (e.g., a "60 min" reminder for an appointment in 45 min), send immediately.
    isDueNow: nowMs >= remindAtMs && nowMs < appointmentMs
  };
}

async function createVoiceCall(client, config, appointmentId, minutesOffset) {
  const baseUrl = normalizePublicBaseUrl();
  const params = new URLSearchParams({
    appointmentId: String(appointmentId),
    minutes: String(minutesOffset)
  });

  return client.calls.create({
    to: config.toNumber,
    from: config.fromNumber,
    url: `${baseUrl}/twilio/voice?${params.toString()}`
  });
}

async function triggerTestCall(appointmentId, minutesOffset) {
  const config = getTwilioConfig();
  const missing = getMissingTwilioVars(config);

  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}. Outbound reminder calls are disabled.`
    );
  }

  if (![30, 60].includes(minutesOffset)) {
    throw new Error("minutes must be either 30 or 60.");
  }

  const client = twilio(config.accountSid, config.authToken);
  return createVoiceCall(client, config, appointmentId, minutesOffset);
}

async function processDueReminders() {
  try {
    const config = getTwilioConfig();
    const missing = getMissingTwilioVars(config);

    if (missing.length > 0) {
      if (!loggedMissingEnv) {
        console.error(
          `[Twilio Reminders] Missing environment variables: ${missing.join(
            ", "
          )}. Outbound reminder calls are disabled.`
        );
        loggedMissingEnv = true;
      }
      return;
    }

    loggedMissingEnv = false;
    if (!process.env.PUBLIC_BASE_URL && !loggedBaseUrlWarning) {
      console.warn(
        "[Twilio Reminders] PUBLIC_BASE_URL not set. Twilio webhook URL will point to localhost and fail for external callbacks."
      );
      loggedBaseUrlWarning = true;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const upcomingAppointments = getUpcomingAppointments(now);

    if (upcomingAppointments.length === 0) {
      return;
    }

    const client = twilio(config.accountSid, config.authToken);

    for (const appointment of upcomingAppointments) {
      const appointmentDateTime = parseAppointmentDateTime(appointment);
      if (!appointmentDateTime) {
        continue;
      }

      for (const offsetMinutes of REMINDER_OFFSETS_MINUTES) {
        const { remindAt, isDueNow } = getReminderDueState(
          now,
          appointmentDateTime,
          offsetMinutes
        );
        if (!isDueNow) {
          continue;
        }

        const remindAtIso = remindAt.toISOString();
        const insertResult = insertPendingReminderStmt.run(
          appointment.id,
          remindAtIso,
          nowIso,
          nowIso
        );
        if (insertResult.changes === 0) {
          continue;
        }

        try {
          const call = await createVoiceCall(
            client,
            config,
            appointment.id,
            offsetMinutes
          );
          markReminderSent(insertResult.lastInsertRowid, call.sid);
        } catch (error) {
          markReminderFailed(
            insertResult.lastInsertRowid,
            error?.message || "Twilio call failed."
          );
        }
      }
    }
  } catch (error) {
    console.error("[Twilio Reminders] Scheduler error:", error.message);
  }
}

function startReminderScheduler() {
  if (schedulerStarted) {
    return;
  }
  schedulerStarted = true;

  cron.schedule("* * * * *", async () => {
    await processDueReminders();
  });

  setTimeout(() => {
    processDueReminders().catch((error) => {
      console.error("[Twilio Reminders] Initial run error:", error.message);
    });
  }, 1500);
}

module.exports = {
  logTwilioEnvStatus,
  startReminderScheduler,
  triggerTestCall
};

