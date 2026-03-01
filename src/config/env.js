const path = require("node:path");
require("dotenv").config({ quiet: true });

function toBool(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(normalized);
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

const nodeEnv = String(process.env.NODE_ENV || "development").trim() || "development";
const isProduction = nodeEnv === "production";

module.exports = {
  app: {
    env: nodeEnv,
    isProduction,
    port: toInt(process.env.PORT, 3000),
    host: String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0",
    baseUrl: String(process.env.PUBLIC_BASE_URL || "http://localhost:3000").trim() || "http://localhost:3000",
    dataDir: String(process.env.DATA_DIR || path.join(__dirname, "..", "..", "data")).trim(),
    authRequired: toBool(process.env.AUTH_REQUIRED, true)
  },
  session: {
    secret: String(process.env.SESSION_SECRET || "appointment-vault-session-secret-change-me").trim(),
    maxAgeMs: toInt(process.env.SESSION_MAX_AGE_MS, 1000 * 60 * 60 * 24 * 14)
  },
  security: {
    rateLimitWindowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    rateLimitMax: toInt(process.env.RATE_LIMIT_MAX, 300)
  },
  mail: {
    host: String(process.env.SMTP_HOST || "").trim(),
    port: toInt(process.env.SMTP_PORT, 587),
    secure: toBool(process.env.SMTP_SECURE, false),
    user: String(process.env.SMTP_USER || "").trim(),
    pass: String(process.env.SMTP_PASS || "").trim(),
    from: String(process.env.SMTP_FROM || "").trim() || "Appointment Vault <no-reply@localhost>"
  }
};