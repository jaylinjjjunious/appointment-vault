const DAY_CODE_TO_INDEX = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6
};

const INDEX_TO_DAY_CODE = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const SUPPORTED_FREQUENCIES = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);

function parseDateString(value) {
  const input = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return null;
  }

  const [year, month, day] = input.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function formatDateString(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date, months) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const targetMonth = month + months;
  const firstOfTarget = new Date(Date.UTC(year, targetMonth, 1));
  const lastDay = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0));
  const clampedDay = Math.min(day, lastDay.getUTCDate());
  return new Date(
    Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth(), clampedDay, 0, 0, 0)
  );
}

function addYears(date, years) {
  const next = new Date(date.getTime());
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next;
}

function parseUntilDate(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  if (/^\d{8}$/.test(raw)) {
    const year = Number.parseInt(raw.slice(0, 4), 10);
    const month = Number.parseInt(raw.slice(4, 6), 10);
    const day = Number.parseInt(raw.slice(6, 8), 10);
    return parseDateString(
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    );
  }

  if (/^\d{8}T\d{6}Z$/.test(raw)) {
    const year = Number.parseInt(raw.slice(0, 4), 10);
    const month = Number.parseInt(raw.slice(4, 6), 10);
    const day = Number.parseInt(raw.slice(6, 8), 10);
    return parseDateString(
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    );
  }

  return parseDateString(raw);
}

function parseRRule(rruleText) {
  const text = String(rruleText || "").trim();
  if (!text) {
    return { isValid: true, value: null, errors: [] };
  }

  const body = text.toUpperCase().startsWith("RRULE:")
    ? text.slice("RRULE:".length)
    : text;
  const parts = body
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const parsed = {};
  const errors = [];

  for (const part of parts) {
    const splitIndex = part.indexOf("=");
    if (splitIndex <= 0) {
      errors.push(`Invalid rule segment: ${part}`);
      continue;
    }

    const key = part.slice(0, splitIndex).trim().toUpperCase();
    const value = part.slice(splitIndex + 1).trim().toUpperCase();
    parsed[key] = value;
  }

  const freq = parsed.FREQ;
  if (!freq || !SUPPORTED_FREQUENCIES.has(freq)) {
    errors.push("RRULE must include a supported FREQ (DAILY, WEEKLY, MONTHLY, YEARLY).");
  }

  const intervalRaw = parsed.INTERVAL || "1";
  const interval = Number.parseInt(intervalRaw, 10);
  if (!Number.isInteger(interval) || interval <= 0) {
    errors.push("INTERVAL must be a positive integer.");
  }

  let count = null;
  if (parsed.COUNT) {
    const parsedCount = Number.parseInt(parsed.COUNT, 10);
    if (!Number.isInteger(parsedCount) || parsedCount <= 0) {
      errors.push("COUNT must be a positive integer.");
    } else {
      count = parsedCount;
    }
  }

  const until = parsed.UNTIL ? parseUntilDate(parsed.UNTIL) : null;
  if (parsed.UNTIL && !until) {
    errors.push("UNTIL must be YYYY-MM-DD, YYYYMMDD, or YYYYMMDDTHHMMSSZ.");
  }

  const byDay = parsed.BYDAY
    ? parsed.BYDAY
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    : [];
  if (byDay.some((code) => !Object.hasOwn(DAY_CODE_TO_INDEX, code))) {
    errors.push("BYDAY contains unsupported values. Use SU,MO,TU,WE,TH,FR,SA.");
  }

  const byMonthDay = parsed.BYMONTHDAY
    ? parsed.BYMONTHDAY
      .split(",")
      .map((item) => Number.parseInt(item.trim(), 10))
      .filter((value) => Number.isInteger(value))
    : [];
  if (parsed.BYMONTHDAY && byMonthDay.length === 0) {
    errors.push("BYMONTHDAY must include one or more integer day values.");
  }
  if (byMonthDay.some((value) => value === 0 || value < -31 || value > 31)) {
    errors.push("BYMONTHDAY values must be between -31 and 31, excluding 0.");
  }

  const wkst = parsed.WKST || "MO";
  if (!Object.hasOwn(DAY_CODE_TO_INDEX, wkst)) {
    errors.push("WKST must be one of SU,MO,TU,WE,TH,FR,SA.");
  }

  return {
    isValid: errors.length === 0,
    errors,
    value:
      errors.length > 0
        ? null
        : {
          freq,
          interval,
          count,
          until,
          byDay,
          byMonthDay,
          wkst
        }
  };
}

function toRuleString(ruleValue) {
  if (!ruleValue) {
    return "";
  }

  const parts = [`FREQ=${ruleValue.freq}`, `INTERVAL=${ruleValue.interval}`];
  if (ruleValue.count) {
    parts.push(`COUNT=${ruleValue.count}`);
  }
  if (ruleValue.until) {
    parts.push(`UNTIL=${formatDateString(ruleValue.until)}`);
  }
  if (ruleValue.byDay?.length > 0) {
    parts.push(`BYDAY=${ruleValue.byDay.join(",")}`);
  }
  if (ruleValue.byMonthDay?.length > 0) {
    parts.push(`BYMONTHDAY=${ruleValue.byMonthDay.join(",")}`);
  }
  if (ruleValue.wkst) {
    parts.push(`WKST=${ruleValue.wkst}`);
  }

  return parts.join(";");
}

function getWeekStart(date, weekStartDayIndex) {
  const weekday = date.getUTCDay();
  const delta = (weekday - weekStartDayIndex + 7) % 7;
  return addDays(date, -delta);
}

function isSameDay(left, right) {
  return (
    left.getUTCFullYear() === right.getUTCFullYear() &&
    left.getUTCMonth() === right.getUTCMonth() &&
    left.getUTCDate() === right.getUTCDate()
  );
}

function includesByMonthDay(date, byMonthDay) {
  if (!byMonthDay || byMonthDay.length === 0) {
    return true;
  }
  const day = date.getUTCDate();
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return byMonthDay.some((value) => {
    if (value > 0) {
      return value === day;
    }
    return lastDay + value + 1 === day;
  });
}

function buildOccurrencesForRule(baseDate, ruleValue, windowStart, windowEnd, maxOccurrences = 400) {
  const occurrences = [];
  const until = ruleValue.until || null;
  let generatedCount = 0;

  function pushOccurrence(candidate) {
    if (until && candidate > until) {
      return false;
    }
    generatedCount += 1;
    if (ruleValue.count && generatedCount > ruleValue.count) {
      return false;
    }
    if (candidate >= windowStart && candidate <= windowEnd) {
      occurrences.push(candidate);
    }
    return occurrences.length < maxOccurrences;
  }

  if (ruleValue.freq === "DAILY") {
    let cursor = new Date(baseDate.getTime());
    while (cursor <= windowEnd) {
      const dayCode = INDEX_TO_DAY_CODE[cursor.getUTCDay()];
      const passesByDay =
        ruleValue.byDay.length === 0 || ruleValue.byDay.includes(dayCode);
      const passesByMonthDay = includesByMonthDay(cursor, ruleValue.byMonthDay);
      if (passesByDay && passesByMonthDay) {
        const keepGoing = pushOccurrence(cursor);
        if (!keepGoing) {
          break;
        }
      }
      cursor = addDays(cursor, ruleValue.interval);
      if (ruleValue.count && generatedCount >= ruleValue.count && cursor < windowStart) {
        break;
      }
      if (until && cursor > until) {
        break;
      }
    }
  }

  if (ruleValue.freq === "WEEKLY") {
    const baseWeekStart = getWeekStart(baseDate, DAY_CODE_TO_INDEX[ruleValue.wkst]);
    const activeDays =
      ruleValue.byDay.length > 0
        ? ruleValue.byDay.map((code) => DAY_CODE_TO_INDEX[code]).sort((a, b) => a - b)
        : [baseDate.getUTCDay()];
    let weekCursor = new Date(baseWeekStart.getTime());

    while (weekCursor <= windowEnd) {
      for (const dayIndex of activeDays) {
        const candidate = addDays(weekCursor, dayIndex);
        if (candidate < baseDate) {
          continue;
        }
        const passesByMonthDay = includesByMonthDay(candidate, ruleValue.byMonthDay);
        if (!passesByMonthDay) {
          continue;
        }
        const keepGoing = pushOccurrence(candidate);
        if (!keepGoing) {
          break;
        }
      }

      weekCursor = addDays(weekCursor, 7 * ruleValue.interval);
      if (ruleValue.count && generatedCount >= ruleValue.count && weekCursor < windowStart) {
        break;
      }
      if (until && weekCursor > until) {
        break;
      }
    }
  }

  if (ruleValue.freq === "MONTHLY") {
    let cursor = new Date(baseDate.getTime());
    while (cursor <= windowEnd) {
      const daysInMonth = new Date(
        Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)
      ).getUTCDate();
      const candidateDays =
        ruleValue.byMonthDay.length > 0
          ? ruleValue.byMonthDay
            .map((value) => (value > 0 ? value : daysInMonth + value + 1))
            .filter((value) => value > 0 && value <= daysInMonth)
          : [baseDate.getUTCDate()];

      const seen = new Set();
      for (const dayValue of candidateDays) {
        if (seen.has(dayValue)) {
          continue;
        }
        seen.add(dayValue);
        const candidate = new Date(
          Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), dayValue, 0, 0, 0)
        );
        if (candidate < baseDate) {
          continue;
        }
        if (ruleValue.byDay.length > 0) {
          const dayCode = INDEX_TO_DAY_CODE[candidate.getUTCDay()];
          if (!ruleValue.byDay.includes(dayCode)) {
            continue;
          }
        }
        const keepGoing = pushOccurrence(candidate);
        if (!keepGoing) {
          break;
        }
      }

      cursor = addMonths(cursor, ruleValue.interval);
      if (ruleValue.count && generatedCount >= ruleValue.count && cursor < windowStart) {
        break;
      }
      if (until && cursor > until) {
        break;
      }
    }
  }

  if (ruleValue.freq === "YEARLY") {
    let cursor = new Date(baseDate.getTime());
    while (cursor <= windowEnd) {
      let candidate = new Date(
        Date.UTC(cursor.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate(), 0, 0, 0)
      );
      if (ruleValue.byMonthDay.length > 0) {
        const monthLastDay = new Date(
          Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, 0)
        ).getUTCDate();
        const dayValue = ruleValue.byMonthDay[0] > 0
          ? ruleValue.byMonthDay[0]
          : monthLastDay + ruleValue.byMonthDay[0] + 1;
        if (dayValue > 0 && dayValue <= monthLastDay) {
          candidate = new Date(
            Date.UTC(candidate.getUTCFullYear(), candidate.getUTCMonth(), dayValue, 0, 0, 0)
          );
        }
      }
      if (candidate >= baseDate) {
        if (ruleValue.byDay.length > 0) {
          const dayCode = INDEX_TO_DAY_CODE[candidate.getUTCDay()];
          if (ruleValue.byDay.includes(dayCode)) {
            const keepGoing = pushOccurrence(candidate);
            if (!keepGoing) {
              break;
            }
          }
        } else {
          const keepGoing = pushOccurrence(candidate);
          if (!keepGoing) {
            break;
          }
        }
      }
      cursor = addYears(cursor, ruleValue.interval);
      if (ruleValue.count && generatedCount >= ruleValue.count && cursor < windowStart) {
        break;
      }
      if (until && cursor > until) {
        break;
      }
    }
  }

  return occurrences
    .sort((left, right) => left.getTime() - right.getTime())
    .slice(0, maxOccurrences);
}

function buildOccurrenceItems(appointment, windowStartDate, windowEndDate, options = {}) {
  const includeBaseNonRecurring = options.includeBaseNonRecurring !== false;
  const maxOccurrences = Number.parseInt(options.maxOccurrences || "400", 10) || 400;
  const startDate = parseDateString(appointment?.date);
  const windowStart = parseDateString(windowStartDate);
  const windowEnd = parseDateString(windowEndDate);

  if (!startDate || !windowStart || !windowEnd || windowStart > windowEnd) {
    return [];
  }

  const base = {
    ...appointment,
    occurrenceKey: null,
    isOccurrence: false
  };

  if (!appointment?.isRecurring || !appointment?.rrule) {
    if (!includeBaseNonRecurring) {
      return [];
    }
    if (startDate < windowStart || startDate > windowEnd) {
      return [];
    }
    return [base];
  }

  const parsedRule = parseRRule(appointment.rrule);
  if (!parsedRule.isValid || !parsedRule.value) {
    return [];
  }

  const occurrenceDates = buildOccurrencesForRule(
    startDate,
    parsedRule.value,
    windowStart,
    windowEnd,
    maxOccurrences
  );

  return occurrenceDates.map((date) => {
    const dateString = formatDateString(date);
    return {
      ...appointment,
      date: dateString,
      time: appointment.time,
      occurrenceKey: `${appointment.id}:${dateString}T${appointment.time}`,
      isOccurrence: !isSameDay(date, startDate)
    };
  });
}

function estimateDurationMinutes(appointment) {
  const fromStart = new Date(`${appointment.date}T${appointment.time}:00`);
  const fromEnd = appointment.occurrenceEnd ? new Date(appointment.occurrenceEnd) : null;
  if (fromEnd && !Number.isNaN(fromEnd.getTime()) && !Number.isNaN(fromStart.getTime())) {
    const delta = Math.round((fromEnd.getTime() - fromStart.getTime()) / (60 * 1000));
    if (delta > 0 && delta <= 24 * 60) {
      return delta;
    }
  }
  return 60;
}

function overlapsSameDay(startTimeA, durationA, startTimeB, durationB) {
  const [aHour, aMinute] = String(startTimeA || "00:00").split(":").map(Number);
  const [bHour, bMinute] = String(startTimeB || "00:00").split(":").map(Number);
  if (!Number.isInteger(aHour) || !Number.isInteger(aMinute)) {
    return false;
  }
  if (!Number.isInteger(bHour) || !Number.isInteger(bMinute)) {
    return false;
  }
  const startA = aHour * 60 + aMinute;
  const endA = startA + durationA;
  const startB = bHour * 60 + bMinute;
  const endB = startB + durationB;
  return startA < endB && startB < endA;
}

function detectConflicts(candidate, existing, windowStartDate, windowEndDate) {
  const candidateOccurrences = buildOccurrenceItems(candidate, windowStartDate, windowEndDate, {
    maxOccurrences: 500
  });
  const candidateDuration = estimateDurationMinutes(candidate);
  const conflicts = [];

  for (const appointment of existing) {
    const existingOccurrences = buildOccurrenceItems(appointment, windowStartDate, windowEndDate, {
      maxOccurrences: 500
    });
    const existingDuration = estimateDurationMinutes(appointment);

    for (const left of candidateOccurrences) {
      for (const right of existingOccurrences) {
        if (left.date !== right.date) {
          continue;
        }
        if (
          overlapsSameDay(left.time, candidateDuration, right.time, existingDuration)
        ) {
          conflicts.push({
            candidateOccurrenceKey: left.occurrenceKey || `${left.id}:${left.date}T${left.time}`,
            withAppointmentId: right.id,
            withTitle: right.title,
            date: left.date,
            time: left.time
          });
        }
      }
    }
  }

  return conflicts;
}

module.exports = {
  parseRRule,
  toRuleString,
  parseDateString,
  formatDateString,
  buildOccurrenceItems,
  detectConflicts
};

