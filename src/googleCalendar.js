const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/calendar"];

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

module.exports = {
  validateGoogleEnv,
  hasGoogleConfig,
  isGoogleConnected,
  getGoogleAuthUrl,
  exchangeCodeForTokens,
  setGoogleTokensOnSession,
  clearGoogleSession,
  createGoogleEventFromSession,
  GoogleCalendarError
};
