const { randomUUID } = require("node:crypto");

function requestContext(req, res, next) {
  const existing = String(req.get("x-request-id") || "").trim();
  const requestId = existing || randomUUID();
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
}

module.exports = { requestContext };