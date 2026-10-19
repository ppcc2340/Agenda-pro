# 0001. Ruta interna de arranque de sesión fuera de `/v1`

- Estado: aceptada
- Fecha: 2026-10-19

## Contexto
`docs/02` fija Auth.js (Google) en `apps/web` y la capa UI → API → core → db. Al iniciar sesión hay que crear `user + workspace + membership + preferences` y la web no debe tocar `packages/db` directamente. `docs/13` solo define `/v1`, `/webhooks/*`, `/health` y `/ready`.

## Opciones consideradas
1. Que la web escriba en la base de datos desde el callback de Auth.js (rompe la capa).
2. Mover Auth.js a Fastify (sin adaptador oficial; más código propio de OAuth).
3. Ruta interna servicio‑a‑servicio en la API, autenticada con secreto compartido.

## Decisión
Opción 3: `POST /internal/auth/bootstrap` en `apps/api`. Cabecera `X-Internal-Secret` comparada en tiempo constante con `INTERNAL_API_SECRET`. Cuerpo `{ email, name?, image?, locale? }` validado con Zod. Transacción única, idempotente por `email` (devuelve el mismo `userId`/`workspaceId` en cada login), ejecutada dentro de `withWorkspace(workspaceId)` para escribir `memberships` y `preferences` bajo RLS. Excluida de OpenAPI y del rate limit público (tiene el suyo). La sesión resultante es un JWT de Auth.js (cookie `HttpOnly`, `SameSite=Lax`, `Secure` en producción) que la API decodifica con la misma `AUTH_SECRET`.

## Consecuencias
- El contrato público de `docs/13` no cambia. Las rutas `/internal/*` son privadas y deben quedar fuera del balanceador público en despliegue (documentar en runbooks).
- Un secreto más que gestionar (`INTERNAL_API_SECRET`). Rotación: cambiar en ambos servicios y reiniciar.
