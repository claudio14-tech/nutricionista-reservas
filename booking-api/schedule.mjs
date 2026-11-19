export const zone = "America/Santiago";
const day = 86_400_000;
const minute = 60_000;
const localFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: zone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function localTime(instant) {
  const p = Object.fromEntries(
    localFormat.formatToParts(instant).map(({ type, value }) => [type, value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function toInstant(date, time) {
  const wall = `${date}T${time}`;
  const target = Date.parse(wall + "Z");
  // Probe offsets on both sides of a daylight-saving change.
  const offsets = [-day, day].map((delta) => {
    const probe = target + delta;
    return Date.parse(localTime(probe) + "Z") - probe;
  });
  return [...new Set(offsets)]
    .map((offset) => target - offset)
    .find((instant) => localTime(instant) === wall);
}

export function settings(env) {
  const schedule = JSON.parse(env.BOOKING_WINDOWS ?? "null");
  const duration = Number(env.BOOKING_DURATION_MINUTES);
  const horizon = Number(env.BOOKING_HORIZON_DAYS);
  const notice = Number(env.BOOKING_NOTICE_MINUTES);
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (
    !schedule ||
    Array.isArray(schedule) ||
    typeof schedule !== "object" ||
    !Object.keys(schedule).length ||
    !Object.entries(schedule).every(
      ([weekday, windows]) =>
        /^[0-6]$/.test(weekday) &&
        Array.isArray(windows) &&
        windows.length &&
        windows.every(
          (window) =>
            Array.isArray(window) &&
            window.length === 2 &&
            window.every((time) => clock.test(time)) &&
            window[0] < window[1],
        ),
    ) ||
    !Number.isInteger(duration) ||
    duration < 10 ||
    duration > 180 ||
    !Number.isInteger(horizon) ||
    horizon < 1 ||
    horizon > 31 ||
    !env.BOOKING_NOTICE_MINUTES ||
    !Number.isInteger(notice) ||
    notice < 0 ||
    notice > 10080
  ) {
    throw new Error("Invalid booking schedule configuration");
  }
  return {
    schedule,
    duration: duration * minute,
    horizon,
    notice: notice * minute,
  };
}

export function candidates({ schedule, duration, horizon, notice }, now) {
  const today = Date.parse(localTime(now).slice(0, 10) + "T00:00:00Z");
  const slots = new Map();
  for (let offset = 0; offset < horizon; offset++) {
    const date = new Date(today + offset * day);
    const dateKey = date.toISOString().slice(0, 10);
    for (const [from, to] of schedule[date.getUTCDay()] ?? []) {
      const first = toInstant(dateKey, from);
      const limit = toInstant(dateKey, to);
      if (first === undefined || limit === undefined) continue;
      for (let start = first; start + duration <= limit; start += duration) {
        if (start >= now + notice) {
          slots.set(start, { date: dateKey, start, end: start + duration });
        }
      }
    }
  }
  return [...slots.values()].sort((a, b) => a.start - b.start);
}

export function isFree(slot, busy) {
  return busy.every(
    (period) => slot.start >= period.end || slot.end <= period.start,
  );
}
