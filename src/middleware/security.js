const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const pinoHttp = require("pino-http");
const env = require("../config/env");
const logger = require("../lib/logger");

function installSecurity(app) {
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false
  }));

  app.use(
    rateLimit({
      windowMs: env.security.rateLimitWindowMs,
      max: env.security.rateLimitMax,
      standardHeaders: true,
      legacyHeaders: false
    })
  );

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.requestId,
      customProps: (req) => ({ requestId: req.requestId, userId: req.currentUser?.id || null })
    })
  );
}

module.exports = { installSecurity };