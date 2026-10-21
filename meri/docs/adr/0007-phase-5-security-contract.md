# 0007. Seguridad y cumplimiento: contrato de la fase 5

- Estado: aceptada
- Fecha: 2026-10-20

## Contexto
La fase 5 (docs/06, F-16) endurece la sesión, la conexión OAuth y la API, integra un KMS real, añade copias cifradas, completa la exportación y la supresión de datos y hace inmutable la auditoría. Las revisiones del plan (`phases/05-security-compliance/PLAN.md`, sección «Revisión») detectaron que la revocación por `iat` de un JWT de Auth.js es eludible, que el rol de la app podía borrar un workspace y con él su auditoría en cascada, y que los scripts de administración no pueden suponer un superusuario bajo FORCE RLS.

## Opciones consideradas
- **Revocación de sesiones**: sesiones en base de datos (Auth.js `database`) frente a JWT con una marca de tiempo de autenticación. Se mantiene JWT (sin tabla ni consulta por petición en la web) con `authTime` fijado al iniciar sesión y `users.sessions_valid_after`, que la guardia de sesión de la API ya consulta con caché.
- **KMS**: AWS y GCP a la vez con firmas propias frente a un proveedor con su SDK oficial. Se elige **AWS KMS** con `@aws-sdk/client-kms` (cadena de credenciales estándar, roles antes que claves); GCP queda detrás de la misma interfaz para cuando se elija ese proveedor.
- **DEK**: por workspace (docs/06 §2) frente a por blob (implementación actual). Se mantiene **por blob**: una DEK nueva por cada cifrado, envuelta por KMS; no hay tabla de claves que proteger y la rotación de la KEK solo reenvuelve. docs/06 §2 queda corregido por este ADR.
- **Purga**: conexión de administrador en el worker frente a una función `SECURITY DEFINER`. Se elige la función: el worker procesa contenido no confiable y no debe tener credenciales de propietario.

## Decisión
1. **Sesión**: claim `authTime` (segundos) fijado solo al iniciar sesión y obligatorio en `SessionClaims`; la API rechaza (401) una sesión con `authTime` anterior a `users.sessions_valid_after` o de más de 14 días. `POST /v1/account/sessions/revoke` (CSRF, `Idempotency-Key` no requerido, 5/min) fija `sessions_valid_after = now()` y audita `account.sessions_revoked`. La identidad se ata al sujeto del proveedor (`users.auth_subject`: `google:<sub>`; en desarrollo `dev:<email>`); el login de Google exige `email_verified`; un email existente con otro sujeto → 409 en el bootstrap.
2. **CSRF**: además de `x-requested-with: meri`, una escritura con sesión con `Sec-Fetch-Site` distinto de `same-origin`/`none`, o con `Origin` presente que no sea exactamente el de `APP_URL` o `API_URL`, → 403.
3. **Límites**: almacén Redis compartido para el rate limit con `skipOnError` (disponibilidad antes que límite si Redis cae); `POST /v1/capture` 60/min; `/internal/auth/bootstrap` 30/min por email normalizado (gancho `preHandler`).
4. **OAuth de integraciones**: PKCE S256; cookie de estado HttpOnly firmada con una clave HKDF derivada de `AUTH_SECRET`, con `state`, `code_verifier`, `workspaceId` y función; comparación en tiempo constante; el login pide solo `openid email profile`.
5. **KMS y claves**: `KMS_PROVIDER=aws` con `KMS_KEY_ID`, `AWS_REGION` y `KMS_PREVIOUS_KEY_IDS` (claves antiguas solo para descifrar); contexto de cifrado `{ purpose }` (`integration-tokens`, `backup`). `pnpm keys:rotate [--reencrypt]` reenvuelve o recifra los tokens con compare-and-swap, con el rol de la app.
6. **Copias**: formato `MERI-BACKUP-1` (STREAM: nonce = prefijo ‖ contador ‖ último; AAD = hash de la cabecera); `pnpm backup` con el rol propietario bajo el contexto de lectura admin y `--enable-row-security` (sin `BYPASSRLS`), manifiesto contado en la misma instantánea que el volcado; `pnpm restore` solo sobre una base vacía, verificando el archivo entero antes y reaplicando las supresiones registradas; `pnpm dr:drill` mide el RTO.
7. **Supresión (F-16)**: `meri_app` pierde `DELETE`/`TRUNCATE` sobre `workspaces` y `users`; `purge_workspace(uuid)` (`SECURITY DEFINER`) purga un workspace borrado hace más de 30 días, a sus usuarios sin otros workspaces y deja un recibo sin datos personales en `deletion_receipts` (sin permisos para la app). Cola `data.delete_account { workspaceId }` diaria; después borra el cliente en Stripe. La lista de tablas está clasificada en código y un test falla si aparece una tabla sin clasificar.
8. **Exportación**: `GET /v1/account/export?format=zip` sincrónica (`export.json` + un CSV por colección); sin parámetro sigue siendo el JSON `meri-export/1`.
9. **Retención**: `data.retention` purga también propuestas descartadas o caducadas; `retentionDays` acepta 7–365.
10. **Auditoría**: trigger que rechaza todo UPDATE y todo DELETE directo de `audit_log`; solo la cascada de `purge_workspace` lo borra.
11. **CI**: CodeQL (`security-extended`), SBOM CycloneDX como artefacto, cliente `postgresql-client-16` para los tests de copias.

## Consecuencias
- Migraciones 0017 (sesiones e identidad), 0018 (supresión y recibos), 0019 (trigger de auditoría).
- Las sesiones emitidas antes de 0017 no llevan `authTime`: dejan de valer y piden volver a entrar una vez.
- Nuevas variables: `KMS_PREVIOUS_KEY_IDS`, `LOCAL_PREVIOUS_MASTER_KEYS`, `AWS_REGION` (y las credenciales estándar de AWS solo si no hay rol).
- Bloqueos humanos que no ejecuta el código: crear la clave KMS y su política, programar la copia diaria, el almacenamiento con bloqueo de objetos para las copias, staging, GitHub Advanced Security si el repositorio es privado.

## Adenda (D-093): scopes de Calendar
- **Contexto:** `calendars.insert` (crear el calendario «Meri») no es posible con `calendar.events` + `calendar.readonly`; además `calendar.events` permite editar cualquier evento de cualquier calendario del usuario, más de lo que el producto necesita.
- **Decisión:** `CALENDAR_SCOPES = [calendar.readonly, calendar.app.created]`. Lectura de todos los calendarios para planificar; escritura solo en los calendarios que Meri creó. `FORBIDDEN_SCOPES` (`gmail.send`, `https://mail.google.com/`, `gmail.modify`, `calendar`, `calendar.events`) con test.
- **Consecuencias:** `docs/06` §1 y `docs/blockers/google-oauth.md` actualizados; la pantalla de consentimiento declara los dos scopes nuevos; las conexiones previas siguen leyendo y el panel de permisos invita a reconectar para estrechar la escritura. Ningún cambio de API ni de esquema.
