const { describe, it, expect } = require("vitest");
const { appointmentCreateSchema } = require("../src/validation/appointmentSchemas");

describe("appointment schema", () => {
  it("accepts a valid payload", () => {
    const parsed = appointmentCreateSchema.safeParse({
      title: "Court Hearing",
      date: "2026-03-04",
      time: "09:00"
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects an invalid payload", () => {
    const parsed = appointmentCreateSchema.safeParse({
      title: "",
      date: "03/04/2026",
      time: "9:00am"
    });

    expect(parsed.success).toBe(false);
  });
});