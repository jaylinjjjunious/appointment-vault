const { z } = require("zod");

const appointmentCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  location: z.string().trim().max(200).optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
  tags: z.string().trim().max(500).optional().nullable(),
  reminderMinutes: z.number().int().min(0).max(10080).optional().nullable()
});

const appointmentSearchSchema = z.object({
  title: z.string().trim().max(200).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  includeCompleted: z.enum(["0", "1"]).optional()
});

module.exports = {
  appointmentCreateSchema,
  appointmentSearchSchema
};