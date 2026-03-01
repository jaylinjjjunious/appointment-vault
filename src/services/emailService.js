const nodemailer = require("nodemailer");
const env = require("../config/env");

function hasEmailConfig() {
  return Boolean(env.mail.host && env.mail.user && env.mail.pass);
}

function createTransporter() {
  if (!hasEmailConfig()) {
    return null;
  }

  return nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    secure: env.mail.secure,
    auth: {
      user: env.mail.user,
      pass: env.mail.pass
    }
  });
}

async function sendReminderEmail({ to, subject, text }) {
  const transporter = createTransporter();
  if (!transporter) {
    const error = new Error("SMTP is not configured.");
    error.statusCode = 400;
    error.publicMessage = "SMTP is not configured.";
    throw error;
  }

  await transporter.sendMail({
    from: env.mail.from,
    to,
    subject,
    text
  });
}

module.exports = {
  hasEmailConfig,
  sendReminderEmail
};