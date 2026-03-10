const { mergeGoogleEventDetails } = require("../src/lib/googleEventMerge");

describe("google event merge", () => {
  it("merges a linked google event by googleEventId", () => {
    const merged = mergeGoogleEventDetails(
      [
        {
          id: 1,
          title: "Court",
          date: "2026-03-12",
          time: "09:00",
          location: "",
          notes: "",
          googleEventId: "abc123"
        }
      ],
      [
        {
          id: "abc123",
          googleEventId: "abc123",
          title: "Court",
          date: "2026-03-12",
          time: "09:00",
          location: "1215 Truxtun Ave",
          notes: "Dept 5"
        }
      ]
    );

    expect(merged[0].location).toBe("1215 Truxtun Ave");
    expect(merged[0].notes).toBe("Dept 5");
  });

  it("merges an unlinked local appointment by title, date, and time when details are blank", () => {
    const merged = mergeGoogleEventDetails(
      [
        {
          id: 2,
          title: "Probation Meeting",
          date: "2026-03-15",
          time: "13:30",
          location: "",
          notes: ""
        }
      ],
      [
        {
          id: "remote-2",
          googleEventId: "remote-2",
          title: "probation   meeting",
          date: "2026-03-15",
          time: "13:30",
          location: "County Probation Office",
          notes: "Bring ID"
        }
      ]
    );

    expect(merged[0].location).toBe("County Probation Office");
    expect(merged[0].notes).toBe("Bring ID");
    expect(merged[0].googleEventId).toBe("remote-2");
  });

  it("does not overwrite an existing local location with fallback title matching", () => {
    const merged = mergeGoogleEventDetails(
      [
        {
          id: 3,
          title: "Appointment",
          date: "2026-03-20",
          time: "10:00",
          location: "Local Office",
          notes: ""
        }
      ],
      [
        {
          id: "remote-3",
          googleEventId: "remote-3",
          title: "Appointment",
          date: "2026-03-20",
          time: "10:00",
          location: "Remote Office",
          notes: "Google note"
        }
      ]
    );

    expect(merged[0].location).toBe("Local Office");
    expect(merged[0].notes).toBe("");
    expect(merged[0].googleEventId).toBeUndefined();
  });
});
