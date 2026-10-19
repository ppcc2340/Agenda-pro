# Fases

Orden estricto. No empezar una fase sin cerrar la anterior (`ACCEPTANCE.md` en ✅ y `pnpm verify` en verde).

| # | Carpeta | Objetivo | Specs |
|---|---|---|---|
| 0 | `00-foundations` | Monorepo, apps, auth, DB+RLS, CI, observabilidad | F-01, F-14 (base) |
| 1 | `01-tasks-calendar-planner` | Tareas, Google Calendar, planificador, Hoy | F-02, F-03, F-04, F-05, F-06, F-13 |
| 2 | `02-gmail-commitment-radar` | Gmail, extracción IA, propuestas, seguimiento | F-07, F-08 |
| 3 | `03-clients-time-briefings` | Clientes, tiempo inferido, briefings | F-09, F-10, F-11 |
| 4 | `04-billing-value` | Stripe, créditos de IA, informes de valor | F-12, F-15 |
| 5 | `05-security-compliance` | Hardening, privacidad, verificación Google | F-16 + docs/06 |
| 6 | `06-beta-validation` | Beta cerrada, métricas, decisión | docs/09 |
| 7 | `07-post-mvp` | Outlook, Notion, equipos, voz | backlog |

Cada carpeta contiene `TASKS.md` (qué construir) y `ACCEPTANCE.md` (cómo se verifica). `PLAN.md` lo genera Claude Code con `/plan-phase`.
