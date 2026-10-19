# 03 — Modelo de datos

El esquema ejecutable está en `packages/db/src/schema.ts` (fuente de verdad). Este documento explica las decisiones.

## Entidades
- `users`, `workspaces`, `memberships` — identidad y tenencia (1 workspace por usuario en MVP).
- `preferences` — horario laboral, zona horaria, bloques de concentración, margen de imprevistos.
- `clients`, `projects` — segregación por cliente y agrupación de trabajo.
- `contacts` — personas externas (correo, dominio, cliente asociado).
- `tasks`, `task_dependencies` — trabajo planificable.
- `calendar_events` — espejo de eventos externos y bloques Meri (`origin`).
- `schedule_blocks` — plan vigente (bloques de trabajo programados).
- `commitments` — compromisos propios/de terceros con confianza y fuente.
- `proposals` — **todo lo que la IA sugiere** y espera confirmación.
- `threads_index` — índice mínimo de hilos de correo (ids, asunto, participantes, fecha). **No** guarda cuerpos por defecto.
- `time_entries` — tiempo inferido/confirmado.
- `integration_accounts` — cuentas conectadas; tokens cifrados con cifrado de sobre.
- `sync_state` — cursores (`syncToken`, `historyId`) por cuenta/recurso.
- `audit_log` — auditoría de acciones automatizadas con before/after.
- `ai_usage` — consumo de IA por usuario/operación (coste, tokens, créditos).
- `subscriptions`, `entitlements` — facturación y derechos.
- `value_events` — eventos que alimentan el informe de valor (con método de cálculo).
- `feature_flags`.

## Reglas
1. **Toda tabla de dominio tiene `workspace_id NOT NULL`** y índice que lo incluya.
2. **RLS:** `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + política `workspace_id = current_setting('app.workspace_id')::uuid`. Cada request/job fija `SET LOCAL app.workspace_id`.
3. **Datos confirmados vs sugeridos:** campos sugeridos viven en `proposals.payload`; al confirmar se copian a la entidad real con `origin = 'ai_confirmed'`.
4. **Soft delete** (`deleted_at`) para entidades de usuario; **hard delete** en eliminación de cuenta (job `data.delete_account`).
5. **Fechas** en `timestamptz` UTC. Fechas "de día completo" como `date`.
6. **IDs** UUID v7 (ordenables) generados en la aplicación.
7. **Auditoría inmutable:** `audit_log` solo-inserción.
8. **Minimización:** no almacenar cuerpos de correo; guardar `snippet` (≤ 200 chars) citado en la propuesta y `message_id` para reabrir en Gmail.

## Índices críticos
- `tasks (workspace_id, status, due_at)`
- `commitments (workspace_id, direction, status, due_at)`
- `calendar_events (workspace_id, starts_at)`
- `proposals (workspace_id, status, created_at)`
- `audit_log (workspace_id, created_at)`
- `ai_usage (workspace_id, period)`

## Migraciones
Drizzle Kit; migraciones versionadas en `packages/db/drizzle/`. Las políticas RLS, el rol de aplicación y los permisos viven en la migración custom `packages/db/drizzle/0001_rls_roles_grants.sql` (creada con `drizzle-kit generate --custom`). Todas las migraciones deben ser reversibles o documentar por qué no.
