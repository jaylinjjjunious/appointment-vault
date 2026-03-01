const { z } = require("zod");

const registerSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().trim().min(1).max(120).optional().default("")
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(128)
});

module.exports = {
  registerSchema,
  loginSchema
};