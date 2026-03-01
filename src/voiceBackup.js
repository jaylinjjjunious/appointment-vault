const cron = require("node-cron");
const twilio = require("twilio");
const db = require("./db");

const MESSAGE_TEXT =
  "This is your Appointment Vault. You have a high-priority probation appointment in two hours. Please stay safe and depart now.";
const TARGET_MINUTES_BEFORE = 120;

let schedulerStarted = false;
let loggedMissingEnv = false;

db.exec(`
  CREATE TABLE IF NOT EXISTS high_priority_voice_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appointmentId INTEGER NOT NULL,
    scheduledFor TEXT NOT NULL,
    callSid TEXT,
    createdAt TEXT NOT NULL,
    UNIQUE(appointmentId, scheduledFor)
  )
`);

const insertBackupCallStmt = db.prepare(
  `INSERT OR IGNORE INTO high_priority_voice_backups
    (appointmentId, scheduledFor, callSid, createdAt)
   VALUES (?, ?, ?, ?)`
);
const selectBackupCallStmt = db.prepare(
  `SELECT id
   FROM high_priority_voice_backups
   WHERE appointmentId = ? AND scheduledFor = ?
   LIMIT 1`
);

function getTwilioConfig() {
  return {
    accountSid: String(process.env.TWILIO_ACCOUNT_SID || "").trim(),
    authToken: String(process.env.TWILIO_AUTH_TOKEN || "").trim(),
    fromNumber: String(process.env.TWILIO_FROM_NUMBER || "").trim(),
    toNumber: String(process.env.CALL_TO_NUMBER || "").trim()
  };
}

function hasRequiredTwilioConfig(config = getTwilioConfig()) {
  return Boolean(config.accountSid && config.authToken && config.fromNumber && config.toNumber);
}

function getHighPrioritySelectStatement() {
  const columnNames = db
    .prepare("PRAGMA table_info(appointments)")
    .all()
    .map((column) => String(column.name || "").trim().toLowerCase());

  if (columnNames.includes("high_priority")) {
    return db.prepare(
      `SELECT id, date, time
       FROM appointments
       WHERE completedAt IS NULL
         AND high_priority = 1`
    );
  }

  return db.prepare(
    `SELECT id, date, time
     FROM appointments
     WHERE completedAt IS NULL
       AND LOWER(COALESCE(tags, '')) LIKE '%high_priority%'`
  );
}

const selectHighPriorityAppointmentsStmt = getHighPrioritySelectStatement();

function parseAppointmentDateTime(date, time) {
  const parsed = new Date(`${String(date || "").trim()}T${String(time || "").trim()}:00`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function isDueForTwoHourWarning(appointmentDateTime, now = new Date()) {
  const diffMinutes = Math.floor((appointmentDateTime.getTime() - now.getTime()) / (60 * 1000));
  return diffMinutes === TARGET_MINUTES_BEFORE;
}

function createVoiceTwiml() {
  const response = new twilio.twiml.VoiceResponse();
  response.say(MESSAGE_TEXT);
  return response.toString();
}

async function runHighPriorityVoiceBackup(now = new Date()) {
  const config = getTwilioConfig();
  if (!hasRequiredTwilioConfig(config)) {
    if (!loggedMissingEnv) {
      loggedMissingEnv = true;
      console.error(
        "[Voice Backup] Missing one or more Twilio vars (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, CALL_TO_NUMBER)."
      );
    }
    return { ok: false, sent: 0 };
  }

  const candidates = selectHighPriorityAppointmentsStmt.all();
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { ok: true, sent: 0 };
  }

  const client = twilio(config.accountSid, config.authToken);
  const twiml = createVoiceTwiml();
  let sent = 0;

  for (const appointment of candidates) {
    const appointmentDateTime = parseAppointmentDateTime(appointment.date, appointment.time);
    if (!appointmentDateTime) {
      continue;
    }

    if (!isDueForTwoHourWarning(appointmentDateTime, now)) {
      continue;
    }

    const scheduledFor = `${appointment.date}T${appointment.time}:00`;
    const existing = selectBackupCallStmt.get(appointment.id, scheduledFor);
    if (existing) {
      continue;
    }

    const call = await client.calls.create({
      from: config.fromNumber,
      to: config.toNumber,
      twiml
    });

    insertBackupCallStmt.run(
      appointment.id,
      scheduledFor,
      String(call.sid || ""),
      new Date().toISOString()
    );
    sent += 1;
  }

  return { ok: true, sent };
}

function startHighPriorityVoiceBackupScheduler() {
  if (schedulerStarted) {
    return;
  }
  schedulerStarted = true;

  cron.schedule("* * * * *", async () => {
    try {
      await runHighPriorityVoiceBackup(new Date());
    } catch (error) {
      console.error("[Voice Backup] Scheduler run failed:", error.message);
    }
  });
}

module.exports = {
  runHighPriorityVoiceBackup,
  startHighPriorityVoiceBackupScheduler
};
