const { pickDashboardHero } = require("../src/lib/dashboardHero");

describe("dashboard hero selector", () => {
  it("prefers the first active appointment from the dashboard buckets", () => {
    const result = pickDashboardHero({
      todayAppointments: [
        { id: 10, title: "Court", date: "2026-03-10", time: "09:00", isCompleted: false }
      ],
      thisWeekAppointments: [
        { id: 11, title: "Meeting", date: "2026-03-11", time: "10:00", isCompleted: false }
      ],
      upcomingAppointments: []
    });

    expect(result.type).toBe("appointment");
    expect(result.item?.id).toBe(10);
  });

  it("deduplicates the same appointment across dashboard collections", () => {
    const result = pickDashboardHero({
      todayAppointments: [
        { id: 22, title: "Probation", date: "2026-03-10", time: "08:00", isCompleted: false }
      ],
      appointments: [
        { id: 22, title: "Probation", date: "2026-03-10", time: "08:00", isCompleted: false }
      ]
    });

    expect(result.type).toBe("appointment");
    expect(result.item?.id).toBe(22);
  });

  it("returns no hero when there are no active appointments", () => {
    const result = pickDashboardHero({
      todayAppointments: [
        { id: 41, title: "Past", date: "2026-03-10", time: "07:00", isCompleted: true }
      ],
      thisWeekAppointments: [],
      upcomingAppointments: []
    });

    expect(result.type).toBe("none");
    expect(result.item).toBeNull();
  });
});
