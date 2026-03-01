const fs = require("node:fs");
const path = require("node:path");

const srcPath = path.join(__dirname, "..", "data", "appointments.db");
const backupDir = path.join(__dirname, "..", "backups");
fs.mkdirSync(backupDir, { recursive: true });

if (!fs.existsSync(srcPath)) {
  console.error("Database file does not exist:", srcPath);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destPath = path.join(backupDir, `appointments-${stamp}.db`);
fs.copyFileSync(srcPath, destPath);
console.log("Backup written:", destPath);