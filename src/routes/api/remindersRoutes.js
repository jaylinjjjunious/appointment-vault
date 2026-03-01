const express = require("express");
const { z } = require("zod");
const { requireAuth } = require("../../middleware/authz");
const { sendReminderEmail } = require("../../services/emailService");

const router = express.Router();

const schema = z.object({
  to: z.string().trim().email(),
  subject: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(8000)
});

router.post("/test-email", requireAuth, async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, message: "Invalid payload.", errors: parsed.error.flatten() });
      return;
    }

    await sendReminderEmail(parsed.data);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;