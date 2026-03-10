const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const configuredDataDir = String(process.env.DATA_DIR || "").trim();
const configuredDbPath = String(process.env.DATABASE_PATH || "").trim();
const dataDir = configuredDataDir
  ? path.resolve(configuredDataDir)
  : path.join(__dirname, "..", "data");
const dbPath = configuredDbPath ? path.resolve(configuredDbPath) : path.join(dataDir, "appointments.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL DEFAULT 'google',
    providerUserId TEXT NOT NULL,
    email TEXT,
    displayName TEXT,
    passwordHash TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    emailVerifiedAt TEXT,
    lastLoginAt TEXT,
    isActive INTEGER NOT NULL DEFAULT 1,
    phoneNumber TEXT,
    timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    voiceEnabled INTEGER NOT NULL DEFAULT 1,
    smsEnabled INTEGER NOT NULL DEFAULT 1,
    quietHoursStart TEXT,
    quietHoursEnd TEXT,
    reminderStrategy TEXT NOT NULL DEFAULT 'voice_primary_sms_fallback',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider_uid
  ON users (provider, providerUserId)
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
  ON users (email)
  WHERE email IS NOT NULL
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    location TEXT,
    notes TEXT,
    tags TEXT,
    reminderMinutes INTEGER,
    googleEventId TEXT,
    isRecurring INTEGER NOT NULL DEFAULT 0,
    rrule TEXT,
    seriesId TEXT,
    occurrenceStart TEXT,
    occurrenceEnd TEXT,
    completedAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id)
  )
`);

const columnNames = db
  .prepare("PRAGMA table_info(appointments)")
  .all()
  .map((column) => column.name);

if (!columnNames.includes("googleEventId")) {
  db.exec("ALTER TABLE appointments ADD COLUMN googleEventId TEXT");
}

if (!columnNames.includes("completedAt")) {
  db.exec("ALTER TABLE appointments ADD COLUMN completedAt TEXT");
}

if (!columnNames.includes("userId")) {
  db.exec("ALTER TABLE appointments ADD COLUMN userId INTEGER");
}

if (!columnNames.includes("isRecurring")) {
  db.exec("ALTER TABLE appointments ADD COLUMN isRecurring INTEGER NOT NULL DEFAULT 0");
}

if (!columnNames.includes("rrule")) {
  db.exec("ALTER TABLE appointments ADD COLUMN rrule TEXT");
}

if (!columnNames.includes("seriesId")) {
  db.exec("ALTER TABLE appointments ADD COLUMN seriesId TEXT");
}

if (!columnNames.includes("occurrenceStart")) {
  db.exec("ALTER TABLE appointments ADD COLUMN occurrenceStart TEXT");
}

if (!columnNames.includes("occurrenceEnd")) {
  db.exec("ALTER TABLE appointments ADD COLUMN occurrenceEnd TEXT");
}

const userColumnNames = db
  .prepare("PRAGMA table_info(users)")
  .all()
  .map((column) => column.name);

if (!userColumnNames.includes("passwordHash")) {
  db.exec("ALTER TABLE users ADD COLUMN passwordHash TEXT");
}

if (!userColumnNames.includes("role")) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}

if (!userColumnNames.includes("emailVerifiedAt")) {
  db.exec("ALTER TABLE users ADD COLUMN emailVerifiedAt TEXT");
}

if (!userColumnNames.includes("lastLoginAt")) {
  db.exec("ALTER TABLE users ADD COLUMN lastLoginAt TEXT");
}

if (!userColumnNames.includes("isActive")) {
  db.exec("ALTER TABLE users ADD COLUMN isActive INTEGER NOT NULL DEFAULT 1");
}

if (!userColumnNames.includes("googleTokensJson")) {
  db.exec("ALTER TABLE users ADD COLUMN googleTokensJson TEXT");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS reminder_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    appointmentId INTEGER NOT NULL,
    remindAt TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
    twilioCallSid TEXT,
    errorMessage TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (appointmentId) REFERENCES appointments(id)
  )
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_calls_unique
  ON reminder_calls (appointmentId, remindAt)
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS reminder_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    appointmentId INTEGER,
    channel TEXT NOT NULL CHECK (channel IN ('voice', 'sms')),
    attemptNumber INTEGER NOT NULL DEFAULT 1,
    scheduledFor TEXT NOT NULL,
    startedAt TEXT,
    finishedAt TEXT,
    status TEXT NOT NULL CHECK (
      status IN (
        'queued',
        'calling',
        'voice_no_answer',
        'voice_failed',
        'sms_sent',
        'completed',
        'cancelled'
      )
    ),
    providerSid TEXT,
    errorCode TEXT,
    errorMessage TEXT,
    metadataJson TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (appointmentId) REFERENCES appointments(id)
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_reminder_attempts_due
  ON reminder_attempts (status, scheduledFor)
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_attempts_voice_unique
  ON reminder_attempts (appointmentId, channel, attemptNumber)
  WHERE appointmentId IS NOT NULL AND channel = 'voice'
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_reminder_attempts_provider_sid
  ON reminder_attempts (providerSid)
  WHERE providerSid IS NOT NULL
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_reminder_attempts_user
  ON reminder_attempts (userId, createdAt DESC)
`);

try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reminder_attempts_parent_attempt
    ON reminder_attempts (channel, json_extract(metadataJson, '$.parentAttemptId'), id DESC)
    WHERE metadataJson IS NOT NULL AND json_valid(metadataJson) = 1
  `);
} catch (error) {
  // JSON extension may be unavailable in some SQLite builds.
}

db.exec(`
  CREATE TABLE IF NOT EXISTS appointment_occurrence_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    appointmentId INTEGER NOT NULL,
    occurrenceKey TEXT NOT NULL,
    completedAt TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (appointmentId) REFERENCES appointments(id)
  )
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_occurrence_completion_unique
  ON appointment_occurrence_completions (appointmentId, occurrenceKey)
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_appointments_user_date_time
  ON appointments (userId, date, time, id)
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_appointments_open_by_date_time
  ON appointments (completedAt, date, time, userId, id)
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_occurrence_completion_user_appointment
  ON appointment_occurrence_completions (userId, appointmentId, occurrenceKey)
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS checkin_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    title TEXT,
    description TEXT,
    fileName TEXT NOT NULL,
    mimeType TEXT NOT NULL,
    sizeBytes INTEGER NOT NULL,
    fileData BLOB NOT NULL,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_checkin_documents_user
  ON checkin_documents (userId, createdAt DESC)
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS automation_integrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    siteId TEXT NOT NULL,
    targetName TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    encryptedUsername TEXT,
    encryptedPassword TEXT,
    scheduleLeadMinutes INTEGER NOT NULL DEFAULT 60,
    lastRunStatus TEXT,
    lastRunAt TEXT,
    lastSuccessAt TEXT,
    failureCount INTEGER NOT NULL DEFAULT 0,
    lastFailureMessage TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_integrations_user_site
  ON automation_integrations (userId, siteId)
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_automation_integrations_enabled
  ON automation_integrations (siteId, enabled, updatedAt DESC)
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS automation_submission_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    appointmentId INTEGER NOT NULL,
    siteId TEXT NOT NULL,
    scheduledFor TEXT NOT NULL,
    claimedAt TEXT,
    claimedBy TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
    attemptCount INTEGER NOT NULL DEFAULT 0,
    externalReference TEXT,
    failureMessage TEXT,
    auditLog TEXT,
    snapshotPath TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    completedAt TEXT,
    FOREIGN KEY (userId) REFERENCES users(id),
    FOREIGN KEY (appointmentId) REFERENCES appointments(id)
  )
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_jobs_unique_source
  ON automation_submission_jobs (userId, appointmentId, siteId)
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_automation_jobs_due
  ON automation_submission_jobs (siteId, status, scheduledFor, id)
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_automation_jobs_user_created
  ON automation_submission_jobs (userId, siteId, createdAt DESC)
`);

module.exports = db;
