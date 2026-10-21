# Cierre del MVP — correo transaccional y deuda de la fase 6

Tras cerrar la parte técnica de la fase 6, el único hueco de código del MVP es la **entrega fuera de la aplicación** de los avisos. D-020 la comprometió («correo transaccional propio, nunca el Gmail del usuario, en la fase 6»), y la factoría lo dice («Live delivery … is wired in phase 6»). Hoy solo existe `FakeNotifier`: el resumen diario, los riesgos y los avisos de cuenta (pago fallido, conexión caducada) solo se ven si la persona abre Meri. Todas las funciones MUST de `docs/01` (F-01..F-16) están cubiertas.

## Decisiones

- **D-113 Correo transaccional por SMTP** (ADR 0009):
  - Adaptador `SmtpNotifier` con `nodemailer`. Todos los proveedores (SES, Postmark, Resend, Mailgun) aceptan SMTP: el proveedor lo elige una persona sin cambiar código.
  - `NOTIFY_MODE=fake|live`, `SMTP_URL`, `MAIL_FROM`; bloqueo `email` en `blockers.json` y `docs/blockers/email.md`.
  - En `live` sin credenciales, la app falla al arrancar citando la variable y la guía. En producción `fake` está prohibido.
  - Tests en vivo contra un servidor SMTP real en proceso (`smtp-server`): protocolo de verdad, no un simulador de API.
- **D-114 Qué se envía**:
  - Preferencia por workspace `preferences.email_notifications`:
    - `off`: nada;
    - `digest` (por defecto): resumen diario y avisos de cuenta (`digest`, `billing`, `integration`);
    - `all`: además riesgos, propuestas y plan.
  - El cuerpo lleva **recuentos y un enlace**, nunca títulos de tareas, nombres de clientes ni texto de correo. Así el proveedor de correo no recibe datos de clientes; es un subencargado más (`docs/compliance/subprocessors.md`).
  - Idioma: el de la persona (`users.locale`), es o en.
  - Se escribe al propietario del workspace. Nunca a la cuenta de demo ni a un workspace borrado.
- **D-115 Cómo se entrega**:
  - Las notificaciones in-app siguen como están: 8 sitios las crean.
  - El despachador `notify.email` (cada minuto) elige las notificaciones de las últimas 2 h sin estado de correo cuya preferencia lo permite, y encola un job por notificación (`jobId` por id).
  - El handler vuelve a comprobar la preferencia dentro de la transacción del workspace, envía y marca `email_state` (`sent`/`skipped`/`failed`) y `emailed_at`.
  - Al menos una vez: si cae entre enviar y marcar, el reintento puede repetir un correo (raro, aceptado). Un error permanente (dirección rechazada) marca `failed` y no reintenta.
  - Se quitan las llamadas directas al notifier de `daily.review` y `planner.replan`.
- **D-116 Baja en un clic** (RFC 8058):
  - Cada correo lleva `List-Unsubscribe` (URL https con token) y `List-Unsubscribe-Post`.
  - Token = HMAC-SHA256 con clave derivada por HKDF de `AUTH_SECRET` (etiqueta propia) sobre `email-unsubscribe:v1:<workspaceId>`. Sin caducidad: un enlace de baja debe funcionar siempre.
  - `POST /v1/email/unsubscribe?t=` es público y sin CSRF: lo llaman los servidores de correo, el token es la autorización y la acción solo reduce envíos. Pone `off`, audita `notifications.email_unsubscribed` y responde igual sea cual sea el estado previo; un token inválido da 400.
  - Un GET nunca da de baja: los escáneres de enlaces abren las URL. El enlace del cuerpo lleva a la página pública `/correo/baja?t=`, con un botón que hace el POST.
  - La preferencia también se cambia en Control → Avisos y en Más → Ajustes.

## Pasos
1. Plan, ADR 0009, `docs/13`, bloqueo `email`.
2. Config y factoría: env, modo `notify`, `SmtpNotifier` + `FakeNotifier` con la nueva forma de mensaje, tests con `smtp-server`, `pnpm smoke email`.
3. Core: `emailAllowed`, `renderNotificationEmail` (es/en, recuentos y enlace, escapado) + tests; token de baja en `@meri/config` + tests.
4. DB: migración 0024 (`preferences.email_notifications`, `notifications.email_state`, `emailed_at`, índice parcial) + repos + tests.
5. Jobs y worker: job `notify.email`, despachador, quitar las llamadas antiguas, tests (preferencias, demo, borrado, idioma, fallo permanente, sin contenido).
6. API: preferencia en `/v1/preferences`, `POST /v1/email/unsubscribe` + tests (token, idempotencia, aislamiento, matriz de autorización).
7. Web: panel de preferencia en Control y Más → Ajustes, página `/correo/baja`, middleware, actividad, privacidad; E2E.
8. Deuda de la fase 6 asequible:
   - E2E de la tarjeta Sean Ellis y de `/precios`;
   - nota de cohorte solo cuando el precio difiere;
   - anillo de foco del rail con contraste ≥ 3:1;
   - tope global de la lista de espera en Redis;
   - `pnpm demo --build`.
9. Cierre: verify, E2E completo, revisores, STATE e informe final actualizados.

## Fuera de alcance
Push web o móvil (post-MVP), plantillas HTML con marca (dependen del dominio), canal de webhooks de Google en vivo (`watch`): el sondeo cada 5 min ya cubre el MVP.
