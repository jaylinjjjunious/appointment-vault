const express = require("express");
const db = require("../../db");
const { requireAuth } = require("../../middleware/authz");
const {
  appointmentCreateSchema,
  appointmentSearchSchema
} = require("../../validation/appointmentSchemas");

const router = express.Router();

function buildIcsEvent(appointment) {
  const uid = `appointment-${appointment.id}@appointment-vault`;
  const dtStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const start = `${appointment.date}T${appointment.time}:00`;
  const startDate = new Date(start);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  const formatUtc = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Appointment Vault//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${formatUtc(startDate)}`,
    `DTEND:${formatUtc(endDate)}`,
    `SUMMARY:${String(appointment.title || "Appointment").replace(/\n/g, " ")}`,
    `DESCRIPTION:${String(appointment.notes || "").replace(/\n/g, " ")}`,
    `LOCATION:${String(appointment.location || "").replace(/\n/g, " ")}`,
    "END:VEVENT",
    "END:VCALENDAR"
  ];

  return lines.join("\r\n");
}

router.get("/", requireAuth, (req, res) => {
  const parsed = appointmentSearchSchema.safeParse(req.query || {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Invalid query parameters." });
    return;
  }

  const { title, dateFrom, dateTo, includeCompleted } = parsed.data;
  const clauses = ["userId = ?"];
  const params = [req.currentUser.id];

  if (title) {
    clauses.push("LOWER(title) LIKE LOWER(?)");
    params.push(`%${title}%`);
  }
  if (dateFrom) {
    clauses.push("date >= ?");
    params.push(dateFrom);
  }
  if (dateTo) {
    clauses.push("date <= ?");
    params.push(dateTo);
  }
  if (includeCompleted !== "1") {
    clauses.push("completedAt IS NULL");
  }

  const sql = `
    SELECT *
    FROM appointments
    WHERE ${clauses.join(" AND ")}
    ORDER BY date ASC, time ASC, id ASC
  `;
  const items = db.prepare(sql).all(...params);

  res.json({ ok: true, items });
});

router.post("/", requireAuth, (req, res) => {
  const raw = {
    ...req.body,
    reminderMinutes:
      req.body?.reminderMinutes === null || req.body?.reminderMinutes === undefined || req.body?.reminderMinutes === ""
        ? null
        : Number.parseInt(String(req.body.reminderMinutes), 10)
  };

  const parsed = appointmentCreateSchema.safeParse(raw);
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Invalid appointment payload.", errors: parsed.error.flatten() });
    return;
  }

  const nowIso = new Date().toISOString();
  const input = parsed.data;
  const result = db.prepare(`
      INSERT INTO appointments
        (userId, title, date, time, location, notes, tags, reminderMinutes, isRecurring, rrule, seriesId, occurrenceStart, occurrenceEnd, createdAt, updatedAt)
      VALUES
        (@userId, @title, @date, @time, @location, @notes, @tags, @reminderMinutes, 0, NULL, NULL, @occurrenceStart, NULL, @createdAt, @updatedAt)
    `).run({
    userId: req.currentUser.id,
    title: input.title,
    date: input.date,
    time: input.time,
    location: input.location || null,
    notes: input.notes || null,
    tags: input.tags || null,
    reminderMinutes: input.reminderMinutes ?? null,
    occurrenceStart: `${input.date}T${input.time}:00`,
    createdAt: nowIso,
    updatedAt: nowIso
  });

  const item = db.prepare("SELECT * FROM appointments WHERE id = ? AND userId = ?").get(result.lastInsertRowid, req.currentUser.id);
  res.status(201).json({ ok: true, item });
});

router.get("/:id", requireAuth, (req, res) => {
  const id = Number.parseInt(String(req.params.id || ""), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, message: "Invalid appointment id." });
    return;
  }

  const item = db.prepare("SELECT * FROM appointments WHERE id = ? AND userId = ? LIMIT 1").get(id, req.currentUser.id);
  if (!item) {
    res.status(404).json({ ok: false, message: "Appointment not found." });
    return;
  }

  res.json({ ok: true, item });
});

router.put("/:id", requireAuth, (req, res) => {
  const id = Number.parseInt(String(req.params.id || ""), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, message: "Invalid appointment id." });
    return;
  }

  const existing = db
    .prepare("SELECT * FROM appointments WHERE id = ? AND userId = ? LIMIT 1")
    .get(id, req.currentUser.id);
  if (!existing) {
    res.status(404).json({ ok: false, message: "Appointment not found." });
    return;
  }

  const raw = {
    title: req.body?.title ?? existing.title,
    date: req.body?.date ?? existing.date,
    time: req.body?.time ?? existing.time,
    location: req.body?.location ?? existing.location,
    notes: req.body?.notes ?? existing.notes,
    tags: req.body?.tags ?? existing.tags,
    reminderMinutes:
      req.body?.reminderMinutes === null || req.body?.reminderMinutes === undefined || req.body?.reminderMinutes === ""
        ? existing.reminderMinutes
        : Number.parseInt(String(req.body.reminderMinutes), 10)
  };

  const parsed = appointmentCreateSchema.safeParse(raw);
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Invalid appointment payload.", errors: parsed.error.flatten() });
    return;
  }

  const input = parsed.data;
  db.prepare(`
      UPDATE appointments
      SET title = @title,
          date = @date,
          time = @time,
          location = @location,
          notes = @notes,
          tags = @tags,
          reminderMinutes = @reminderMinutes,
          occurrenceStart = @occurrenceStart,
          updatedAt = @updatedAt
      WHERE id = @id AND userId = @userId
    `).run({
    id,
    userId: req.currentUser.id,
    title: input.title,
    date: input.date,
    time: input.time,
    location: input.location || null,
    notes: input.notes || null,
    tags: input.tags || null,
    reminderMinutes: input.reminderMinutes ?? null,
    occurrenceStart: `${input.date}T${input.time}:00`,
    updatedAt: new Date().toISOString()
  });

  const item = db.prepare("SELECT * FROM appointments WHERE id = ? AND userId = ? LIMIT 1").get(id, req.currentUser.id);
  res.json({ ok: true, item });
});

router.delete("/:id", requireAuth, (req, res) => {
  const id = Number.parseInt(String(req.params.id || ""), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, message: "Invalid appointment id." });
    return;
  }

  const result = db.prepare("DELETE FROM appointments WHERE id = ? AND userId = ?").run(id, req.currentUser.id);
  if (!result.changes) {
    res.status(404).json({ ok: false, message: "Appointment not found." });
    return;
  }

  res.json({ ok: true });
});

router.get("/:id.ics", requireAuth, (req, res) => {
  const id = Number.parseInt(String(req.params.id || ""), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, message: "Invalid appointment id." });
    return;
  }

  const item = db.prepare("SELECT * FROM appointments WHERE id = ? AND userId = ? LIMIT 1").get(id, req.currentUser.id);
  if (!item) {
    res.status(404).json({ ok: false, message: "Appointment not found." });
    return;
  }

  const ics = buildIcsEvent(item);
  res.setHeader("content-type", "text/calendar; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename=appointment-${id}.ics`);
  res.send(ics);
});

module.exports = router;
