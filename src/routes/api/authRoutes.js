const express = require("express");
const { requireAuth } = require("../../middleware/authz");
const { sanitizeUser } = require("../../services/authService");

const router = express.Router();

router.get("/me", requireAuth, (req, res) => {
  res.json({
    ok: true,
    user: sanitizeUser(req.currentUser)
  });
});

module.exports = router;