# Runbook: despliegue

Cómo se lleva Meri a staging o producción (fase 6, D-098). Lo preparado en el repo: imágenes (`Dockerfile`), su construcción y arranque en CI (`.github/workflows/images.yml`), la comprobación de migraciones (`pnpm check:migrations`) y este orden. **Desplegar, elegir proveedor, el dominio, el gestor de secretos, las alertas y las copias en la nube son pasos humanos** (`docs/blockers/`); nada en el repo publica imágenes ni despliega.

## 1. Piezas

| Imagen (`--target`) | Qué es | Puerto / salud | Réplicas |
|---|---|---|---|
| `api` | Fastify (`/app/dist/main.js`) | 4000 · `GET /health` | ≥ 2 detrás del balanceador |
| `worker` | BullMQ + despachadores (`/app/dist/main.js`) | 4100 · `GET /ready` | ≥ 1 (los despachadores son idempotentes por `jobId`; el refresco de tokens usa *compare-and-swap*) |
| `web` | Next.js *standalone* (`/app/apps/web/server.js`) | 3000 · `GET /privacy` | ≥ 2 |
| `migrate` | `/app/dist/migrate-cli.js` con las migraciones de `packages/db/drizzle` | tarea única | 1, antes de cada versión |

- Todas corren como el usuario `node` (no root), con imagen base fijada por *digest* (`Dockerfile`, `NODE_IMAGE`). Para actualizar Node se cambian juntos la etiqueta y su *digest*.
- La imagen `web` se construye **por entorno**: `--build-arg API_URL=<URL interna de la API>` (Next fija el *rewrite* `/api/v1/*` al construir; no es un secreto).
- Ninguna imagen contiene secretos: `.dockerignore` excluye `.env*`, copias `*.mbk`, las muestras de revisión de IA y los informes de beta (carpetas locales ignoradas por git) y `.git`; CI comprueba que no hay `.env` en `/app` ni secretos en el `ENV` de la imagen.

## 2. Configuración (gestor de secretos → variables de entorno)

| Variable | Dónde | Nota |
|---|---|---|
| `APP_ENV=production` (o `staging`) | todas | Con `production`/`staging` los adaptadores `fake` y `KMS_PROVIDER=local` hacen fallar el arranque |
| `DATABASE_URL` (rol `meri_app`) | api, worker, web | Sin `BYPASSRLS`; contraseña en el gestor |
| `DATABASE_ADMIN_URL` (propietario) | worker, migrate | Solo lectura entre tenants para los despachadores (D-025); escritura solo en migraciones |
| `REDIS_URL` | api, worker | Redis con persistencia AOF y contraseña |
| `AUTH_SECRET`, `INTERNAL_API_SECRET` | api, web | Rotación: `docs/runbooks/key-rotation.md` |
| `APP_URL`, `API_URL`, `AUTH_URL`, `PUBLIC_DOMAIN` | todas | HTTPS; `APP_URL` es el origen exacto que comprueba el CSRF |
| `TRUST_PROXY_HOPS` | api | Número **exacto** de proxies delante de la API. El navegador llega a la API a través de la reescritura `/api/v1` de la web, así que la web cuenta como un salto: balanceador + web = 2. Con 0 se ignora `X-Forwarded-For`; un valor mayor que el real deja falsificar la IP y saltarse los límites por IP; uno menor hace que todos compartan la IP de la web y el límite de 5/min de la lista de espera se agote para todos. Compruébalo tras el despliegue: dos peticiones desde redes distintas deben verse con IPs distintas en los registros. El tope global de la lista de espera (300/h) es por proceso: con N réplicas de la API el tope efectivo es N × 300 |
| `GOOGLE_MODE=live`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | api, worker | `docs/blockers/google-oauth.md`. En `live` no hay *push*: el worker sondea cada 5 min (ADR 0008) |
| `AI_MODE=live`, `ANTHROPIC_API_KEY` | api, worker | `docs/blockers/anthropic.md` |
| `STRIPE_MODE=live`, `STRIPE_*` | api, worker | `docs/blockers/stripe.md` |
| `KMS_PROVIDER=aws`, `KMS_KEY_ID`, `AWS_REGION` | api, worker | `docs/blockers/kms.md` |
| `SENTRY_DSN`, `POSTHOG_KEY`, `ANALYTICS_MODE=live` | todas | `docs/blockers/observability.md` |
| `BETA_INVITE_REQUIRED=1` | api, web | Beta cerrada: las cuentas nuevas necesitan invitación (`pnpm beta:invite <correo>`; avisa al pasar de 100 personas, el tope de una app de Google en «Testing») |
| `LISTEN_HOST=0.0.0.0` | api, worker | Ya fijado en la imagen |

`pnpm blockers` dice qué falta sin imprimir valores. En `live` con una credencial ausente el proceso no arranca y cita la variable y su `docs/blockers/<id>.md`.

## 3. Orden de una versión

1. **CI en verde** en el commit: `ci.yml` (incluye `pnpm check:migrations`) e `images.yml` (construye y arranca las cuatro imágenes).
2. **Copia de seguridad** previa (`docs/runbooks/backup-restore.md`) si la versión trae migraciones.
3. **Migración**: ejecutar la imagen `migrate` una vez, con `DATABASE_ADMIN_URL`. Las migraciones son compatibles hacia atrás (*expand/contract*): la versión anterior de la API sigue funcionando con el esquema nuevo.
4. **API y worker**: desplegar la versión nueva con reemplazo gradual; esperar `GET /health` y `GET /ready`.
5. **Web**: desplegar la versión nueva (construida con el `API_URL` del entorno).
6. **Comprobación**: `pnpm smoke <id>` de cada servicio en `live` contra staging; revisar errores en Sentry durante 15 minutos.

### Migraciones seguras (`pnpm check:migrations`)
- Desde la `0021` (línea base) se rechazan: `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `ALTER COLUMN … TYPE`, `RENAME`, `DROP CONSTRAINT` sin recrearla en la misma migración; y por seguridad `DISABLE`/`NO FORCE ROW LEVEL SECURITY`, `DROP POLICY`, `DROP TRIGGER audit_log_*`, `GRANT … TO meri_app`, `SECURITY DEFINER` y `DELETE`/`UPDATE` sin `WHERE`. Los comentarios no cuentan y los cuerpos `DO $$ … $$` se analizan.
- Un cambio destructivo se hace en dos versiones: (1) *expand*: columna nueva, código que escribe en ambas y lee la nueva; (2) *contract*, cuando ninguna versión desplegada usa la antigua: el `DROP`, con `-- meri:destructive-approved <motivo de al menos 10 caracteres>` en la migración.
- La marca **no basta sola**: la ruta `meri/packages/db/drizzle/` tiene propietario en `.github/CODEOWNERS`, y la protección de rama debe exigir su revisión (**humano**: activar «Require review from Code Owners» en `main`).

## 4. Reversión
- **Código** (api, worker, web): volver a desplegar la imagen anterior. Es seguro porque las migraciones son compatibles hacia atrás.
- **Migración**: no hay migraciones «down». Si una migración rompe algo: desplegar código que no dependa de ella, o una migración correctora nueva. Pérdida de datos: restaurar según `docs/runbooks/disaster-recovery.md` (RPO/RTO allí).
- **Claves comprometidas**: `docs/runbooks/key-rotation.md`. **Caída de un proveedor**: `docs/runbooks/provider-outage.md`.

## 5. Alertas mínimas (a configurar por un humano en el proveedor elegido)

| Señal | Umbral | Acción |
|---|---|---|
| `GET /health` o `/ready` fallan | 2 comprobaciones seguidas | Página al de guardia; `docs/runbooks/incident-response.md` |
| Errores 5xx de la API | > 1 % durante 5 min | Revisar Sentry y el último despliegue; revertir |
| Cola de BullMQ con trabajos fallidos (DLQ) | > 20 en 15 min | Panel del worker; causa en los logs (`traceId`) |
| Conexiones en `needs_reauth` | aumento brusco (> 5 % en un día) | Probable cambio de credenciales o de verificación de Google |
| Coste de IA por usuario | > `AI_MONTHLY_COST_CAP_USD_PER_USER` | Puerta `aiBudget` ya corta; revisar `pnpm report:margins` |
| Copia de seguridad diaria | ausente 26 h | `docs/runbooks/backup-restore.md` |

## 6. Qué no está probado
Las imágenes se construyen y arrancan en CI contra Postgres y Redis efímeros con adaptadores `fake`. No se ha desplegado en ningún proveedor, ni probado con TLS, balanceador, KMS real ni credenciales reales: eso lo valida la persona que despliega, siguiendo este orden en staging.
