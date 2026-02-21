const express = require("express");
const session = require("express-session");
const path = require("node:path");
const db = require("./db");
const { parseAppointment, AiParseError } = require("./ai");
const {
  hasGoogleConfig,
  isGoogleConnected,
  getGoogleAuthUrl,
  exchangeCodeForTokens,
  setGoogleTokensOnSession,
  clearGoogleSession,
  createGoogleEventFromSession,
  GoogleCalendarError
} = require("./googleCalendar");
const {
  logTwilioEnvStatus,
  startReminderScheduler,
  triggerTestCall
} = require("./reminderScheduler");
require("dotenv").config({ quiet: true });

const app = express();
const SESSION_SECRET = process.env.SESSION_SECRET || "appointment-vault-session-secret-change-me";
const GOOGLE_TOKENS_SETTING_KEY = "google.tokens";
const selectAppSettingStatement = db.prepare("SELECT value FROM app_settings WHERE key = ?");
const upsertAppSettingStatement = db.prepare(`
  INSERT INTO app_settings (key, value, updatedAt)
  VALUES (@key, @value, @updatedAt)
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updatedAt = excluded.updatedAt
`);
const deleteAppSettingStatement = db.prepare("DELETE FROM app_settings WHERE key = ?");

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 14
    }
  })
);
app.use((req, res, next) => {
  if (!isGoogleConnected(req.session)) {
    const persistedTokens = getPersistedGoogleTokens();
    if (persistedTokens) {
      setGoogleTokensOnSession(req.session, persistedTokens);
    }
  }

  next();
});
app.use("/public", express.static(path.join(__dirname, "public")));
app.use((req, res, next) => {
  res.locals.googleConfigured = hasGoogleConfig();
  res.locals.googleConnected = isGoogleConnected(req.session);
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

function persistGoogleTokens(tokens) {
  if (!tokens || (!tokens.access_token && !tokens.refresh_token)) {
    return;
  }

  upsertAppSettingStatement.run({
    key: GOOGLE_TOKENS_SETTING_KEY,
    value: JSON.stringify(tokens),
    updatedAt: new Date().toISOString()
  });
}

function clearPersistedGoogleTokens() {
  deleteAppSettingStatement.run(GOOGLE_TOKENS_SETTING_KEY);
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

  return {
    title: String(body.title ?? "").trim(),
    date: String(body.date ?? "").trim(),
    time: String(body.time ?? "").trim(),
    location: String(body.location ?? "").trim(),
    notes: String(body.notes ?? "").trim(),
    tags: normalizeTags(String(body.tags ?? "")),
    reminderMinutes: reminderRaw
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

  return errors;
}

function serializeForDb(input) {
  const parsedReminder = Number.parseInt(input.reminderMinutes, 10);

  return {
    ...input,
    reminderMinutes:
      input.reminderMinutes === "" ||
      !Number.isInteger(parsedReminder) ||
      parsedReminder < 0
        ? null
        : parsedReminder
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

function getAppointmentById(id) {
  return db.prepare("SELECT * FROM appointments WHERE id = ?").get(id);
}

function parseId(idValue) {
  const id = Number.parseInt(idValue, 10);

  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  return id;
}

function getQuickAddDefaults() {
  const now = new Date();
  const plusOneHour = new Date(now.getTime() + 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");

  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(plusOneHour.getHours())}:${pad(plusOneHour.getMinutes())}`
  };
}

function formatLocalDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatLocalTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

function isPastAppointment(appointment, todayDate, nowTime) {
  return (
    appointment.date < todayDate ||
    (appointment.date === todayDate && appointment.time < nowTime)
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

  const parsed = new Date(`${appointment.date}T${appointment.time}:00`);
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

function buildVoiceReminderMessage(appointment, minutesOffset) {
  const hasMinutes = minutesOffset === 30 || minutesOffset === 60;

  if (!appointment) {
    return hasMinutes
      ? `Reminder. You have an appointment in ${minutesOffset} minutes.`
      : "Reminder. You have an upcoming appointment.";
  }

  let spokenMinutes = minutesOffset;
  if (hasMinutes) {
    const appointmentDateTime = parseAppointmentDateTime(appointment);
    if (appointmentDateTime) {
      const minutesUntilStart = getMinutesUntilAppointment(appointmentDateTime);
      // Keep normal "60/30 minute reminder" wording near the expected mark.
      // If the reminder is sent late, announce the true minutes remaining.
      spokenMinutes =
        minutesUntilStart < minutesOffset - 1
          ? minutesUntilStart
          : minutesOffset;
    }
  }

  let message = hasMinutes
    ? `Reminder. You have ${appointment.title} in ${spokenMinutes} minutes at ${appointment.time}.`
    : `Reminder. You have ${appointment.title} at ${appointment.time}.`;

  if (appointment.location) {
    message += ` Location: ${appointment.location}.`;
  }
  return message;
}

app.get("/auth/google", (req, res, next) => {
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
    setGoogleTokensOnSession(req.session, tokens);
    persistGoogleTokens(req.session.googleTokens || tokens);
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
  clearGoogleSession(req.session);
  clearPersistedGoogleTokens();
  res.redirect("/?google=disconnected");
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.post("/twilio/voice", (req, res) => {
  const appointmentId = parseId(req.query.appointmentId || req.body.appointmentId);
  const minutesRaw = Number.parseInt(
    String(req.query.minutes || req.body.minutes || ""),
    10
  );
  const minutesOffset = [30, 60].includes(minutesRaw) ? minutesRaw : null;
  const appointment = appointmentId ? getAppointmentById(appointmentId) : null;
  const message = buildVoiceReminderMessage(appointment, minutesOffset);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${escapeXml(message)}</Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

app.get("/twilio/test-call", async (req, res) => {
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
  const appointment = requestedId
    ? getAppointmentById(requestedId)
    : db.prepare(
      `SELECT id, title, date, time
       FROM appointments
       WHERE date >= ?
       ORDER BY date ASC, time ASC, id ASC
       LIMIT 1`
    ).get(getTodayDateString());

  if (!appointment) {
    res.status(400).json({
      ok: false,
      message: "No appointment found. Pass appointmentId or create an appointment first."
    });
    return;
  }

  try {
    const call = await triggerTestCall(appointment.id, minutesOffset);
    res.json({
      ok: true,
      callSid: call.sid,
      appointmentId: appointment.id,
      minutes: minutesOffset
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error?.message || "Unable to place test call."
    });
  }
});

app.get("/", (req, res) => {
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

    const appointments = db
      .prepare("SELECT * FROM appointments ORDER BY date ASC, time ASC, id ASC")
      .all()
      .map((appointment) => ({
        ...appointment,
        tagList: tagsToArray(appointment.tags),
        isPast: isPastAppointment(appointment, todayDate, nowTime),
        isCompleted: isPastAppointment(appointment, todayDate, nowTime)
      }));

    const todayAppointments = appointments.filter(
      (appointment) => appointment.date === todayDate && appointment.time >= nowTime
    );
    const thisWeekAppointments = appointments.filter(
      (appointment) =>
        !appointment.isPast &&
        appointment.date >= todayDate &&
        appointment.date <= endOfWeekDate
    );
    const upcomingAppointments = appointments.filter(
      (appointment) => appointment.date > endOfWeekDate
    );

    const googleStatusMessage =
      req.query.google === "connected"
        ? "Google Calendar connected."
        : req.query.google === "disconnected"
          ? "Google Calendar disconnected."
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

app.get("/settings", (req, res, next) => {
  try {
    const now = new Date();
    const todayDate = formatLocalDate(now);
    const nowTime = formatLocalTime(now);
    const historyAppointments = db
      .prepare("SELECT * FROM appointments ORDER BY date ASC, time ASC, id ASC")
      .all()
      .map((appointment) => ({
        ...appointment,
        tagList: tagsToArray(appointment.tags),
        isPast: isPastAppointment(appointment, todayDate, nowTime)
      }))
      .filter((appointment) => appointment.isPast)
      .sort((left, right) => {
        if (left.date !== right.date) {
          return right.date.localeCompare(left.date);
        }

        if (left.time !== right.time) {
          return right.time.localeCompare(left.time);
        }

        return right.id - left.id;
      });

    res.render("settings", {
      title: "Settings",
      historyAppointments
    });
  } catch (error) {
    next(error);
  }
});

app.get("/agent", (req, res) => {
  renderAgentPage(res);
});

app.post("/agent/parse", async (req, res, next) => {
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
  const promptText = String(req.body.promptText ?? "").trim();
  const appointmentInput = normalizeInput({
    title: req.body.title ?? "",
    date: req.body.date ?? "",
    time: req.body.time ?? "",
    location: req.body.location ?? "",
    notes: req.body.notes ?? "",
    tags: req.body.tags ?? "",
    reminderMinutes: req.body.reminderMinutes ?? ""
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
        (title, date, time, location, notes, tags, reminderMinutes, createdAt, updatedAt)
       VALUES
        (@title, @date, @time, @location, @notes, @tags, @reminderMinutes, @createdAt, @updatedAt)`
    ).run({
      ...record,
      createdAt: now,
      updatedAt: now
    });

    try {
      if (isGoogleConnected(req.session)) {
        const appointment = getAppointmentById(Number(insertInfo.lastInsertRowid));
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
      reminderMinutes: ""
    },
    errors: {}
  });
});

app.post("/appointments", async (req, res, next) => {
  try {
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
        (title, date, time, location, notes, tags, reminderMinutes, createdAt, updatedAt)
       VALUES
        (@title, @date, @time, @location, @notes, @tags, @reminderMinutes, @createdAt, @updatedAt)`
    ).run({
      ...record,
      createdAt: now,
      updatedAt: now
    });

    try {
      if (isGoogleConnected(req.session)) {
        const appointment = getAppointmentById(Number(insertInfo.lastInsertRowid));
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

app.get("/appointments/:id", (req, res, next) => {
  try {
    const id = parseId(req.params.id);

    if (!id) {
      res.status(404).render("404", { title: "Not Found" });
      return;
    }

    const appointment = getAppointmentById(id);

    if (!appointment) {
      res.status(404).render("404", { title: "Not Found" });
      return;
    }

    res.render("appointments/view", {
      title: appointment.title,
      appointment: {
        ...appointment,
        tagList: tagsToArray(appointment.tags)
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/appointments/:id/edit", (req, res, next) => {
  try {
    const id = parseId(req.params.id);

    if (!id) {
      res.status(404).render("404", { title: "Not Found" });
      return;
    }

    const appointment = getAppointmentById(id);

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
            : String(appointment.reminderMinutes)
      },
      errors: {}
    });
  } catch (error) {
    next(error);
  }
});

app.post("/appointments/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);

    if (!id) {
      res.status(404).render("404", { title: "Not Found" });
      return;
    }

    const existing = getAppointmentById(id);

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
           updatedAt = @updatedAt
       WHERE id = @id`
    ).run({
      ...record,
      id,
      updatedAt: new Date().toISOString()
    });

    res.redirect(`/appointments/${id}`);
  } catch (error) {
    next(error);
  }
});

app.post("/appointments/:id/delete", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);

    if (!id) {
      res.status(404).render("404", { title: "Not Found" });
      return;
    }

    db.prepare("DELETE FROM appointments WHERE id = ?").run(id);
    res.redirect("/");
  } catch (error) {
    next(error);
  }
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Appointment Vault listening on ${PORT}`);
});
