const { google } = require("googleapis");
const { randomUUID } = require("node:crypto");

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar"
];

class GoogleCalendarError extends Error {
  constructor(message) {
    super(message);
    this.name = "GoogleCalendarError";
  }
}

function getGoogleConfig() {
  return {
    clientId: String(process.env.GOOGLE_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || "").trim(),
    redirectUri: String(process.env.GOOGLE_REDIRECT_URI || "").trim()
  };
}

function hasGoogleConfig() {
  const { clientId, clientSecret, redirectUri } = getGoogleConfig();
  return Boolean(clientId && clientSecret && redirectUri);
}

function validateGoogleEnv() {
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REDIRECT_URI"
  ];
  const missing = required.filter((key) => !String(process.env[key] || "").trim());

  if (missing.length > 0) {
    throw new GoogleCalendarError(
      `Missing required Google OAuth environment variables: ${missing.join(", ")}`
    );
  }
}

function getOAuth2Client() {
  validateGoogleEnv();
  const { clientId, clientSecret, redirectUri } = getGoogleConfig();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function isGoogleConnected(session) {
  const tokens = session?.googleTokens;
  return Boolean(tokens && (tokens.access_token || tokens.refresh_token));
}

function setGoogleTokensOnSession(session, nextTokens) {
  if (!session) {
    return;
  }

  const previous = session.googleTokens || {};
  const merged = { ...previous, ...(nextTokens || {}) };

  if (!merged.refresh_token && previous.refresh_token) {
    merged.refresh_token = previous.refresh_token;
  }

  session.googleTokens = merged;
}

function clearGoogleSession(session) {
  if (session?.googleTokens) {
    delete session.googleTokens;
  }
}

function getGoogleAuthUrl() {
  const oauth2Client = getOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    include_granted_scopes: true
  });
}

function parseJwtPayload(token) {
  const value = String(token || "").trim();
  if (!value.includes(".")) {
    return null;
  }

  const segments = value.split(".");
  if (segments.length < 2) {
    return null;
  }

  try {
    const payloadSegment = segments[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(segments[1].length / 4) * 4, "=");
    const json = Buffer.from(payloadSegment, "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload && typeof payload === "object" ? payload : null;
  } catch (error) {
    return null;
  }
}

function extractGoogleIdentityFromTokens(tokens) {
  const payload = parseJwtPayload(tokens?.id_token);
  if (!payload) {
    return null;
  }

  const providerUserId = String(payload.sub || "").trim();
  if (!providerUserId) {
    return null;
  }

  return {
    provider: "google",
    providerUserId,
    email: String(payload.email || "").trim() || null,
    displayName: String(payload.name || "").trim() || null
  };
}

async function exchangeCodeForTokens(code) {
  const oauth2Client = getOAuth2Client();

  let tokenResponse;
  try {
    tokenResponse = await oauth2Client.getToken(code);
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed to exchange Google auth code: ${error?.message || "unknown error"}`
    );
  }

  const tokens = tokenResponse?.tokens || {};
  if (!tokens.access_token && !tokens.refresh_token) {
    throw new GoogleCalendarError("Google token exchange returned no usable tokens.");
  }

  return tokens;
}

function getLocalTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatLocalDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

function formatLocalTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(
    2,
    "0"
  )}`;
}

function buildCalendarEvent(appointment) {
  const startLocal = `${appointment.date}T${appointment.time}:00`;
  const startDate = new Date(startLocal);
  if (Number.isNaN(startDate.getTime())) {
    throw new GoogleCalendarError("Appointment has invalid date or time for Google sync.");
  }

  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  const timezone = getLocalTimezone();

  const event = {
    summary: appointment.title,
    start: {
      dateTime: `${appointment.date}T${appointment.time}:00`,
      timeZone: timezone
    },
    end: {
      dateTime: `${formatLocalDate(endDate)}T${formatLocalTime(endDate)}:00`,
      timeZone: timezone
    }
  };

  if (appointment.location) {
    event.location = appointment.location;
  }

  const notes = String(appointment.notes || "").trim();
  if (notes) {
    event.description = notes;
  }

  if (typeof appointment.reminderMinutes === "number" && appointment.reminderMinutes >= 0) {
    event.reminders = {
      useDefault: false,
      overrides: [{ method: "popup", minutes: appointment.reminderMinutes }]
    };
  } else {
    event.reminders = { useDefault: true };
  }

  return event;
}

function getTodoCalendarName() {
  return "Appointment Vault - To Do";
}

function getRoundedNextHourStart() {
  const now = new Date();
  const start = new Date(now.getTime());
  start.setMinutes(0, 0, 0);
  start.setHours(start.getHours() + 1);
  return start;
}

function parseLocalDateTime(dateValue, timeValue) {
  const date = String(dateValue || "").trim();
  const time = String(timeValue || "").trim();
  if (!date && !time) {
    return null;
  }

  if (date && time) {
    const parsed = new Date(`${date}T${time}:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (date && !time) {
    const parsed = new Date(`${date}T09:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function buildTodoEvent(title, options = {}) {
  const safeTitle = String(title || "").trim();
  if (!safeTitle) {
    throw new GoogleCalendarError("To-Do title is required.");
  }

  const startDate =
    options.startDate instanceof Date ? options.startDate : getRoundedNextHourStart();
  const durationMinutes = Number.parseInt(String(options.durationMinutes || "30"), 10) || 30;
  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
  const timezone = getLocalTimezone();
  const syncId = String(options.syncId || "").trim();

  return {
    summary: safeTitle,
    description: "To-Do item created from Appointment Vault.",
    extendedProperties: syncId
      ? {
          private: {
            avTodoId: syncId
          }
        }
      : undefined,
    start: {
      dateTime: `${formatLocalDate(startDate)}T${formatLocalTime(startDate)}:00`,
      timeZone: timezone
    },
    end: {
      dateTime: `${formatLocalDate(endDate)}T${formatLocalTime(endDate)}:00`,
      timeZone: timezone
    }
  };
}

async function ensureTodoCalendar(session, options = {}) {
  if (!isGoogleConnected(session)) {
    throw new GoogleCalendarError("Google Calendar is not connected.");
  }

  if (session?.todoCalendarId) {
    return session.todoCalendarId;
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(session.googleTokens || {});
  oauth2Client.on("tokens", (tokens) => {
    setGoogleTokensOnSession(session, tokens || {});
  });

  try {
    await oauth2Client.getAccessToken();
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed refreshing Google access token: ${error?.message || "unknown error"}`
    );
  }

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const calendarName = String(options.calendarName || getTodoCalendarName()).trim();

  try {
    const list = await calendar.calendarList.list({ maxResults: 250 });
    const items = Array.isArray(list?.data?.items) ? list.data.items : [];
    const match = items.find((item) => String(item?.summary || "").trim() === calendarName);
    if (match?.id) {
      session.todoCalendarId = match.id;
      return match.id;
    }

    const created = await calendar.calendars.insert({
      requestBody: {
        summary: calendarName,
        timeZone: getLocalTimezone()
      }
    });
    const createdId = created?.data?.id || null;
    if (createdId) {
      session.todoCalendarId = createdId;
      return createdId;
    }
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed ensuring To-Do calendar: ${error?.message || "unknown error"}`
    );
  }

  throw new GoogleCalendarError("Unable to create or find To-Do calendar.");
}

async function createTodoEventFromSession(session, title, options = {}) {
  if (!isGoogleConnected(session)) {
    throw new GoogleCalendarError("Google Calendar is not connected.");
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(session.googleTokens || {});
  oauth2Client.on("tokens", (tokens) => {
    setGoogleTokensOnSession(session, tokens || {});
  });

  try {
    await oauth2Client.getAccessToken();
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed refreshing Google access token: ${error?.message || "unknown error"}`
    );
  }

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const todoCalendarId = await ensureTodoCalendar(session, options);
  const syncId = String(options.syncId || randomUUID()).trim() || randomUUID();
  const eventBody = buildTodoEvent(title, { ...options, syncId });

  try {
    const primaryCreated = await calendar.events.insert({
      calendarId: "primary",
      requestBody: eventBody
    });

    const todoCreated = await calendar.events.insert({
      calendarId: todoCalendarId,
      requestBody: eventBody
    });

    return {
      primaryEventId: primaryCreated?.data?.id || null,
      todoEventId: todoCreated?.data?.id || null,
      todoCalendarId,
      syncId
    };
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed creating To-Do Google Calendar event: ${error?.message || "unknown error"}`
    );
  }
}

async function listTodoEventsFromSession(session, options = {}) {
  if (!isGoogleConnected(session)) {
    return [];
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(session.googleTokens || {});
  oauth2Client.on("tokens", (tokens) => {
    setGoogleTokensOnSession(session, tokens || {});
  });

  try {
    await oauth2Client.getAccessToken();
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed refreshing Google access token: ${error?.message || "unknown error"}`
    );
  }

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const todoCalendarId = await ensureTodoCalendar(session, options);
  const timeMin = options.timeMin || new Date().toISOString();
  const maxResults = Number.parseInt(String(options.maxResults || "10"), 10) || 10;

  try {
    const response = await calendar.events.list({
      calendarId: todoCalendarId,
      timeMin,
      singleEvents: true,
      orderBy: "startTime",
      maxResults
    });

    const items = Array.isArray(response?.data?.items) ? response.data.items : [];
    return items.map((item) => ({
      id: item?.id || null,
      title: String(item?.summary || "To-Do"),
      start: item?.start?.dateTime || item?.start?.date || null,
      end: item?.end?.dateTime || item?.end?.date || null,
      syncId: item?.extendedProperties?.private?.avTodoId || null
    }));
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed listing To-Do Calendar events: ${error?.message || "unknown error"}`
    );
  }
}

async function deleteTodoEventFromSession(session, options = {}) {
  if (!isGoogleConnected(session)) {
    throw new GoogleCalendarError("Google Calendar is not connected.");
  }

  const todoEventId = String(options.todoEventId || "").trim();
  const syncId = String(options.syncId || "").trim();

  if (!todoEventId && !syncId) {
    throw new GoogleCalendarError("Missing To-Do identifiers for deletion.");
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(session.googleTokens || {});
  oauth2Client.on("tokens", (tokens) => {
    setGoogleTokensOnSession(session, tokens || {});
  });

  try {
    await oauth2Client.getAccessToken();
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed refreshing Google access token: ${error?.message || "unknown error"}`
    );
  }

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  const todoCalendarId = await ensureTodoCalendar(session, options);

  try {
    if (todoEventId) {
      await calendar.events.delete({
        calendarId: todoCalendarId,
        eventId: todoEventId
      });
    }

    if (syncId) {
      const primaryList = await calendar.events.list({
        calendarId: "primary",
        privateExtendedProperty: `avTodoId=${syncId}`,
        maxResults: 5
      });
      const primaryItems = Array.isArray(primaryList?.data?.items)
        ? primaryList.data.items
        : [];
      for (const item of primaryItems) {
        if (item?.id) {
          await calendar.events.delete({
            calendarId: "primary",
            eventId: item.id
          });
        }
      }
    }
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed deleting To-Do Google Calendar event: ${error?.message || "unknown error"}`
    );
  }
}
async function createGoogleEventFromSession(session, appointment) {
  if (!isGoogleConnected(session)) {
    throw new GoogleCalendarError("Google Calendar is not connected.");
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(session.googleTokens || {});
  oauth2Client.on("tokens", (tokens) => {
    setGoogleTokensOnSession(session, tokens || {});
  });

  try {
    await oauth2Client.getAccessToken();
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed refreshing Google access token: ${error?.message || "unknown error"}`
    );
  }

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  try {
    const created = await calendar.events.insert({
      calendarId: "primary",
      requestBody: buildCalendarEvent(appointment)
    });
    return created.data?.id || null;
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed creating Google Calendar event: ${error?.message || "unknown error"}`
    );
  }
}

function parseEventDateTimeParts(startValue, endValue) {
  if (startValue?.dateTime && endValue?.dateTime) {
    const start = new Date(startValue.dateTime);
    const end = new Date(endValue.dateTime);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      return { start, end };
    }
  }

  if (startValue?.date && endValue?.date) {
    const start = new Date(`${startValue.date}T00:00:00`);
    const end = new Date(`${endValue.date}T00:00:00`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      return { start, end };
    }
  }

  return null;
}

function overlapMinutes(startA, endA, startB, endB) {
  const start = Math.max(startA.getTime(), startB.getTime());
  const end = Math.min(endA.getTime(), endB.getTime());
  if (end <= start) {
    return 0;
  }
  return (end - start) / (60 * 1000);
}

async function findGoogleCalendarConflict(session, date, time, durationMinutes = 30, options = {}) {
  if (!isGoogleConnected(session)) {
    return null;
  }

  const normalizedDate = String(date || "").trim();
  const normalizedTime = String(time || "").trim();
  const meetingMinutes = Number.parseInt(String(durationMinutes || "30"), 10);
  const safeDurationMinutes =
    Number.isInteger(meetingMinutes) && meetingMinutes > 0 ? meetingMinutes : 30;
  const minimumOverlapMinutes =
    Number.parseInt(String(options.minimumOverlapMinutes || "1"), 10) || 1;
  const bufferMinutes = Number.parseInt(String(options.bufferMinutes || "0"), 10) || 0;

  const startDate = new Date(`${normalizedDate}T${normalizedTime}:00`);
  if (Number.isNaN(startDate.getTime())) {
    throw new GoogleCalendarError("Invalid date/time provided for Google conflict lookup.");
  }
  const endDate = new Date(startDate.getTime() + safeDurationMinutes * 60 * 1000);
  const queryStart = new Date(startDate.getTime() - bufferMinutes * 60 * 1000);
  const queryEnd = new Date(endDate.getTime() + bufferMinutes * 60 * 1000);
  const protectedStart = queryStart;
  const protectedEnd = queryEnd;

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(session.googleTokens || {});
  oauth2Client.on("tokens", (tokens) => {
    setGoogleTokensOnSession(session, tokens || {});
  });

  try {
    await oauth2Client.getAccessToken();
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed refreshing Google access token: ${error?.message || "unknown error"}`
    );
  }

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  try {
    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: queryStart.toISOString(),
      timeMax: queryEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 25
    });
    const items = Array.isArray(response?.data?.items) ? response.data.items : [];
    for (const item of items) {
      const eventRange = parseEventDateTimeParts(item.start, item.end);
      if (!eventRange) {
        continue;
      }

      const directOverlap = overlapMinutes(startDate, endDate, eventRange.start, eventRange.end);
      const bufferOverlap = overlapMinutes(
        protectedStart,
        protectedEnd,
        eventRange.start,
        eventRange.end
      );
      if (directOverlap >= minimumOverlapMinutes || bufferOverlap > 0) {
        return {
          id: item.id || null,
          title: item.summary || "Google Calendar event",
          start: item.start?.dateTime || item.start?.date || null,
          end: item.end?.dateTime || item.end?.date || null
        };
      }
    }

    return null;
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed checking Google Calendar conflicts: ${error?.message || "unknown error"}`
    );
  }
}

function toIsoDate(value) {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toIsoTime(value) {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  const hh = String(parsed.getHours()).padStart(2, "0");
  const mm = String(parsed.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

async function listGoogleCalendarEvents(session, options = {}) {
  if (!isGoogleConnected(session)) {
    return [];
  }

  const startIso = String(options.startIso || "").trim();
  const endIso = String(options.endIso || "").trim();
  if (!startIso || !endIso) {
    return [];
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(session.googleTokens || {});
  oauth2Client.on("tokens", (tokens) => {
    setGoogleTokensOnSession(session, tokens || {});
  });

  try {
    await oauth2Client.getAccessToken();
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed refreshing Google access token: ${error?.message || "unknown error"}`
    );
  }

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  try {
    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: startIso,
      timeMax: endIso,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: Number.parseInt(String(options.maxResults || "250"), 10) || 250
    });

    const items = Array.isArray(response?.data?.items) ? response.data.items : [];
    return items
      .map((item) => {
        const startDateTime = item?.start?.dateTime || null;
        const startDate = item?.start?.date || null;
        const date = startDateTime ? toIsoDate(startDateTime) : String(startDate || "");
        const time = startDateTime ? toIsoTime(startDateTime) : "00:00";
        if (!date) {
          return null;
        }

        return {
          id: item?.id || null,
          googleEventId: item?.id || null,
          title: String(item?.summary || "Google Calendar event"),
          date,
          time,
          location: String(item?.location || "").trim() || null,
          notes: String(item?.description || "").trim() || null,
          tags: "google_calendar",
          reminderMinutes: null,
          isRecurring: 0,
          rrule: null,
          isExternalGoogle: true,
          isHistory: false,
          isCompleted: false
        };
      })
      .filter(Boolean);
  } catch (error) {
    throw new GoogleCalendarError(
      `Failed listing Google Calendar events: ${error?.message || "unknown error"}`
    );
  }
}

module.exports = {
  validateGoogleEnv,
  hasGoogleConfig,
  isGoogleConnected,
  getGoogleAuthUrl,
  exchangeCodeForTokens,
  extractGoogleIdentityFromTokens,
  setGoogleTokensOnSession,
  clearGoogleSession,
  createGoogleEventFromSession,
  createTodoEventFromSession,
  listTodoEventsFromSession,
  parseLocalDateTime,
  deleteTodoEventFromSession,
  findGoogleCalendarConflict,
  listGoogleCalendarEvents,
  GoogleCalendarError
};
