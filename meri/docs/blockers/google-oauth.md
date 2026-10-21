# Proyecto OAuth de Google

**Variables:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_MODE=live`
**Desbloquea:** calendario real (Fase 1), Gmail real (Fase 2), beta (Fase 6).
**Mientras tanto:** `FakeCalendar` y `FakeGmail`.

## Pasos
1. En Google Cloud Console, crea un proyecto llamado `meri`.
2. Activa las APIs: **Gmail API**, **Google Calendar API** y **Cloud Pub/Sub API**.
3. Pantalla de consentimiento OAuth: tipo **Externo**, nombre «Meri», correo de soporte, enlaces a política de privacidad y términos (`/privacy` y `/terms`), dominio autorizado.
4. Scopes que debes declarar (mínimos):
   - `openid`, `email`, `profile`
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/calendar.app.created` (crea el calendario «Meri» y solo escribe en él)
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.compose`
   - **No** pidas `gmail.send`, `calendar` ni `calendar.events` (lista en `FORBIDDEN_SCOPES`, `packages/integrations/src/oauth/scopes.ts`).
5. Mientras la app esté en estado **Testing**, añade a los usuarios de prueba (hasta 100).
6. Credenciales, crear ID de cliente OAuth tipo **Aplicación web**. URIs de redirección:
   - `http://localhost:3000/api/auth/callback/google`
   - la de producción cuando exista dominio.
7. Gmail push: crea un tema de Pub/Sub `gmail-push`, da el rol *Publisher* a `gmail-api-push@system.gserviceaccount.com` y crea una suscripción push hacia `${API_URL}/webhooks/google/gmail`. Hasta tener URL pública usa el *polling* de respaldo.
8. Copia el ID y el secreto a `.env` y pon `GOOGLE_MODE=live`.
9. `pnpm blockers`, luego `/connect-blocker google-oauth`.

## Cosas que muerden
- En estado **Testing**, los *refresh tokens* de apps externas caducan a los **7 días**. Hay que reconectar. Es normal en la fase de pruebas.
- Los scopes de Gmail (`readonly`, `compose`) son **restringidos**: para uso real Google exige verificación de la app y una evaluación de seguridad anual (CASA). Los de Calendar son sensibles (verificación, sin CASA).
- La verificación necesita **dominio verificado** y política de privacidad pública. Resuelve antes [domain-brand.md](domain-brand.md).
- Respeta la política de uso limitado de datos de Google: nada de publicidad ni entrenar modelos generales con datos de Gmail.

## Verificación de humo (`scripts/smoke/google-oauth.ts`)
- Calendar: listar calendarios, crear y borrar un evento de prueba en el calendario «Meri».
- Gmail: leer el perfil y listar 1 mensaje solo con metadatos. No debe crear ni enviar nada.
- En `live` necesita una conexión de una cuenta de prueba: exporta en la shell (no en el repo) `SMOKE_GOOGLE_EMAIL` y `SMOKE_GOOGLE_REFRESH_TOKEN` (obtenido conectando esa cuenta en un entorno local con `GOOGLE_MODE=live`, o con el OAuth Playground usando tu propio cliente). El script lo cambia por un token de acceso y no lo imprime. Si la concesión trae un scope prohibido (`gmail.send`), falla.

## Paquete de verificación (Fase 5)
Todo el paquete (justificación de cada scope, guion del vídeo, pantalla de consentimiento, uso limitado, CASA) está en [`docs/google-verification.md`](../google-verification.md).
