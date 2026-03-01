const express = require("express");
const db = require("../../db");
const { requireAuth, requireRole } = require("../../middleware/authz");

const router = express.Router();

router.get("/users", requireAuth, requireRole("admin"), (req, res) => {
  const items = db
    .prepare("SELECT id, provider, email, displayName, role, isActive, createdAt, updatedAt FROM users ORDER BY id DESC")
    .all();
  res.json({ ok: true, items });
});

module.exports = router;