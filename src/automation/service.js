const db = require("../db");
const {
  DEFAULT_SITE_ID,
  DEFAULT_TARGET_NAME,
  getAutomationConfig,
  getMissingAutomationConfigKeys,
  hasAutomationTargetConfig,
  parseBoolean,
  parseInteger
} = require("./config");
const { decryptSecret, encryptSecret, hasAutomationSecretKey } = require("./crypto");
const { createSingleSiteAdapter } = require("./siteAdapter");

const selectIntegrationByUserStatement = db.prepare(
  `SELECT *
   FROM automation_integrations
   WHERE userId = ? AND siteId = ?
   LIMIT 1`
);
const selectEnabledIntegrationsStatement = db.prepare(
  `SELECT *
   FROM automation_integrations
   WHERE siteId = ? AND enabled = 1`
);
const upsertIntegrationStatement = db.prepare(`
  INSERT INTO automation_integrations (
    userId,
    siteId,
    targetName,
    enabled,
    encryptedUsername,
    encryptedPassword,
    scheduleLeadMinutes,
    lastRunStatus,
    lastRunAt,
    lastSuccessAt,
    failureCount,
    lastFailureMessage,
    createdAt,
    updatedAt
  ) VALUES (
    @userId,
    @siteId,
    @targetName,
    @enabled,
    @encryptedUsername,
    @encryptedPassword,
    @scheduleLeadMinutes,
    @lastRunStatus,
    @lastRunAt,
    @lastSuccessAt,
    @failureCount,
    @lastFailureMessage,
    @createdAt,
    @updatedAt
  )
  ON CONFLICT(userId, siteId) DO UPDATE SET
    targetName = excluded.targetName,
    enabled = excluded.enabled,
    encryptedUsername = excluded.encryptedUsername,
    encryptedPassword = excluded.encryptedPassword,
    scheduleLeadMinutes = excluded.scheduleLeadMinutes,
    updatedAt = excluded.updatedAt
`);
const updateIntegrationRunStatusStatement = db.prepare(`
  UPDATE automation_integrations
     SET lastRunStatus = ?,
         lastRunAt = ?,
         lastSuccessAt = COALESCE(?, lastSuccessAt),
         failureCount = ?,
         lastFailureMessage = ?,
         updatedAt = ?
   WHERE userId = ? AND siteId = ?
`);
const updateIntegrationRunLogStatement = db.prepare(`
  UPDATE automation_integrations
     SET currentRunLog = ?,
         lastRunLog = ?,
         currentRunSnapshotPath = ?,
         lastRunSnapshotPath = ?,
         updatedAt = ?
   WHERE userId = ? AND siteId = ?
`);
const selectJobsForUserStatement = db.prepare(
  `SELECT *
   FROM automation_submission_jobs
   WHERE userId = ? AND siteId = ?
   ORDER BY createdAt DESC
   LIMIT ?`
);
const cancelPendingJobsForUserStatement = db.prepare(`
  UPDATE automation_submission_jobs
     SET status = 'cancelled',
         updatedAt = ?
   WHERE userId = ?
     AND siteId = ?
     AND status IN ('pending', 'running')
`);
const selectNextJobForUserStatement = db.prepare(
  `SELECT *
   FROM automation_submission_jobs
   WHERE userId = ? AND siteId = ? AND status IN ('pending', 'running')
   ORDER BY scheduledFor ASC, id ASC
   LIMIT 1`
);
const selectEligibleAppointmentsForUserStatement = db.prepare(
  `SELECT *
   FROM appointments
   WHERE userId = ?
     AND completedAt IS NULL
     AND COALESCE(isRecurring, 0) = 0
     AND date >= ?
     AND date <= ?
   ORDER BY date ASC, time ASC, id ASC`
);
const upsertJobStatement = db.prepare(`
  INSERT INTO automation_submission_jobs (
    userId,
    appointmentId,
    siteId,
    scheduledFor,
    status,
    attemptCount,
    externalReference,
    failureMessage,
    auditLog,
    createdAt,
    updatedAt
  ) VALUES (
    @userId,
    @appointmentId,
    @siteId,
    @scheduledFor,
    @status,
    @attemptCount,
    @externalReference,
    @failureMessage,
    @auditLog,
    @createdAt,
    @updatedAt
  )
  ON CONFLICT(userId, appointmentId, siteId) DO UPDATE SET
    scheduledFor = CASE
      WHEN automation_submission_jobs.status = 'succeeded'
        THEN automation_submission_jobs.scheduledFor
      ELSE excluded.scheduledFor
    END,
    status = CASE
      WHEN automation_submission_jobs.status = 'succeeded'
        THEN automation_submission_jobs.status
      ELSE 'pending'
    END,
    failureMessage = CASE
      WHEN automation_submission_jobs.status = 'succeeded'
        THEN automation_submission_jobs.failureMessage
      ELSE NULL
    END,
    claimedAt = CASE
      WHEN automation_submission_jobs.status = 'succeeded'
        THEN automation_submission_jobs.claimedAt
      ELSE NULL
    END,
    claimedBy = CASE
      WHEN automation_submission_jobs.status = 'succeeded'
        THEN automation_submission_jobs.claimedBy
      ELSE NULL
    END,
    updatedAt = excluded.updatedAt
`);
const claimDueJobStatement = db.prepare(`
  UPDATE automation_submission_jobs
     SET status = 'running',
         claimedAt = @claimedAt,
         claimedBy = @claimedBy,
         attemptCount = attemptCount + 1,
         updatedAt = @claimedAt
   WHERE id = @id
     AND status = 'pending'
`);
const selectDueJobStatement = db.prepare(
  `SELECT *
   FROM automation_submission_jobs
   WHERE siteId = ?
     AND status = 'pending'
     AND scheduledFor <= ?
   ORDER BY scheduledFor ASC, id ASC
   LIMIT 1`
);
const selectJobByIdStatement = db.prepare(
  `SELECT *
   FROM automation_submission_jobs
   WHERE id = ?`
);
const selectAppointmentForJobStatement = db.prepare(
  `SELECT *
   FROM appointments
   WHERE id = ? AND userId = ?`
);
const completeJobStatement = db.prepare(`
  UPDATE automation_submission_jobs
     SET status = @status,
         externalReference = @externalReference,
         failureMessage = @failureMessage,
         auditLog = @auditLog,
         snapshotPath = @snapshotPath,
         completedAt = @completedAt,
         updatedAt = @updatedAt
   WHERE id = @id
`);

function getSiteIdentity() {
  const config = getAutomationConfig();
  return {
    siteId: config.siteId || DEFAULT_SITE_ID,
    targetName: config.targetName || DEFAULT_TARGET_NAME
  };
}

function normalizeIsoFromAppointment(appointment) {
  const date = String(appointment?.date || "").trim();
  const time = String(appointment?.time || "").trim();
  if (!date || !time) {
    return null;
  }
  const parsed = new Date(`${date}T${time}:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildJobAuditLog(entries) {
  return JSON.stringify(
    entries.map((entry) => ({
      at: new Date().toISOString(),
      message: String(entry || "")
    }))
  );
}

function parseRunLog(rawValue) {
  try {
    const parsed = JSON.parse(String(rawValue || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function buildRunLogEntry(message) {
  return {
    at: new Date().toISOString(),
    message: String(message || "").trim()
  };
}

function listAutomationJobsForUser(userId, limit = 12) {
  if (!userId) {
    return [];
  }
  const { siteId } = getSiteIdentity();
  return selectJobsForUserStatement.all(userId, siteId, Math.max(limit, 1));
}

function getUserAutomationIntegrationRow(userId) {
  if (!userId) {
    return null;
  }
  const { siteId } = getSiteIdentity();
  return selectIntegrationByUserStatement.get(userId, siteId) || null;
}

function toViewIntegration(row) {
  const config = getAutomationConfig();
  const integration = row || null;
  const nextJob = integration
    ? selectNextJobForUserStatement.get(integration.userId, integration.siteId)
    : null;
  return {
    configured: hasAutomationTargetConfig(config) && hasAutomationSecretKey(),
    targetName: config.targetName || DEFAULT_TARGET_NAME,
    siteId: config.siteId || DEFAULT_SITE_ID,
    missingConfigKeys: [
      ...getMissingAutomationConfigKeys(config),
      ...(hasAutomationSecretKey() ? [] : ["AUTOMATION_SECRET_KEY"])
    ],
    enabled: integration ? Number(integration.enabled) === 1 : false,
    scheduleLeadMinutes: integration
      ? Number(integration.scheduleLeadMinutes || config.defaultLeadMinutes)
      : config.defaultLeadMinutes,
    username: "",
    hasStoredCredentials: Boolean(
      integration && integration.encryptedUsername && integration.encryptedPassword
    ),
    lastRunStatus: integration?.lastRunStatus || "",
    lastRunAt: integration?.lastRunAt || "",
    lastSuccessAt: integration?.lastSuccessAt || "",
    failureCount: Number(integration?.failureCount || 0),
    lastFailureMessage: integration?.lastFailureMessage || "",
    currentRunLog: parseRunLog(integration?.currentRunLog),
    lastRunLog: parseRunLog(integration?.lastRunLog),
    hasCurrentRunSnapshot: Boolean(integration?.currentRunSnapshotPath),
    hasLastRunSnapshot: Boolean(integration?.lastRunSnapshotPath),
    nextRunAt: nextJob?.scheduledFor || "",
    jobs: integration ? listAutomationJobsForUser(integration.userId) : []
  };
}

function getUserAutomationView(userId) {
  return toViewIntegration(getUserAutomationIntegrationRow(userId));
}

function saveUserAutomationIntegration(userId, input = {}) {
  if (!userId) {
    throw new Error("User is required.");
  }

  const config = getAutomationConfig();
  if (!hasAutomationTargetConfig(config)) {
    throw new Error("Automation target is not configured on this server.");
  }
  if (!hasAutomationSecretKey()) {
    throw new Error("AUTOMATION_SECRET_KEY is not configured on this server.");
  }

  const existing = getUserAutomationIntegrationRow(userId);
  const nextUsername = String(input.username || "").trim();
  const nextPassword = String(input.password || "").trim();
  const enabled = parseBoolean(input.enabled, false);
  const clearSavedCredentials = parseBoolean(input.clearSavedCredentials, false);
  const scheduleLeadMinutes = Math.max(
    parseInteger(input.scheduleLeadMinutes, config.defaultLeadMinutes),
    0
  );

  const encryptedUsername = clearSavedCredentials
    ? null
    : nextUsername
      ? encryptSecret(nextUsername)
      : existing?.encryptedUsername || null;
  const encryptedPassword = clearSavedCredentials
    ? null
    : nextPassword
      ? encryptSecret(nextPassword)
      : existing?.encryptedPassword || null;

  if (enabled && (!encryptedUsername || !encryptedPassword)) {
    throw new Error("Save target-site credentials before enabling automation.");
  }

  const nowIso = new Date().toISOString();
  const { siteId, targetName } = getSiteIdentity();
  upsertIntegrationStatement.run({
    userId,
    siteId,
    targetName,
    enabled: enabled ? 1 : 0,
    encryptedUsername,
    encryptedPassword,
    scheduleLeadMinutes,
    lastRunStatus: existing?.lastRunStatus || "",
    lastRunAt: existing?.lastRunAt || null,
    lastSuccessAt: existing?.lastSuccessAt || null,
    failureCount: Number(existing?.failureCount || 0),
    lastFailureMessage: existing?.lastFailureMessage || null,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso
  });

  if (enabled) {
    syncAutomationJobsForUser(userId);
  } else {
    cancelPendingJobsForUserStatement.run(nowIso, userId, siteId);
  }

  return getUserAutomationView(userId);
}

function getIntegrationCredentials(integration) {
  if (!integration?.encryptedUsername || !integration?.encryptedPassword) {
    throw new Error("Automation credentials are not saved.");
  }
  return {
    username: decryptSecret(integration.encryptedUsername),
    password: decryptSecret(integration.encryptedPassword)
  };
}

function syncAutomationJobsForUser(userId) {
  const integration = getUserAutomationIntegrationRow(userId);
  if (!integration || Number(integration.enabled) !== 1) {
    return 0;
  }

  const config = getAutomationConfig();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + config.horizonDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const appointments = selectEligibleAppointmentsForUserStatement.all(userId, today, horizon);
  const scheduleLeadMinutes = Math.max(
    Number(integration.scheduleLeadMinutes || config.defaultLeadMinutes),
    0
  );
  let touched = 0;

  for (const appointment of appointments) {
    const appointmentDate = normalizeIsoFromAppointment(appointment);
    if (!appointmentDate) {
      continue;
    }
    const scheduled = new Date(
      Math.max(appointmentDate.getTime() - scheduleLeadMinutes * 60 * 1000, now.getTime())
    );
    const nowIso = new Date().toISOString();
    upsertJobStatement.run({
      userId,
      appointmentId: appointment.id,
      siteId: integration.siteId,
      scheduledFor: scheduled.toISOString(),
      status: "pending",
      attemptCount: 0,
      externalReference: null,
      failureMessage: null,
      auditLog: buildJobAuditLog([
        `Queued from appointment ${appointment.id} for ${integration.targetName}.`
      ]),
      createdAt: nowIso,
      updatedAt: nowIso
    });
    touched += 1;
  }

  return touched;
}

function getAppointmentAutomationStatusMap(userId, appointmentIds = []) {
  if (!userId || !Array.isArray(appointmentIds) || appointmentIds.length === 0) {
    return {};
  }
  const { siteId } = getSiteIdentity();
  const uniqueIds = [...new Set(appointmentIds.filter(Boolean).map((value) => Number(value)))].filter(
    Number.isInteger
  );
  if (uniqueIds.length === 0) {
    return {};
  }
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT appointmentId, status, scheduledFor, completedAt, failureMessage
       FROM automation_submission_jobs
       WHERE userId = ? AND siteId = ? AND appointmentId IN (${placeholders})`
    )
    .all(userId, siteId, ...uniqueIds);
  return rows.reduce((accumulator, row) => {
    accumulator[row.appointmentId] = {
      status: row.status,
      scheduledFor: row.scheduledFor,
      completedAt: row.completedAt || "",
      failureMessage: row.failureMessage || ""
    };
    return accumulator;
  }, {});
}

function attachAutomationStatus(appointments = [], statusMap = {}) {
  return appointments.map((appointment) => ({
    ...appointment,
    automationStatus: statusMap[appointment.id] || null
  }));
}

async function runAutomationLoginTest(userId, handlers = {}) {
  const integration = getUserAutomationIntegrationRow(userId);
  if (!integration) {
    throw new Error("Save automation settings first.");
  }
  const adapter = createSingleSiteAdapter(getAutomationConfig());
  return adapter.run({
    credentials: getIntegrationCredentials(integration),
    payload: {},
    dryRun: true,
    onProgress: typeof handlers.onProgress === "function" ? handlers.onProgress : () => {},
    onSnapshot: typeof handlers.onSnapshot === "function" ? handlers.onSnapshot : () => {}
  });
}

async function runAutomationSubmissionDryRun(userId, handlers = {}) {
  const integration = getUserAutomationIntegrationRow(userId);
  if (!integration) {
    throw new Error("Save automation settings first.");
  }

  const today = new Date().toISOString().slice(0, 10);
  const appointment = selectEligibleAppointmentsForUserStatement.all(userId, today, "9999-12-31")[0] || null;
  if (!appointment) {
    throw new Error("No eligible appointments found for a dry run.");
  }

  const adapter = createSingleSiteAdapter(getAutomationConfig());
  const { payload, missingFields } = adapter.buildPayloadFromAppointment(appointment);
  if (missingFields.length > 0) {
    throw new Error(`Dry run blocked. Missing fields: ${missingFields.join(", ")}`);
  }
  return adapter.run({
    credentials: getIntegrationCredentials(integration),
    payload,
    dryRun: true,
    onProgress: typeof handlers.onProgress === "function" ? handlers.onProgress : () => {},
    onSnapshot: typeof handlers.onSnapshot === "function" ? handlers.onSnapshot : () => {}
  });
}

const claimDueJob = db.transaction((claimedBy) => {
  const { siteId } = getSiteIdentity();
  const nowIso = new Date().toISOString();
  const nextJob = selectDueJobStatement.get(siteId, nowIso);
  if (!nextJob) {
    return null;
  }
  const result = claimDueJobStatement.run({
    id: nextJob.id,
    claimedAt: nowIso,
    claimedBy
  });
  if (result.changes !== 1) {
    return null;
  }
  return selectJobByIdStatement.get(nextJob.id) || null;
});

function updateIntegrationRunStatus(userId, status, failureMessage = "", successAt = null) {
  const integration = getUserAutomationIntegrationRow(userId);
  if (!integration) {
    return;
  }
  const nowIso = new Date().toISOString();
  const nextFailureCount =
    status === "failed" ? Number(integration.failureCount || 0) + 1 : Number(integration.failureCount || 0);
  updateIntegrationRunStatusStatement.run(
    status,
    nowIso,
    successAt,
    status === "succeeded" ? 0 : nextFailureCount,
    failureMessage || null,
    nowIso,
    userId,
    integration.siteId
  );
}

function updateIntegrationRunLog(
  userId,
  currentRunLog,
  lastRunLog,
  currentRunSnapshotPath = undefined,
  lastRunSnapshotPath = undefined
) {
  const integration = getUserAutomationIntegrationRow(userId);
  if (!integration) {
    return;
  }
  const nowIso = new Date().toISOString();
  updateIntegrationRunLogStatement.run(
    currentRunLog === undefined
      ? integration.currentRunLog || null
      : currentRunLog === null
        ? null
        : JSON.stringify(currentRunLog || []),
    lastRunLog === undefined
      ? integration.lastRunLog || null
      : lastRunLog === null
        ? null
        : JSON.stringify(lastRunLog || []),
    currentRunSnapshotPath === undefined
      ? integration.currentRunSnapshotPath || null
      : currentRunSnapshotPath,
    lastRunSnapshotPath === undefined ? integration.lastRunSnapshotPath || null : lastRunSnapshotPath,
    nowIso,
    userId,
    integration.siteId
  );
}

function startIntegrationRunLog(userId, initialMessage) {
  const entries = [buildRunLogEntry(initialMessage)];
  updateIntegrationRunLog(userId, entries, null, null, null);
  return entries;
}

function appendIntegrationRunLog(userId, currentEntries, message) {
  const nextEntries = [...(currentEntries || []), buildRunLogEntry(message)];
  updateIntegrationRunLog(userId, nextEntries, null);
  return nextEntries;
}

function updateIntegrationRunSnapshot(userId, snapshotPath) {
  updateIntegrationRunLog(userId, undefined, undefined, snapshotPath || null, undefined);
}

function finalizeIntegrationRunLog(userId, currentEntries, finalMessage = "", snapshotPath = undefined) {
  const nextEntries = finalMessage
    ? [...(currentEntries || []), buildRunLogEntry(finalMessage)]
    : [...(currentEntries || [])];
  updateIntegrationRunLog(userId, null, nextEntries, null, snapshotPath);
  return nextEntries;
}

function runDetached(promiseFactory) {
  setTimeout(() => {
    Promise.resolve()
      .then(() => promiseFactory())
      .catch((error) => {
        console.error("[automation] detached run failed:", error?.message || error);
      });
  }, 0);
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function createRunObservers(userId, initialMessage) {
  let currentRunLog = startIntegrationRunLog(userId, initialMessage);
  let latestSnapshotPath = "";
  return {
    onProgress(message) {
      currentRunLog = appendIntegrationRunLog(userId, currentRunLog, message);
    },
    onSnapshot(snapshotPath) {
      if (snapshotPath) {
        latestSnapshotPath = snapshotPath;
        updateIntegrationRunSnapshot(userId, snapshotPath);
      }
    },
    onComplete(message, snapshotPath = undefined) {
      finalizeIntegrationRunLog(userId, currentRunLog, message, snapshotPath || latestSnapshotPath || null);
    },
    onFailure(message, snapshotPath = undefined) {
      finalizeIntegrationRunLog(userId, currentRunLog, message, snapshotPath || latestSnapshotPath || null);
    }
  };
}

function startAutomationLoginTest(userId) {
  const integration = getUserAutomationIntegrationRow(userId);
  if (!integration) {
    throw new Error("Save automation settings first.");
  }

  const config = getAutomationConfig();
  const timeoutMs = Math.max(config.timeoutMs * 6, 120000);
  const run = createRunObservers(userId, "Queued login test");
  updateIntegrationRunStatus(userId, "running", "Automation login test in progress.");
  runDetached(async () => {
    try {
      const result = await withTimeout(
        runAutomationLoginTest(userId, {
          onProgress: (message) => run.onProgress(message),
          onSnapshot: (snapshotPath) => run.onSnapshot(snapshotPath)
        }),
        timeoutMs,
        "Automation login test"
      );
      run.onComplete("Login test completed", result?.snapshotPath || null);
      updateIntegrationRunStatus(userId, "succeeded", "", new Date().toISOString());
    } catch (error) {
      run.onFailure(error?.message || "Automation login failed.", error?.artifacts?.screenshotPath || null);
      updateIntegrationRunStatus(
        userId,
        "failed",
        error?.message || "Automation login failed."
      );
    }
  });
}

function startAutomationSubmissionDryRun(userId) {
  const integration = getUserAutomationIntegrationRow(userId);
  if (!integration) {
    throw new Error("Save automation settings first.");
  }

  const config = getAutomationConfig();
  const timeoutMs = Math.max(config.timeoutMs * 9, 180000);
  const run = createRunObservers(userId, "Queued dry run");
  updateIntegrationRunStatus(userId, "running", "Automation dry run in progress.");
  runDetached(async () => {
    try {
      const result = await withTimeout(
        runAutomationSubmissionDryRun(userId, {
          onProgress: (message) => run.onProgress(message),
          onSnapshot: (snapshotPath) => run.onSnapshot(snapshotPath)
        }),
        timeoutMs,
        "Automation dry run"
      );
      run.onComplete("Dry run completed", result?.snapshotPath || null);
      updateIntegrationRunStatus(userId, "succeeded", "", new Date().toISOString());
    } catch (error) {
      run.onFailure(error?.message || "Automation dry run failed.", error?.artifacts?.screenshotPath || null);
      updateIntegrationRunStatus(
        userId,
        "failed",
        error?.message || "Automation dry run failed."
      );
    }
  });
}

async function runAutomationWorkerCycle(options = {}) {
  const config = getAutomationConfig();
  if (!hasAutomationTargetConfig(config) || !hasAutomationSecretKey()) {
    return { processed: 0, skipped: true };
  }

  const enabled = selectEnabledIntegrationsStatement.all(config.siteId);
  for (const integration of enabled) {
    syncAutomationJobsForUser(integration.userId);
  }

  const adapter = createSingleSiteAdapter(config);
  const claimedBy = String(options.claimedBy || process.pid || "automation-worker");
  let processed = 0;

  for (;;) {
    const job = claimDueJob(claimedBy);
    if (!job) {
      break;
    }
    processed += 1;
    const integration = getUserAutomationIntegrationRow(job.userId);
    const appointment = selectAppointmentForJobStatement.get(job.appointmentId, job.userId);
    const nowIso = new Date().toISOString();

    if (!integration || Number(integration.enabled) !== 1 || !appointment) {
      completeJobStatement.run({
        id: job.id,
        status: !integration || !appointment ? "failed" : "cancelled",
        externalReference: null,
        failureMessage:
          !integration || !appointment
            ? "Automation job lost its source appointment or integration."
            : "Automation was disabled before the job ran.",
        auditLog: buildJobAuditLog([
          !integration || !appointment
            ? "Job failed because its source data was missing."
            : "Job cancelled because automation was disabled."
        ]),
        snapshotPath: null,
        completedAt: nowIso,
        updatedAt: nowIso
      });
      if (!integration || !appointment) {
        updateIntegrationRunStatus(job.userId, "failed", "Automation job source data was missing.");
      }
      continue;
    }

    try {
      const credentials = getIntegrationCredentials(integration);
      const { payload, missingFields } = adapter.buildPayloadFromAppointment(appointment);
      if (missingFields.length > 0) {
        throw new Error(`Missing fields: ${missingFields.join(", ")}`);
      }
      const run = createRunObservers(job.userId, `Queued job for appointment ${job.appointmentId}`);
      const result = await adapter.run({
        credentials,
        payload,
        dryRun: false,
        onProgress: (message) => {
          run.onProgress(message);
        },
        onSnapshot: (snapshotPath) => {
          run.onSnapshot(snapshotPath);
        }
      });
      run.onComplete("Scheduled automation completed", result?.snapshotPath || null);
      completeJobStatement.run({
        id: job.id,
        status: "succeeded",
        externalReference: result.externalReference || null,
        failureMessage: null,
        auditLog: buildJobAuditLog([
          `Logged in to ${integration.targetName}.`,
          "Form filled from appointment data.",
          "Submission completed successfully."
        ]),
        snapshotPath: null,
        completedAt: nowIso,
        updatedAt: nowIso
      });
      updateIntegrationRunStatus(job.userId, "succeeded", "", nowIso);
    } catch (error) {
      const integrationRun = getUserAutomationIntegrationRow(job.userId);
      finalizeIntegrationRunLog(
        job.userId,
        parseRunLog(integrationRun?.currentRunLog),
        error?.message || "Automation submission failed.",
        error?.artifacts?.screenshotPath || null
      );
      const snapshotPath = error?.artifacts?.screenshotPath || error?.artifacts?.htmlPath || null;
      completeJobStatement.run({
        id: job.id,
        status: "failed",
        externalReference: null,
        failureMessage: error?.message || "Automation submission failed.",
        auditLog: buildJobAuditLog([
          `Automation run failed: ${error?.message || "Unknown error"}`
        ]),
        snapshotPath,
        completedAt: nowIso,
        updatedAt: nowIso
      });
      updateIntegrationRunStatus(
        job.userId,
        "failed",
        error?.message || "Automation submission failed."
      );
    }
  }

  return { processed, skipped: false };
}

module.exports = {
  attachAutomationStatus,
  getAppointmentAutomationStatusMap,
  getAutomationConfig,
  getAutomationSnapshotPath(userId, mode = "last") {
    const integration = getUserAutomationIntegrationRow(userId);
    if (!integration) {
      return "";
    }
    return mode === "current"
      ? String(integration.currentRunSnapshotPath || "")
      : String(integration.lastRunSnapshotPath || "");
  },
  getUserAutomationView,
  hasAutomationConfigured: () => hasAutomationTargetConfig(getAutomationConfig()) && hasAutomationSecretKey(),
  listAutomationJobsForUser,
  runAutomationLoginTest,
  runAutomationSubmissionDryRun,
  runAutomationWorkerCycle,
  saveUserAutomationIntegration,
  startAutomationLoginTest,
  startAutomationSubmissionDryRun,
  syncAutomationJobsForUser
};
