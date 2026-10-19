# 0003. Aplicación automática de diffs seguros, propuestas de reprogramación y deshacer append-only

- Estado: aceptada
- Fecha: 2026-10-19

## Contexto
`docs/13` dice que `planner.replan` «calcula diff y crea propuesta reschedule», y `docs/01` F-13 AC1 exige que Meri nunca desplace silenciosamente. La demo muestra «Meri generó el plan de hoy» como acción del sistema deshacible. `audit_log` es append-only (docs/03 regla 7), así que `undone_at` no puede escribirse desde la aplicación.

## Decisión
1. **Diff seguro** = solo añade bloques, o retira bloques de tareas completadas, borradas o ya pasadas. Se aplica automáticamente en `schedule_blocks` como acción `system`, auditada y deshacible.
2. Cualquier **movimiento o retirada de un bloque vivo** crea una propuesta `reschedule` con el diff y `basePlanVersion`. Se aplica solo con `POST /v1/plan/accept`; un `basePlanVersion` distinto del vigente devuelve `CONFLICT`. Cada replan expira las propuestas `reschedule` pendientes anteriores.
3. **Escritura en Google Calendar** (solo eventos Meri) al aceptar una propuesta o, para diffs seguros, solo si `preferences.autonomy = auto_low_risk`. Con `suggest_only` el calendario externo no cambia hasta que el usuario confirma.
4. **Deshacer** inserta una nueva fila en `audit_log` (`action: "<acción>.undone"`, `undo_of_audit_id`) y aplica la compensación (bloques, eventos Meri, estados de tarea). «Deshecho» se deriva por join. Se rechaza con `CONFLICT` si existe un plan posterior.

## Consecuencias
- El contrato de `docs/13` se amplía: `planner.replan` puede aplicar diffs seguros; `GET /v1/audit` incluye `undoneAt` derivado y `POST /v1/audit/:id/undo` existe desde la fase 1.
- Más tablas de soporte (`idempotency_keys`, `notifications`, `tasks.risk`, `audit_log.undo_of_audit_id`) con RLS.
