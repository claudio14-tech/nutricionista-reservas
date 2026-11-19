import { candidates, isFree, settings, zone } from "./schedule.mjs";

const json = (status, body) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (status, error) => json(status, { error });
const iso = (instant) => new Date(instant).toISOString();
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function readBooking(request) {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    const data = JSON.parse(text + decoder.decode());
    const clean = (key) =>
      typeof data[key] === "string" ? data[key].trim() : "";
    const booking = {
      start: Date.parse(clean("start")),
      requestId: clean("requestId"),
      name: clean("name"),
      email: clean("email"),
      phone: clean("phone"),
      reason: clean("reason"),
      token: clean("token"),
    };
    const { name, email, phone, reason, token, requestId, start } = booking;
    if (
      !Number.isFinite(start) ||
      !uuid.test(requestId) ||
      name.length < 2 ||
      name.length > 100 ||
      email.length > 254 ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ||
      phone.length > 25 ||
      !/^\+?[\d ()-]+$/.test(phone) ||
      !/^\d{8,15}$/.test(phone.replace(/\D/g, "")) ||
      reason.length > 160 ||
      /[\u0000-\u001f\u007f]/.test(name + reason) ||
      !token ||
      token.length > 2048
    )
      return null;
    return booking;
  } catch {
    return null;
  }
}

async function authorized(booking, env) {
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: booking.token,
      }),
      signal: AbortSignal.timeout(7000),
    },
  );
  if (!response.ok) throw new Error("Turnstile unavailable");
  const result = await response.json();
  return (
    result.success &&
    result.action === "booking" &&
    result.hostname === new URL(env.SITE_ORIGIN).hostname
  );
}

async function googleClient(env) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal: AbortSignal.timeout(7000),
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) throw new Error("Google authentication failed");
  const { access_token: token } = await response.json();
  if (!token) throw new Error("Google authentication failed");
  const events =
    "/calendars/" + encodeURIComponent(env.GOOGLE_CALENDAR_ID) + "/events";
  async function api(path, method = "GET", body, allowed = []) {
    const result = await fetch(
      "https://www.googleapis.com/calendar/v3" + path,
      {
        method,
        signal: AbortSignal.timeout(7000),
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: body && JSON.stringify(body),
      },
    );
    if (allowed.includes(result.status)) return null;
    if (!result.ok) throw new Error("Google Calendar unavailable");
    return result.json();
  }
  return {
    event: (id) => api(events + "/" + id, "GET", undefined, [404, 410]),
    create: (event) =>
      api(events + "?conferenceDataVersion=1&sendUpdates=none", "POST", event, [
        409,
      ]),
    invite: (id, email) =>
      api(
        events + "/" + id + "?conferenceDataVersion=1&sendUpdates=all",
        "PATCH",
        { attendees: [{ email }] },
      ),
    async busy(start, end) {
      const items = [
        ...new Set([
          env.GOOGLE_CALENDAR_ID,
          ...(env.BUSY_CALENDAR_IDS ?? "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
        ]),
      ].map((id) => ({ id }));
      const response = await api("/freeBusy", "POST", {
        timeMin: iso(start),
        timeMax: iso(end),
        items,
      });
      return items.flatMap(({ id }) => {
        const calendar = response.calendars?.[id];
        if (!Array.isArray(calendar?.busy) || calendar.errors?.length)
          throw new Error("FreeBusy unavailable");
        return calendar.busy.map((period) => {
          const start = Date.parse(period.start);
          const end = Date.parse(period.end);
          if (!(start < end)) throw new Error("Invalid busy period");
          return { start, end };
        });
      });
    },
  };
}

function ready(env) {
  return [
    "GOOGLE_CALENDAR_ID",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "TURNSTILE_SECRET",
    "PAYMENT_INSTRUCTIONS",
  ].every((key) => !!env[key]?.trim());
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const path = new URL(request.url).pathname;
    if (origin !== env.SITE_ORIGIN || !origin) return fail(403, "origin");
    if (!["/availability", "/bookings"].includes(path))
      return fail(404, "not_found");
    const headers = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    let result;
    try {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.BOOKING_LIMIT.limit({ key: ip + path });
      if (!success) result = fail(429, "rate_limit");
      else if (!ready(env)) result = fail(503, "unavailable");
      else if (path === "/availability" && request.method === "GET") {
        const slots = candidates(settings(env), Date.now());
        if (slots.length) {
          const google = await googleClient(env);
          const busy = await google.busy(slots[0].start, slots.at(-1).end);
          result = json(200, {
            slots: slots
              .filter((slot) => isFree(slot, busy))
              .map((slot) => ({ date: slot.date, start: iso(slot.start) })),
          });
        } else result = json(200, { slots: [] });
      } else if (path === "/bookings" && request.method === "POST") {
        const booking = await readBooking(request);
        if (!booking) result = fail(400, "invalid");
        else if (!(await authorized(booking, env)))
          result = fail(403, "verification");
        else {
          const lock = env.BOOKINGS.get(
            env.BOOKINGS.idFromName(env.GOOGLE_CALENDAR_ID),
          );
          result = await lock.fetch("https://booking.internal/reserve", {
            method: "POST",
            body: JSON.stringify(booking),
          });
        }
      } else result = fail(405, "method");
    } catch {
      result = fail(503, "unavailable");
    }
    return new Response(result.body, {
      status: result.status,
      headers: { ...Object.fromEntries(result.headers), ...headers },
    });
  },
};

async function eventId(start) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("nutricuida:" + start),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function meetLink(event) {
  const url =
    event.hangoutLink ??
    event.conferenceData?.entryPoints?.find(
      (entry) => entry.entryPointType === "video",
    )?.uri;
  return /^https:\/\/meet\.google\.com\/[a-z-]+$/.test(url ?? "")
    ? url
    : undefined;
}

async function inviteIfNeeded(google, event, email) {
  if (
    !event.attendees?.some(
      (attendee) => attendee.email?.toLowerCase() === email.toLowerCase(),
    )
  ) {
    await google.invite(event.id, email);
  }
}

async function book(booking, env, track, complete) {
  const google = await googleClient(env);
  const id = await eventId(booking.start);
  let event = await google.event(id);
  if (!event) {
    const slot = candidates(settings(env), Date.now()).find(
      (slot) => slot.start === booking.start,
    );
    if (!slot || !isFree(slot, await google.busy(slot.start, slot.end)))
      return fail(409, "taken");
    if (!(await track(id, booking.requestId))) return fail(409, "taken");
    event =
      (await google.create({
        id,
        summary: "NutriCuida · Consulta nutricional online",
        start: { dateTime: iso(slot.start), timeZone: zone },
        end: { dateTime: iso(slot.end), timeZone: zone },
        visibility: "private",
        guestsCanInviteOthers: false,
        guestsCanSeeOtherGuests: false,
        description:
          "<b>Valor $25.000 CLP.</b><br>Envía el comprobante dentro de los 60 minutos siguientes a la reserva.<br>" +
          env.PAYMENT_INSTRUCTIONS.replace(
            /[&<>]/g,
            (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char],
          ).replace(/\r?\n/g, "<br>"),
        extendedProperties: {
          private: {
            requestId: booking.requestId,
            name: booking.name,
            email: booking.email,
            phone: booking.phone,
            ...(booking.reason && { reason: booking.reason }),
          },
        },
        conferenceData: {
          createRequest: {
            requestId: booking.requestId,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      })) ?? (await google.event(id));
  }
  let meet;
  for (const wait of [0, 500, 1000]) {
    if (wait) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      event = await google.event(id);
    }
    if (!event) return fail(503, "pending");
    const owner = event.extendedProperties?.private;
    if (
      event.status === "cancelled" ||
      owner?.requestId !== booking.requestId ||
      owner.email !== booking.email ||
      Date.parse(event.start?.dateTime) !== booking.start
    ) {
      return fail(409, "taken");
    }
    meet = meetLink(event);
    if (meet) break;
    const state = event.conferenceData?.createRequest?.status?.statusCode;
    if (state === "failure") return fail(503, "support");
    if (state !== "pending") break;
  }
  if (!meet) return fail(503, "pending");
  await inviteIfNeeded(google, event, booking.email);
  await complete(id);
  return json(201, { start: iso(booking.start), meet });
}

// A single Durable Object per calendar serializes each check-and-create sequence.
export class BookingLock {
  queue = Promise.resolve();

  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
  }

  run(operation) {
    const current = this.queue.then(operation);
    this.queue = current.catch(() => {});
    return current;
  }

  async track(id, requestId) {
    const key = "invite:" + id;
    const previous = await this.storage.get(key);
    if (previous?.expires > Date.now() && previous.requestId !== requestId)
      return false;
    if ((await this.storage.getAlarm()) === null)
      await this.storage.setAlarm(Date.now() + 15_000);
    await this.storage.put(key, { requestId, expires: Date.now() + 900_000 });
    return true;
  }

  complete(id) {
    return this.storage.delete("invite:" + id);
  }

  async fetch(request) {
    const booking = await request.json();
    try {
      return await this.run(() =>
        book(
          booking,
          this.env,
          (id, requestId) => this.track(id, requestId),
          (id) => this.complete(id),
        ),
      );
    } catch {
      return fail(503, "unavailable");
    }
  }

  alarm() {
    return this.run(async () => {
      const pending = await this.storage.list({ prefix: "invite:", limit: 20 });
      if (!pending.size) return;
      // Schedule the next pass before external calls so transient failures can recover.
      await this.storage.setAlarm(Date.now() + 30_000);
      const google = await googleClient(this.env);
      for (const [key, task] of pending) {
        const id = key.slice("invite:".length);
        const event = await google.event(id);
        const owner = event?.extendedProperties?.private;
        if (
          task.expires < Date.now() ||
          event?.status === "cancelled" ||
          (event && owner?.requestId !== task.requestId) ||
          event?.conferenceData?.createRequest?.status?.statusCode === "failure"
        ) {
          await this.complete(id);
        } else if (event && owner?.email && meetLink(event)) {
          await inviteIfNeeded(google, event, owner.email);
          await this.complete(id);
        }
      }
    });
  }
}
