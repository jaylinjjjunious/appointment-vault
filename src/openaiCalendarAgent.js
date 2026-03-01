const OpenAI = require("openai");

const DEFAULT_MODEL = "gpt-4.1-mini";

const TOOL_DEFINITION = {
  type: "function",
  function: {
    name: "log_appointment",
    description:
      "Log a calendar appointment with required start time and timezone. Use when the user provides a date and time.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["title", "start", "end", "timezone", "notes"],
      properties: {
        title: {
          type: "string",
          description: "Appointment title."
        },
        start: {
          type: "string",
          description: "ISO-8601 datetime string with timezone offset."
        },
        end: {
          type: ["string", "null"],
          description: "ISO-8601 datetime string with timezone offset."
        },
        timezone: {
          type: "string",
          description: "IANA timezone, e.g. America/Los_Angeles."
        },
        notes: {
          type: ["string", "null"],
          description: "Optional notes for the appointment."
        }
      }
    }
  }
};

function buildSystemPrompt(defaultTimezone) {
  return [
    "You are a calendar assistant for Appointment Vault.",
    "If the user provides a date AND time for an appointment, call the log_appointment tool.",
    "If the date or time is missing or ambiguous, ask a clarifying question instead (NO tool call).",
    "Always include a timezone.",
    "If the user omits the year, interpret month/day as the next upcoming date in that timezone (if already passed this year, use next year).",
    "If end is missing, set end to start + 30 minutes.",
    `Default timezone: ${defaultTimezone}.`,
    "Return tool call arguments as JSON."
  ].join(" ");
}

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function getModel() {
  return String(process.env.OPENAI_MODEL || "").trim() || DEFAULT_MODEL;
}

function extractTextFromResponse(response) {
  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const outputs = Array.isArray(response?.output) ? response.output : [];
  for (const item of outputs) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      const textItem = item.content.find(
        (content) => content.type === "output_text" || content.type === "text"
      );
      if (textItem?.text) {
        return String(textItem.text).trim();
      }
    }
  }

  return "";
}

function extractToolCall(response) {
  const outputs = Array.isArray(response?.output) ? response.output : [];
  const toolCall = outputs.find((item) => item?.type === "function_call");
  if (!toolCall) {
    return null;
  }

  let args = null;
  try {
    args = toolCall.arguments ? JSON.parse(toolCall.arguments) : null;
  } catch (error) {
    args = null;
  }

  return {
    call_id: toolCall.call_id,
    name: toolCall.name,
    arguments: args
  };
}

async function runCalendarAssistant(userText, timezone) {
  const client = getClient();
  const system = buildSystemPrompt(timezone);
  const response = await client.responses.create({
    model: getModel(),
    input: [
      {
        role: "system",
        content: [{ type: "text", text: system }]
      },
      {
        role: "user",
        content: [{ type: "text", text: userText }]
      }
    ],
    tools: [TOOL_DEFINITION]
  });

  const toolCall = extractToolCall(response);
  const reply = extractTextFromResponse(response);

  return {
    reply,
    toolCall,
    responseId: response.id
  };
}

async function submitCalendarToolResult(previousResponseId, callId, toolResult, timezone) {
  const client = getClient();
  const system = buildSystemPrompt(timezone);
  const response = await client.responses.create({
    model: getModel(),
    previous_response_id: previousResponseId,
    input: [
      {
        role: "system",
        content: [{ type: "text", text: system }]
      },
      {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(toolResult)
      }
    ],
    tools: [TOOL_DEFINITION]
  });

  return extractTextFromResponse(response);
}

module.exports = {
  runCalendarAssistant,
  submitCalendarToolResult
};
