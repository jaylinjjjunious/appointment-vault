const pino = require("pino");
const env = require("../config/env");

const logger = pino({
  name: "appointment-vault",
  level: env.app.isProduction ? "info" : "debug",
  transport: env.app.isProduction
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
          singleLine: true,
          translateTime: "SYS:standard"
        }
      }
});

module.exports = logger;