function createHeroKey(item) {
  const id = Number(item?.id || 0);
  if (Number.isInteger(id) && id > 0) {
    return `id:${id}`;
  }

  return [
    String(item?.title || "").trim().toLowerCase(),
    String(item?.date || "").trim(),
    String(item?.time || "").trim(),
    String(item?.location || "").trim().toLowerCase()
  ].join("|");
}

function toArray(items) {
  return Array.isArray(items) ? items.filter(Boolean) : [];
}

function collectUniqueAppointments(groups = []) {
  const seen = new Set();
  const results = [];

  for (const group of groups) {
    for (const item of toArray(group)) {
      const key = createHeroKey(item);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(item);
    }
  }

  return results;
}

function pickDashboardHero(input = {}) {
  const appointments = collectUniqueAppointments([
    input.todayAppointments,
    input.thisWeekAppointments,
    input.upcomingAppointments,
    input.appointments
  ]);

  const nextAppointment =
    appointments.find((appointment) => !appointment?.isCompleted && !appointment?.isHistory) ||
    appointments.find((appointment) => !appointment?.isCompleted) ||
    null;

  if (nextAppointment) {
    return {
      type: "appointment",
      item: nextAppointment
    };
  }

  return {
    type: "none",
    item: null
  };
}

module.exports = {
  pickDashboardHero
};
