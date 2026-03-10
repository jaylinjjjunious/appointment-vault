const request = require("supertest");
const app = require("../src/app");

describe("health endpoint", () => {
  it("returns ok", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.text).toBe("OK");
  });
});
