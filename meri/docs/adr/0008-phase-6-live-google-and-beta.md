# 0008. Fase 6: Google en vivo, acceso por cuenta y programa de beta

- Estado: aceptada
- Fecha: 2026-10-21

## Contexto
La beta necesita correo y calendarios reales: hasta ahora `GOOGLE_MODE=live` lanzaba «no implementado» y los tokens simulados no caducaban, así que no había refresco. La fase 6 también pide invitaciones, lista de espera, comentarios, encuesta Sean Ellis, cohortes de precio, panel de decisión y muestra de calidad de IA. Decisiones detalladas y revisión del plan en `phases/06-beta-validation/PLAN.md` (D-096..D-104 y su sección de revisión, que prevalece).

## Opciones consideradas
- **SDK `googleapis`** frente a **cliente propio sobre `fetch`**: el SDK trae cientos de APIs, incluido el envío de correo; un cliente propio con lista cerrada de rutas hace imposible enviar por construcción y deja menos superficie.
- **Refresco en cada adaptador** frente a **un proveedor de token por cuenta**: el segundo concentra el *compare-and-swap*, la deduplicación y el paso a `needs_reauth` en un solo sitio.
- **Push de Google en vivo** frente a **sondeo**: el push necesita un token por canal y OIDC de Pub/Sub (deuda del modelo de amenazas); hasta entonces, sondeo.

## Decisión
1. **Cliente Google** (`packages/integrations/src/google/`): `fetch` con timeout de 10 s, solo hosts de Google y HTTPS, sin redirecciones, tope de tamaño, respuestas validadas con Zod, errores = estado + razones (nunca cuerpos). 401 → un refresco forzado y un reintento; `invalid_grant` en el refresco → `AuthExpired`; `insufficientPermissions` → `AuthExpired` (falta un scope).
2. **Gmail sin envío por construcción**: rutas permitidas `GET users/me/profile|history|messages|messages/{id}` y `POST users/me/drafts`; cualquier otra se rechaza antes de llamar; el grep de CI cubre también `/send`.
3. **Acceso por cuenta**: `calendarFor(ref)` y `mailFor(ref)` reciben `GoogleAccountRef = { email, accessToken() }`. `googleAccess()` (jobs y API) descifra una vez, memoriza el token, refresca fuera de transacción con un único refresco en vuelo por cuenta, persiste con *compare-and-swap* conservando identidad y scopes del blob guardado, y marca `needs_reauth` solo si el cifrado sigue siendo el que falló.
4. **Calendario**: `calendar_events` gana `calendar_id` en la clave única y la resincronización por `410` es por calendario; solo se sincronizan calendarios `owner|writer` seleccionados (sin festivos, contactos ni números de semana); el calendario «Meri» se crea una vez y su id se guarda por cuenta (`integration_accounts.meri_calendar_id`); solo se escribe en él y en eventos con la marca `meri=1`. `412` = `Permanent` y borrar un evento inexistente = hecho, igual en el simulado.
5. **Scopes**: toda conexión pide `openid email` además de los de la función; se guardan los concedidos; una concesión con un scope prohibido se rechaza; Gmail exige `readonly` y `compose`.
6. **Push desactivado en vivo**: con `GOOGLE_MODE=live` los webhooks de Google responden 404; los dispatchers sondean.
7. **Beta**: `BETA_INVITE_ONLY`; invitaciones y lista de espera (clase `global_personal`, borradas en el bootstrap y en la purga por correo, `pnpm beta:forget`); `POST /v1/waitlist` público con CSRF por cabecera y `Origin` aunque no haya sesión; `POST /v1/feedback`; encuesta `sean_ellis`; error `BETA_INVITE_REQUIRED`.
8. **Precio**: cohorte determinista por workspace fijada en `subscriptions.price_cohort`; precios A y B (mensual y anual) conocidos por el proveedor de pagos y el webhook; el cliente nunca elige precio.
9. **Panel y calidad de IA**: agregados con conexión administradora de solo lectura; muestra de calidad solo de propuestas que no vienen del correo y de cuentas con `evalConsent`.

## Consecuencias
- Migraciones nuevas (calendarios por id, `meri_calendar_id`, beta, encuestas, cohorte, preferencia de consentimiento, purga ampliada).
- Los adaptadores en vivo solo se prueban contra un Google simulado; la primera prueba real es `pnpm smoke google-oauth` con credenciales (humano).
- En modo Testing de Google los refresh tokens caducan a los 7 días: la beta se limita a 100 usuarios y la reconexión es de un clic.
- Deuda: push en vivo (token por canal, OIDC de Pub/Sub), herramienta para la cola de errores.
