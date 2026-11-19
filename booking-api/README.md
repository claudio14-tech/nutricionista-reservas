# Reservas de NutriCuida

GitHub Pages sirve la interfaz. Un Cloudflare Worker separado consulta Google Calendar con OAuth y valida Cloudflare Turnstile. El navegador solo recibe los horarios libres, la confirmación de su propia cita y su enlace de Meet. La configuración pública consta de la URL del Worker y la clave pública de Turnstile.

## Configuración previa a producción

1. En Google Cloud, habilita Google Calendar API y configura OAuth con acceso offline para la cuenta organizadora. Usa los alcances `https://www.googleapis.com/auth/calendar.events` y `https://www.googleapis.com/auth/calendar.freebusy`. Valida que el token de actualización no corresponda a un consentimiento externo en modo de prueba que caduque en siete días. La cuenta debe poder crear Google Meet en el calendario de destino e invitar participantes externos.
2. Crea un widget Turnstile para `nutricuida.cl`. Configura como secretos del Worker `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `TURNSTILE_SECRET` y `PAYMENT_INSTRUCTIONS`. Define estas últimas con los datos bancarios y el canal oficial para entregar el comprobante. Usa el panel de Cloudflare o `wrangler secret put NOMBRE` desde `booking-api`.
3. Configura `GOOGLE_CALENDAR_ID` y, si corresponde, `BUSY_CALENDAR_IDS` como lista separada por comas. Incluye los calendarios que ocupen el tiempo de la profesional, especialmente el calendario de la agenda anterior. Proporciona `BOOKING_WINDOWS` como JSON con claves de domingo (0) a sábado (6) y pares de horas locales en formato HH:mm. Define `BOOKING_DURATION_MINUTES`, `BOOKING_HORIZON_DAYS` y `BOOKING_NOTICE_MINUTES` con las reglas aprobadas. Esos valores carecen de configuración inicial porque las reglas del programa de citas de Google Calendar no se obtienen desde FreeBusy.
4. En un entorno de prueba, usa un calendario, destinatario, instrucciones de pago y widget de prueba. Para probar desde otro origen configura `SITE_ORIGIN` y el hostname del widget para que coincidan. Verifica que llegue la invitación de Google Calendar con los datos de transferencia y que abra el Meet.
5. Tras la aprobación, despliega el Worker mediante Wrangler. Completa en `index.html` los metadatos públicos `booking-api` con su URL HTTPS y `booking-turnstile` con la clave pública del widget. Sustituye el canal anterior en la puesta en marcha para evitar carreras entre dos sistemas de reservas. La interfaz muestra que la reserva está deshabilitada mientras falte esa configuración.

## Operación

El Worker aplica el horario comercial y excluye los intervalos ocupados de Google Calendar. Un Durable Object por calendario serializa la comprobación y creación dentro de NutriCuida. El identificador estable del evento impide crear otro evento para la misma hora ante una respuesta perdida. Los cambios externos en Google Calendar pueden ocurrir entre la comprobación y la escritura. Coordina por un único canal las reservas simultáneas.

Calendar genera la conferencia de forma asíncrona. La aplicación permite reintentar la confirmación con la misma solicitud y los mismos datos. La invitación se solicita con `sendUpdates=all` cuando existe un enlace de Meet. Si Meet o la invitación siguen pendientes al terminar la petición, el Durable Object vuelve a intentar durante 15 minutos aunque el paciente cierre la página. Si Google rechaza la conferencia, la consulta queda registrada para atención manual. Un evento cancelado o movido puede conservar su identificador original en Calendar y requerir gestión manual para volver a ofrecer esa hora.

La reserva se crea antes de la transferencia. El valor es $25.000 CLP y el plazo para enviar el comprobante es de 60 minutos desde la reserva. No hay cancelación automática. Los datos de contacto y el motivo general quedan en propiedades privadas del evento. Limita el acceso al calendario a las personas que coordinan las consultas y aplica la política de retención de la consulta.

## Pruebas

Ejecuta `node --test booking-api/worker.test.mjs` desde la raíz. Las pruebas interceptan las llamadas a Google y Turnstile. Cubren zona horaria, intervalos ocupados, validación, concurrencia, reintento de Meet e invitación. Para desarrollo local, GitHub Pages se puede reproducir sirviendo la raíz del repositorio con `python3 -m http.server 8000`.
