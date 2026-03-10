require("dotenv").config({ quiet: true });

const { getAutomationConfig, runAutomationWorkerCycle } = require("./automation/service");

async function main() {
  const config = getAutomationConfig();
  const claimedBy = String(process.env.RENDER_INSTANCE_ID || process.pid || "automation-worker");

  const runOnce = async () => {
    try {
      const result = await runAutomationWorkerCycle({ claimedBy });
      console.log("[automation-worker] cycle complete:", result);
    } catch (error) {
      console.error("[automation-worker] cycle failed:", error?.message || error);
    }
  };

  await runOnce();
  setInterval(runOnce, config.workerIntervalMs);
}

main().catch((error) => {
  console.error("[automation-worker] fatal:", error?.message || error);
  process.exitCode = 1;
});
