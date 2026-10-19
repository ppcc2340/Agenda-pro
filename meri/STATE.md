# STATE — estado vivo del proyecto

**Fase actual:** 0 — Foundations (sin empezar)

## Fases
| # | Fase | Estado |
|---|---|---|
| 0 | Foundations | pendiente |
| 1 | Tareas, calendario y planificador | pendiente |
| 2 | Gmail + Radar de compromisos | pendiente |
| 3 | Clientes, tiempo y briefings | pendiente |
| 4 | Facturación, créditos de IA e informes de valor | pendiente |
| 5 | Seguridad, cumplimiento y verificación OAuth | pendiente |
| 6 | Beta cerrada e instrumentación de validación | pendiente |
| 7 | Post-MVP (Outlook, Notion, equipos, voz) | backlog |

## Decisiones
- D-001: Vertical inicial = profesionales de servicios con clientes/matters.
- D-002: Proveedor MVP = Google. Microsoft en fase 7.
- D-003: Monorepo pnpm + Turborepo; web Next.js, api Fastify, worker BullMQ.
- D-004: Postgres + Drizzle; RLS activado por `workspace_id`.
- D-005: Modelos IA por variable de entorno (`AI_MODEL_FAST`, `AI_MODEL_SMART`); no hardcodear.
- D-006: Sin `gmail.send` en el MVP.
- D-007: Nombre del producto: **Meri**.
- D-008: Toda integración externa tiene modo `fake` (por defecto) y `live`. Ver `docs/blockers/README.md`.
- D-010: Construcción autónoma por fases con `prompts/build-phase.md`, subagentes revisores y puertas de calidad. Ver `KICKOFF.md`.
- D-009: La demo `demo/desktop.html` y `demo/mobile.html` es la referencia visual y de textos (ver `docs/11-design-system.md`).

## Bloqueos humanos
**Estado: todos pendientes, pero listos para incorporar.** Cada uno tiene adaptador falso, guía y comando de activación. Ver `docs/blockers/README.md`.

Comprobar estado: `pnpm blockers`. Incorporar uno: `/connect-blocker <id>`.

| Id | Bloqueo | Crítico | Estado | Guía |
|---|---|:-:|---|---|
| `domain-brand` | Dominio y marca de Meri | sí | ⏳ pendiente | docs/blockers/domain-brand.md |
| `google-oauth` | Proyecto OAuth de Google (Gmail y Calendar) | sí | ⏳ pendiente | docs/blockers/google-oauth.md |
| `anthropic` | Clave de API de Anthropic | sí | ⏳ pendiente | docs/blockers/anthropic.md |
| `stripe` | Cuenta de Stripe (modo test) | no | ⏳ pendiente | docs/blockers/stripe.md |
| `observability` | Sentry y PostHog | no | ⏳ pendiente | docs/blockers/observability.md |
| `kms` | KMS de producción | no | ⏳ pendiente | docs/blockers/kms.md |

La verificación de scopes de Gmail tarda semanas: conviene empezarla en cuanto exista el dominio.

## Deuda técnica
(ninguna todavía)

## Registro de sesiones
(Claude Code: añade una línea por sesión con fecha, fase y resumen.)
