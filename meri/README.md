# Meri — Plataforma de productividad profesional

Sistema operativo personal para el trabajo: reúne correo, calendario y documentos y los convierte en un plan realista, con **radar de compromisos**, **seguimiento automático**, **tiempo facturable inferido** y **segregación por cliente**.

Este repositorio está diseñado para que **Claude Code lo construya por fases** (desarrollo guiado por especificaciones).

## Cómo arrancar con Claude Code

Lee `KICKOFF.md`. En corto:

```bash
cd meri && git init && git add -A && git commit -m "chore: initial spec"
claude
# dentro de Claude Code:
/build-phase 0      # y así hasta la 5. O todo seguido: scripts/build-all.sh
```

Seguimiento: `pnpm status` (progreso) y `pnpm blockers` (pendientes humanos).

## Demos

Abre en el navegador, sin instalar nada:
- `demo/desktop.html`: la aplicación en ordenador (prueba `Ctrl K` y «Ver cómo reorganizar»).
- `demo/mobile.html`: la aplicación en móvil (botón `+` para capturar).

Son mockups interactivos con datos de ejemplo. Ver `demo/README.md`.

## Bloqueos pendientes, listos para incorporar

`pnpm blockers` muestra qué falta (dominio, Google, Anthropic, Stripe, observabilidad, KMS). Mientras tanto todo funciona con adaptadores falsos. Ver `docs/blockers/README.md`.

## Mapa del repo

| Ruta | Contenido |
|---|---|
| `CLAUDE.md` | Reglas permanentes para Claude Code |
| `STATE.md` | Estado vivo del proyecto (qué fase, qué falta, decisiones) |
| `docs/00-vision.md` | Visión, posicionamiento, vertical elegida |
| `docs/01-product-spec.md` | Funcionalidades F-01..F-16 con criterios de aceptación |
| `docs/02-architecture.md` | Stack, módulos, flujos |
| `docs/03-data-model.md` | Modelo de datos y multi-tenancy |
| `docs/04-planner-engine.md` | Algoritmo del planificador (determinista) |
| `docs/05-ai-design.md` | Extracción de compromisos, prompts, evals, costes |
| `docs/06-security-privacy.md` | Seguridad, permisos, privacidad, cumplimiento |
| `docs/07-integrations.md` | Gmail, Google Calendar (MVP), Outlook/Notion (post-MVP) |
| `docs/08-pricing-billing.md` | Planes, créditos de IA, Stripe |
| `docs/09-metrics-validation.md` | Métricas, eventos, umbrales de decisión |
| `docs/10-testing-quality.md` | Estrategia de pruebas y Definition of Done |
| `docs/11-design-system.md` | Tokens de diseño, tipografía y reglas de texto |
| `docs/12-engineering-standards.md` | Estándares de ingeniería verificables |
| `docs/13-api-contract.md` | Rutas, errores, colas y cargas |
| `prompts/`, `.claude/` | Protocolo autónomo, comandos y subagentes |
| `KICKOFF.md` | Cómo lanzar la construcción |
| `docs/blockers/` | Guías de cada bloqueo humano |
| `blockers.json` | Manifiesto de bloqueos (lo lee `pnpm blockers`) |
| `demo/` | Demos HTML de escritorio y móvil |
| `phases/` | Una carpeta por fase con tareas y criterios |
| `packages/db` | Esquema Drizzle (ya escrito) |
| `packages/core` | Contratos del planificador |
| `packages/ai` | Esquemas Zod de extracción |
| `evals/` | Conjunto de evaluación de la IA |

## Decisiones ya tomadas (se pueden cambiar en `STATE.md`)

- **Vertical inicial:** profesionales de servicios que facturan por cliente (abogados, consultores, asesores).
- **Proveedor del MVP:** Google (Gmail + Calendar). Microsoft en fase 7.
- **Stack:** TypeScript, pnpm + Turborepo, Next.js, Fastify, Postgres + Drizzle, Redis + BullMQ, Anthropic SDK, Stripe.
- **Sin envío de correo en el MVP:** solo borradores.
