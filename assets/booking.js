const form = document.querySelector("#booking-form");
const status = document.querySelector("#booking-status");
const retry = document.querySelector("#booking-retry");
const dateGroup = document.querySelector("#booking-date-group");
const timeGroup = document.querySelector("#booking-time-group");
const dates = document.querySelector("#booking-dates");
const times = document.querySelector("#booking-times");
const fields = document.querySelector("#booking-fields");
const verify = document.querySelector("#booking-verify");
const submit = form.querySelector("button[type=submit]");
const confirmation = document.querySelector("#booking-confirmation");
const endpoint = document
  .querySelector('meta[name="booking-api"]')
  .content.replace(/\/$/, "");
const siteKey = document.querySelector(
  'meta[name="booking-turnstile"]',
).content;
const zone = "America/Santiago";
const timesFormat = new Intl.DateTimeFormat("es-CL", {
  timeZone: zone,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dayFormat = new Intl.DateTimeFormat("es-CL", {
  timeZone: zone,
  weekday: "short",
});
const monthFormat = new Intl.DateTimeFormat("es-CL", {
  timeZone: zone,
  month: "short",
});
const confirmationFormat = new Intl.DateTimeFormat("es-CL", {
  timeZone: zone,
  dateStyle: "full",
  timeStyle: "short",
});
let widgetPromise;
let attempt;
let locked = false;

function message(text) {
  status.textContent = text;
}

function option(container, name, value, content) {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.required = true;
  const text = document.createElement("span");
  text.append(...content);
  label.append(input, text);
  container.append(label);
}

async function request(path, options) {
  const response = await fetch(endpoint + path, {
    ...options,
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error), { code: result.error });
  return result;
}

function showTimes(slots) {
  times.replaceChildren();
  for (const slot of slots) {
    option(times, "start", slot.start, [
      timesFormat.format(new Date(slot.start)),
    ]);
  }
  timeGroup.disabled = false;
  timeGroup.hidden = false;
  fields.hidden = true;
  fields.disabled = true;
  verify.hidden = true;
  submit.hidden = true;
  message("Selecciona una hora para continuar.");
}

async function load() {
  retry.hidden = true;
  dateGroup.hidden = true;
  timeGroup.hidden = true;
  fields.hidden = true;
  fields.disabled = true;
  verify.hidden = true;
  submit.hidden = true;
  dates.replaceChildren();
  times.replaceChildren();
  message("Consultando disponibilidad…");
  try {
    const { slots } = await request("/availability");
    const days = new Map();
    for (const slot of slots) {
      if (!days.has(slot.date)) days.set(slot.date, []);
      days.get(slot.date).push(slot);
    }
    if (!days.size) {
      message(
        "Por ahora no hay horas disponibles. Puedes volver a consultar o escribirnos por WhatsApp.",
      );
      retry.hidden = false;
      return;
    }
    for (const [date, daySlots] of days) {
      const instant = new Date(daySlots[0].start);
      const day = document.createElement("strong");
      day.textContent = String(Number(date.slice(-2)));
      option(dates, "date", date, [
        dayFormat.format(instant),
        day,
        monthFormat.format(instant),
      ]);
    }
    dateGroup.disabled = false;
    dateGroup.hidden = false;
    dates.onchange = (event) => showTimes(days.get(event.target.value));
    message(
      "Selecciona un día. Los horarios se muestran en hora de Chile continental.",
    );
  } catch {
    message("No pudimos cargar la disponibilidad. Intenta nuevamente.");
    retry.hidden = false;
  }
}

function widget() {
  widgetPromise ??= new Promise((resolve, reject) => {
    const callback = "initNutriCuidaTurnstile";
    window[callback] = () => {
      delete window[callback];
      try {
        resolve(
          window.turnstile.render(verify, {
            sitekey: siteKey,
            action: "booking",
            size: verify.clientWidth < 300 ? "compact" : "flexible",
            language: "es",
          }),
        );
      } catch (error) {
        reject(error);
      }
    };
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=" +
      callback;
    script.onerror = () => {
      script.remove();
      delete window[callback];
      reject(new Error("verification"));
    };
    document.head.append(script);
  }).catch((error) => {
    widgetPromise = undefined;
    throw error;
  });
  return widgetPromise;
}

times.addEventListener("change", () => {
  fields.hidden = false;
  fields.disabled = false;
  verify.hidden = false;
  submit.hidden = false;
  message("Completa tus datos para reservar la hora seleccionada.");
  widget().catch(() =>
    message(
      "No se pudo cargar la verificación. Puedes reintentar al reservar.",
    ),
  );
});

retry.addEventListener("click", load);
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (locked) return;
  locked = true;
  submit.disabled = true;
  let widgetId;
  let uncertain = Boolean(attempt);
  try {
    widgetId = await widget();
    const token = window.turnstile.getResponse(widgetId);
    if (!token) {
      message("Completa la verificación antes de reservar.");
      return;
    }
    if (!attempt) {
      const payload = Object.fromEntries(new FormData(form));
      delete payload.date;
      attempt = { ...payload, requestId: crypto.randomUUID() };
    }
    dateGroup.disabled = true;
    timeGroup.disabled = true;
    fields.disabled = true;
    uncertain = true;
    message("Registrando tu reserva…");
    const result = await request("/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...attempt, token }),
    });
    confirmation.querySelector("p").textContent =
      "Tu consulta online es el " +
      confirmationFormat.format(new Date(result.start)) +
      " (hora de Chile continental). Enviamos una invitación al correo que ingresaste.";
    confirmation.querySelector("a").href = result.meet;
    form.hidden = true;
    status.textContent = "";
    confirmation.hidden = false;
    confirmation.focus();
  } catch (error) {
    if (error.code === "taken") {
      attempt = undefined;
      uncertain = false;
      submit.textContent = "Confirmar reserva";
      await load();
      if (!dateGroup.hidden)
        message("Esa hora ya no está disponible. Selecciona otra.");
    } else if (error.code === "invalid" || error.code === "verification") {
      if (error.code === "invalid") {
        attempt = undefined;
        uncertain = false;
        submit.textContent = "Confirmar reserva";
      }
      message(
        error.code === "invalid"
          ? "Revisa tus datos y vuelve a intentar."
          : "Completa de nuevo la verificación.",
      );
    } else if (error.code === "support") {
      message(
        "La hora quedó registrada, pero Google Meet no se pudo generar. Escríbenos por WhatsApp para confirmarla.",
      );
      submit.hidden = true;
    } else {
      message(
        !uncertain
          ? "No se pudo cargar la verificación. Intenta nuevamente."
          : "Aún no podemos confirmar el resultado. Completa de nuevo la verificación y reintenta con la misma hora y los mismos datos.",
      );
      if (attempt) submit.textContent = "Reintentar confirmación";
    }
  } finally {
    if (widgetId !== undefined) window.turnstile.reset(widgetId);
    locked = false;
    submit.disabled = false;
    if (!uncertain) {
      dateGroup.disabled = dateGroup.hidden;
      timeGroup.disabled = timeGroup.hidden;
      fields.disabled = fields.hidden;
    }
  }
});

if (endpoint && siteKey) load();
else
  message(
    "La reserva en línea todavía no está habilitada. Puedes contactarnos por WhatsApp.",
  );
