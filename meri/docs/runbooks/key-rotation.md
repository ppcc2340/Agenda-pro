# Runbook: rotación de claves

Qué secretos tiene Meri, cuándo se rotan y cómo (ADR 0007, D-085). Ningún paso imprime secretos: los scripts muestran recuentos e ids de clave.

## 1. Inventario

| Secreto | Dónde vive | Efecto de rotarlo | Rotación ordinaria |
|---|---|---|---|
| Clave KMS (`KMS_KEY_ID`) | AWS KMS | Nuevas DEK envueltas con la clave nueva; las antiguas siguen descifrables mientras estén en el anillo | anual (rotación automática de AWS) o tras compromiso |
| `LOCAL_MASTER_KEY` | solo desarrollo | — | — |
| `AUTH_SECRET` | gestor de secretos | Invalida todas las sesiones y la cookie de estado OAuth (HKDF) | anual o tras compromiso |
| `INTERNAL_API_SECRET` | gestor de secretos (web y API) | La web deja de poder llamar al bootstrap hasta desplegar ambas | anual o tras compromiso |
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY` | gestor de secretos | Webhooks rechazados hasta actualizar | tras compromiso |
| `GOOGLE_CLIENT_SECRET` | gestor de secretos | Los refresh tokens siguen valiendo con el secreto nuevo | tras compromiso |
| `ANTHROPIC_API_KEY` | gestor de secretos | — | tras compromiso |

## 2. Rotación ordinaria de la clave KMS (sin compromiso)

1. Crear la clave nueva en KMS con la misma política (humano).
2. Desplegar con `KMS_KEY_ID=<nueva>` y `KMS_PREVIOUS_KEY_IDS=<anterior>[,<más antiguas>]`. Desde ese momento todo lo que se cifra usa la nueva.
3. Reenvolver las DEK de los tokens guardados (rápido; no cambia los datos cifrados):
   ```bash
   pnpm keys:rotate
   ```
   Lista las cuentas con tokens, y para cada una, dentro de su workspace, reenvuelve con *compare-and-swap* (si el worker refrescó el token entretanto, reintenta). Idempotente: se puede repetir. Auditoría `security.keys_rotated`.
4. Comprobar que no queda nada con la clave anterior: volver a ejecutar `pnpm keys:rotate` y ver `rotated=0 failed=0` (todo en `current`). Un `failed>0` sale con código 2 y lista cuenta y motivo.
5. **Retirar la clave anterior** del anillo (y programar su borrado en KMS) solo cuando haya caducado la copia más antigua cifrada con ella (≤ 30 días después del paso 2). Antes, `pnpm restore` de esas copias la necesita.

## 3. Rotación tras un compromiso

Reenvolver no basta si alguien pudo leer las DEK o los tokens: hay que **cambiar los datos cifrados y los tokens**.

1. Abrir incidente S1 ([`incident-response.md`](incident-response.md)).
2. Clave nueva en KMS; desplegar como en §2.2.
3. Re-cifrar con DEK nuevas:
   ```bash
   pnpm keys:rotate --reencrypt
   ```
4. Revocar los tokens de Google afectados y pedir reconexión: marcar las cuentas como `needs_reauth` (la UI pide reconectar) y revocar en Google.
   ```sql
   -- como propietario, en el contexto de lectura admin
   set app.workspace_id = '*';
   update integration_accounts set status = 'needs_reauth', last_error = 'security rotation' where provider = 'google' and status <> 'revoked';
   ```
5. Desactivar la clave comprometida en KMS de inmediato (no esperar a la caducidad de las copias: esas copias se tratan como comprometidas y se sustituyen por una copia nueva, `pnpm backup`).
6. Rotar `AUTH_SECRET` si la exposición incluye el servidor web: todas las sesiones caen (es lo deseado).

## 4. `AUTH_SECRET` e `INTERNAL_API_SECRET`

Generar con `openssl rand -base64 48`. `AUTH_SECRET`: desplegar web y API a la vez; los usuarios vuelven a entrar. `INTERNAL_API_SECRET`: desplegar primero la API aceptando el nuevo (no hay doble valor: hacerlo en una ventana de mantenimiento corta) y después la web.

## 5. Verificación

- `pnpm smoke kms` cifra y descifra con los dos propósitos (`integration-tokens`, `backup`).
- `pnpm dr:drill` tras cada rotación: confirma que las copias nuevas se restauran.
