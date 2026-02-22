const express = require("express");
const session = require("express-session");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const db = require("./db");
const { parseAppointment, AiParseError } = require("./ai");
const {
  hasGoogleConfig,
  isGoogleConnected,
  getGoogleAuthUrl,
  exchangeCodeForTokens,
  extractGoogleIdentityFromTokens,
  setGoogleTokensOnSession,
  clearGoogleSession,
  createGoogleEventFromSession,
  GoogleCalendarError
} = require("./googleCalendar");
const {
  logTwilioEnvStatus,
  startReminderScheduler,
  triggerTestCall,
  handleVoiceStatusCallback,
  getReminderActivity
} = require("./reminderScheduler");
const {
  parseRRule,
  toRuleString,
  parseDateString,
  formatDateString,
  buildOccurrenceItems,
  detectConflicts
} = require("./recurrence");
require("dotenv").config({ quiet: true });

const app = express();
const SESSION_SECRET = process.env.SESSION_SECRET || "appointment-vault-session-secret-change-me";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const TEST_PROFILE_ENABLED = !["0", "false", "off", "no"].includes(
  String(process.env.TEMP_TEST_PROFILE || "true")
    .trim()
    .toLowerCase()
);
const TEST_PROFILE_NAME =
  String(process.env.TEST_PROFILE_NAME || "").trim() || "Temporary Test Profile";
const TEST_PROFILE_EMAIL =
  String(process.env.TEST_PROFILE_EMAIL || "").trim() || "test-profile@appointment-vault.local";

if (IS_PRODUCTION) {
  app.set("trust proxy", 1);
}
function resolveAppTimezone() {
  const candidate =
    String(process.env.APP_TIMEZONE || process.env.TZ || "America/Los_Angeles").trim() ||
    "America/Los_Angeles";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch (error) {
    return "America/Los_Angeles";
  }
}

const APP_TIMEZONE = resolveAppTimezone();
const GOOGLE_TOKENS_SETTING_KEY = "google.tokens";
const GOOGLE_PROFILE_SETTING_KEY = "google.profile";
const LEGACY_APPOINTMENT_ASSIGNMENT_KEY = "legacy.appointments.assigned";
const selectAppSettingStatement = db.prepare("SELECT value FROM app_settings WHERE key = ?");
const upsertAppSettingStatement = db.prepare(`
  INSERT INTO app_settings (key, value, updatedAt)
  VALUES (@key, @value, @updatedAt)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updatedAt = excluded.updatedAt
`);
const deleteAppSettingStatement = db.prepare("DELETE FROM app_settings WHERE key = ?");
const selectUserByIdStatement = db.prepare("SELECT * FROM users WHERE id = ?");
const selectUserByProviderStatement = db.prepare(
  "SELECT * FROM users WHERE provider = ? AND providerUserId = ?"
);
const insertUserStatement = db.prepare(
  `INSERT INTO users
    (provider, providerUserId, email, displayName, phoneNumber, timezone, voiceEnabled, smsEnabled, quietHoursStart, quietHoursEnd, reminderStrategy, createdAt, updatedAt)
   VALUES
    (@provider, @providerUserId, @email, @displayName, @phoneNumber, @timezone, @voiceEnabled, @smsEnabled, @quietHoursStart, @quietHoursEnd, @reminderStrategy, @createdAt, @updatedAt)`
);
const updateUserStatement = db.prepare(
  `UPDATE users
   SET email = @email,
       displayName = @displayName,
       phoneNumber = @phoneNumber,
       timezone = @timezone,
       voiceEnabled = @voiceEnabled,
       smsEnabled = @smsEnabled,
       quietHoursStart = @quietHoursStart,
       quietHoursEnd = @quietHoursEnd,
       reminderStrategy = @reminderStrategy,
       updatedAt = @updatedAt
   WHERE id = @id`
);
const updateAppointmentOwnerStatement = db.prepare(
  "UPDATE appointments SET userId = ? WHERE userId IS NULL"
);
const selectAnyUserStatement = db.prepare("SELECT id FROM users ORDER BY id ASC LIMIT 1");
const insertOccurrenceCompletionStatement = db.prepare(
  `INSERT OR IGNORE INTO appointment_occurrence_completions
    (userId, appointmentId, occurrenceKey, completedAt, createdAt)
   VALUES (?, ?, ?, ?, ?)`
);
const selectOccurrenceCompletionsForUserStatement = db.prepare(
  `SELECT appointmentId, occurrenceKey, completedAt
   FROM appointment_occurrence_completions
   WHERE userId = ?`
);
const selectOccurrenceCompletionByKeyStatement = db.prepare(
  `SELECT id
   FROM appointment_occurrence_completions
   WHERE userId = ? AND appointmentId = ? AND occurrenceKey = ?
   LIMIT 1`
);
const selectAppointmentsForUserStatement = db.prepare(
  `SELECT *
   FROM appointments
   WHERE userId = ?
   ORDER BY date ASC, time ASC, id ASC`
);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: IS_PRODUCTION,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PRODUCTION,
      maxAge: 1000 * 60 * 60 * 24 * 14
    }
  })
);
app.use((req, res, next) => {
  if (TEST_PROFILE_ENABLED) {
    req.session.testProfile = {
      name: TEST_PROFILE_NAME,
      email: TEST_PROFILE_EMAIL,
      role: "tester"
    };
  }

  next();
});
app.use((req, res, next) => {
  const persistedTokens = getPersistedGoogleTokens();
  if (!isGoogleConnected(req.session) && persistedTokens) {
    setGoogleTokensOnSession(req.session, persistedTokens);
  }

  req.persistedGoogleTokens = persistedTokens;
  req.persistedGoogleProfile = getPersistedGoogleProfile();
  next();
});
app.use((req, res, next) => {
  try {
    let user = null;

    if (TEST_PROFILE_ENABLED && req.session?.testProfile) {
      const testIdentity = {
        provider: "test",
        providerUserId: String(req.session.testProfile.email || TEST_PROFILE_EMAIL)
          .trim()
          .toLowerCase(),
        email: String(req.session.testProfile.email || TEST_PROFILE_EMAIL).trim().toLowerCase(),
        displayName: String(req.session.testProfile.name || TEST_PROFILE_NAME).trim()
      };
      user = upsertUserFromIdentity(testIdentity);
      req.session.userId = user.id;
    } else if (req.session?.userId) {
      user = selectUserByIdStatement.get(req.session.userId) || null;
    }

    if (!user && req.persistedGoogleProfile) {
      user = upsertUserFromIdentity(req.persistedGoogleProfile);
      req.session.userId = user.id;
    }

    if (!user) {
      const fallback = selectAnyUserStatement.get();
      if (fallback?.id) {
        user = selectUserByIdStatement.get(fallback.id) || null;
        if (user) {
          req.session.userId = user.id;
        }
      }
    }

    if (!user) {
      user = upsertUserFromIdentity({
        provider: "local",
        providerUserId: "local-default",
        email: null,
        displayName: "Local Profile"
      });
      if (user) {
        req.session.userId = user.id;
      }
    }

    req.currentUser = user || null;
    if (req.currentUser) {
      assignLegacyAppointmentsToUser(req.currentUser.id);
    }
    next();
  } catch (error) {
    next(error);
  }
});
app.use("/public", express.static(path.join(__dirname, "public")));
app.use((req, res, next) => {
  const hasRealGoogleConnection =
    isGoogleConnected(req.session) || Boolean(req.persistedGoogleTokens);
  const testProfile = req.session?.testProfile || null;
  const testProfileActive = Boolean(TEST_PROFILE_ENABLED && testProfile);

  res.locals.googleConfigured = hasGoogleConfig() || testProfileActive;
  res.locals.googleConnected =
    hasRealGoogleConnection || testProfileActive;
  res.locals.testProfileActive = testProfileActive;
  res.locals.testProfile = testProfile;
  res.locals.currentUser = req.currentUser || null;
  res.locals.formatDisplayTime = formatDisplayTime;
  next();
});

function getPersistedGoogleTokens() {
  const row = selectAppSettingStatement.get(GOOGLE_TOKENS_SETTING_KEY);
  if (!row?.value) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.value);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.access_token || parsed.refresh_token)
    ) {
      return parsed;
    }
  } catch (error) {
    console.error("Failed to parse persisted Google tokens:", error.message);
  }

  return null;
}

function mergeGoogleTokens(nextTokens, previousTokens) {
  const merged = { ...(previousTokens || {}), ...(nextTokens || {}) };

  if (!merged.refresh_token && previousTokens?.refresh_token) {
    merged.refresh_token = previousTokens.refresh_token;
  }

  return merged;
}

function persistGoogleTokens(tokens) {
  const existingTokens = getPersistedGoogleTokens();
  const merged = mergeGoogleTokens(tokens, existingTokens);
  if (!merged || (!merged.access_token && !merged.refresh_token)) {
    return;
  }

  upsertAppSettingStatement.run({
    key: GOOGLE_TOKENS_SETTING_KEY,
    value: JSON.stringify(merged),
    updatedAt: new Date().toISOString()
  });
}

function clearPersistedGoogleTokens() {
  deleteAppSettingStatement.run(GOOGLE_TOKENS_SETTING_KEY);
}

function getPersistedGoogleProfile() {
  const row = selectAppSettingStatement.get(GOOGLE_PROFILE_SETTING_KEY);
  if (!row?.value) {
    return null;
  }

  try {
    const parsed = JSON.parse(row.value);
    if (
      parsed &&
      typeof parsed === "object" &&
      String(parsed.providerUserId || "").trim()
    ) {
      return {
        provider: String(parsed.provider || "google").trim() || "google",
        providerUserId: String(parsed.providerUserId || "").trim(),
        email: String(parsed.email || "").trim() || null,
        displayName: String(parsed.displayName || "").trim() || null
      };
    }
  } catch (error) {
    console.error("Failed to parse persisted Google profile:", error.message);
  }

  return null;
}

function persistGoogleProfile(profile) {
  if (!profile || !String(profile.providerUserId || "").trim()) {
    return;
  }

  const nowIso = new Date().toISOString();
  upsertAppSettingStatement.run({
    key: GOOGLE_PROFILE_SETTING_KEY,
    value: JSON.stringify({
      provider: String(profile.provider || "google").trim() || "google",
      providerUserId: String(profile.providerUserId || "").trim(),
      email: String(profile.email || "").trim() || null,
      displayName: String(profile.displayName || "").trim() || null
    }),
    updatedAt: nowIso
  });
}

function clearPersistedGoogleProfile() {
  deleteAppSettingStatement.run(GOOGLE_PROFILE_SETTING_KEY);
}

function normalizeIdentity(identity) {
  if (!identity) {
    return null;
  }

  const provider = String(identity.provider || "google").trim() || "google";
  const providerUserId = String(identity.providerUserId || "").trim();
  if (!providerUserId) {
    return null;
  }

  return {
    provider,
    providerUserId,
    email: String(identity.email || "").trim() || null,
    displayName: String(identity.displayName || "").trim() || null
  };
}

function upsertUserFromIdentity(identity) {
  const normalized = normalizeIdentity(identity);
  if (!normalized) {
    return null;
  }

  const existing = selectUserByProviderStatement.get(
    normalized.provider,
    normalized.providerUserId
  );
  const nowIso = new Date().toISOString();

  if (existing) {
    updateUserStatement.run({
      id: existing.id,
      email: normalized.email || existing.email || null,
      displayName: normalized.displayName || existing.displayName || null,
      phoneNumber: existing.phoneNumber || String(process.env.CALL_TO_NUMBER || "").trim() || null,
      timezone: existing.timezone || APP_TIMEZONE,
      voiceEnabled: Number(existing.voiceEnabled) === 1 ? 1 : 0,
      smsEnabled: Number(existing.smsEnabled) === 1 ? 1 : 0,
      quietHoursStart: existing.quietHoursStart || null,
      quietHoursEnd: existing.quietHoursEnd || null,
      reminderStrategy: existing.reminderStrategy || "voice_primary_sms_fallback",
      updatedAt: nowIso
    });
    return selectUserByIdStatement.get(existing.id);
  }

  const inserted = insertUserStatement.run({
    provider: normalized.provider,
    providerUserId: normalized.providerUserId,
    email: normalized.email,
    displayName: normalized.displayName,
    phoneNumber: String(process.env.CALL_TO_NUMBER || "").trim() || null,
    timezone: APP_TIMEZONE,
    voiceEnabled: 1,
    smsEnabled: 1,
    quietHoursStart: null,
    quietHoursEnd: null,
    reminderStrategy: "voice_primary_sms_fallback",
    createdAt: nowIso,
    updatedAt: nowIso
  });

  return selectUserByIdStatement.get(inserted.lastInsertRowid);
}

function updateUserPreferences(userId, patch) {
  const existing = selectUserByIdStatement.get(userId);
  if (!existing) {
    return null;
  }

  updateUserStatement.run({
    id: existing.id,
    email: patch.email ?? existing.email ?? null,
    displayName: patch.displayName ?? existing.displayName ?? null,
    phoneNumber: patch.phoneNumber ?? existing.phoneNumber ?? null,
    timezone: patch.timezone ?? existing.timezone ?? APP_TIMEZONE,
    voiceEnabled:
      patch.voiceEnabled === undefined ? (Number(existing.voiceEnabled) === 1 ? 1 : 0) : patch.voiceEnabled,
    smsEnabled:
      patch.smsEnabled === undefined ? (Number(existing.smsEnabled) === 1 ? 1 : 0) : patch.smsEnabled,
    quietHoursStart:
      patch.quietHoursStart === undefined ? existing.quietHoursStart ?? null : patch.quietHoursStart,
    quietHoursEnd: patch.quietHoursEnd === undefined ? existing.quietHoursEnd ?? null : patch.quietHoursEnd,
    reminderStrategy: patch.reminderStrategy ?? existing.reminderStrategy ?? "voice_primary_sms_fallback",
    updatedAt: new Date().toISOString()
  });

  return selectUserByIdStatement.get(existing.id);
}

function assignLegacyAppointmentsToUser(userId) {
  if (!userId) {
    return;
  }

  const marker = selectAppSettingStatement.get(LEGACY_APPOINTMENT_ASSIGNMENT_KEY);
  if (marker?.value) {
    return;
  }

  const updated = updateAppointmentOwnerStatement.run(userId);
  upsertAppSettingStatement.run({
    key: LEGACY_APPOINTMENT_ASSIGNMENT_KEY,
    value: JSON.stringify({
      userId,
      migratedAt: new Date().toISOString(),
      rows: Number(updated.changes || 0)
    }),
    updatedAt: new Date().toISOString()
  });
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function normalizeTags(value) {
  if (!value) {
    return "";
  }

  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .join(", ");
}

function normalizeInput(body) {
  const reminderRaw = String(body.reminderMinutes ?? "").trim();
  const recurringRaw = String(
    body.isRecurring ?? body.recurring ?? body.recurrenceEnabled ?? ""
  )
    .trim()
    .toLowerCase();
  const isRecurring =
    recurringRaw === "1" ||
    recurringRaw === "true" ||
    recurringRaw === "yes" ||
    recurringRaw === "on";

  return {
    title: String(body.title ?? "").trim(),
    date: String(body.date ?? "").trim(),
    time: String(body.time ?? "").trim(),
    location: String(body.location ?? "").trim(),
    notes: String(body.notes ?? "").trim(),
    tags: normalizeTags(String(body.tags ?? "")),
    reminderMinutes: reminderRaw,
    isRecurring,
    rrule: String(body.rrule ?? "").trim()
  };
}

function validateAppointment(input) {
  const errors = {};

  if (!input.title) {
    errors.title = "Title is required.";
  }

  if (!input.date) {
    errors.date = "Date is required.";
  } else if (!isValidDateString(input.date)) {
    errors.date = "Enter a valid date in YYYY-MM-DD format.";
  }

  if (!input.time) {
    errors.time = "Time is required.";
  } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) {
    errors.time = "Enter a valid time in HH:MM (24-hour) format.";
  }

  if (input.isRecurring) {
    if (!input.rrule) {
      errors.rrule = "Recurring appointments require an RRULE.";
    } else {
      const parsed = parseRRule(input.rrule);
      if (!parsed.isValid) {
        errors.rrule = parsed.errors[0] || "Invalid RRULE.";
      }
    }
  }

  return errors;
}

function serializeForDb(input) {
  const parsedReminder = Number.parseInt(input.reminderMinutes, 10);
  const parsedRule = input.isRecurring ? parseRRule(input.rrule) : { isValid: true, value: null };
  const normalizedRrule =
    input.isRecurring && parsedRule.isValid && parsedRule.value
      ? toRuleString(parsedRule.value)
      : null;

  return {
    ...input,
    reminderMinutes:
      input.reminderMinutes === "" ||
      !Number.isInteger(parsedReminder) ||
      parsedReminder < 0
        ? null
        : parsedReminder,
    isRecurring: input.isRecurring ? 1 : 0,
    rrule: normalizedRrule,
    seriesId: input.isRecurring ? String(input.seriesId || randomUUID()) : null
  };
}

function tagsToArray(tagsValue) {
  if (!tagsValue) {
    return [];
  }

  return tagsValue
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function getAppointmentById(id, userId = null) {
  if (userId) {
    return db
      .prepare("SELECT * FROM appointments WHERE id = ? AND userId = ?")
      .get(id, userId);
  }
  return db.prepare("SELECT * FROM appointments WHERE id = ?").get(id);
}

function parseId(idValue) {
  const id = Number.parseInt(idValue, 10);

  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  return id;
}

function getCurrentUser(req) {
  return req.currentUser || null;
}

function getCurrentUserId(req) {
  return req.currentUser?.id || null;
}

function requireCurrentUser(req, res) {
  const user = getCurrentUser(req);
  if (!user) {
    res.status(401).render("error", {
      title: "Sign In Required",
      message: "Connect Google Calendar or use the test profile to continue."
    });
    return null;
  }
  return user;
}

function clampPageNumber(value, fallback = 1) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseBooleanInput(value, fallback = false) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeClockTime(value) {
  const input = String(value || "").trim();
  if (!input) {
    return null;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input)) {
    return null;
  }
  return input;
}

function requestPrefersJson(req) {
  const accept = String(req.get("accept") || "").toLowerCase();
  return accept.includes("application/json") || req.xhr === true;
}

function getQuickAddDefaults() {
  const now = new Date();
  const plusOneHour = new Date(now.getTime() + 60 * 60 * 1000);
  return { date: formatLocalDate(now), time: formatLocalTime(plusOneHour) };
}

function formatInAppTimezoneParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  return {
    year: parts.find((part) => part.type === "year")?.value || "0000",
    month: parts.find((part) => part.type === "month")?.value || "01",
    day: parts.find((part) => part.type === "day")?.value || "01",
    hour: parts.find((part) => part.type === "hour")?.value || "00",
    minute: parts.find((part) => part.type === "minute")?.value || "00",
    second: parts.find((part) => part.type === "second")?.value || "00"
  };
}

function formatLocalDate(date) {
  const parts = formatInAppTimezoneParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatLocalTime(date) {
  const parts = formatInAppTimezoneParts(date);
  return `${parts.hour}:${parts.minute}`;
}

function formatDisplayTime(timeValue) {
  const value = String(timeValue ?? "").trim();
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    return value;
  }

  const hour24 = Number.parseInt(match[1], 10);
  const minutes = match[2];
  const meridiem = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  return `${hour12}:${minutes} ${meridiem}`;
}

function getEndOfWeekDateString(todayDateString) {
  const [year, month, day] = todayDateString.split("-").map(Number);
  const today = new Date(year, month - 1, day);
  const dayOfWeek = today.getDay(); // Sunday = 0
  const daysUntilSunday = (7 - dayOfWeek) % 7;
  const endOfWeek = new Date(today);
  endOfWeek.setDate(today.getDate() + daysUntilSunday);
  return formatLocalDate(endOfWeek);
}

function getTodayDateString() {
  return formatLocalDate(new Date());
}

function getUpcomingAppointmentForCall(requestedId, userId) {
  if (!userId) {
    return null;
  }

  if (requestedId) {
    return getAppointmentById(requestedId, userId);
  }

  const now = new Date();
  const todayDate = formatLocalDate(now);
  const nowTime = formatLocalTime(now);

  return db.prepare(
    `SELECT id, title, date, time
     FROM appointments
     WHERE completedAt IS NULL
       AND userId = ?
       AND (
         date > ?
        OR (date = ? AND time >= ?)
       )
     ORDER BY date ASC, time ASC, id ASC
     LIMIT 1`
  ).get(userId, todayDate, todayDate, nowTime);
}

function isPastAppointment(appointment, todayDate, nowTime) {
  return (
    appointment.date < todayDate ||
    (appointment.date === todayDate && appointment.time < nowTime)
  );
}

function isCompletedAppointment(appointment) {
  return Boolean(appointment?.completedAt);
}

function isHistoryAppointment(appointment, todayDate, nowTime) {
  return isCompletedAppointment(appointment) || isPastAppointment(appointment, todayDate, nowTime);
}

function createOccurrenceKey(appointment) {
  return `${appointment.id}:${appointment.date}T${appointment.time}`;
}

function getUserOccurrenceCompletionSet(userId) {
  if (!userId) {
    return new Set();
  }

  const rows = selectOccurrenceCompletionsForUserStatement.all(userId);
  return new Set(rows.map((row) => String(row.occurrenceKey || "").trim()).filter(Boolean));
}

function expandAppointmentsForWindow(appointments, windowStartDate, windowEndDate) {
  const expanded = [];
  for (const appointment of appointments) {
    const occurrences = buildOccurrenceItems(appointment, windowStartDate, windowEndDate, {
      maxOccurrences: 600
    });
    if (occurrences.length === 0) {
      if (!appointment.isRecurring && appointment.date >= windowStartDate && appointment.date <= windowEndDate) {
        expanded.push({
          ...appointment,
          occurrenceKey: createOccurrenceKey(appointment),
          isOccurrence: false
        });
      }
      continue;
    }

    expanded.push(
      ...occurrences.map((item) => ({
        ...item,
        occurrenceKey: item.occurrenceKey || createOccurrenceKey(item)
      }))
    );
  }

  return expanded.sort((left, right) => {
    if (left.date !== right.date) {
      return left.date.localeCompare(right.date);
    }
    if (left.time !== right.time) {
      return left.time.localeCompare(right.time);
    }
    return left.id - right.id;
  });
}

function mapAppointmentForView(appointment, todayDate, nowTime, completedOccurrenceKeys) {
  const occurrenceKey = appointment.occurrenceKey || createOccurrenceKey(appointment);
  const isOccurrenceCompleted = completedOccurrenceKeys.has(occurrenceKey);
  const isHistory = isHistoryAppointment(appointment, todayDate, nowTime) || isOccurrenceCompleted;

  return {
    ...appointment,
    tagList: tagsToArray(appointment.tags),
    occurrenceKey,
    isOccurrenceCompleted,
    isPast: isPastAppointment(appointment, todayDate, nowTime),
    isCompleted: isCompletedAppointment(appointment),
    isHistory
  };
}

function getAppointmentsForUserWithOccurrences(userId, options = {}) {
  if (!userId) {
    return [];
  }
  const now = options.now instanceof Date ? options.now : new Date();
  const todayDate = formatLocalDate(now);
  const daysAhead = Number.parseInt(String(options.daysAhead || "42"), 10) || 42;
  const horizon = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const endDate = formatLocalDate(horizon);

  const baseAppointments = selectAppointmentsForUserStatement.all(userId);
  const expanded = expandAppointmentsForWindow(baseAppointments, todayDate, endDate);
  const completionSet = getUserOccurrenceCompletionSet(userId);
  return expanded.map((appointment) =>
    mapAppointmentForView(appointment, todayDate, formatLocalTime(now), completionSet)
  );
}

function applyAgentDefaults(input) {
  const withDefaults = { ...input };

  if (withDefaults.date && !withDefaults.time) {
    withDefaults.time = "09:00";
  }

  if (withDefaults.time && !withDefaults.date) {
    withDefaults.date = getTodayDateString();
  }

  if (withDefaults.isRecurring && !withDefaults.rrule) {
    withDefaults.rrule = "FREQ=WEEKLY;INTERVAL=1";
  }

  return withDefaults;
}

function toAgentFormValues(appointmentInput) {
  return {
    title: appointmentInput.title || "",
    date: appointmentInput.date || "",
    time: appointmentInput.time || "",
    location: appointmentInput.location || "",
    notes: appointmentInput.notes || "",
    tags: appointmentInput.tags || "",
    isRecurring: Boolean(appointmentInput.isRecurring),
    rrule: appointmentInput.rrule || "",
    reminderMinutes:
      appointmentInput.reminderMinutes === "" ||
      appointmentInput.reminderMinutes === null ||
      appointmentInput.reminderMinutes === undefined
        ? ""
        : String(appointmentInput.reminderMinutes)
  };
}

function renderAgentPage(res, options = {}) {
  res.render("agent", {
    title: "AI Quick Add",
    promptText: options.promptText || "",
    parsed: options.parsed || null,
    parseError: options.parseError || "",
    saveErrors: options.saveErrors || {}
  });
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseAppointmentDateTime(appointment) {
  if (!appointment?.date || !appointment?.time) {
    return null;
  }

  const [year, month, day] = String(appointment.date).split("-").map(Number);
  const [hour, minute] = String(appointment.time).split(":").map(Number);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute)
  ) {
    return null;
  }

  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetBaseDate = new Date(utcGuess);
  const parts = formatInAppTimezoneParts(offsetBaseDate);
  const asIfUtc = Date.UTC(
    Number.parseInt(parts.year, 10),
    Number.parseInt(parts.month, 10) - 1,
    Number.parseInt(parts.day, 10),
    Number.parseInt(parts.hour, 10),
    Number.parseInt(parts.minute, 10),
    Number.parseInt(parts.second, 10)
  );
  const offsetMs = asIfUtc - utcGuess;
  const parsed = new Date(utcGuess - offsetMs);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

function getMinutesUntilAppointment(appointmentDateTime, now = new Date()) {
  const deltaMs = appointmentDateTime.getTime() - now.getTime();
  if (deltaMs <= 0) {
    return 0;
  }

  return Math.ceil(deltaMs / (60 * 1000));
}

function formatVoiceTime(appointmentDateTime) {
  return appointmentDateTime.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });
}

function getTodayAppointments(userId, now = new Date()) {
  if (!userId) {
    return [];
  }
  const todayDate = formatLocalDate(now);
  const withOccurrences = getAppointmentsForUserWithOccurrences(userId, {
    now,
    daysAhead: 1
  });
  return withOccurrences
    .filter((appointment) => appointment.date === todayDate && !appointment.isHistory)
    .sort((left, right) => {
      if (left.time !== right.time) {
        return left.time.localeCompare(right.time);
      }
      return left.id - right.id;
    });
}

function buildTodayVoiceMessage(userId, requestedAppointmentId, now = new Date()) {
  const todayDate = formatLocalDate(now);
  const nowTime = formatLocalTime(now);
  const todayAppointments = getTodayAppointments(userId, now);
  const upcomingToday = todayAppointments.filter((appointment) => appointment.time >= nowTime);

  if (requestedAppointmentId) {
    const requested = getAppointmentById(requestedAppointmentId, userId);
    if (requested) {
      const requestedDateTime = parseAppointmentDateTime(requested);
      const formattedTime = requestedDateTime
        ? formatVoiceTime(requestedDateTime)
        : formatDisplayTime(requested.time);
      const diffMinutes = requestedDateTime
        ? getMinutesUntilAppointment(requestedDateTime, now)
        : 0;

      if (requested.date === todayDate) {
        const laterCount = todayAppointments.filter(
          (appointment) => appointment.time > requested.time
        ).length;
        let message =
          `Reminder. Your ${requested.title} appointment starts at ${formattedTime}. ` +
          `It is in ${diffMinutes} minutes.`;
        if (laterCount > 0) {
          message += ` You have ${laterCount} more appointment${laterCount === 1 ? "" : "s"} later today.`;
        }
        return message;
      }

      return (
        `Reminder. Your ${requested.title} appointment is on ${requested.date} ` +
        `at ${formattedTime}. It is in ${diffMinutes} minutes.`
      );
    }
  }

  if (upcomingToday.length === 0) {
    return "You have no more appointments scheduled for today.";
  }

  const nextAppointment = upcomingToday[0];
  const nextDateTime = parseAppointmentDateTime(nextAppointment);
  const formattedTime = nextDateTime
    ? formatVoiceTime(nextDateTime)
    : formatDisplayTime(nextAppointment.time);
  const diffMinutes = nextDateTime
    ? getMinutesUntilAppointment(nextDateTime, now)
    : 0;
  const laterCount = Math.max(upcomingToday.length - 1, 0);

  let message =
    `Reminder. Your next appointment is ${nextAppointment.title} at ${formattedTime}. ` +
    `It is in ${diffMinutes} minutes.`;
  if (laterCount > 0) {
    message += ` You have ${laterCount} more appointment${laterCount === 1 ? "" : "s"} later today.`;
  }

  return message;
}

app.get("/auth/google", (req, res, next) => {
  if (TEST_PROFILE_ENABLED) {
    res.redirect("/?google=test_profile");
    return;
  }

  if (!hasGoogleConfig()) {
    res.status(400).render("error", {
      title: "Google Not Configured",
      message:
        "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI."
    });
    return;
  }

  try {
    res.redirect(getGoogleAuthUrl());
  } catch (error) {
    next(error);
  }
});

app.get("/auth/google/callback", async (req, res, next) => {
  const code = String(req.query.code || "");
  if (!code) {
    res.redirect("/?google=auth_error");
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const mergedTokens = mergeGoogleTokens(tokens, getPersistedGoogleTokens());
    setGoogleTokensOnSession(req.session, mergedTokens);
    persistGoogleTokens(mergedTokens);
    const identityFromTokens = extractGoogleIdentityFromTokens(mergedTokens);
    if (identityFromTokens) {
      const user = upsertUserFromIdentity(identityFromTokens);
      if (user) {
        req.session.userId = user.id;
        persistGoogleProfile(identityFromTokens);
        assignLegacyAppointmentsToUser(user.id);
      }
    }
    res.redirect("/?google=connected");
  } catch (error) {
    if (error instanceof GoogleCalendarError) {
      res.redirect("/?google=auth_error");
      return;
    }

    next(error);
  }
});

app.post("/auth/google/disconnect", (req, res) => {
  if (TEST_PROFILE_ENABLED) {
    res.redirect("/?google=test_profile");
    return;
  }

  clearGoogleSession(req.session);
  clearPersistedGoogleTokens();
  clearPersistedGoogleProfile();
  if (req.session?.userId) {
    delete req.session.userId;
  }
  res.redirect("/?google=disconnected");
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.post("/twilio/voice", (req, res) => {
  const VoiceResponse = require("twilio").twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  const requestedId = parseId(req.query.appointmentId || req.body.appointmentId);
  const userId = parseId(req.query.userId || req.body.userId) || null;
  twiml.say(buildTodayVoiceMessage(userId, requestedId, new Date()));

  res.type("text/xml");
  res.send(twiml.toString());
});

app.post("/twilio/status-callback", (req, res) => {
  const result = handleVoiceStatusCallback({
    attemptId: req.query.attemptId || req.body.attemptId,
    callSid: req.body.CallSid || req.body.callSid,
    callStatus: req.body.CallStatus || req.body.callStatus,
    errorCode: req.body.ErrorCode || req.body.errorCode,
    errorMessage: req.body.ErrorMessage || req.body.errorMessage
  });

  res.status(result.ok ? 200 : 404).type("text/plain").send(result.ok ? "OK" : "NOT_FOUND");
});

app.get("/twilio/test-call", async (req, res) => {
  const user = requireCurrentUser(req, res);
  if (!user) {
    return;
  }

  const minutesRaw = Number.parseInt(String(req.query.minutes || "30"), 10);
  const minutesOffset = [30, 60].includes(minutesRaw) ? minutesRaw : null;
  if (!minutesOffset) {
    res.status(400).json({
      ok: false,
      message: "minutes must be 30 or 60."
    });
    return;
  }

  const requestedId = parseId(req.query.appointmentId);
  const appointment = getUpcomingAppointmentForCall(requestedId, user.id);
  const targetAppointmentId = appointment?.id ?? null;

  try {
    const call = await triggerTestCall(user.id, targetAppointmentId, minutesOffset);
    res.json({
      ok: true,
      callSid: call.sid,
      appointmentId: targetAppointmentId,
      minutes: minutesOffset,
      message: appointment
        ? "Test call placed for the selected appointment."
        : "Test call placed with no upcoming appointment context."
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error?.message || "Unable to place test call."
    });
  }
});

app.post("/settings/test-call", async (req, res) => {
  const user = requireCurrentUser(req, res);
  if (!user) {
    return;
  }

  const minutesRaw = Number.parseInt(String(req.body.minutes || "30"), 10);
  const minutesOffset = [30, 60].includes(minutesRaw) ? minutesRaw : 30;
  const requestedId = parseId(req.body.appointmentId || req.query.appointmentId);
  const appointment = getUpcomingAppointmentForCall(requestedId, user.id);
  const targetAppointmentId = appointment?.id ?? null;

  try {
    const call = await triggerTestCall(user.id, targetAppointmentId, minutesOffset);
    const query = new URLSearchParams({
      call: "success",
      callSid: String(call.sid || ""),
      minutes: String(minutesOffset)
    });

    if (targetAppointmentId) {
      query.set("appointmentId", String(targetAppointmentId));
    }

    res.redirect(`/settings?${query.toString()}`);
  } catch (error) {
    const query = new URLSearchParams({
      call: "error",
      error: String(error?.message || "Unable to place test call.")
    });
    res.redirect(`/settings?${query.toString()}`);
  }
});

app.get("/", (req, res) => {
  const user = requireCurrentUser(req, res);
  if (!user) {
    return;
  }

  const viewModel = {
    title: "Appointment Vault",
    appointments: [],
    todayAppointments: [],
    thisWeekAppointments: [],
    upcomingAppointments: [],
    googleStatusMessage: ""
  };

  try {
    const now = new Date();
    const todayDate = formatLocalDate(now);
    const nowTime = formatLocalTime(now);
    const endOfWeekDate = getEndOfWeekDateString(todayDate);

    const appointments = getAppointmentsForUserWithOccurrences(user.id, {
      now,
      daysAhead: 60
    });

    const todayAppointments = appointments.filter(
      (appointment) =>
        !appointment.isHistory &&
        appointment.date === todayDate &&
        appointment.time >= nowTime
    );
    const thisWeekAppointments = appointments.filter(
      (appointment) =>
        !appointment.isHistory &&
        appointment.date >= todayDate &&
        appointment.date <= endOfWeekDate
    );
    const upcomingAppointments = appointments.filter(
      (appointment) => !appointment.isHistory && appointment.date > endOfWeekDate
    );

    const googleStatusMessage =
      req.query.google === "connected"
        ? "Google Calendar connected."
        : req.query.google === "disconnected"
          ? "Google Calendar disconnected."
          : req.query.google === "test_profile"
            ? "Temporary test profile is active. Google sign-in is bypassed."
          : req.query.google === "auth_error"
            ? "Google sign-in failed. Please try connecting again."
            : "";

    res.render("index", {
      ...viewModel,
      appointments,
      todayAppointments,
      thisWeekAppointments,
      upcomingAppointments,
      googleStatusMessage
    });
  } catch (error) {
    console.error("Home page load failed:", error.message);
    res.status(500).render("index", {
      ...viewModel,
      googleStatusMessage: "Unable to load appointments right now."
    });
  }
});

function renderSettingsPage(req, res, next) {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    if (/^\/settings\/history\/?$/i.test(String(req.path || ""))) {
      renderSettingsHistoryPage(req, res, next);
      return;
    }

    const historyAppointments = getHistoryAppointments(user.id);
    const reminderActivityPage = clampPageNumber(req.query.activityPage, 1);
    const reminderStatus = String(req.query.status || "").trim();
    const reminderChannel = String(req.query.channel || "").trim();
    const reminderActivity = getReminderActivity(user.id, {
      page: reminderActivityPage,
      pageSize: 20,
      status: reminderStatus,
      channel: reminderChannel
    });

    const callStatus = String(req.query.call || "");
    const callStatusMessage =
      callStatus === "success"
        ? `Test call placed. Call SID: ${String(req.query.callSid || "n/a")}`
        : callStatus === "error"
          ? `Test call failed: ${String(req.query.error || "Unknown error")}`
          : "";

    res.render("settings", {
      title: "Settings",
      user,
      historyAppointments,
      reminderActivity,
      reminderStatus,
      reminderChannel,
      query: req.query || {},
      callStatus,
      callStatusMessage
    });
  } catch (error) {
    next(error);
  }
}

function getHistoryAppointments(userId) {
  if (!userId) {
    return [];
  }

  const now = new Date();
  const todayDate = formatLocalDate(now);
  const nowTime = formatLocalTime(now);
  const baseAppointments = selectAppointmentsForUserStatement.all(userId);
  const historyWindowStart = formatDateString(
    new Date(Date.now() - 120 * 24 * 60 * 60 * 1000)
  );
  const historyWindowEnd = formatDateString(new Date());
  const expanded = expandAppointmentsForWindow(baseAppointments, historyWindowStart, historyWindowEnd);
  const completionSet = getUserOccurrenceCompletionSet(userId);

  return expanded
    .map((appointment) =>
      mapAppointmentForView(appointment, todayDate, nowTime, completionSet)
    )
    .filter((appointment) => appointment.isHistory)
    .sort((left, right) => {
      if (left.date !== right.date) {
        return right.date.localeCompare(left.date);
      }
      if (left.time !== right.time) {
        return right.time.localeCompare(left.time);
      }
      return right.id - left.id;
    });
}

function renderSettingsHistoryPage(req, res, next) {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    res.render("settings-history", {
      title: "History Log",
      historyAppointments: getHistoryAppointments(user.id)
    });
  } catch (error) {
    next(error);
  }
}

app.get("/setting", (req, res) => {
  res.redirect("/settings");
});
app.get("/settings/history", renderSettingsHistoryPage);
app.get(/^\/settings.*$/i, renderSettingsPage);

app.post("/settings/reminders", (req, res, next) => {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    const voiceEnabled = parseBooleanInput(req.body.voiceEnabled, false);
    const smsEnabled = parseBooleanInput(req.body.smsEnabled, false);
    const quietHoursStart = normalizeClockTime(req.body.quietHoursStart);
    const quietHoursEnd = normalizeClockTime(req.body.quietHoursEnd);
    const timezone = String(req.body.timezone || user.timezone || APP_TIMEZONE).trim() || APP_TIMEZONE;

    updateUserPreferences(user.id, {
      voiceEnabled: voiceEnabled ? 1 : 0,
      smsEnabled: smsEnabled ? 1 : 0,
      quietHoursStart,
      quietHoursEnd,
      timezone,
      reminderStrategy: "voice_primary_sms_fallback"
    });
    req.currentUser = selectUserByIdStatement.get(user.id) || req.currentUser;
    res.redirect("/settings?prefs=saved");
  } catch (error) {
    next(error);
  }
});

app.patch("/api/settings/reminders", (req, res, next) => {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    const nextUser = updateUserPreferences(user.id, {
      voiceEnabled:
        req.body.voiceEnabled === undefined ? undefined : parseBooleanInput(req.body.voiceEnabled, true) ? 1 : 0,
      smsEnabled:
        req.body.smsEnabled === undefined ? undefined : parseBooleanInput(req.body.smsEnabled, true) ? 1 : 0,
      quietHoursStart:
        req.body.quietHoursStart === undefined ? undefined : normalizeClockTime(req.body.quietHoursStart),
      quietHoursEnd:
        req.body.quietHoursEnd === undefined ? undefined : normalizeClockTime(req.body.quietHoursEnd),
      timezone:
        req.body.timezone === undefined
          ? undefined
          : String(req.body.timezone || "").trim() || APP_TIMEZONE,
      reminderStrategy:
        req.body.reminderStrategy === undefined
          ? undefined
          : String(req.body.reminderStrategy || "").trim() || "voice_primary_sms_fallback"
    });

    if (!nextUser) {
      res.status(404).json({ ok: false, message: "User not found." });
      return;
    }

    req.currentUser = nextUser;
    res.json({
      ok: true,
      settings: {
        voiceEnabled: Number(nextUser.voiceEnabled) === 1,
        smsEnabled: Number(nextUser.smsEnabled) === 1,
        quietHoursStart: nextUser.quietHoursStart || null,
        quietHoursEnd: nextUser.quietHoursEnd || null,
        timezone: nextUser.timezone || APP_TIMEZONE,
        reminderStrategy: nextUser.reminderStrategy || "voice_primary_sms_fallback"
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/reminders/activity", (req, res, next) => {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    const data = getReminderActivity(user.id, {
      page: clampPageNumber(req.query.page, 1),
      pageSize: clampPageNumber(req.query.pageSize, 20),
      status: String(req.query.status || "").trim(),
      channel: String(req.query.channel || "").trim()
    });

    res.json({
      ok: true,
      ...data
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/reminders/test", async (req, res, next) => {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    const appointmentId = parseId(req.body.appointmentId);
    const minutesRaw = Number.parseInt(String(req.body.minutes || "30"), 10);
    const minutes = [30, 60].includes(minutesRaw) ? minutesRaw : 30;
    const result = await triggerTestCall(user.id, appointmentId, minutes);
    res.json({
      ok: true,
      callSid: result.sid,
      attemptId: result.attemptId
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error?.message || "Unable to trigger test reminder."
    });
  }
});

app.get("/agent", (req, res) => {
  const user = requireCurrentUser(req, res);
  if (!user) {
    return;
  }
  renderAgentPage(res);
});

app.post("/agent/parse", async (req, res, next) => {
  const user = requireCurrentUser(req, res);
  if (!user) {
    return;
  }

  const promptText = String(req.body.promptText ?? req.body.quickText ?? "").trim();

  if (!promptText) {
    res.status(400);
    renderAgentPage(res, {
      parseError: "Please describe your appointment before parsing."
    });
    return;
  }

  try {
    const parsedByAi = await parseAppointment(promptText);
    const appointmentInput = normalizeInput({
      title: parsedByAi.title ?? "",
      date: parsedByAi.date ?? "",
      time: parsedByAi.time ?? "",
      location: parsedByAi.location ?? "",
      notes: parsedByAi.notes ?? "",
      tags: parsedByAi.tags ?? "",
      reminderMinutes:
        parsedByAi.reminderMinutes === null || parsedByAi.reminderMinutes === undefined
          ? ""
          : String(parsedByAi.reminderMinutes)
    });
    const appointmentWithDefaults = applyAgentDefaults(appointmentInput);

    const saveErrors = validateAppointment(appointmentWithDefaults);
    if (saveErrors.title || saveErrors.date || saveErrors.time) {
      res.status(400);
      renderAgentPage(res, {
        promptText,
        parsed: toAgentFormValues(appointmentWithDefaults),
        parseError: "I need a title, date, and time. Example: 'Dentist tomorrow at 3pm'"
      });
      return;
    }

    renderAgentPage(res, {
      promptText,
      parsed: toAgentFormValues(appointmentWithDefaults),
      saveErrors
    });
  } catch (error) {
    if (error instanceof AiParseError) {
      res.status(400);
      renderAgentPage(res, {
        promptText,
        parseError: error.message
      });
      return;
    }

    next(error);
  }
});

app.post("/agent/save", async (req, res, next) => {
  const user = requireCurrentUser(req, res);
  if (!user) {
    return;
  }

  const promptText = String(req.body.promptText ?? "").trim();
  const appointmentInput = normalizeInput({
    title: req.body.title ?? "",
    date: req.body.date ?? "",
    time: req.body.time ?? "",
    location: req.body.location ?? "",
    notes: req.body.notes ?? "",
    tags: req.body.tags ?? "",
    reminderMinutes: req.body.reminderMinutes ?? "",
    isRecurring: req.body.isRecurring ?? "",
    rrule: req.body.rrule ?? ""
  });

  const saveErrors = validateAppointment(appointmentInput);
  if (Object.keys(saveErrors).length > 0) {
    res.status(400);
    renderAgentPage(res, {
      promptText,
      parsed: toAgentFormValues(appointmentInput),
      parseError: "Please fix the highlighted fields before saving.",
      saveErrors
    });
    return;
  }

  try {
    const now = new Date().toISOString();
    const record = serializeForDb(appointmentInput);

    const insertInfo = db.prepare(
      `INSERT INTO appointments
        (userId, title, date, time, location, notes, tags, reminderMinutes, isRecurring, rrule, seriesId, occurrenceStart, occurrenceEnd, createdAt, updatedAt)
       VALUES
        (@userId, @title, @date, @time, @location, @notes, @tags, @reminderMinutes, @isRecurring, @rrule, @seriesId, @occurrenceStart, @occurrenceEnd, @createdAt, @updatedAt)`
    ).run({
      ...record,
      userId: user.id,
      occurrenceStart: `${record.date}T${record.time}:00`,
      occurrenceEnd: null,
      createdAt: now,
      updatedAt: now
    });

    try {
      if (isGoogleConnected(req.session)) {
        const appointment = getAppointmentById(Number(insertInfo.lastInsertRowid), user.id);
        if (appointment) {
          await createGoogleEventFromSession(req.session, appointment);
          persistGoogleTokens(req.session.googleTokens);
        }
      }
    } catch (error) {
      if (!(error instanceof GoogleCalendarError)) {
        throw error;
      }

      console.error("Google Calendar sync failed:", error.message);
    }

    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

app.get("/appointments/new", (req, res) => {
  const user = requireCurrentUser(req, res);
  if (!user) {
    return;
  }

  const defaults = getQuickAddDefaults();

  res.render("appointments/form", {
    title: "Add Appointment",
    pageTitle: "Add Appointment",
    formAction: "/appointments",
    submitLabel: "Save Appointment",
    quickAddMode: true,
    appointment: {
      title: "",
      date: defaults.date,
      time: defaults.time,
      location: "",
      notes: "",
      tags: "",
      reminderMinutes: "",
      isRecurring: false,
      rrule: ""
    },
    errors: {}
  });
});

app.post("/appointments", async (req, res, next) => {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    const appointmentInput = normalizeInput(req.body);
    const errors = validateAppointment(appointmentInput);

    if (Object.keys(errors).length > 0) {
      res.status(400).render("appointments/form", {
        title: "Add Appointment",
        pageTitle: "Add Appointment",
        formAction: "/appointments",
        submitLabel: "Save Appointment",
        quickAddMode: true,
        appointment: appointmentInput,
        errors
      });
      return;
    }

    const now = new Date().toISOString();
    const record = serializeForDb(appointmentInput);

    const insertInfo = db.prepare(
      `INSERT INTO appointments
        (userId, title, date, time, location, notes, tags, reminderMinutes, isRecurring, rrule, seriesId, occurrenceStart, occurrenceEnd, createdAt, updatedAt)
       VALUES
        (@userId, @title, @date, @time, @location, @notes, @tags, @reminderMinutes, @isRecurring, @rrule, @seriesId, @occurrenceStart, @occurrenceEnd, @createdAt, @updatedAt)`
    ).run({
      ...record,
      userId: user.id,
      occurrenceStart: `${record.date}T${record.time}:00`,
      occurrenceEnd: null,
      createdAt: now,
      updatedAt: now
    });

    try {
      if (isGoogleConnected(req.session)) {
        const appointment = getAppointmentById(Number(insertInfo.lastInsertRowid), user.id);
        if (appointment) {
          await createGoogleEventFromSession(req.session, appointment);
          persistGoogleTokens(req.session.googleTokens);
        }
      }
    } catch (error) {
      if (!(error instanceof GoogleCalendarError)) {
        throw error;
      }

      console.error("Google Calendar sync failed:", error.message);
    }

    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

app.post("/api/appointments/validate-conflict", (req, res, next) => {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    const payload = normalizeInput(req.body || {});
    const errors = validateAppointment(payload);
    if (Object.keys(errors).length > 0) {
      res.status(400).json({
        ok: false,
        message: "Invalid appointment payload.",
        errors
      });
      return;
    }

    const serialized = serializeForDb(payload);
    const excludeId = parseId(req.body.excludeId || req.body.id) || null;
    const existing = selectAppointmentsForUserStatement
      .all(user.id)
      .filter((appointment) => !excludeId || appointment.id !== excludeId);

    const windowStart = serialized.date;
    const windowStartDate = parseDateString(serialized.date) || new Date();
    const horizonDate = new Date(windowStartDate.getTime());
    horizonDate.setUTCDate(horizonDate.getUTCDate() + 120);
    const windowEnd = formatDateString(horizonDate);

    const conflicts = detectConflicts(
      {
        ...serialized,
        id: excludeId || 0,
        occurrenceEnd: null
      },
      existing,
      windowStart,
      windowEnd
    );

    res.json({
      ok: true,
      hasConflict: conflicts.length > 0,
      conflicts
    });
  } catch (error) {
    next(error);
  }
});

app.get("/appointments/:id", (req, res, next) => {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    const id = parseId(req.params.id);

    if (!id) {
      res.status(404).render("404", { title: "Not Found" });
      return;
    }

    const appointment = getAppointmentById(id, user.id);

    if (!appointment) {
      res.status(404).render("404", { title: "Not Found" });
      return;
    }

    const now = new Date();
    const todayDate = formatLocalDate(now);
    const nowTime = formatLocalTime(now);

    res.render("appointments/view", {
      title: appointment.title,
      appointment: {
        ...appointment,
        tagList: tagsToArray(appointment.tags),
        isHistory: isHistoryAppointment(appointment, todayDate, nowTime),
        occurrenceKey: createOccurrenceKey(appointment),
        isOccurrence: false
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/appointments/:id/edit", (req, res, next) => {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    const id = parseId(req.params.id);

    if (!id) {
      res.status(404).render("404", { title: "Not Found" });
      return;
    }

    const appointment = getAppointmentById(id, user.id);

    if (!appointment) {
      res.status(404).render("404", { title: "Not Found" });
      return;
    }

    res.render("appointments/form", {
      title: "Edit Appointment",
      pageTitle: "Edit Appointment",
      formAction: `/appointments/${id}`,
      submitLabel: "Update Appointment",
      quickAddMode: false,
      appointment: {
        ...appointment,
        reminderMinutes:
          appointment.reminderMinutes === null
            ? ""
            : String(appointment.reminderMinutes),
        isRecurring: Number(appointment.isRecurring) === 1,
        rrule: appointment.rrule || ""
      },
      errors: {}
    });
  } catch (error) {
    next(error);
  }
});

app.post("/appointments/:id", async (req, res, next) => {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    const id = parseId(req.params.id);

    if (!id) {
      res.status(404).render("404", { title: "Not Found" });
      return;
    }

    const existing = getAppointmentById(id, user.id);

    if (!existing) {
      res.status(404).render("404", { title: "Not Found" });
      return;
    }

    const appointmentInput = normalizeInput(req.body);
    const errors = validateAppointment(appointmentInput);

    if (Object.keys(errors).length > 0) {
      res.status(400).render("appointments/form", {
        title: "Edit Appointment",
        pageTitle: "Edit Appointment",
        formAction: `/appointments/${id}`,
        submitLabel: "Update Appointment",
        quickAddMode: false,
        appointment: {
          ...appointmentInput,
          id
        },
        errors
      });
      return;
    }

    const record = serializeForDb(appointmentInput);

    db.prepare(
      `UPDATE appointments
       SET title = @title,
           date = @date,
           time = @time,
           location = @location,
           notes = @notes,
           tags = @tags,
           reminderMinutes = @reminderMinutes,
           isRecurring = @isRecurring,
           rrule = @rrule,
           seriesId = @seriesId,
           occurrenceStart = @occurrenceStart,
           updatedAt = @updatedAt
       WHERE id = @id
         AND userId = @userId`
    ).run({
      ...record,
      id,
      userId: user.id,
      seriesId: record.isRecurring
        ? record.seriesId || existing.seriesId || randomUUID()
        : null,
      occurrenceStart: `${record.date}T${record.time}:00`,
      updatedAt: new Date().toISOString()
    });

    res.redirect(`/appointments/${id}`);
  } catch (error) {
    next(error);
  }
});

app.post("/appointments/:id/delete", async (req, res, next) => {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    const id = parseId(req.params.id);

    if (!id) {
      res.status(404).render("404", { title: "Not Found" });
      return;
    }

    db.prepare("DELETE FROM appointments WHERE id = ? AND userId = ?").run(id, user.id);
    res.redirect("/");
  } catch (error) {
    next(error);
  }
});

app.post("/api/appointments/:id/complete-occurrence", (req, res, next) => {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    const id = parseId(req.params.id);
    if (!id) {
      res.status(404).json({ ok: false, message: "Invalid appointment id." });
      return;
    }

    const appointment = getAppointmentById(id, user.id);
    if (!appointment) {
      res.status(404).json({ ok: false, message: "Appointment not found." });
      return;
    }

    const occurrenceKeyRaw = String(req.body.occurrenceKey || req.query.occurrenceKey || "").trim();
    const occurrenceKey = occurrenceKeyRaw || createOccurrenceKey(appointment);
    const nowIso = new Date().toISOString();
    insertOccurrenceCompletionStatement.run(user.id, id, occurrenceKey, nowIso, nowIso);

    if (requestPrefersJson(req)) {
      res.json({ ok: true, appointmentId: id, occurrenceKey });
      return;
    }
    const referer = String(req.get("referer") || "/").trim();
    res.redirect(referer || "/");
  } catch (error) {
    next(error);
  }
});

app.post("/api/appointments/:id/complete-series", (req, res, next) => {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    const id = parseId(req.params.id);
    if (!id) {
      res.status(404).json({ ok: false, message: "Invalid appointment id." });
      return;
    }

    const appointment = getAppointmentById(id, user.id);
    if (!appointment) {
      res.status(404).json({ ok: false, message: "Appointment not found." });
      return;
    }

    const nowIso = new Date().toISOString();
    db.prepare(
      `UPDATE appointments
       SET completedAt = ?, updatedAt = ?
       WHERE id = ? AND userId = ?`
    ).run(nowIso, nowIso, id, user.id);

    if (requestPrefersJson(req)) {
      res.json({ ok: true, appointmentId: id });
      return;
    }
    const referer = String(req.get("referer") || "/").trim();
    res.redirect(referer || "/");
  } catch (error) {
    next(error);
  }
});

function completeAppointment(req, res, next) {
  try {
    const user = requireCurrentUser(req, res);
    if (!user) {
      return;
    }

    const id = parseId(req.params.id);
    if (!id) {
      res.status(404).render("404", { title: "Not Found" });
      return;
    }

    const existing = getAppointmentById(id, user.id);
    if (!existing) {
      res.status(404).render("404", { title: "Not Found" });
      return;
    }

    const requestedOccurrenceKey = String(req.body?.occurrenceKey || req.query?.occurrenceKey || "").trim();
    if (Number(existing.isRecurring) === 1 && requestedOccurrenceKey) {
      const nowIso = new Date().toISOString();
      insertOccurrenceCompletionStatement.run(
        user.id,
        id,
        requestedOccurrenceKey,
        nowIso,
        nowIso
      );
      const referer = String(req.get("referer") || "").trim();
      if (referer.includes("/settings")) {
        res.redirect("/settings");
        return;
      }
      res.redirect("/");
      return;
    }

    db.prepare(
      `UPDATE appointments
       SET completedAt = @completedAt,
           updatedAt = @updatedAt
       WHERE id = @id
         AND userId = @userId`
    ).run({
      id,
      userId: user.id,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const referer = String(req.get("referer") || "").trim();
    if (referer.includes("/settings")) {
      res.redirect("/settings");
      return;
    }

    res.redirect("/");
  } catch (error) {
    next(error);
  }
}

app.all(/^\/appointments\/([^/]+)\/complete\/?$/i, (req, res, next) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  req.params = {
    ...(req.params || {}),
    id: req.params?.id || req.params?.[0]
  };

  completeAppointment(req, res, next);
});

app.use((req, res) => {
  res.status(404).render("404", { title: "Not Found" });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render("error", {
    title: "Server Error",
    message: "Something went wrong. Please try again."
  });
});

logTwilioEnvStatus();
startReminderScheduler();

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Appointment Vault listening on ${PORT}`);
});
