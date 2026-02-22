const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const roots = [path.join(process.cwd(), "src"), path.join(process.cwd(), "scripts")];
const jsFiles = [];

function walk(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      walk(fullPath);
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".js")) {
      jsFiles.push(fullPath);
    }
  }
}

for (const root of roots) {
  walk(root);
}

if (jsFiles.length === 0) {
  console.log("No JavaScript files found to lint.");
  process.exit(0);
}

let hasFailures = false;
for (const filePath of jsFiles) {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    new vm.Script(source, { filename: filePath });
  } catch (error) {
    hasFailures = true;
    process.stderr.write(`\n[lint-lite] ${path.relative(process.cwd(), filePath)}\n`);
    process.stderr.write(`${error.message}\n`);
  }
}

if (hasFailures) {
  process.exit(1);
}

console.log(`[lint-lite] Checked ${jsFiles.length} files. No syntax errors.`);
