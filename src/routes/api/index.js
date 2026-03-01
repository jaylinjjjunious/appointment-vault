const express = require("express");
const authRoutes = require("./authRoutes");
const appointmentsRoutes = require("./appointmentsRoutes");
const adminRoutes = require("./adminRoutes");
const remindersRoutes = require("./remindersRoutes");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/appointments", appointmentsRoutes);
router.use("/admin", adminRoutes);
router.use("/reminders", remindersRoutes);

module.exports = router;