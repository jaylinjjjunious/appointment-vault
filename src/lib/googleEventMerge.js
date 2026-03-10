function normalizeMatchText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function createEventMatchKey(event) {
  return [
    normalizeMatchText(event?.title),
    String(event?.date || "").trim(),
    String(event?.time || "").trim()
  ].join("|");
}

function mergeGoogleEventDetails(localAppointments = [], googleEvents = []) {
  const googleById = new Map();
  const googleByKey = new Map();

  for (const event of Array.isArray(googleEvents) ? googleEvents : []) {
    const eventId = String(event?.googleEventId || event?.id || "").trim();
    if (eventId) {
      googleById.set(eventId, event);
    }
    const key = createEventMatchKey(event);
    if (key !== "||" && !googleByKey.has(key)) {
      googleByKey.set(key, event);
    }
  }

  return (Array.isArray(localAppointments) ? localAppointments : []).map((appointment) => {
    const linkedId = String(appointment?.googleEventId || "").trim();
    const key = createEventMatchKey(appointment);
    const remote =
      (linkedId && googleById.get(linkedId)) ||
      (!appointment?.location && !appointment?.notes ? googleByKey.get(key) : null) ||
      null;

    if (!remote) {
      return appointment;
    }

    return {
      ...appointment,
      title: remote.title || appointment.title,
      date: remote.date || appointment.date,
      time: remote.time || appointment.time,
      location: remote.location || appointment.location,
      notes: remote.notes || appointment.notes,
      googleEventId: appointment.googleEventId || remote.googleEventId || remote.id || null,
      syncedFromGoogle: true
    };
  });
}

module.exports = {
  mergeGoogleEventDetails
};
