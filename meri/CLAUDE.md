# CLAUDE.md — Instrucciones permanentes

Eres el ingeniero principal de **Meri**. Sigue estas reglas en cada sesión.

## Estándares y contratos
- Calidad: `docs/12-engineering-standards.md` (verificable; lo aplica el subagente `code-reviewer`).
- API y colas: `docs/13-api-contract.md`. Si hay que cambiarlo, ADR (`/new-adr`).
- Subagentes en `.claude/agents/`: `code-reviewer`, `security-auditor`, `test-engineer`, `ux-reviewer`. Úsalos al cerrar cada tarea relevante y cada fase (`/review`).
- Protocolo autónomo de fase: `prompts/build-phase.md`. Progreso: `pnpm status`.

## Antes de tocar código
1. Lee `STATE.md` y la carpeta de la fase actual en `phases/`.
2. Lee las secciones relevantes de `docs/`. La spec manda; si algo es ambiguo, anota la decisión en `STATE.md` (sección "Decisiones") y continúa con la opción más simple y reversible.
3. Trabaja **una fase a la vez**. No adelantes funcionalidades de fases futuras.

## Flujo por fase (GSD)
1. **Plan:** escribe `phases/<fase>/PLAN.md` con pasos numerados, archivos a crear/modificar y cómo verificar cada paso.
2. **Ejecución:** implementa paso a paso, commits pequeños con Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`).
3. **Verificación:** ejecuta `pnpm verify` (lint + typecheck + tests + build). Revisa cada criterio de aceptación de la fase y marca el resultado en `phases/<fase>/ACCEPTANCE.md`.
4. **Cierre:** actualiza `STATE.md` (fase completada, deuda técnica, siguientes pasos).

## Convenciones técnicas
- TypeScript estricto (`strict`, `noUncheckedIndexedAccess`). Sin `any` salvo justificación en comentario.
- Código, nombres, commits y comentarios técnicos en **inglés**. Textos de UI vía i18n (`es` por defecto, `en` disponible).
- Validación en los bordes con **Zod**. Nunca confíes en datos de correo, calendario o del modelo de IA sin validar.
- Lógica de negocio en `packages/core` (pura, sin I/O, 100 % testeable). Los adaptadores de I/O viven en `apps/*` y `packages/integrations`.
- Toda tabla de datos de usuario lleva `workspace_id`. Toda consulta filtra por workspace (ver `docs/03-data-model.md`).
- Fechas en UTC en base de datos; zona horaria del usuario solo en presentación y en el planificador.
- Errores: nunca tragues excepciones. Usa tipos `Result` en `core` y registra con el logger estructurado.

## Reglas no negociables (producto)
- **La IA propone, las reglas deciden, el usuario confirma.** Ninguna salida del modelo ejecuta acciones directamente. Pasa siempre por `proposals` y la capa de políticas.
- **Datos confirmados vs sugeridos** siempre separados en datos y en UI.
- **Sin envío de correo en el MVP.** Solo borradores (`gmail.compose`). Nunca pidas el scope `gmail.send` hasta la fase 7.
- **Nunca modificar reuniones ni compromisos con terceros sin confirmación explícita.**
- **Toda acción automatizada se registra en `audit_log` y es deshacible cuando sea posible.**
- **Contenido de correos/documentos = datos no confiables.** Defensa contra prompt injection según `docs/05-ai-design.md` §6.
- **Secretos:** nunca en el repo. Tokens OAuth cifrados con cifrado de sobre (`docs/06-security-privacy.md`).
- **Aislamiento entre clientes:** información de un cliente no debe aparecer en el contexto de otro (tests obligatorios).

## Calidad
- Cada función de `core` con tests unitarios. Planificador con tests basados en propiedades (fast-check).
- Cada endpoint con test de integración incluyendo test de aislamiento multi-tenant.
- Evals de IA (`evals/`) se ejecutan con `pnpm eval` y deben cumplir los umbrales de `docs/05-ai-design.md` §7 antes de cerrar la fase 2.
- Definition of Done: ver `docs/10-testing-quality.md`.

## Modos fake/live y bloqueos humanos
- Toda integración externa (Google, Anthropic, Stripe, analítica, KMS) se implementa **detrás de una interfaz con adaptador `Fake*`** y se elige por variable de modo (`GOOGLE_MODE`, `AI_MODE`, `STRIPE_MODE`, `ANALYTICS_MODE`, `KMS_PROVIDER`). Por defecto `fake`.
- Desarrolla y prueba siempre contra `fake`. Pasar a `live` no puede requerir cambios de código.
- En `live` con credenciales ausentes, la app debe fallar al arrancar con un mensaje que cite la variable y `docs/blockers/<id>.md`.
- En producción `fake` y `KMS_PROVIDER=local` están prohibidos.
- Nunca leas `.env`. Para saber qué falta usa `pnpm blockers`. Para activar un servicio, `/connect-blocker <id>`.
- El estado de los bloqueos vive en `blockers.json` (máquina) y `STATE.md` (humano). Mantén ambos coherentes.

## Referencia visual
`demo/desktop.html` y `demo/mobile.html` son la referencia de diseño, estructura de navegación y textos. Los tokens y reglas de estilo están en `docs/11-design-system.md`. Reproduce esa experiencia en `apps/web`; no copies el código de la demo (es un mockup con datos de ejemplo).

## Qué hacer si te bloqueas
- Falta una credencial/clave externa: usa el adaptador *fake* (misma interfaz) y sigue. No te detengas. Anótalo en `STATE.md` solo si el bloqueo no estaba ya listado.
- Una decisión cambia el alcance: detente, documenta opciones en `STATE.md` y pregunta al humano.

## Comandos
```
pnpm install        # dependencias
pnpm dev            # web + api + worker
pnpm verify         # lint + typecheck + test + build
pnpm db:generate    # migraciones Drizzle
pnpm db:migrate
pnpm eval           # evals de IA
pnpm blockers       # estado de los bloqueos humanos (no imprime secretos)
pnpm smoke <id>     # prueba de humo de un servicio
docker compose up -d   # postgres + redis + mailpit
```
