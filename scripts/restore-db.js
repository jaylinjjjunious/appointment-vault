const fs = require("node:fs");
const path = require("node:path");

const input = String(process.argv[2] || "").trim();
if (!input) {
  console.error("Usage: node scripts/restore-db.js <backup-file-path>");
  process.exit(1);
}

const srcPath = path.resolve(input);
const destPath = path.join(__dirname, "..", "data", "appointments.db");

if (!fs.existsSync(srcPath)) {
  console.error("Backup file does not exist:", srcPath);
  process.exit(1);
}

fs.copyFileSync(srcPath, destPath);
console.log("Database restored from:", srcPath);