const { spawnSync } = require("node:child_process");

const isWindows = process.platform === "win32";
const command = "npx";
const args = ["playwright", "install"];

if (process.platform === "linux") {
  args.push("--with-deps");
}

args.push("chromium");

const result = spawnSync(command, args, {
  stdio: "inherit",
  shell: isWindows
});

if (result.error) {
  console.error("[playwright-install] failed to launch installer:", result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status || 1);
}
