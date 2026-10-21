# Verificación de la supresión de una cuenta (F-16)

Qué se borra, cuándo y cómo se comprueba que no queda nada (ADR 0007, D-087).

## 1. Flujo

1. El usuario borra la cuenta (`DELETE /v1/account`): borrado lógico (`workspaces.deleted_at`), conexiones revocadas en Google, sesiones cerradas y auditoría `account.deleted`. Durante 30 días la cuenta no es accesible.
2. El dispatcher del worker (cada 6 h) encola `data.delete_account { workspaceId }` por cada workspace con `deleted_at` de hace más de 30 días (`listPurgeCandidates`).
3. El handler (`packages/jobs/src/handlers/account-purge.ts`):
   1. borra el cliente en Stripe (`BillingProvider.deleteCustomer`, idempotente; un 404 cuenta como hecho);
   2. llama a `purge_workspace(id)` (función `SECURITY DEFINER`, migración 0018) como `meri_app`: comprueba de nuevo la ventana de 30 días, borra el workspace en cascada, borra los usuarios sin otros workspaces y escribe un recibo en `deletion_receipts` con `sha256('meri-deletion-v1:' || id)`, sin datos personales.
4. Reintentar es inocuo: un workspace ya purgado devuelve `already_purged`.

La aplicación no puede borrar workspaces ni usuarios por su cuenta (`DELETE` y `TRUNCATE` revocados a `meri_app`), y la auditoría solo desaparece con la cascada de la purga (trigger `audit_log_immutable`, migración 0019).

## 2. Verificación en Postgres

Toda tabla está clasificada en `TABLE_CLASSIFICATION` (`packages/db/src/purge.ts`): `workspace`, `user`, `global` (sin datos personales: `stripe_events`, `deletion_receipts`) o `global_personal` (un correo guardado antes de que exista la cuenta: `beta_invites`, `waitlist`; fase 6). Un test falla si aparece una tabla sin clasificar.

`remainingPersonalRows(adminDb, { workspaceId, userIds, emails })` cuenta, con una conexión administradora en el contexto de lectura `app.workspace_id='*'`, las filas que aún referencian el workspace o sus usuarios en cada tabla, más `audit_log.actor_user_id`, y las filas de `beta_invites`/`waitlist` con los correos de los miembros (leídos antes de la purga). Tras la purga todas deben ser 0 (`packages/db/src/repos/beta.test.ts`).

Las filas `global_personal` desaparecen también al crear la cuenta (`consume_beta_email()`, en la misma transacción del alta), a los 180 días (lista de espera, `prune_waitlist()` en el despacho diario de retención) o a petición de alguien que nunca llegó a tener cuenta: `pnpm beta:forget <correo>`.

Comprobación manual (staging o producción, con el rol propietario):

```sql
set app.workspace_id = '*';
select count(*) from deletion_receipts where subject_hash = encode(sha256(('meri-deletion-v1:' || '<workspace-id>')::bytea), 'hex');  -- 1
select count(*) from workspaces where id = '<workspace-id>';                                                                         -- 0
select count(*) from audit_log where workspace_id = '<workspace-id>';                                                                -- 0
```

Evidencia automática: `apps/api/src/routes/account-erasure.test.ts` crea una cuenta por las rutas reales (tareas, clientes, captura, Google, plan de pago, encuesta de cancelación), comprueba que hay datos en más de 8 tablas, la borra, verifica que en la ventana no se purga, la purga y obtiene **0 filas en todas las tablas** y el cliente de Stripe borrado. `packages/db/src/purge.test.ts` cubre la clasificación y la función.

## 3. Fuera de Postgres

| Sistema | Qué tenía | Cómo se borra | Verificación |
|---|---|---|---|
| Google | Tokens OAuth | Revocación al borrar la cuenta (endpoint de revocación de Google) | La conexión aparece revocada en la cuenta de Google del usuario |
| Stripe | Cliente, suscripción | `DELETE /v1/customers/:id` en la purga | El handler devuelve `customerDeleted: true`; Stripe conserva facturas por obligación legal (revisión legal) |
| Redis | Jobs con ids, contadores de rate limit | Los jobs de un workspace borrado se descartan; los completados caducan en 24 h y los fallidos en 7 días; contadores con TTL de 1 min | Sin acción |
| Copias de seguridad | Volcados cifrados | Caducan en ≤ 30 días; `pnpm restore` reaplica las supresiones de `deletion_receipts` (`--receipts-from`) | `scripts/test/backup-restore.test.ts` |
| PostHog | Id de workspace y eventos enumerados | Sin datos personales (D-065); borrado de la persona por API si se pide | Humano, cuando esté en vivo |
| Sentry | Trazas técnicas | Sin contenido ni tokens; retención del proveedor | Humano |
| Proveedor de IA | Fragmentos enviados por petición | Retención cero configurada en el proveedor | Humano ([`anthropic.md`](../blockers/anthropic.md)) |

## 4. Respuesta a una solicitud de supresión

Si el usuario no puede borrar la cuenta por sí mismo: verificar la identidad desde el email de la cuenta, ejecutar el borrado lógico por el mismo camino de la API (nunca SQL manual), confirmar por escrito el plazo de 30 días y, tras la purga, enviar el hash del recibo como justificante.

## Muestras de revisión de IA (fase 6, D-103)
Las muestras de `pnpm ai:review-sample` no contienen ids de cuenta ni datos sin censurar y viven fuera de la base de datos (carpeta local `evals` › candidates, 0600, ignorada por git y por Docker). No se pueden ligar a una cuenta para borrarlas una a una: por eso se borran todas a los 30 días (en la siguiente ejecución del comando) y solo incluyen cuentas con consentimiento. Retirar el consentimiento excluye la cuenta de las muestras siguientes.

