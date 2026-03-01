const bcrypt = require("bcrypt");
const db = require("../db");

const selectUserByEmailStatement = db.prepare(
  "SELECT * FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1"
);

const insertLocalUserStatement = db.prepare(`
  INSERT INTO users
    (provider, providerUserId, email, displayName, passwordHash, role, emailVerifiedAt, timezone, voiceEnabled, smsEnabled, reminderStrategy, createdAt, updatedAt)
   VALUES
    (@provider, @providerUserId, @email, @displayName, @passwordHash, @role, @emailVerifiedAt, @timezone, @voiceEnabled, @smsEnabled, @reminderStrategy, @createdAt, @updatedAt)
`);

const selectUserByIdStatement = db.prepare("SELECT * FROM users WHERE id = ? LIMIT 1");

function sanitizeUser(user) {
  if (!user) {
    return null;
  }
  const next = { ...user };
  delete next.passwordHash;
  return next;
}

async function registerLocalUser(input) {
  const email = String(input.email || "").trim().toLowerCase();
  const existing = selectUserByEmailStatement.get(email);
  if (existing) {
    const error = new Error("Email already in use.");
    error.statusCode = 409;
    error.publicMessage = "Email already in use.";
    throw error;
  }

  const nowIso = new Date().toISOString();
  const passwordHash = await bcrypt.hash(String(input.password || ""), 12);
  const inserted = insertLocalUserStatement.run({
    provider: "local",
    providerUserId: `local:${email}`,
    email,
    displayName: String(input.displayName || "").trim() || email,
    passwordHash,
    role: "user",
    emailVerifiedAt: null,
    timezone: "America/Los_Angeles",
    voiceEnabled: 1,
    smsEnabled: 1,
    reminderStrategy: "voice_primary_sms_fallback",
    createdAt: nowIso,
    updatedAt: nowIso
  });

  return sanitizeUser(selectUserByIdStatement.get(inserted.lastInsertRowid));
}

async function authenticateLocalUser(emailRaw, passwordRaw) {
  const email = String(emailRaw || "").trim().toLowerCase();
  const user = selectUserByEmailStatement.get(email);
  if (!user || !user.passwordHash) {
    return null;
  }

  const ok = await bcrypt.compare(String(passwordRaw || ""), user.passwordHash);
  if (!ok) {
    return null;
  }

  return sanitizeUser(user);
}

function getUserById(userId) {
  return sanitizeUser(selectUserByIdStatement.get(userId));
}

module.exports = {
  registerLocalUser,
  authenticateLocalUser,
  getUserById,
  sanitizeUser
};