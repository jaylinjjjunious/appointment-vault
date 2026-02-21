const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

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

function getDateContext() {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const pad = (value) => String(value).padStart(2, "0");
  const currentDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const currentTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  return { timezone, currentDate, currentTime };
}

function buildMessages(text, strictRetry) {
  const { timezone, currentDate, currentTime } = getDateContext();

  const systemMessage = [
    "You convert user text into one appointment JSON object.",
    "Return ONLY valid JSON. No markdown. No backticks. No extra text.",
    "Use this schema exactly:",
    "{",
    '  "title": string,',
    '  "date": "YYYY-MM-DD",',
    '  "time": "HH:MM",',
    '  "location": string|null,',
    '  "notes": string|null,',
    '  "tags": string|null,',
    '  "reminderMinutes": number|null',
    "}",
    "Use server local timezone and date context.",
    `Server timezone: ${timezone}.`,
    `Server current date: ${currentDate}.`,
    `Server current time: ${currentTime}.`,
    "Interpret relative phrases like tomorrow, next Friday, tonight from that context.",
    "If required info is missing, return empty strings for missing required fields.",
    "Required fields are title, date, and time.",
    "If date or time is missing, include a clarification request in notes."
  ].join("\n");

  const messages = [
    { role: "system", content: systemMessage },
    { role: "user", content: text }
  ];

  if (strictRetry) {
    messages.push({
      role: "system",
      content:
        "JSON ONLY. Response must start with { and end with }. No prose."
    });
  }

  return messages;
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
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const dateCandidate = typeof raw.date === "string" ? raw.date.trim() : "";
  const timeCandidate = typeof raw.time === "string" ? raw.time.trim() : "";

  return {
    title,
    date: DATE_RE.test(dateCandidate) ? dateCandidate : "",
    time: TIME_RE.test(timeCandidate) ? timeCandidate : "",
    location: toNullableString(raw.location),
    notes: toNullableString(raw.notes),
    tags: toNullableString(raw.tags),
    reminderMinutes: toReminderMinutes(raw.reminderMinutes)
  };
}

async function callOllama(text, strictRetry) {
  const { host, model } = getAiConfig();
  const url = `${host}/api/chat`;

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: buildMessages(text, strictRetry),
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

async function parseAppointment(text) {
  const userText = String(text ?? "").trim();
  if (!userText) {
    throw new AiParseError("Please enter appointment text first.");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const strictRetry = attempt === 1;

    try {
      const rawOutput = await callOllama(userText, strictRetry);
      const jsonText = extractFirstJsonObject(rawOutput);
      const parsed = JSON.parse(jsonText);

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new JsonExtractionError("Parsed JSON was not an object.");
      }

      return normalizeAppointment(parsed);
    } catch (error) {
      const shouldRetry =
        attempt === 0 &&
        (error instanceof JsonExtractionError || error instanceof SyntaxError);

      if (shouldRetry) {
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

  throw new AiParseError(
    "I couldn't parse that into a valid appointment. Please try again with clear date and time."
  );
}

module.exports = {
  parseAppointment,
  AiParseError
};
