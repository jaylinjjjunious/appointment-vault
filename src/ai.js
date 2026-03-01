const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const db = require("./db");
const {
  hasGoogleConfig,
  isGoogleConnected,
  findGoogleCalendarConflict
} = require("./googleCalendar");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const HIGH_PRIORITY_RE = /\b(probation|court|po|officer)\b/i;
const DEFAULT_DURATION_MINUTES = 60;

const VAULT_DB_PATH = path.join(__dirname, "..", "data", "vault.db");
const AUDIT_LOG_PATH = path.join(__dirname, "..", "data", "audit.log");

class AiParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiParseError";
  }
}

class JsonExtractionError extends Error {
  constructor(message) {
    super(message);
    this.name = "JsonExtractionError";
  }
}

function getAiConfig() {
  const host = (process.env.OLLAMA_HOST || "http://localhost:11434").trim();
  const model = (process.env.OLLAMA_MODEL || "phi3").trim();

  return {
    host: host.replace(/\/+$/, ""),
    model
  };
}

function extractFirstJsonObject(rawText) {
  const text = String(rawText ?? "");
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (char === "}") {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          return text.slice(start, i + 1);
        }
      }
    }
  }

  throw new JsonExtractionError("No JSON object found in model output.");
}

function getDateContext() {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const pad = (value) => String(value).padStart(2, "0");
  const currentDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const currentTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return { timezone, currentDate, currentTime };
}

function toNullableString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function toReminderMinutes(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (/^\d+$/.test(normalized)) {
      return Number.parseInt(normalized, 10);
    }
  }
  return null;
}

function normalizeAppointment(raw) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const dateCandidate = typeof input.date === "string" ? input.date.trim() : "";
  const timeCandidate = typeof input.time === "string" ? input.time.trim() : "";

  return {
    title,
    date: DATE_RE.test(dateCandidate) ? dateCandidate : "",
    time: TIME_RE.test(timeCandidate) ? timeCandidate : "",
    location: toNullableString(input.location),
    notes: toNullableString(input.notes),
    tags: toNullableString(input.tags),
    reminderMinutes: toReminderMinutes(input.reminderMinutes)
  };
}

function toLocalDateTime(date, time) {
  const parsed = new Date(`${String(date || "").trim()}T${String(time || "").trim()}:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addMinutesToDate(dateObj, minutes) {
  return new Date(dateObj.getTime() + minutes * 60 * 1000);
}

function overlapMinutes(startA, endA, startB, endB) {
  const start = Math.max(startA.getTime(), startB.getTime());
  const end = Math.min(endA.getTime(), endB.getTime());
  if (end <= start) {
    return 0;
  }
  return (end - start) / (60 * 1000);
}

function formatTime(dateObj) {
  if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) {
    return "";
  }
  const hour = String(dateObj.getHours()).padStart(2, "0");
  const minute = String(dateObj.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}

function normalizeTagsList(tagsValue) {
  return String(tagsValue || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function withHighPriorityFlags(appointment) {
  const tagSet = new Set(
    normalizeTagsList(appointment?.tags).map((tag) => tag.toLowerCase())
  );
  tagSet.add("high_priority");
  tagSet.add("legal");

  return {
    ...(appointment || {}),
    tags: Array.from(tagSet).join(", ")
  };
}

function detectHighPriority(userText, appointment, history = []) {
  if (HIGH_PRIORITY_RE.test(String(userText || ""))) {
    return true;
  }

  const title = String(appointment?.title || "");
  const notes = String(appointment?.notes || "");
  if (HIGH_PRIORITY_RE.test(title) || HIGH_PRIORITY_RE.test(notes)) {
    return true;
  }

  const safeHistory = Array.isArray(history) ? history : [];
  for (const entry of safeHistory.slice(-10)) {
    const content = typeof entry?.content === "string" ? entry.content : "";
    if (HIGH_PRIORITY_RE.test(content)) {
      return true;
    }
  }

  return false;
}

function normalizeMemory(memory) {
  if (!memory || typeof memory !== "object" || Array.isArray(memory)) {
    return null;
  }
  const normalized = normalizeAppointment(memory);
  if (
    !normalized.title &&
    !normalized.date &&
    !normalized.time &&
    !normalized.location &&
    !normalized.notes &&
    !normalized.tags &&
    normalized.reminderMinutes === null
  ) {
    return null;
  }
  return normalized;
}

function mergeWithMemory(candidate, memory) {
  const base = normalizeAppointment(candidate || {});
  if (!memory) {
    return base;
  }

  return {
    title: base.title || memory.title || "",
    date: base.date || memory.date || "",
    time: base.time || memory.time || "",
    location: base.location || memory.location || null,
    notes: base.notes || memory.notes || null,
    tags: base.tags || memory.tags || null,
    reminderMinutes:
      base.reminderMinutes === null || base.reminderMinutes === undefined
        ? memory.reminderMinutes ?? null
        : base.reminderMinutes
  };
}

function addMinutes(dateString, timeString, minutesToAdd) {
  const [year, month, day] = String(dateString).split("-").map(Number);
  const [hour, minute] = String(timeString).split(":").map(Number);
  const base = new Date(year, month - 1, day, hour, minute, 0, 0);
  const next = new Date(base.getTime() + minutesToAdd * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");

  return {
    date: `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`,
    time: `${pad(next.getHours())}:${pad(next.getMinutes())}`
  };
}

async function checkAvailability(date, time, options = {}) {
  const userId = Number.parseInt(String(options.userId || ""), 10) || null;
  const isHighPriority = Boolean(options.highPriority);

  if (!DATE_RE.test(String(date || "")) || !TIME_RE.test(String(time || ""))) {
    return {
      status: "needs_info",
      message: "Valid date and time are required to check availability.",
      data: {
        requestedSlot: { date: String(date || ""), time: String(time || "") }
      }
    };
  }

  const localConflict = isHighPriority
    ? findLocalConflictForHighPriority(date, time, {
        userId,
        durationMinutes: options.durationMinutes || DEFAULT_DURATION_MINUTES,
        minimumOverlapMinutes: 1,
        bufferMinutes: 60
      })
    : queryConflictFromVaultDb(date, time, userId);
  let googleConflict = null;
  let googleCheckFailed = false;
  const googleReady = hasGoogleConfig() && isGoogleConnected(options.session);
  if (googleReady) {
    try {
      googleConflict = await findGoogleCalendarConflict(
        options.session,
        date,
        time,
        Number.parseInt(String(options.durationMinutes || DEFAULT_DURATION_MINUTES), 10) ||
          DEFAULT_DURATION_MINUTES,
        isHighPriority
          ? {
              minimumOverlapMinutes: 1,
              bufferMinutes: 60
            }
          : {}
      );
    } catch (error) {
      googleCheckFailed = true;
    }
  }

  if (isHighPriority && googleCheckFailed) {
    // Keep scheduling available using local safety checks when Google is temporarily unavailable.
  }

  if (!localConflict && !googleConflict) {
    return {
      status: "free",
      message: "Slot is available.",
      data: {
        requestedSlot: { date, time }
      }
    };
  }

  return {
    status: "busy",
    message: "Slot is already booked.",
    data: {
      requestedSlot: { date, time },
      conflicts: {
        local: localConflict
          ? {
              id: localConflict.id,
              userId: localConflict.userId,
              title: localConflict.title,
              date: localConflict.date,
              time: localConflict.time
            }
          : null,
        google: googleConflict
          ? {
              id: googleConflict.id,
              title: googleConflict.title,
              start: googleConflict.start,
              end: googleConflict.end
            }
          : null
      }
    }
  };
}

function queryConflictFromVaultDb(date, time, userId) {
  const sqlWithUser =
    `SELECT id, userId, title, date, time
     FROM appointments
     WHERE userId = ?
       AND date = ?
       AND time = ?
       AND completedAt IS NULL
     ORDER BY id DESC
     LIMIT 1`;
  const sqlAnyUser =
    `SELECT id, userId, title, date, time
     FROM appointments
     WHERE date = ?
       AND time = ?
       AND completedAt IS NULL
     ORDER BY id DESC
     LIMIT 1`;

  const queryWithDb = (database) => {
    if (!database) {
      return null;
    }
    try {
      if (userId) {
        return database.prepare(sqlWithUser).get(userId, date, time) || null;
      }
      return database.prepare(sqlAnyUser).get(date, time) || null;
    } catch (error) {
      return null;
    }
  };

  if (fs.existsSync(VAULT_DB_PATH)) {
    let vaultDb = null;
    try {
      vaultDb = new Database(VAULT_DB_PATH, { readonly: true, fileMustExist: true });
      const row = queryWithDb(vaultDb);
      if (row) {
        return row;
      }
    } catch (error) {
      // Fall through to app DB as a safe runtime fallback.
    } finally {
      if (vaultDb) {
        try {
          vaultDb.close();
        } catch (error) {
          // ignore close failures
        }
      }
    }
  }

  return queryWithDb(db);
}

function findLocalConflictForHighPriority(date, time, options = {}) {
  const userId = Number.parseInt(String(options.userId || ""), 10) || null;
  const durationMinutes =
    Number.parseInt(String(options.durationMinutes || DEFAULT_DURATION_MINUTES), 10) ||
    DEFAULT_DURATION_MINUTES;
  const minimumOverlapMinutes = Number.parseInt(String(options.minimumOverlapMinutes || "15"), 10) || 15;
  const bufferMinutes = Number.parseInt(String(options.bufferMinutes || "60"), 10) || 60;

  const requestedStart = toLocalDateTime(date, time);
  if (!requestedStart) {
    return null;
  }
  const requestedEnd = addMinutesToDate(requestedStart, durationMinutes);
  const protectedStart = addMinutesToDate(requestedStart, -bufferMinutes);
  const protectedEnd = addMinutesToDate(requestedEnd, bufferMinutes);

  const sql = userId
    ? `SELECT id, userId, title, date, time
       FROM appointments
       WHERE userId = ?
         AND completedAt IS NULL
       ORDER BY date ASC, time ASC, id ASC`
    : `SELECT id, userId, title, date, time
       FROM appointments
       WHERE completedAt IS NULL
       ORDER BY date ASC, time ASC, id ASC`;

  const queryWithDb = (database) => {
    if (!database) {
      return null;
    }

    let rows = [];
    try {
      rows = userId ? database.prepare(sql).all(userId) : database.prepare(sql).all();
    } catch (error) {
      return null;
    }

    for (const row of rows) {
      const otherStart = toLocalDateTime(row.date, row.time);
      if (!otherStart) {
        continue;
      }
      const otherEnd = addMinutesToDate(otherStart, durationMinutes);

      const directOverlap = overlapMinutes(requestedStart, requestedEnd, otherStart, otherEnd);
      const bufferOverlap = overlapMinutes(protectedStart, protectedEnd, otherStart, otherEnd);
      if (directOverlap >= minimumOverlapMinutes || bufferOverlap > 0) {
        return {
          id: row.id,
          userId: row.userId,
          title: row.title,
          date: row.date,
          time: row.time,
          overlapMinutes: directOverlap,
          violatesBuffer: bufferOverlap > 0
        };
      }
    }

    return null;
  };

  if (fs.existsSync(VAULT_DB_PATH)) {
    let vaultDb = null;
    try {
      vaultDb = new Database(VAULT_DB_PATH, { readonly: true, fileMustExist: true });
      const row = queryWithDb(vaultDb);
      if (row) {
        return row;
      }
    } catch (error) {
      // fall through to app DB
    } finally {
      if (vaultDb) {
        try {
          vaultDb.close();
        } catch (error) {
          // ignore
        }
      }
    }
  }

  return queryWithDb(db);
}

async function check_availability(date, time, options = {}) {
  return checkAvailability(date, time, options);
}

async function getNextAvailableSlots(date, time, options = {}) {
  const count = Number.parseInt(String(options.count || "2"), 10) || 2;
  const targetDate = String(date || "").trim();
  const targetTime = String(time || "").trim();
  if (!DATE_RE.test(targetDate) || !TIME_RE.test(targetTime)) {
    return [];
  }

  const suggestions = [];
  let cursor = { date: targetDate, time: targetTime };

  // Only suggest later windows on the same date.
  for (let i = 0; i < 48 && suggestions.length < count; i += 1) {
    cursor = addMinutes(cursor.date, cursor.time, 30);
    if (cursor.date !== targetDate) {
      break;
    }
    const availability = await checkAvailability(targetDate, cursor.time, options);
    if (availability.status === "free") {
      suggestions.push({ date: targetDate, time: cursor.time });
    }
  }

  return suggestions;
}

function extractAppointmentFromHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  if (entry.appointment && typeof entry.appointment === "object") {
    return normalizeAppointment(entry.appointment);
  }

  if (entry.data?.appointment && typeof entry.data.appointment === "object") {
    return normalizeAppointment(entry.data.appointment);
  }

  if (typeof entry.content === "string") {
    try {
      const parsedContent = JSON.parse(extractFirstJsonObject(entry.content));
      if (parsedContent?.data?.appointment) {
        return normalizeAppointment(parsedContent.data.appointment);
      }
      if (parsedContent?.appointment) {
        return normalizeAppointment(parsedContent.appointment);
      }
    } catch (error) {
      return null;
    }
  }

  return null;
}

function buildMemoryFromHistory(history, explicitMemory = null) {
  const safeHistory = Array.isArray(history) ? history : [];
  let memory = normalizeMemory(explicitMemory) || null;

  for (const entry of safeHistory) {
    const fromEntry = extractAppointmentFromHistoryEntry(entry);
    if (fromEntry) {
      memory = mergeWithMemory(fromEntry, memory);
    }
  }

  return memory;
}

function buildReasoningMessages(userText, history, memory) {
  const { timezone, currentDate, currentTime } = getDateContext();
  const safeHistory = Array.isArray(history) ? history : [];

  const historyText = safeHistory
    .slice(-12)
    .map((entry) => {
      const role = String(entry?.role || "user").toLowerCase();
      const content =
        typeof entry?.content === "string" ? entry.content : JSON.stringify(entry?.content || "");
      return `${role}: ${content}`;
    })
    .join("\n");

  const system = [
    "You are a scheduling agent running a reasoning loop with tools.",
    "First think privately, then output only one JSON object.",
    "If the user asks to create or modify an appointment, you MUST call tool check_availability(date, time).",
    "Tool contract: check_availability(date, time) -> busy|free.",
    "If user references prior context (example: 'make it 3 PM instead'), preserve missing details from memory.",
    "Return schema exactly:",
    "{",
    '  "thought": string,',
    '  "appointment": {',
    '    "title": string,',
    '    "date": "YYYY-MM-DD",',
    '    "time": "HH:MM",',
    '    "location": string|null,',
    '    "notes": string|null,',
    '    "tags": string|null,',
    '    "reminderMinutes": number|null',
    "  },",
    '  "tool_call": null | {',
    '    "name": "check_availability",',
    '    "arguments": { "date": "YYYY-MM-DD", "time": "HH:MM" }',
    "  },",
    '  "needs_info": string[]',
    "}",
    "Output JSON only.",
    `Timezone: ${timezone}.`,
    `Current date: ${currentDate}.`,
    `Current time: ${currentTime}.`,
    `Memory: ${JSON.stringify(memory || {}, null, 2)}`,
    `History:\n${historyText || "(none)"}`
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: userText }
  ];
}

async function callOllamaWithMessages(messages, strictRetry = false) {
  const { host, model } = getAiConfig();
  const url = `${host}/api/chat`;

  const requestMessages = Array.isArray(messages) ? [...messages] : [];
  if (strictRetry) {
    requestMessages.push({
      role: "system",
      content: "JSON ONLY. Response must start with { and end with }."
    });
  }

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: requestMessages,
        stream: false
      })
    });
  } catch (error) {
    throw new AiParseError(
      `Could not connect to Ollama at ${host}. Make sure Ollama is running.`
    );
  }

  if (!response.ok) {
    const failureText = await response.text();
    throw new AiParseError(
      `Ollama request failed (${response.status}): ${failureText.slice(0, 250)}`
    );
  }

  const payload = await response.json();
  const content = payload?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new JsonExtractionError("Model returned an empty response.");
  }

  return content;
}

function getMissingRequiredFields(appointment) {
  const missing = [];
  if (!appointment.title) {
    missing.push("title");
  }
  if (!appointment.date) {
    missing.push("date");
  }
  if (!appointment.time) {
    missing.push("time");
  }
  return missing;
}

function buildNeedsInfoMessage(missing) {
  if (!Array.isArray(missing) || missing.length === 0) {
    return "I need more details before saving this appointment.";
  }
  if (missing.length === 1) {
    return `I still need the ${missing[0]}.`;
  }
  return `I still need ${missing.join(" and ")}.`;
}

function buildConflictMessage(conflicts, suggestions, options = {}) {
  if (options.highPriority) {
    const conflictTime =
      conflicts?.local?.time ||
      (conflicts?.google?.start ? formatTime(new Date(conflicts.google.start)) : "this time");
    return `This is a probation appointment. You have a conflict nearby at ${conflictTime}. I am blocking this slot until you clear that conflict to ensure you aren't late.`;
  }

  const localConflict = conflicts?.local || null;
  const googleConflict = conflicts?.google || null;
  const title = localConflict?.title || googleConflict?.title || "another appointment";
  const date = localConflict?.date || "this date";
  const time = localConflict?.time || "this time";
  const prefix = `That slot is already taken by "${title}" on ${date} at ${time}.`;

  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return `${prefix} Please pick another time.`;
  }

  const suggestionText = suggestions.map((slot) => `${slot.date} ${slot.time}`).join(" or ");
  return `${prefix} Next available slots: ${suggestionText}.`;
}

function appendHighPriorityAuditLog(appointment, options = {}) {
  const nowIso = new Date().toISOString();
  const safeAppointment = appointment || {};
  const userId = Number.parseInt(String(options.userId || ""), 10) || null;
  const line = JSON.stringify({
    timestamp: nowIso,
    event: "high_priority_booked",
    userId,
    title: String(safeAppointment.title || ""),
    date: String(safeAppointment.date || ""),
    time: String(safeAppointment.time || ""),
    priority: "high",
    category: "legal"
  });

  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_LOG_PATH, `${line}\n`, "utf8");
  } catch (error) {
    // Do not block scheduling on log write failures.
  }
}

function isHighPriorityAppointment(appointment, userText = "", history = []) {
  const safeAppointment =
    appointment && typeof appointment === "object" && !Array.isArray(appointment)
      ? appointment
      : {};
  const tagSet = new Set(
    normalizeTagsList(safeAppointment.tags).map((tag) => tag.toLowerCase())
  );
  if (tagSet.has("high_priority") || tagSet.has("legal")) {
    return true;
  }
  return detectHighPriority(userText, safeAppointment, history);
}

async function processRequest(text, history = [], options = {}) {
  const userText = String(text ?? "").trim();
  if (!userText) {
    throw new AiParseError("Please enter appointment text first.");
  }

  const memory = buildMemoryFromHistory(history, options.memory);
  const reasoningMessages = buildReasoningMessages(userText, history, memory);

  let parsed;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const output = await callOllamaWithMessages(reasoningMessages, attempt === 1);
      parsed = JSON.parse(extractFirstJsonObject(output));
      break;
    } catch (error) {
      const retryable =
        attempt === 0 &&
        (error instanceof JsonExtractionError || error instanceof SyntaxError);
      if (retryable) {
        continue;
      }
      if (error instanceof AiParseError) {
        throw error;
      }
      throw new AiParseError(
        "I couldn't parse that into a valid appointment. Please try again with clear date and time."
      );
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AiParseError(
      "I couldn't parse that into a valid appointment. Please try again with clear date and time."
    );
  }

  const mergedAppointment = mergeWithMemory(parsed.appointment || {}, memory);
  const isHighPriority = detectHighPriority(userText, mergedAppointment, history);
  const flaggedAppointment = isHighPriority
    ? withHighPriorityFlags(mergedAppointment)
    : mergedAppointment;
  const missingFields = getMissingRequiredFields(mergedAppointment);
  if (missingFields.length > 0) {
    return {
      status: "needs_info",
      message: buildNeedsInfoMessage(missingFields),
      data: {
        appointment: flaggedAppointment,
        missingFields,
        memory: flaggedAppointment,
        highPriority: isHighPriority,
        priority: isHighPriority ? "high" : null,
        category: isHighPriority ? "legal" : null,
        thought: String(parsed.thought || "")
      }
    };
  }

  const requestedToolCall = parsed.tool_call && typeof parsed.tool_call === "object" ? parsed.tool_call : null;
  const shouldCheckAvailability = Boolean(mergedAppointment.date && mergedAppointment.time);

  let toolResult = null;
  if (shouldCheckAvailability) {
    const toolDate =
      requestedToolCall?.name === "check_availability"
        ? String(requestedToolCall?.arguments?.date || mergedAppointment.date).trim()
        : mergedAppointment.date;
    const toolTime =
      requestedToolCall?.name === "check_availability"
        ? String(requestedToolCall?.arguments?.time || mergedAppointment.time).trim()
        : mergedAppointment.time;

    toolResult = await check_availability(toolDate, toolTime, {
      userId: options.userId,
      session: options.session || null,
      durationMinutes: DEFAULT_DURATION_MINUTES,
      highPriority: isHighPriority
    });
  }

  if (toolResult?.status === "busy") {
    const suggestions = await getNextAvailableSlots(flaggedAppointment.date, flaggedAppointment.time, {
      userId: options.userId,
      session: options.session || null,
      highPriority: isHighPriority,
      count: 2
    });

    return {
      status: "conflict",
      message: buildConflictMessage(toolResult.data?.conflicts || null, suggestions, {
        highPriority: isHighPriority
      }),
      data: {
        appointment: flaggedAppointment,
        conflict: toolResult.data?.conflicts || null,
        suggestions,
        memory: flaggedAppointment,
        highPriority: isHighPriority,
        priority: isHighPriority ? "high" : null,
        category: isHighPriority ? "legal" : null,
        thought: String(parsed.thought || ""),
        tool: {
          name: "check_availability",
          arguments: {
            date: flaggedAppointment.date,
            time: flaggedAppointment.time
          },
          result: toolResult
        }
      }
    };
  }

  return {
    status: "success",
    message: "Appointment is available and ready to save.",
    data: {
      appointment: flaggedAppointment,
      memory: flaggedAppointment,
      highPriority: isHighPriority,
      priority: isHighPriority ? "high" : null,
      category: isHighPriority ? "legal" : null,
      thought: String(parsed.thought || ""),
      tool: {
        name: "check_availability",
        arguments: {
          date: flaggedAppointment.date,
          time: flaggedAppointment.time
        },
        result: toolResult || null
      }
    }
  };
}

async function parseAppointment(text, options = {}) {
  const history = Array.isArray(options.history) ? options.history : [];
  const result = await processRequest(text, history, options);

  const appointment = normalizeAppointment(result?.data?.appointment || {});
  const memory = normalizeAppointment(result?.data?.memory || appointment);

  if (result.status === "success") {
    return {
      action: "save",
      status: "ready",
      message: result.message,
      appointment,
      conflict: null,
      memory
    };
  }

  if (result.status === "conflict") {
    const localConflict = result?.data?.conflict?.local || null;
    return {
      action: "ask_clarification",
      status: "conflict",
      message: result.message,
      appointment,
      conflict: {
        requestedSlot: { date: appointment.date, time: appointment.time },
        existing: localConflict || result?.data?.conflict?.google || null,
        sources: result?.data?.conflict || null,
        suggestions: Array.isArray(result?.data?.suggestions) ? result.data.suggestions : []
      },
      memory
    };
  }

  return {
    action: "ask_clarification",
    status: "needs_clarification",
    message: result.message,
    appointment,
    conflict: null,
    memory
  };
}

module.exports = {
  processRequest,
  parseAppointment,
  check_availability,
  checkAvailability,
  appendHighPriorityAuditLog,
  isHighPriorityAppointment,
  AiParseError
};
