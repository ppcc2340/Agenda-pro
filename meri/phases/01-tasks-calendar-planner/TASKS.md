# Fase 1 — Tareas, calendario y planificador

**Objetivo:** un planificador realista y explicable sobre tareas propias + Google Calendar, con vista "Hoy".
**Lee:** `docs/01-product-spec.md` (F-02..F-06, F-13), `docs/04-planner-engine.md`, `docs/07-integrations.md` (Calendar).

## Tareas
- [ ] P1-01 **CRUD de tareas** (API + UI): estados, prioridad, fecha límite blanda/dura, duración, dependencias, subtareas, etiquetas. Detección de ciclos.
- [ ] P1-02 **Entrada (inbox) y captura rápida:** `⌘K`; captura con solo título; parser NL (AI-1) detrás de flag, con **fallback por reglas** (fechas relativas "jueves", duraciones "2h"). Sugerencias vs confirmado (UI).
- [ ] P1-03 **Conector Google Calendar:** OAuth incremental (scopes de Calendar), sync incremental con `syncToken`, `watch` + polling, calendario dedicado "Meri", idempotencia, estados de conexión. Adaptador `FakeCalendar` para tests.
- [ ] P1-04 **`packages/core/planner`:** implementar `plan()` según `docs/04` (contrato en `types.ts`). Pesos en `weights.ts`. Explicaciones estructuradas.
- [ ] P1-05 **Tests de propiedades** (fast-check) de las 8 propiedades del doc 04 + tests de ejemplos (golden).
- [ ] P1-06 **Replanificación asistida:** job `planner.replan`, cálculo de `diff`, UI de diff (aceptar/rechazar), escritura de bloques en Calendar solo al aceptar + `audit_log` + deshacer.
- [ ] P1-07 **Detección de riesgo/sobrecarga (F-13):** `at_risk`, vista de conflictos con alternativas, agrupación y límite de alertas diarias.
- [ ] P1-08 **Vista "Hoy" y "Calendario":** responde las 4 preguntas; plan semanal; bloques con explicación ("por qué"); anclar (pin) bloques.
- [ ] P1-09 **Notificaciones:** correo/push agrupados y resumen de inicio de día (sin IA: plantilla).
- [ ] P1-10 **Rendimiento:** seed de 500 tareas/5 000 eventos; "Hoy" < 1.5 s p75.

## Fuera de alcance
Gmail, compromisos, clientes (solo el campo `client_id` opcional), tiempo, Stripe.
