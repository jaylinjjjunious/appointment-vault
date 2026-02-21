const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "appointments.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    location TEXT,
    notes TEXT,
    tags TEXT,
    reminderMinutes INTEGER,
    googleEventId TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  )
`);

const columnNames = db
  .prepare("PRAGMA table_info(appointments)")
  .all()
  .map((column) => column.name);

if (!columnNames.includes("googleEventId")) {
  db.exec("ALTER TABLE appointments ADD COLUMN googleEventId TEXT");
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

module.exports = db;
