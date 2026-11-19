import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { BookingLock } from "./worker.mjs";
import { candidates, isFree, settings } from "./schedule.mjs";

const completeSchedule = JSON.stringify(
  Object.fromEntries(
    Array.from({ length: 7 }, (_, day) => [day, [["09:00", "12:00"]]]),
  ),
);
const env = {
  SITE_ORIGIN: "https://nutricuida.cl",
  GOOGLE_CALENDAR_ID: "bookings",
  BUSY_CALENDAR_IDS: "other-agenda",
  GOOGLE_CLIENT_ID: "fixture-client",
  GOOGLE_CLIENT_SECRET: "fixture-secret",
  GOOGLE_REFRESH_TOKEN: "fixture-refresh",
  TURNSTILE_SECRET: "fixture-verification",
  PAYMENT_INSTRUCTIONS: "Instrucciones de prueba",
  BOOKING_WINDOWS: completeSchedule,
  BOOKING_DURATION_MINUTES: "30",
  BOOKING_HORIZON_DAYS: "3",
  BOOKING_NOTICE_MINUTES: "60",
  BOOKING_LIMIT: { limit: async () => ({ success: true }) },
};

test("applies Santiago winter and summer offsets and busy interval boundaries", () => {
  for (const [date, utcHour] of [
    ["2026-07-06", "13"],
    ["2026-12-07", "12"],
  ]) {
    const slots = candidates(settings(env), Date.parse(date + "T06:00:00Z"));
    assert.equal(
      new Date(slots[0].start).toISOString(),
      date + "T" + utcHour + ":00:00.000Z",
    );
    assert.equal(
      isFree(slots[0], [{ start: slots[0].end, end: slots[1].end }]),
      true,
    );
    assert.equal(
      isFree(slots[1], [{ start: slots[0].end, end: slots[1].end }]),
      false,
    );
  }
  assert.throws(() => settings({ ...env, BOOKING_WINDOWS: "{}" }));
});

test("loads real-API-shaped availability, fails closed and serializes concurrent bookings", async (t) => {
  const slots = candidates(settings(env), Date.now());
  assert(slots.length > 3);
  const calendar = new Map();
  let externalBusy = [
    {
      start: new Date(slots[0].start).toISOString(),
      end: new Date(slots[0].end).toISOString(),
    },
  ];
  let rejectAvailability = false;
  let meetReady = false;
  let creates = 0;
  let invitations = 0;
  const jobs = new Map();
  let alarm = null;
  const lock = new BookingLock(
    {
      storage: {
        get: async (key) => jobs.get(key),
        put: async (key, value) => jobs.set(key, value),
        delete: async (key) => jobs.delete(key),
        list: async () => jobs,
        getAlarm: async () => alarm,
        setAlarm: async (instant) => {
          alarm = instant;
        },
      },
    },
    env,
  );
  const bindings = {
    ...env,
    BOOKINGS: {
      idFromName: (name) => name,
      get: () => ({
        fetch: (url, options) => lock.fetch(new Request(url, options)),
      }),
    },
  };
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "fixture-token" });
    if (url.hostname === "challenges.cloudflare.com") {
      return Response.json({
        success: new URLSearchParams(options.body).get("response") === "valid",
        hostname: "nutricuida.cl",
        action: "booking",
      });
    }
    assert.equal(url.hostname, "www.googleapis.com");
    if (url.pathname.endsWith("/freeBusy"))
      return Response.json({
        calendars: {
          bookings: {
            busy: [...calendar.values()].map((event) => ({
              start: event.start.dateTime,
              end: event.end.dateTime,
            })),
          },
          "other-agenda": rejectAvailability
            ? { errors: [{ reason: "forbidden" }] }
            : { busy: externalBusy },
        },
      });
    if (options.method === "POST") {
      assert.equal(url.searchParams.get("sendUpdates"), "none");
      const event = JSON.parse(options.body);
      assert.equal(
        event.conferenceData.createRequest.conferenceSolutionKey.type,
        "hangoutsMeet",
      );
      assert(!event.description.includes("Motivo privado"));
      assert.equal(event.extendedProperties.private.reason, "Motivo privado");
      creates++;
      calendar.set(event.id, event);
      return Response.json(event);
    }
    const id = url.pathname.split("/").at(-1);
    const event = calendar.get(id);
    if (!event) return new Response(null, { status: 404 });
    if (meetReady) event.hangoutLink = "https://meet.google.com/abc-defg-hij";
    if (options.method === "PATCH") {
      invitations++;
      assert.equal(url.searchParams.get("sendUpdates"), "all");
      assert.match(event.description, /60 minutos/);
      assert.match(event.description, /Instrucciones de prueba/);
      Object.assign(event, JSON.parse(options.body));
    }
    return Response.json(event);
  });

  const web = (path, method = "GET", body, origin = env.SITE_ORIGIN) =>
    worker.fetch(
      new Request("https://api.example.test" + path, {
        method,
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: body && JSON.stringify(body),
      }),
      bindings,
    );
  assert.equal(
    (await web("/availability", "GET", undefined, "https://other.example.test"))
      .status,
    403,
  );
  assert.equal((await web("/bookings", "OPTIONS")).status, 204);
  const response = await web("/availability");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const availability = (await response.json()).slots;
  assert.equal(availability[0].start, new Date(slots[1].start).toISOString());
  rejectAvailability = true;
  assert.equal((await web("/availability")).status, 503);
  rejectAvailability = false;

  const patient = {
    start: availability[0].start,
    requestId: crypto.randomUUID(),
    name: "Paciente de prueba",
    email: "paciente@example.test",
    phone: "+56 9 1111 1111",
    reason: "Motivo privado",
    token: "valid",
  };
  assert.equal(
    (await web("/bookings", "POST", { ...patient, token: "invalid" })).status,
    403,
  );
  assert.equal(
    (await web("/bookings", "POST", { ...patient, phone: "abc" })).status,
    400,
  );
  const [first, competing] = await Promise.all([
    web("/bookings", "POST", patient),
    web("/bookings", "POST", {
      ...patient,
      requestId: crypto.randomUUID(),
      email: "otro@example.test",
    }),
  ]);
  assert.equal(first.status, 503);
  assert.equal((await first.json()).error, "pending");
  assert.equal(competing.status, 409);
  assert.equal(creates, 1);
  assert.equal(invitations, 0);

  assert.equal(jobs.size, 1);
  assert(alarm > Date.now());
  meetReady = true;
  await lock.alarm();
  assert.equal(jobs.size, 0);
  assert.equal(invitations, 1);
  const confirmed = await web("/bookings", "POST", patient);
  assert.deepEqual(await confirmed.json(), {
    start: patient.start,
    meet: "https://meet.google.com/abc-defg-hij",
  });
  assert.equal(confirmed.status, 201);
  assert.equal((await web("/bookings", "POST", patient)).status, 201);
  assert.equal(creates, 1);
  assert.equal(invitations, 1);
  assert(
    !(await (await web("/availability")).json()).slots.some(
      (slot) => slot.start === patient.start,
    ),
  );
});
