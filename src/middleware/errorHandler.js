const logger = require("../lib/logger");

function notFoundHandler(req, res) {
  if (String(req.get("accept") || "").includes("application/json")) {
    return res.status(404).json({ ok: false, message: "Not found" });
  }

  return res.status(404).render("404", { title: "Not Found" });
}

function errorHandler(error, req, res, next) {
  // Mirror to stderr so server.err.log captures the stack in local runs.
  // This preserves existing structured logging while making debugging easier.
  try {
    console.error("[errorHandler]", error?.stack || error);
  } catch (logError) {
    // ignore logging failures
  }

  logger.error(
    {
      err: error,
      requestId: req.requestId,
      userId: req.currentUser?.id || null,
      path: req.originalUrl,
      method: req.method
    },
    "Unhandled request error"
  );

  if (res.headersSent) {
    return;
  }

  if (String(req.get("accept") || "").includes("application/json")) {
    res.status(error.statusCode || 500).json({
      ok: false,
      message: error.publicMessage || "Unexpected server error.",
      requestId: req.requestId
    });
    return;
  }

  const statusCode = error.statusCode || 500;
  const serverTime = new Date().toISOString();
  const errorReport = {
    requestId: req.requestId || null,
    status: statusCode,
    method: req.method || "",
    path: req.originalUrl || "",
    time: serverTime,
    message: error.publicMessage || "Unexpected server error."
  };
  const errorReportText = [
    "Appointment Vault Error Report",
    `Request ID: ${errorReport.requestId || "Unavailable"}`,
    `Status: ${errorReport.status}`,
    `Path: ${errorReport.method} ${errorReport.path}`,
    `Message: ${errorReport.message}`,
    `Time: ${errorReport.time}`
  ].join("\n");

  res.status(statusCode).render("error", {
    title: "Server Error",
    message: "Something went wrong. Please try again.",
    requestId: req.requestId || null,
    path: req.originalUrl || "",
    method: req.method || "",
    serverTime,
    errorReport,
    errorReportText
  });
}

module.exports = {
  notFoundHandler,
  errorHandler
};
