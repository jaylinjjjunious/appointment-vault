const { createCipheriv, createDecipheriv, createHash, randomBytes } = require("node:crypto");

const ALGORITHM = "aes-256-gcm";

function getAutomationSecretKey() {
  return String(process.env.AUTOMATION_SECRET_KEY || "").trim();
}

function hasAutomationSecretKey() {
  return Boolean(getAutomationSecretKey());
}

function deriveKey(secret) {
  return createHash("sha256").update(String(secret || "")).digest();
}

function encryptSecret(value) {
  const input = String(value || "");
  if (!input) {
    return null;
  }
  const secret = getAutomationSecretKey();
  if (!secret) {
    throw new Error("AUTOMATION_SECRET_KEY is not set.");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(input, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptSecret(value) {
  const input = String(value || "").trim();
  if (!input) {
    return "";
  }
  const secret = getAutomationSecretKey();
  if (!secret) {
    throw new Error("AUTOMATION_SECRET_KEY is not set.");
  }

  const [ivRaw, tagRaw, encryptedRaw] = input.split(".");
  if (!ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Encrypted secret is malformed.");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    deriveKey(secret),
    Buffer.from(ivRaw, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

module.exports = {
  decryptSecret,
  encryptSecret,
  hasAutomationSecretKey
};
