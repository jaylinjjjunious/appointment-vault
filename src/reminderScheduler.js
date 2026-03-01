const cron = require("node-cron");
const twilio = require("twilio");
const db = require("./db");

const DEFAULT_REMINDER_OFFSET_MINUTES = 30;
const LOOKAHEAD_MINUTES = 180;
const VOICE_RETRY_DELAY_MINUTES = 2;

let schedulerStarted = false;
let loggedMissingEnv = false;
let loggedBaseUrlWarning = false;

const selectDueQueuedAttemptsStmt = db.prepare(
  `SELECT ra.*,
          a.title AS appointmentTitle,
          a.date AS appointmentDate,
          a.time AS appointmentTime,
          a.completedAt AS appointmentCompletedAt,
          u.phoneNumber AS userPhoneNumber,
          u.timezone AS userTimezone,
          u.voiceEnabled AS userVoiceEnabled,
          u.smsEnabled AS userSmsEnabled,
          u.quietHoursStart AS userQuietHoursStart,
          u.quietHoursEnd AS userQuietHoursEnd,
          u.reminderStrategy AS userReminderStrategy
   FROM reminder_attempts ra
   JOIN users u ON u.id = ra.userId
   LEFT JOIN appointments a ON a.id = ra.appointmentId
   WHERE ra.status = 'queued'
     AND ra.scheduledFor <= ?
   ORDER BY ra.scheduledFor ASC, ra.id ASC`
);

const selectInitialAttemptStmt = db.prepare(
  `SELECT id
   FROM reminder_attempts
   WHERE appointmentId = ?
     AND channel = 'voice'
     AND attemptNumber = 1
   LIMIT 1`
);

const insertReminderAttemptStmt = db.prepare(
  `INSERT INTO reminder_attempts
    (userId, appointmentId, channel, attemptNumber, scheduledFor, startedAt, finishedAt, status, providerSid, errorCode, errorMessage, metadataJson, createdAt, updatedAt)
   VALUES
    (@userId, @appointmentId, @channel, @attemptNumber, @scheduledFor, @startedAt, @finishedAt, @status, @providerSid, @errorCode, @errorMessage, @metadataJson, @createdAt, @updatedAt)`
);

const updateAttemptStatusStmt = db.prepare(
  `UPDATE reminder_attempts
   SET status = @status,
       providerSid = COALESCE(@providerSid, providerSid),
       errorCode = @errorCode,
       errorMessage = @errorMessage,
       startedAt = COALESCE(@startedAt, startedAt),
       finishedAt = COALESCE(@finishedAt, finishedAt),
       metadataJson = COALESCE(@metadataJson, metadataJson),
       updatedAt = @updatedAt
   WHERE id = @id`
);

const selectAttemptByProviderSidStmt = db.prepare(
  `SELECT ra.*,
          a.title AS appointmentTitle,
          a.date AS appointmentDate,
          a.time AS appointmentTime,
          a.completedAt AS appointmentCompletedAt,
          u.phoneNumber AS userPhoneNumber,
          u.voiceEnabled AS userVoiceEnabled,
          u.smsEnabled AS userSmsEnabled,
          u.quietHoursStart AS userQuietHoursStart,
          u.quietHoursEnd AS userQuietHoursEnd,
          u.reminderStrategy AS userReminderStrategy
   FROM reminder_attempts ra
   JOIN users u ON u.id = ra.userId
   LEFT JOIN appointments a ON a.id = ra.appointmentId
   WHERE ra.providerSid = ?
     AND ra.channel = 'voice'
   ORDER BY ra.id DESC
   LIMIT 1`
);

const selectAttemptByIdStmt = db.prepare(
  `SELECT ra.*,
          a.title AS appointmentTitle,
          a.date AS appointmentDate,
          a.time AS appointmentTime,
          a.completedAt AS appointmentCompletedAt,
          u.phoneNumber AS userPhoneNumber,
          u.voiceEnabled AS userVoiceEnabled,
          u.smsEnabled AS userSmsEnabled,
          u.quietHoursStart AS userQuietHoursStart,
          u.quietHoursEnd AS userQuietHoursEnd,
          u.reminderStrategy AS userReminderStrategy
   FROM reminder_attempts ra
   JOIN users u ON u.id = ra.userId
   LEFT JOIN appointments a ON a.id = ra.appointmentId
   WHERE ra.id = ?`
);

const selectReminderActivityStmt = db.prepare(
  `SELECT id, userId, appointmentId, channel, attemptNumber, scheduledFor, startedAt, finishedAt, status, providerSid, errorCode, errorMessage, metadataJson, createdAt, updatedAt
   FROM reminder_attempts
   WHERE userId = @userId
     AND (@status = '' OR status = @status)
     AND (@channel = '' OR channel = @channel)
   ORDER BY createdAt DESC
   LIMIT @limit OFFSET @offset`
);

const countReminderActivityStmt = db.prepare(
  `SELECT COUNT(*) AS count
   FROM reminder_attempts
   WHERE userId = @userId
     AND (@status = '' OR status = @status)
     AND (@channel = '' OR channel = @channel)`
);

const selectUpcomingAppointmentsStmt = db.prepare(
  `SELECT a.id,
          a.userId,
          a.title,
          a.date,
          a.time,
          a.reminderMinutes,
          a.completedAt,
          u.phoneNumber AS userPhoneNumber,
          u.voiceEnabled AS userVoiceEnabled,
          u.smsEnabled AS userSmsEnabled,
          u.quietHoursStart AS userQuietHoursStart,
          u.quietHoursEnd AS userQuietHoursEnd
   FROM appointments a
   JOIN users u ON u.id = a.userId
   WHERE a.completedAt IS NULL
     AND a.userId IS NOT NULL
     AND a.date >= ?
     AND a.date <= ?
   ORDER BY a.date ASC, a.time ASC, a.id ASC`
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

function normalizePublicBaseUrl() {
  const config = getTwilioConfig();
  if (config.publicBaseUrl) {
    return config.publicBaseUrl.replace(/\/+$/, "");
  }

  const host = String(process.env.APP_HOST || "localhost").trim();
  const port = String(process.env.APP_PORT || process.env.PORT || "3000").trim();
  return `http://${host}:${port}`;
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

function formatLocalDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

function parseAppointmentDateTime(appointment) {
  const combined = `${appointment.date}T${appointment.time}:00`;
  const parsed = new Date(combined);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function getReminderOffsetMinutes(appointment) {
  const parsed = Number.parseInt(String(appointment.reminderMinutes ?? ""), 10);
  if (Number.isInteger(parsed) && parsed >= 0) {
    return parsed;
  }
  return DEFAULT_REMINDER_OFFSET_MINUTES;
}

function isWithinQuietHours(now, quietHoursStart, quietHoursEnd) {
  const start = String(quietHoursStart || "").trim();
  const end = String(quietHoursEnd || "").trim();
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!valid.test(start) || !valid.test(end)) {
    return false;
  }

  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const [startHour, startMinute] = start.split(":").map(Number);
  const [endHour, endMinute] = end.split(":").map(Number);
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;

  if (startMinutes === endMinutes) {
    return true;
  }
  if (startMinutes < endMinutes) {
    return minutesNow >= startMinutes && minutesNow < endMinutes;
  }
  return minutesNow >= startMinutes || minutesNow < endMinutes;
}

function nextAllowedAfterQuietHours(now, quietHoursStart, quietHoursEnd) {
  const start = String(quietHoursStart || "").trim();
  const end = String(quietHoursEnd || "").trim();
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!valid.test(start) || !valid.test(end)) {
    return now;
  }

  const [endHour, endMinute] = end.split(":").map(Number);
  const next = new Date(now.getTime());
  next.setSeconds(0, 0);
  next.setHours(endHour, endMinute, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function safeJsonParse(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ""));
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch (error) {
    // ignore
  }
  return fallback;
}

function createAttemptRecord({
  userId,
  appointmentId,
  channel,
  attemptNumber,
  scheduledFor,
  status = "queued",
  metadata = null
}) {
  const nowIso = new Date().toISOString();
  const payload = {
    userId,
    appointmentId: appointmentId || null,
    channel,
    attemptNumber,
    scheduledFor,
    startedAt: null,
    finishedAt: null,
    status,
    providerSid: null,
    errorCode: null,
    errorMessage: null,
    metadataJson: metadata ? JSON.stringify(metadata) : null,
    createdAt: nowIso,
    updatedAt: nowIso
  };
  const inserted = insertReminderAttemptStmt.run(payload);
  return inserted.lastInsertRowid;
}

function updateAttemptStatus(id, status, updates = {}) {
  const nowIso = new Date().toISOString();
  updateAttemptStatusStmt.run({
    id,
    status,
    providerSid: updates.providerSid || null,
    errorCode: updates.errorCode || null,
    errorMessage: updates.errorMessage ? String(updates.errorMessage).slice(0, 500) : null,
    startedAt: updates.startedAt || null,
    finishedAt: updates.finishedAt || null,
    metadataJson: updates.metadata ? JSON.stringify(updates.metadata) : null,
    updatedAt: nowIso
  });
}

function createTwilioClient(config) {
  return twilio(config.accountSid, config.authToken);
}

function getTargetNumberForUser(userPhoneNumber) {
  const direct = String(userPhoneNumber || "").trim();
  if (direct) {
    return direct;
  }
  return String(process.env.CALL_TO_NUMBER || "").trim();
}

function _buildVoiceMessage(appointmentTitle, appointmentDate, appointmentTime) {
  const dateTime = new Date(`${appointmentDate}T${appointmentTime}:00`);
  const now = new Date();
  const diffMs = dateTime.getTime() - now.getTime();
  const diffMinutes = Math.max(Math.round(diffMs / 60000), 0);
  const formattedTime = dateTime.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
  return `Reminder. Your ${appointmentTitle} appointment starts at ${formattedTime}. It is in ${diffMinutes} minutes.`;
}

function buildSmsMessage(appointmentTitle, appointmentDate, appointmentTime) {
  const dateTime = new Date(`${appointmentDate}T${appointmentTime}:00`);
  const diffMs = dateTime.getTime() - Date.now();
  const diffMinutes = Math.max(Math.round(diffMs / 60000), 0);
  const formatted = dateTime.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  });
  return `Appointment reminder: ${appointmentTitle} at ${formatted} (${diffMinutes} min).`;
}

async function createVoiceCall(client, config, attempt) {
  const toNumber = getTargetNumberForUser(attempt.userPhoneNumber) || config.toNumber;
  const baseUrl = normalizePublicBaseUrl();
  const params = new URLSearchParams({
    appointmentId: String(attempt.appointmentId || ""),
    attemptId: String(attempt.id || ""),
    userId: String(attempt.userId || "")
  });

  return client.calls.create({
    to: toNumber,
    from: config.fromNumber,
    url: `${baseUrl}/twilio/voice?${params.toString()}`,
    statusCallback: `${baseUrl}/twilio/status-callback?attemptId=${encodeURIComponent(
      String(attempt.id || "")
    )}`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed", "busy", "failed", "no-answer", "canceled"]
  });
}

async function createSms(client, config, attempt) {
  const toNumber = getTargetNumberForUser(attempt.userPhoneNumber) || config.toNumber;
  const body = buildSmsMessage(
    attempt.appointmentTitle || "appointment",
    attempt.appointmentDate || "",
    attempt.appointmentTime || ""
  );
  return client.messages.create({
    to: toNumber,
    from: config.fromNumber,
    body
  });
}

function maybeQueueVoiceRetry(attempt, reason = "no_answer") {
  if (Number(attempt.userVoiceEnabled) !== 1) {
    return null;
  }
  if (attempt.attemptNumber >= 2) {
    return null;
  }
  const scheduledFor = new Date(Date.now() + VOICE_RETRY_DELAY_MINUTES * 60 * 1000).toISOString();
  return createAttemptRecord({
    userId: attempt.userId,
    appointmentId: attempt.appointmentId,
    channel: "voice",
    attemptNumber: Number(attempt.attemptNumber || 1) + 1,
    scheduledFor,
    metadata: {
      reason,
      parentAttemptId: attempt.id
    }
  });
}

function maybeQueueSmsFallback(attempt, reason = "voice_failed") {
  if (Number(attempt.userSmsEnabled) !== 1) {
    return null;
  }
  const scheduledFor = new Date().toISOString();
  return createAttemptRecord({
    userId: attempt.userId,
    appointmentId: attempt.appointmentId,
    channel: "sms",
    attemptNumber: 1,
    scheduledFor,
    metadata: {
      reason,
      parentAttemptId: attempt.id
    }
  });
}

function isFailureVoiceStatus(callStatus) {
  const status = String(callStatus || "").trim().toLowerCase();
  return ["busy", "failed", "no-answer", "canceled"].includes(status);
}

function isCompletedVoiceStatus(callStatus) {
  const status = String(callStatus || "").trim().toLowerCase();
  return status === "completed";
}

async function processQueuedAttempts() {
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

  const dueAttempts = selectDueQueuedAttemptsStmt.all(new Date().toISOString());
  if (dueAttempts.length === 0) {
    return;
  }

  const client = createTwilioClient(config);
  for (const attempt of dueAttempts) {
    if (attempt.appointmentId && attempt.appointmentCompletedAt) {
      updateAttemptStatus(attempt.id, "cancelled", {
        finishedAt: new Date().toISOString(),
        errorMessage: "Appointment already completed."
      });
      continue;
    }

    const now = new Date();
    if (
      isWithinQuietHours(now, attempt.userQuietHoursStart, attempt.userQuietHoursEnd)
    ) {
      const nextAllowed = nextAllowedAfterQuietHours(
        now,
        attempt.userQuietHoursStart,
        attempt.userQuietHoursEnd
      );
      updateAttemptStatus(attempt.id, "queued", {
        metadata: {
          ...safeJsonParse(attempt.metadataJson),
          deferredFrom: attempt.scheduledFor,
          deferredTo: nextAllowed.toISOString(),
          reason: "quiet_hours"
        }
      });
      db.prepare("UPDATE reminder_attempts SET scheduledFor = ?, updatedAt = ? WHERE id = ?").run(
        nextAllowed.toISOString(),
        new Date().toISOString(),
        attempt.id
      );
      continue;
    }

    if (attempt.channel === "voice" && Number(attempt.userVoiceEnabled) !== 1) {
      updateAttemptStatus(attempt.id, "cancelled", {
        finishedAt: new Date().toISOString(),
        errorMessage: "Voice reminders are disabled for user."
      });
      continue;
    }

    if (attempt.channel === "sms" && Number(attempt.userSmsEnabled) !== 1) {
      updateAttemptStatus(attempt.id, "cancelled", {
        finishedAt: new Date().toISOString(),
        errorMessage: "SMS reminders are disabled for user."
      });
      continue;
    }

    try {
      if (attempt.channel === "voice") {
        const call = await createVoiceCall(client, config, attempt);
        updateAttemptStatus(attempt.id, "calling", {
          providerSid: call.sid,
          startedAt: new Date().toISOString()
        });
        continue;
      }

      const message = await createSms(client, config, attempt);
      updateAttemptStatus(attempt.id, "sms_sent", {
        providerSid: message.sid,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString()
      });
    } catch (error) {
      const status = attempt.channel === "voice" ? "voice_failed" : "cancelled";
      updateAttemptStatus(attempt.id, status, {
        finishedAt: new Date().toISOString(),
        errorCode: error?.code ? String(error.code) : null,
        errorMessage: error?.message || "Reminder send failed."
      });
      if (attempt.channel === "voice") {
        const queuedRetryId = maybeQueueVoiceRetry(attempt, "api_error");
        if (!queuedRetryId) {
          maybeQueueSmsFallback(attempt, "voice_api_error");
        }
      }
    }
  }
}

function getUpcomingAppointmentsForScheduling(now) {
  const horizon = new Date(now.getTime() + LOOKAHEAD_MINUTES * 60 * 1000);
  const lowerDate = formatLocalDate(now);
  const upperDate = formatLocalDate(horizon);

  return selectUpcomingAppointmentsStmt
    .all(lowerDate, upperDate)
    .filter((appointment) => {
      const dateTime = parseAppointmentDateTime(appointment);
      if (!dateTime) {
        return false;
      }
      return dateTime > now && dateTime <= horizon;
    });
}

function queueInitialAttemptsForUpcomingAppointments() {
  const now = new Date();
  const appointments = getUpcomingAppointmentsForScheduling(now);
  for (const appointment of appointments) {
    if (Number(appointment.userVoiceEnabled) !== 1) {
      continue;
    }

    const appointmentDateTime = parseAppointmentDateTime(appointment);
    if (!appointmentDateTime) {
      continue;
    }

    const offsetMinutes = getReminderOffsetMinutes(appointment);
    const remindAt = new Date(appointmentDateTime.getTime() - offsetMinutes * 60 * 1000);
    if (remindAt >= appointmentDateTime) {
      continue;
    }
    if (now < remindAt) {
      continue;
    }
    if (now >= appointmentDateTime) {
      continue;
    }

    const existing = selectInitialAttemptStmt.get(appointment.id);
    if (existing) {
      continue;
    }

    createAttemptRecord({
      userId: appointment.userId,
      appointmentId: appointment.id,
      channel: "voice",
      attemptNumber: 1,
      scheduledFor: remindAt.toISOString(),
      metadata: {
        source: "scheduler",
        offsetMinutes
      }
    });
  }
}

async function processDueReminders() {
  try {
    queueInitialAttemptsForUpcomingAppointments();
    await processQueuedAttempts();
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

async function triggerTestCall(userId, appointmentId, minutesOffset) {
  const parsedUserId = Number.parseInt(String(userId || ""), 10);
  if (!parsedUserId) {
    throw new Error("A valid user is required for test calls.");
  }

  const parsedOffset = Number.parseInt(String(minutesOffset || "30"), 10);
  if (![30, 60].includes(parsedOffset)) {
    throw new Error("minutes must be either 30 or 60.");
  }

  const appointment = appointmentId
    ? db
      .prepare(
        `SELECT a.id, a.userId, a.title, a.date, a.time, a.completedAt, u.phoneNumber AS userPhoneNumber
         FROM appointments a
         JOIN users u ON u.id = a.userId
         WHERE a.id = ? AND a.userId = ?`
      )
      .get(appointmentId, parsedUserId)
    : null;

  const now = new Date();
  const scheduledFor = now.toISOString();
  const attemptId = createAttemptRecord({
    userId: parsedUserId,
    appointmentId: appointment?.id || null,
    channel: "voice",
    attemptNumber: 1,
    scheduledFor,
    metadata: {
      source: "manual_test",
      minutesOffset: parsedOffset
    }
  });

  const config = getTwilioConfig();
  const missing = getMissingTwilioVars(config);
  if (missing.length > 0) {
    updateAttemptStatus(attemptId, "voice_failed", {
      finishedAt: new Date().toISOString(),
      errorMessage: `Missing environment variables: ${missing.join(", ")}`
    });
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}. Outbound reminder calls are disabled.`
    );
  }

  const client = createTwilioClient(config);
  try {
    const attempt = selectAttemptByIdStmt.get(attemptId);
    const call = await createVoiceCall(client, config, {
      ...attempt,
      appointmentTitle: appointment?.title || "appointment",
      appointmentDate: appointment?.date || formatLocalDate(now),
      appointmentTime: appointment?.time || "09:00"
    });
    updateAttemptStatus(attemptId, "calling", {
      providerSid: call.sid,
      startedAt: new Date().toISOString()
    });
    return { sid: call.sid, attemptId };
  } catch (error) {
    updateAttemptStatus(attemptId, "voice_failed", {
      finishedAt: new Date().toISOString(),
      errorCode: error?.code ? String(error.code) : null,
      errorMessage: error?.message || "Unable to place test call."
    });
    throw error;
  }
}

function mapCallStatusToAttemptStatus(callStatus) {
  const normalized = String(callStatus || "").trim().toLowerCase();
  if (normalized === "completed") {
    return "completed";
  }
  if (normalized === "no-answer") {
    return "voice_no_answer";
  }
  if (["busy", "failed", "canceled"].includes(normalized)) {
    return "voice_failed";
  }
  if (["in-progress", "ringing", "queued", "initiated", "answered"].includes(normalized)) {
    return "calling";
  }
  return "voice_failed";
}

function handleVoiceStatusCallback(payload) {
  const attemptIdRaw = payload.attemptId;
  const callSid = String(payload.callSid || payload.CallSid || "").trim();
  const callStatus = String(payload.callStatus || payload.CallStatus || "").trim();
  const errorCode = String(payload.errorCode || payload.ErrorCode || "").trim();
  const errorMessage = String(payload.errorMessage || payload.ErrorMessage || "").trim();

  let attempt = null;
  const attemptId = Number.parseInt(String(attemptIdRaw || ""), 10);
  if (attemptId) {
    attempt = selectAttemptByIdStmt.get(attemptId);
  }
  if (!attempt && callSid) {
    attempt = selectAttemptByProviderSidStmt.get(callSid);
  }
  if (!attempt) {
    return {
      ok: false,
      message: "No matching reminder attempt."
    };
  }

  const mapped = mapCallStatusToAttemptStatus(callStatus);
  const nowIso = new Date().toISOString();
  updateAttemptStatus(attempt.id, mapped, {
    providerSid: callSid || null,
    errorCode: errorCode || null,
    errorMessage: errorMessage || null,
    startedAt: mapped === "calling" ? nowIso : null,
    finishedAt: mapped === "calling" ? null : nowIso,
    metadata: {
      ...safeJsonParse(attempt.metadataJson),
      callbackStatus: callStatus || null
    }
  });

  if (isFailureVoiceStatus(callStatus)) {
    const retryAttemptId = maybeQueueVoiceRetry(attempt, callStatus || "voice_failure");
    if (!retryAttemptId) {
      maybeQueueSmsFallback(attempt, callStatus || "voice_failure");
    }
  }
  if (isCompletedVoiceStatus(callStatus)) {
    updateAttemptStatus(attempt.id, "completed", {
      providerSid: callSid || null,
      finishedAt: nowIso,
      metadata: {
        ...safeJsonParse(attempt.metadataJson),
        callbackStatus: callStatus || "completed"
      }
    });
  }

  return {
    ok: true,
    attemptId: attempt.id,
    status: mapped
  };
}

function getReminderActivity(userId, options = {}) {
  const parsedUserId = Number.parseInt(String(userId || ""), 10);
  if (!parsedUserId) {
    return {
      items: [],
      page: 1,
      pageSize: 20,
      total: 0
    };
  }

  const pageSize = Math.max(1, Math.min(Number.parseInt(String(options.pageSize || "20"), 10) || 20, 100));
  const page = Math.max(1, Number.parseInt(String(options.page || "1"), 10) || 1);
  const offset = (page - 1) * pageSize;
  const status = String(options.status || "").trim();
  const channel = String(options.channel || "").trim();

  const rows = selectReminderActivityStmt.all({
    userId: parsedUserId,
    status,
    channel,
    limit: pageSize,
    offset
  });
  const totalRow = countReminderActivityStmt.get({
    userId: parsedUserId,
    status,
    channel
  });

  return {
    items: rows.map((row) => ({
      ...row,
      metadata: safeJsonParse(row.metadataJson, {})
    })),
    page,
    pageSize,
    total: Number(totalRow?.count || 0)
  };
}

function enqueueSmsFallbackForAttemptId(attemptId, reason = "manual") {
  const attempt = selectAttemptByIdStmt.get(attemptId);
  if (!attempt) {
    return null;
  }
  return maybeQueueSmsFallback(attempt, reason);
}

module.exports = {
  logTwilioEnvStatus,
  startReminderScheduler,
  triggerTestCall,
  handleVoiceStatusCallback,
  getReminderActivity,
  enqueueSmsFallbackForAttemptId
};
