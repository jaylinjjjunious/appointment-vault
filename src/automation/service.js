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
const { hasEmailConfig, sendReminderEmail } = require("../services/emailService");
const {
  attachPageToViewer,
  getViewerStateForUser,
  startViewerSession,
  stopViewerSession,
  updateViewerSession
} = require("./viewerSession");

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
    monthlyPhotoEnabled,
    monthlyPhotoDay,
    handoffReminderEmail,
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
    @monthlyPhotoEnabled,
    @monthlyPhotoDay,
    @handoffReminderEmail,
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
    monthlyPhotoEnabled = excluded.monthlyPhotoEnabled,
    monthlyPhotoDay = excluded.monthlyPhotoDay,
    handoffReminderEmail = excluded.handoffReminderEmail,
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
const selectPhotoHandoffsForUserStatement = db.prepare(
  `SELECT *
   FROM automation_photo_handoffs
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
const selectNextPhotoHandoffStatement = db.prepare(
  `SELECT *
   FROM automation_photo_handoffs
   WHERE userId = ? AND siteId = ? AND status IN ('pending', 'preparing', 'waiting_for_user')
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
const upsertPhotoHandoffStatement = db.prepare(`
  INSERT INTO automation_photo_handoffs (
    userId,
    siteId,
    periodKey,
    scheduledFor,
    status,
    checkpoint,
    resumeUrl,
    failureMessage,
    notificationSent,
    createdAt,
    updatedAt,
    completedAt
  ) VALUES (
    @userId,
    @siteId,
    @periodKey,
    @scheduledFor,
    @status,
    @checkpoint,
    @resumeUrl,
    @failureMessage,
    @notificationSent,
    @createdAt,
    @updatedAt,
    @completedAt
  )
  ON CONFLICT(userId, siteId, periodKey) DO UPDATE SET
    scheduledFor = excluded.scheduledFor,
    updatedAt = excluded.updatedAt
`);
const claimDuePhotoHandoffStatement = db.prepare(`
  UPDATE automation_photo_handoffs
     SET status = 'preparing',
         updatedAt = @updatedAt
   WHERE id = @id
     AND status = 'pending'
`);
const selectDuePhotoHandoffStatement = db.prepare(
  `SELECT *
   FROM automation_photo_handoffs
   WHERE siteId = ?
     AND status = 'pending'
     AND scheduledFor <= ?
   ORDER BY scheduledFor ASC, id ASC
   LIMIT 1`
);
const selectUserContactForHandoffStatement = db.prepare(
  `SELECT id, email, phoneNumber, displayName
   FROM users
   WHERE id = ?`
);
const updatePhotoHandoffStatement = db.prepare(`
  UPDATE automation_photo_handoffs
     SET scheduledFor = COALESCE(@scheduledFor, scheduledFor),
         status = @status,
         checkpoint = @checkpoint,
         resumeUrl = @resumeUrl,
         failureMessage = @failureMessage,
         notificationSent = @notificationSent,
         completedAt = @completedAt,
         updatedAt = @updatedAt
   WHERE id = @id
`);
const selectPhotoHandoffByIdStatement = db.prepare(
  `SELECT *
   FROM automation_photo_handoffs
   WHERE id = ?`
);

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

function listPhotoHandoffsForUser(userId, limit = 6) {
  if (!userId) {
    return [];
  }
  const { siteId } = getSiteIdentity();
  return selectPhotoHandoffsForUserStatement.all(userId, siteId, Math.max(limit, 1));
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
  const nextPhotoHandoff = integration
    ? selectNextPhotoHandoffStatement.get(integration.userId, integration.siteId)
    : null;
  const recentPhotoHandoffs = integration ? listPhotoHandoffsForUser(integration.userId) : [];
  const viewerState = integration ? getViewerStateForUser(integration.userId) : getViewerStateForUser(0);
  return {
    configured: hasAutomationTargetConfig(config) && hasAutomationSecretKey(),
    targetName: config.targetName || DEFAULT_TARGET_NAME,
    siteId: config.siteId || DEFAULT_SITE_ID,
    missingConfigKeys: [
      ...getMissingAutomationConfigKeys(config),
      ...(hasAutomationSecretKey() ? [] : ["AUTOMATION_SECRET_KEY"])
    ],
    enabled: integration ? Number(integration.enabled) === 1 : false,
    monthlyPhotoEnabled: integration ? Number(integration.monthlyPhotoEnabled) === 1 : false,
    monthlyPhotoDay: integration ? Number(integration.monthlyPhotoDay || 1) : 1,
    handoffReminderEmail: integration?.handoffReminderEmail || "",
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
    lastHandoffStatus: integration?.lastHandoffStatus || "",
    lastHandoffAt: integration?.lastHandoffAt || "",
    lastHandoffCompletedAt: integration?.lastHandoffCompletedAt || "",
    lastHandoffMessage: integration?.lastHandoffMessage || "",
    lastHandoffResumeUrl: integration?.lastHandoffResumeUrl || "",
    nextRunAt: nextJob?.scheduledFor || "",
    nextPhotoHandoffAt: nextPhotoHandoff?.scheduledFor || "",
    jobs: integration ? listAutomationJobsForUser(integration.userId) : [],
    photoHandoffs: recentPhotoHandoffs,
    currentPhotoHandoff:
      recentPhotoHandoffs.find((handoff) =>
        ["pending", "preparing", "waiting_for_user"].includes(String(handoff.status || ""))
      ) || null,
    canEmailPhotoReminder: hasEmailConfig(),
    viewerActive: Boolean(viewerState.active),
    viewerSessionId: viewerState.sessionId || "",
    viewerStatus: viewerState.status || "",
    viewerStreamUrl: viewerState.streamUrl || "",
    viewerStartedAt: viewerState.startedAt || "",
    viewerEndedAt: viewerState.endedAt || "",
    viewerLastFrameAt: viewerState.lastFrameAt || ""
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
  const monthlyPhotoEnabled = parseBoolean(input.monthlyPhotoEnabled, false);
  const monthlyPhotoDay = Math.min(
    Math.max(parseInteger(input.monthlyPhotoDay, Number(existing?.monthlyPhotoDay || 1)), 1),
    28
  );
  const handoffReminderEmail = String(
    input.handoffReminderEmail !== undefined
      ? input.handoffReminderEmail
      : existing?.handoffReminderEmail || ""
  ).trim();
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
    monthlyPhotoEnabled: monthlyPhotoEnabled ? 1 : 0,
    monthlyPhotoDay,
    handoffReminderEmail: handoffReminderEmail || null,
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
    if (monthlyPhotoEnabled) {
      syncMonthlyPhotoHandoffForUser(userId);
    }
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

function buildMonthlyPeriodKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function buildMonthlyScheduledFor(dayOfMonth, baseDate = new Date()) {
  const scheduled = new Date(
    Date.UTC(
      baseDate.getUTCFullYear(),
      baseDate.getUTCMonth(),
      Math.min(Math.max(Number(dayOfMonth || 1), 1), 28),
      16,
      0,
      0,
      0
    )
  );
  return scheduled.toISOString();
}

function updateIntegrationHandoffState(userId, patch = {}) {
  const integration = getUserAutomationIntegrationRow(userId);
  if (!integration) {
    return;
  }
  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE automation_integrations
       SET lastHandoffStatus = ?,
           lastHandoffAt = ?,
           lastHandoffCompletedAt = ?,
           lastHandoffMessage = ?,
           lastHandoffResumeUrl = ?,
           updatedAt = ?
     WHERE userId = ? AND siteId = ?
  `).run(
    patch.status || integration.lastHandoffStatus || null,
    patch.at === undefined ? integration.lastHandoffAt || null : patch.at,
    patch.completedAt === undefined
      ? integration.lastHandoffCompletedAt || null
      : patch.completedAt,
    patch.message === undefined ? integration.lastHandoffMessage || null : patch.message,
    patch.resumeUrl === undefined ? integration.lastHandoffResumeUrl || null : patch.resumeUrl,
    nowIso,
    userId,
    integration.siteId
  );
}

function syncMonthlyPhotoHandoffForUser(userId, now = new Date()) {
  const integration = getUserAutomationIntegrationRow(userId);
  if (!integration || Number(integration.enabled) !== 1 || Number(integration.monthlyPhotoEnabled) !== 1) {
    return null;
  }
  const periodKey = buildMonthlyPeriodKey(now);
  const scheduledFor = buildMonthlyScheduledFor(integration.monthlyPhotoDay || 1, now);
  const nowIso = new Date().toISOString();
  upsertPhotoHandoffStatement.run({
    userId,
    siteId: integration.siteId,
    periodKey,
    scheduledFor,
    status: "pending",
    checkpoint: null,
    resumeUrl: null,
    failureMessage: null,
    notificationSent: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
    completedAt: null
  });
  return selectNextPhotoHandoffStatement.get(userId, integration.siteId) || null;
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
  const viewer = createViewerHooks(userId, "login test");
  return adapter.run({
    credentials: getIntegrationCredentials(integration),
    payload: {},
    dryRun: true,
    onProgress: (message) => {
      if (typeof handlers.onProgress === "function") {
        handlers.onProgress(message);
      }
      viewer.onProgress(message);
    },
    onSnapshot: typeof handlers.onSnapshot === "function" ? handlers.onSnapshot : () => {},
    onPageReady: viewer.onPageReady,
    onRunFinished: viewer.onRunFinished,
    onRunFailed: viewer.onRunFailed
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
  const viewer = createViewerHooks(userId, "dry run");
  const { payload, missingFields } = adapter.buildPayloadFromAppointment(appointment);
  if (missingFields.length > 0) {
    throw new Error(`Dry run blocked. Missing fields: ${missingFields.join(", ")}`);
  }
  return adapter.run({
    credentials: getIntegrationCredentials(integration),
    payload,
    dryRun: true,
    onProgress: (message) => {
      if (typeof handlers.onProgress === "function") {
        handlers.onProgress(message);
      }
      viewer.onProgress(message);
    },
    onSnapshot: typeof handlers.onSnapshot === "function" ? handlers.onSnapshot : () => {},
    onPageReady: viewer.onPageReady,
    onRunFinished: viewer.onRunFinished,
    onRunFailed: viewer.onRunFailed
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

const claimDuePhotoHandoff = db.transaction(() => {
  const { siteId } = getSiteIdentity();
  const nowIso = new Date().toISOString();
  const nextHandoff = selectDuePhotoHandoffStatement.get(siteId, nowIso);
  if (!nextHandoff) {
    return null;
  }
  const result = claimDuePhotoHandoffStatement.run({
    id: nextHandoff.id,
    updatedAt: nowIso
  });
  if (result.changes !== 1) {
    return null;
  }
  return selectPhotoHandoffByIdStatement.get(nextHandoff.id) || null;
});

const claimPhotoHandoffById = db.transaction((handoffId) => {
  const nowIso = new Date().toISOString();
  const existing = selectPhotoHandoffByIdStatement.get(handoffId);
  if (!existing || String(existing.status || "") !== "pending") {
    return null;
  }
  const result = claimDuePhotoHandoffStatement.run({
    id: handoffId,
    updatedAt: nowIso
  });
  if (result.changes !== 1) {
    return null;
  }
  return selectPhotoHandoffByIdStatement.get(handoffId) || null;
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

function getMonthlyPhotoHandoffTimeoutMs(config) {
  return Math.max(config.timeoutMs * 18, 420000);
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

function createViewerHooks(userId, label) {
  const config = getAutomationConfig();
  if (!config.viewerEnabled) {
    return {
      onProgress() {},
      onPageReady: async () => {},
      onRunFinished: async () => {},
      onRunFailed: async () => {}
    };
  }
  const session = startViewerSession(userId, { status: label });
  if (!session) {
    return {
      onProgress() {},
      onPageReady: async () => {},
      onRunFinished: async () => {},
      onRunFailed: async () => {}
    };
  }
  return {
    onProgress(message) {
      updateViewerSession(session.sessionId, { status: message });
    },
    async onPageReady(page) {
      attachPageToViewer(session.sessionId, page, config);
    },
    async onRunFinished(result) {
      stopViewerSession(session.sessionId, {
        status: result?.mode || "completed"
      });
    },
    async onRunFailed(error) {
      stopViewerSession(session.sessionId, {
        status: error?.message || "failed"
      });
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

async function sendPhotoHandoffReminder(user, handoff, integration) {
  const to =
    String(integration?.handoffReminderEmail || "").trim() ||
    String(user?.email || "").trim();
  if (!to || !hasEmailConfig()) {
    return false;
  }
  await sendReminderEmail({
    to,
    subject: `${integration.targetName} photo check-in needed`,
    text: [
      `Your ${integration.targetName} monthly check-in is ready for the photo step.`,
      "",
      "Open this page in Appointment Vault to continue:",
      `${String(process.env.PUBLIC_BASE_URL || "https://appointment-vault.onrender.com").replace(/\/+$/, "")}/settings#automation`,
      "",
      handoff?.resumeUrl ? `Resume website: ${handoff.resumeUrl}` : ""
    ]
      .filter(Boolean)
      .join("\n")
  });
  return true;
}

async function runPhotoHandoffPrep(userId, handoffId, handlers = {}) {
  const integration = getUserAutomationIntegrationRow(userId);
  if (!integration) {
    throw new Error("Automation integration is not configured.");
  }
  const handoff = selectPhotoHandoffByIdStatement.get(handoffId);
  if (!handoff) {
    throw new Error("Photo handoff request was not found.");
  }
  const adapter = createSingleSiteAdapter(getAutomationConfig());
  const viewer = createViewerHooks(userId, "monthly photo handoff");
  const { payload, missingFields } = adapter.buildPayloadFromAppointment({});
  if (missingFields.length > 0 && integration.siteId !== "ce-check-in") {
    throw new Error(`Photo handoff blocked. Missing fields: ${missingFields.join(", ")}`);
  }
  return adapter.prepareForPhoto({
    credentials: getIntegrationCredentials(integration),
    payload,
    onProgress: (message) => {
      if (typeof handlers.onProgress === "function") {
        handlers.onProgress(message);
      }
      viewer.onProgress(message);
    },
    onSnapshot: typeof handlers.onSnapshot === "function" ? handlers.onSnapshot : () => {},
    onPageReady: viewer.onPageReady,
    onRunFinished: viewer.onRunFinished,
    onRunFailed: viewer.onRunFailed
  });
}

function startMonthlyPhotoHandoff(userId) {
  let integration = getUserAutomationIntegrationRow(userId);
  if (!integration) {
    throw new Error("Save your website login before starting the monthly photo step.");
  }
  if (!integration.encryptedUsername || !integration.encryptedPassword) {
    throw new Error("Save your website login before starting the monthly photo step.");
  }
  if (Number(integration.enabled) !== 1 || Number(integration.monthlyPhotoEnabled) !== 1) {
    saveUserAutomationIntegration(userId, {
      enabled: true,
      monthlyPhotoEnabled: true,
      monthlyPhotoDay: Number(integration.monthlyPhotoDay || 1)
    });
    integration = getUserAutomationIntegrationRow(userId);
  }
  if (!integration || Number(integration.enabled) !== 1) {
    throw new Error("Unable to enable website automation for the monthly photo step.");
  }
  const handoff = syncMonthlyPhotoHandoffForUser(userId, new Date()) || selectNextPhotoHandoffStatement.get(userId, integration.siteId);
  if (!handoff) {
    throw new Error("Unable to schedule the monthly photo handoff.");
  }
  updatePhotoHandoffStatement.run({
    id: handoff.id,
    scheduledFor: new Date().toISOString(),
    status: "pending",
    checkpoint: null,
    resumeUrl: null,
    failureMessage: null,
    notificationSent: 0,
    completedAt: null,
    updatedAt: new Date().toISOString()
  });
  updateIntegrationHandoffState(userId, {
    status: "pending",
    at: new Date().toISOString(),
    completedAt: null,
    message: "Monthly photo handoff queued.",
    resumeUrl: null
  });
  return selectPhotoHandoffByIdStatement.get(handoff.id) || handoff;
}

function completeMonthlyPhotoHandoff(userId, handoffId) {
  const handoff = selectPhotoHandoffByIdStatement.get(handoffId);
  if (!handoff || Number(handoff.userId) !== Number(userId)) {
    throw new Error("Photo handoff was not found.");
  }
  const nowIso = new Date().toISOString();
  updatePhotoHandoffStatement.run({
    id: handoff.id,
    scheduledFor: null,
    status: "completed",
    checkpoint: handoff.checkpoint || "photo_capture_required",
    resumeUrl: handoff.resumeUrl || null,
    failureMessage: null,
    notificationSent: Number(handoff.notificationSent || 0),
    completedAt: nowIso,
    updatedAt: nowIso
  });
  updateIntegrationHandoffState(userId, {
    status: "completed",
    at: handoff.scheduledFor || nowIso,
    completedAt: nowIso,
    message: "Photo handoff marked complete.",
    resumeUrl: handoff.resumeUrl || null
  });
}

async function processPhotoHandoff(handoff, config) {
  const integration = getUserAutomationIntegrationRow(handoff.userId);
  const nowIso = new Date().toISOString();
  const run = createRunObservers(handoff.userId, "Queued monthly photo handoff");

  if (
    !integration ||
    Number(integration.enabled) !== 1 ||
    Number(integration.monthlyPhotoEnabled) !== 1
  ) {
    updatePhotoHandoffStatement.run({
      id: handoff.id,
      scheduledFor: null,
      status: "cancelled",
      checkpoint: handoff.checkpoint || null,
      resumeUrl: handoff.resumeUrl || null,
      failureMessage: "Monthly photo handoff is no longer enabled.",
      notificationSent: Number(handoff.notificationSent || 0),
      completedAt: nowIso,
      updatedAt: nowIso
    });
    updateIntegrationHandoffState(handoff.userId, {
      status: "cancelled",
      at: nowIso,
      completedAt: nowIso,
      message: "Monthly photo handoff was cancelled.",
      resumeUrl: handoff.resumeUrl || null
    });
    return;
  }

  try {
    updateIntegrationHandoffState(handoff.userId, {
      status: "preparing",
      at: nowIso,
      completedAt: null,
      message: "Preparing the monthly photo handoff.",
      resumeUrl: null
    });
    const result = await withTimeout(
      runPhotoHandoffPrep(handoff.userId, handoff.id, {
        onProgress: (message) => run.onProgress(message),
        onSnapshot: (snapshotPath) => run.onSnapshot(snapshotPath)
      }),
      getMonthlyPhotoHandoffTimeoutMs(config),
      "Monthly photo handoff"
    );
    const user = selectUserContactForHandoffStatement.get(handoff.userId) || null;
    let reminderSent = false;
    try {
      reminderSent = await sendPhotoHandoffReminder(
        user,
        { ...handoff, resumeUrl: result?.resumeUrl || handoff.resumeUrl || null },
        integration
      );
    } catch (error) {
      run.onProgress(`Photo reminder email skipped: ${error?.message || "Unknown error"}`);
    }
    updatePhotoHandoffStatement.run({
      id: handoff.id,
      scheduledFor: null,
      status: "waiting_for_user",
      checkpoint: result?.checkpoint || "photo_capture_required",
      resumeUrl: result?.resumeUrl || handoff.resumeUrl || null,
      failureMessage: null,
      notificationSent: reminderSent ? 1 : Number(handoff.notificationSent || 0),
      completedAt: null,
      updatedAt: new Date().toISOString()
    });
    run.onComplete("Monthly photo handoff is ready for you", result?.snapshotPath || null);
    updateIntegrationHandoffState(handoff.userId, {
      status: "waiting_for_user",
      at: nowIso,
      completedAt: null,
      message: reminderSent
        ? "Photo step is ready. We emailed you a reminder too."
        : "Photo step is ready. Open the website and take the photo to finish.",
      resumeUrl: result?.resumeUrl || handoff.resumeUrl || null
    });
  } catch (error) {
    run.onFailure(
      error?.message || "Monthly photo handoff failed.",
      error?.artifacts?.screenshotPath || null
    );
    updatePhotoHandoffStatement.run({
      id: handoff.id,
      scheduledFor: null,
      status: "failed",
      checkpoint: handoff.checkpoint || null,
      resumeUrl: handoff.resumeUrl || null,
      failureMessage: error?.message || "Monthly photo handoff failed.",
      notificationSent: Number(handoff.notificationSent || 0),
      completedAt: nowIso,
      updatedAt: nowIso
    });
    updateIntegrationHandoffState(handoff.userId, {
      status: "failed",
      at: nowIso,
      completedAt: nowIso,
      message: error?.message || "Monthly photo handoff failed.",
      resumeUrl: handoff.resumeUrl || null
    });
  }
}

function startMonthlyPhotoHandoffPrep(userId) {
  const queued = startMonthlyPhotoHandoff(userId);
  const handoffId = queued?.id;
  if (!handoffId) {
    return null;
  }
  const config = getAutomationConfig();
  runDetached(async () => {
    const claimed = claimPhotoHandoffById(handoffId);
    if (!claimed) {
      return;
    }
    await processPhotoHandoff(claimed, config);
  });
  return handoffId;
}

async function runAutomationWorkerCycle(options = {}) {
  const config = getAutomationConfig();
  if (!hasAutomationTargetConfig(config) || !hasAutomationSecretKey()) {
    return { processed: 0, skipped: true };
  }

  const enabled = selectEnabledIntegrationsStatement.all(config.siteId);
  for (const integration of enabled) {
    syncAutomationJobsForUser(integration.userId);
    if (Number(integration.monthlyPhotoEnabled) === 1) {
      syncMonthlyPhotoHandoffForUser(integration.userId);
    }
  }

  const adapter = createSingleSiteAdapter(config);
  const claimedBy = String(options.claimedBy || process.pid || "automation-worker");
  let processed = 0;

  for (;;) {
    const handoff = claimDuePhotoHandoff();
    if (!handoff) {
      break;
    }
    processed += 1;
    await processPhotoHandoff(handoff, config);
  }

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
      const viewer = createViewerHooks(job.userId, `scheduled job ${job.appointmentId}`);
      const result = await adapter.run({
        credentials,
        payload,
        dryRun: false,
        onProgress: (message) => {
          run.onProgress(message);
          viewer.onProgress(message);
        },
        onSnapshot: (snapshotPath) => {
          run.onSnapshot(snapshotPath);
        },
        onPageReady: viewer.onPageReady,
        onRunFinished: viewer.onRunFinished,
        onRunFailed: viewer.onRunFailed
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
  listPhotoHandoffsForUser,
  runAutomationLoginTest,
  runAutomationSubmissionDryRun,
  runAutomationWorkerCycle,
  saveUserAutomationIntegration,
  startAutomationLoginTest,
  startMonthlyPhotoHandoffPrep,
  startAutomationSubmissionDryRun,
  startMonthlyPhotoHandoff,
  completeMonthlyPhotoHandoff,
  syncAutomationJobsForUser
};
