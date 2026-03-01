function normalizeText(value) {
  return String(value || "").toLowerCase();
}

function matchesAppointmentQuery(appointment, query) {
  const needle = normalizeText(query).trim();
  if (!needle) return true;

  const haystack = [
    appointment.title,
    appointment.tags,
    appointment.notes,
    appointment.location
  ]
    .map(normalizeText)
    .join(" ");

  return haystack.includes(needle);
}

module.exports = {
  matchesAppointmentQuery
};
