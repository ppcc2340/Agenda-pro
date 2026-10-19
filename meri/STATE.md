# STATE — estado vivo del proyecto

**Fase actual:** 2 — Gmail + Radar de compromisos (sin empezar). Fases 0 y 1 cerradas el 2026-10-19.

## Fases
| # | Fase | Estado |
|---|---|---|
| 0 | Foundations | ✅ cerrada (2026-10-19) |
| 1 | Tareas, calendario y planificador | ✅ cerrada (2026-10-19) |
| 2 | Gmail + Radar de compromisos | ✅ cerrada (2026-10-19) |
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
- D-011: `PROTOTYPE.md` y `prompts/build-prototype.md` no venían en el kit; se redactan a partir del prompt maestro y de la demo (hito obligatorio tras la fase 3).
- D-012: El kit vive en `meri/` dentro del repositorio `Agenda-pro`; CI en `.github/` de la raíz con `working-directory: meri`.
- D-013: Auth.js v5 en `apps/web`; cookie JWT compartida con la API; arranque de usuario por ruta interna (ADR 0001).
- D-014: Versiones fijadas: Next 15, React 19, Tailwind 4, Fastify 5, Zod 3, Drizzle 0.36, BullMQ 5, Vitest 2, TypeScript 5, ESLint 9.
- D-015: Cifrado de sobre en `packages/config/src/crypto`; `KeyProvider` es la única interfaz de KMS.
- D-016: Rol `meri_app` sin `BYPASSRLS` para la aplicación; migraciones con el propietario (`DATABASE_ADMIN_URL`).
- D-017: Componentes propios con convención shadcn/ui, sin su CLI (ADR 0002).
- D-018: Pestaña «Tareas» en «Proyectos y compromisos» para el CRUD de tareas (fase 1).
- D-019: Diffs seguros del planificador se aplican solos (auditados, deshacibles); movimientos → propuesta `reschedule`; Calendar se escribe al confirmar o con `auto_low_risk` (ADR 0003).
- D-020: Notificaciones por interfaz `Notifier` con `FakeNotifier` + bandeja in-app; correo transaccional propio (nunca Gmail del usuario) en la fase 6.
- D-021: Conexión de Google en `fake`: OAuth simulado con `state`, tokens ficticios cifrados por la misma ruta que en `live`.
- D-022: Riesgo en `tasks.risk` (jsonb) calculado por reglas; `at_risk` solo desde `pending`/`scheduled`.
- D-023: Deshacer append-only con `audit_log.undo_of_audit_id` (ADR 0003).
- D-024: `Idempotency-Key` con tabla `idempotency_keys` y hook de Fastify.
- D-025: Crons como jobs dispatcher que encolan un job por workspace/cuenta.
- D-026: Las tareas sin estimación se planifican con 60 min (`deep`) o 30 min (`shallow`); el usuario lo ve como estimación por defecto y puede corregirla.
- D-027: `notifications` guarda `template` + `params` (la UI traduce es/en) además de `title`/`body` renderizados en español como respaldo para correo.
- D-028: El debounce de `planner.replan` usa el reloj de pared para el `jobId`, nunca el reloj inyectado (`DEMO_NOW` congelado colapsaría todos los replans en un solo job).
- D-029: `APP_ENV` (entorno de despliegue) separado de `NODE_ENV` (modo de build). `production` prohíbe `fake`; `staging` cuenta como producción; `APP_ENV=development` + `ALLOW_FAKES_ON_PRODUCTION_BUILD=1` permiten ejecutar un build optimizado contra `fake` para E2E y `pnpm demo` (con aviso en el arranque).
- D-030 Gmail usa la **misma cuenta Google** que Calendar: el connect acepta `scope=calendar|gmail|all`; en `fake` el OAuth concede lo pedido y `integration_accounts.scopes` acumula (autorización incremental). `gmail.sync` solo corre si la cuenta tiene `gmail.readonly`.
- D-031 **Nada de cuerpos en DB**: `threads_index` guarda asunto, participantes, fechas, `last_message_from_me` y `processed_at`; el cuerpo se lee bajo demanda para la IA y se descarta. La evidencia (≤ 200 car.) vive en `proposals.payload`/`commitments.evidence`. Test de esquema: ninguna columna `body*` en tablas de correo.
- D-032 Extracción por **reglas** como fallback y como handler del cliente simulado (`packages/core/src/mail/commitments.ts`): verbos de compromiso es/en + fechas del parser de captura + dirección por remitente. El pipeline (`packages/ai/src/extract.ts`) es el mismo para `fake` y `live`: contexto acotado por cliente, Zod, verificación literal de la cita, coherencia, clasificación de confianza por reglas, dedupe por hash.
- D-033 Cliente Anthropic (`packages/integrations/src/anthropic/client.ts`): salida estructurada vía `tools` con `input_schema` generado desde Zod (conversor mínimo propio, sin dependencia nueva), reintentos con backoff en 429/5xx, `cache_control` en el prompt de sistema, coste por modelo desde una tabla configurable (`AI_PRICES_JSON` opcional) y `ai_usage` escrito por el job; probado con transporte simulado.
- D-034 Auto-confirmación (`gmail_autoconfirm`) es una **preferencia por workspace** (`preferences.gmail_autoconfirm`, por defecto `false`) y solo aplica a `explicit` con confianza ≥ 0,9. Se audita como `commitment.autoconfirmed` (deshacible).
- D-035 Seguimiento: `followups.scan` (cron diario por zona, dispatcher D-025) crea **una única propuesta `followup`** por compromiso vencido o hilo enviado sin respuesta tras `followupDays` (preferencia, 3 por defecto), más un aviso agrupado. Acciones: recordatorio (tarea «Esperando a …»), borrador (AI-3 → texto; guardar crea un borrador en Gmail con `to` fijado por código). Silenciar por contacto (`contacts.muted`) o cliente (`clients.followups_muted`).
- D-036 Privacidad: pausa de ingesta = `integration_accounts.status = paused` (ya existe); exclusiones en `mail_exclusions` (remitente, dominio o etiqueta); desconectar purga `threads_index`, propuestas pendientes de correo y compromisos `proposed`; retención de propuestas descartadas 90 días (`preferences.retention_days`) aplicada por el job `data.retention` (cron).
- D-037: Contexto de administración para los crons entre tenants: el rol propietario está sujeto a `FORCE ROW LEVEL SECURITY` igual que `meri_app` (sin `BYPASSRLS` salvo el superusuario de CI), así que ningún sondeo, resumen diario ni `followups.scan` enumeraba cuentas en local. La política `ws_isolation` admite lectura de todos los workspaces cuando `app.workspace_id = '*'` **y** el rol no es `meri_app` (migración 0012); la escritura sigue acotada al tenant. El worker lo fija como parámetro de conexión del `adminSql` (`ADMIN_WORKSPACE_CONTEXT`). Test: `packages/db/src/workspace.test.ts` («the app role gains nothing from app.workspace_id = '*'…»).
- D-038: Los `jobId` personalizados de BullMQ no pueden contener `:` (v5.81): separador `_` en todos los ids (`calendar.sync_<id>_poll_<bucket>`, …).
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

## Fase 0 — qué se construyó
- Monorepo pnpm + Turborepo con `pnpm verify` (lint, typecheck, test, build, dependency-cruiser) en verde y CI en `.github/workflows/ci.yml` (raíz del repo, `working-directory: meri`): servicios Postgres/Redis, migración sobre base limpia, verify, 6 pruebas de humo, artefacto OpenAPI, gitleaks y `pnpm audit`.
- `packages/config`: entorno Zod, modos fake/live desde `blockers.json`, logger pino con censura, flags, cifrado de sobre (`KeyProvider` + `LocalKeyProvider`), wrappers de observabilidad no-op.
- `packages/db`: 3 migraciones (esquema, RLS + rol `meri_app` + grants, `preferences.onboarded_at`), `withWorkspace` transaccional, ids UUID v7 con marca, repositorios (cuenta, preferencias, auditoría), seed de desarrollo, tests de aislamiento sobre Postgres real.
- `packages/integrations`: interfaces + `FakeCalendar`, `FakeGmail` (sin método de envío), `FakeAiClient`, `FakeBilling`, `NoopAnalytics`, `LocalKms`; `pnpm smoke <id>` ×6.
- `apps/api`: Fastify 5 + Zod, problem+json con códigos estables, sesión JWT de Auth.js, CSRF por cabecera, rate limit por usuario/IP, OpenAPI, `/v1/me`, `/v1/preferences`, `/v1/audit`, `/internal/auth/bootstrap` (ADR 0001).
- `apps/worker`: BullMQ con sobre `{workspaceId, traceId}`, backoff con jitter, cola de errores, panel `/ready`.
- `apps/web`: Next 15, tokens de `docs/11`, barra lateral y pestañas móviles con las cinco áreas (estados vacíos), login (Google en live, desarrollo en fake), onboarding, Centro de control, `/privacy`, `/terms`, `/mobile`, i18n es/en, tema claro/oscuro, manifest PWA.

Cómo ejecutarlo: `cp .env.example .env`, Postgres y Redis (`docker compose up -d` o locales), `pnpm install`, `pnpm db:migrate`, `pnpm dev` → web `http://localhost:3000`, api `:4000`, worker `:4100`.

## Fase 1 — qué se construyó
- **Planificador** (`packages/core/src/planner`, puro y determinista): normalización Zod + ciclos, capacidad por día en la zona del usuario (DST correcto), puntuación según `docs/04`, colocación voraz con retroceso limitado (≤ 3 bloques liberados), estabilidad (anclados + bloques vigentes), factibilidad con alternativas, riesgos, explicaciones estructuradas y diff. 8 propiedades fast-check × 1 000 casos, 23 escenarios golden, cobertura 100 % líneas / 93,5 % ramas.
- **Tareas** (`/v1/tasks`, dependencias con detección de ciclos, pestaña Tareas), **captura** (`parseCapture` por reglas es/en + AI-1 simulado detrás de `ai_capture`, paleta `Ctrl/⌘ K`, Entrada con confirmar/editar/descartar, `Idempotency-Key`), **evals** (`evals/capture/seed.jsonl`, `pnpm eval` ≥ 85 %).
- **Google Calendar** (`fake`): OAuth con `state`, tokens cifrados con cifrado de sobre, `calendar.sync` incremental por calendario con resync 410, webhook + polling, purga al desconectar, eventos de ejemplo en el calendario simulado.
- **Replanificación** (ADR 0003): `planner.replan` con debounce por workspace al cambiar tareas o eventos; diff seguro aplicado y auditado; movimientos → propuesta `reschedule` con `basePlanVersion`; `POST /v1/plan/accept` escribe solo eventos Meri; `POST /v1/audit/:id/undo` append-only; anclar y marcar hecho; `plan_runs` con riesgos/conflictos; `tasks.risk`.
- **Alertas y avisos**: agrupación con tope `maxAlertsPerDay` (`packages/core/src/alerts`), tabla `notifications` (`template` + `params`), `daily.review` por zona horaria, `Notifier` (fake), bandeja en Centro de control.
- **Web**: Hoy con línea del día (calendario / plan de Meri, línea de ahora), detalle «por qué está aquí», las cuatro preguntas, riesgos con «Ver cómo reorganizar» y diálogo de diff, Calendario semanal y agenda móvil, actividad con deshacer, avisos.
- **Calidad**: E2E Playwright + axe (desktop y móvil) en CI, seed de rendimiento (500 tareas / 5 000 eventos) y medición p75 = 772 ms (`docs/perf/phase-1.md`), `APP_ENV` para ejecutar builds optimizados contra `fake` (D-029).

Cómo probar el plan: `pnpm dev` con `DEMO_NOW=2026-10-20T08:40:00Z` (martes 10:40 en Madrid), crear dos tareas, conectar Google Calendar (fake) desde el Centro de control y volver a Hoy.

## Fase 2 — qué se construyó
- **Gmail** (`fake`, misma cuenta Google con autorización incremental, D-030): scopes `gmail.readonly` + `gmail.compose` (nunca `send`), carga inicial de 30 días y `history.list`, polling + webhook, `threads_index` sin cuerpos (D-031), prefiltro por reglas (`List-Unsubscribe`, `Precedence`, no-reply, categorías, invitaciones, exclusiones del usuario), contactos.
- **IA** (`packages/ai`, `packages/integrations/src/anthropic`): cliente Anthropic con salida estructurada (tool + JSON Schema desde Zod), caché de prompt, reparación, reintentos y coste por modelo (D-033); pipeline AI-2 con contexto acotado por cliente, cita literal obligatoria, política de inyección a nivel de mensaje y de campo (direcciones y enlaces nunca llegan a un compromiso), coherencia de fechas, contraparte del hilo, clasificación por reglas y hash de deduplicación; AI-3 borrador de seguimiento (destinatario fijado por código); extractor por reglas es/en como handler simulado y como respaldo cuando se agota el presupuesto (D-032). Tope mensual por workspace (`ai_usage`, `GET /v1/ai/usage`).
- **Radar y seguimiento**: job `ai.extract_commitments` (compromisos `proposed` + propuestas deduplicadas en una transacción, auto-confirmación opcional auditada y deshacible, D-034), `followups.scan` (vencidos → `at_risk`, hilos sin respuesta tras `followup_days`, una propuesta por elemento, silencios por contacto/cliente, aviso agrupado, D-035), rutas `/v1/commitments` (lista, edición, borrador → guardar en Gmail en el hilo original, recordatorio como tarea), confirmación de propuestas `commitment` con edición y tarea «Esperando a», `confirm-batch` solo `explicit`.
- **Privacidad** (D-036): pausa de lectura, `mail_exclusions` validadas por tipo, desconectar y purgar con orden seguro (compromisos `proposed` fuera, confirmados sin hilo, propuestas expiradas, hilos borrados), `data.retention` diario con `min(preferencias, plan, 365)`.
- **Web**: Entrada con tarjetas de compromiso (cita, enlace al hilo, confianza, dirección, contraparte, edición en línea) y de seguimiento; Proyectos → Compromisos (Debo / Me deben, filtro por cliente, estados, «Preparar seguimiento» → diálogo con borrador editable, «Recordarme mañana», «Guardar borrador en Gmail»); Hoy «¿Qué estoy esperando de otras personas?»; Centro de control con conexión Gmail, auto-confirmación, gasto de IA, correo y privacidad (pausa, exclusiones, desconectar y purgar); avisos `proposals.new`, `followups.due`, `ai.paused`.
- **Evals** (`pnpm eval`, CI): generador determinista de 234 casos sintéticos es/en + 73 correos automáticos, suite de inyección de 28 correos hostiles, runners de compromisos (precisión/recobrado/global/citas), inyección (100 %) y prefiltro (≥ 95 %); `docs/perf/ai-cost.md` ≈ 1,6 USD/usuario/mes.
- **Calidad**: E2E `apps/web/e2e/phase-2.spec.ts` (desktop + móvil, axe); tests de jobs, API (aislamiento A/B en cada ruta nueva), db (contexto admin D-037).

Cómo probarlo: `pnpm dev` con `DEMO_NOW=2026-10-20T08:40:00Z`, Centro de control → «Conectar Gmail» (fake, siembra 7 correos de ejemplo, uno hostil), Entrada → confirmar, Proyectos → Compromisos → «Preparar seguimiento».

## Deuda técnica
Hallazgos de severidad baja de los revisores de la fase 0 (los altos y medios están corregidos):
- Seguridad: `users` y `workspaces` son legibles por cualquier contexto de workspace (lo necesita el bootstrap); añadir política por usuario/membresía cuando la sesión lleve `userId` a SQL. CSP estricta con nonce en la fase 5 (P5-02); hoy `script-src 'unsafe-inline'` (+ `'unsafe-eval'` solo en desarrollo). El proveedor de acceso de desarrollo existe siempre que `GOOGLE_MODE=fake` fuera de producción: limitar a `localhost`/`DEMO_MODE` antes de un staging público. El panel de salud del worker escucha sin autenticación (ligarlo a la red interna en despliegue). Avisos de `pnpm audit` solo en herramientas de desarrollo (vitest/vite/tinypool), seguidos por Dependabot; el audit bloqueante de CI cubre dependencias de producción.
- Código: `packages/db/src/schema.ts` supera las 300 líneas (viene del kit; dividir por dominio más adelante). Metadatos y manifest con literales en español (usar `generateMetadata` + i18n). `feature_flags` es global y de solo lectura para la app; el almacén en DB llega con las flags de la fase 1.
- UX: título de «Hoy» con la fecha del día en la zona del usuario; atajo «⌘ K» en macOS; barra lateral colapsada a 76 px entre 768 y 1000 px; textos de «Editar preferencias» cuando se llega desde el Centro de control; swatches de leyenda en la línea del día (llegan con el planificador en la fase 1).
- Observabilidad: los wrappers son no-op/log; los SDK reales de Sentry, OpenTelemetry y PostHog se conectan al resolver el bloqueo `observability` (fase 4).
- `/v1/audit/:id/undo`, exportación y eliminación de cuenta: botones deshabilitados en Centro de control hasta sus fases (1 y 5).
- Cobertura: umbrales activos en `core` (90 %) y `api` (80 %) vía `vitest --coverage`.
- Fase 1 (hallazgos bajos de los revisores; los altos y medios están corregidos en `fix(phase-1)` y `fix(web)`): `confirm-batch` son N transacciones (no atómico); `expirePending` y `getBlocksByIds` sin uso fuera de accept; margen de imprevistos («margen rayado» de la demo) no se dibuja porque el plan no expone la reserva (añadir a `GET /v1/plan`); alternativas de conflicto son texto (acciones en fase 2); la actividad no muestra el título de la entidad ni pagina (`nextCursor`); el canal del webhook de Calendar usa un token global (ligarlo a un registro de `watch` al activar `live`); archivos > 300 líneas (`replan.ts`, `plan.ts`, `integrations.ts`, `repos/tasks.ts`, `palette.tsx`, `plan-apply.ts`, `capture.ts`, `hoy-view.tsx`) pendientes de dividir; cuerpo de alertas en español como respaldo; `text-ink3` a 11,5–12,5 px roza AA (usar `text-ink2` en textos pequeños); sin test de navegación solo con teclado ni de manifest PWA en E2E; evals de IA contra la API real pendientes de `/connect-blocker anthropic`; «¿Qué estoy esperando de otras personas?» queda vacía hasta los compromisos (fase 2); `GET /v1/plan` devuelve riesgos/conflictos sin paginar (paginar si superan ~200); el `Notifier` en vivo (push/correo transaccional) llega en la fase 6; la bandeja de avisos no agrupa por día en la UI; los eventos de ejemplo del calendario simulado se siembran por cuenta en memoria (se pierden al reiniciar la API).
- La fuente tipográfica se carga desde Google Fonts en tiempo de ejecución (sin dependencia en el build); evaluar auto-hospedaje con el dominio.

## Registro de sesiones
(Claude Code: añade una línea por sesión con fecha, fase y resumen.)
- 2026-10-19 · Fase 0 · Kit sin `.claude/`, `PROTOTYPE.md` ni CI: se crearon (D-011). Construida la base completa (config, db+RLS, integraciones fake, api, worker, web, auth, onboarding, legales, CI, runbook); `pnpm verify` en verde; flujo login→onboarding→Hoy→control verificado en Chromium. Revisores code/security/test/ux: corregidos el callback JWT que fallaba en cada lectura de sesión, el bootstrap de cuenta no atómico ante carreras, la validación parcial de horario, `trustProxy` total, redirección abierta con barra invertida, secretos de ejemplo en producción, CSP/HSTS, censura de parámetros SQL en logs, vulnerabilidades de dependencias de producción (drizzle-orm 0.45, sin swagger-ui), accesibilidad (ARIA del selector de autonomía, etiquetas de días, contraste AA) y textos del Centro de control; añadidos tests de cobertura RLS, carrera de bootstrap, formulario de onboarding, páginas legales, callback de auth y `pnpm blockers`.
- 2026-10-19 · Fase 1 · Planificador puro (subagente con contrato cerrado; dos contraejemplos de estabilidad convertidos en golden), tareas, captura con reglas + IA simulada, conector de Calendar `fake`, replanificación con diffs seguros / propuestas / aceptar / deshacer append-only, alertas agrupadas, resumen diario, vistas Hoy y Calendario (desktop y móvil), avisos y deshacer en el Centro de control. Evals de captura 30/30, E2E Playwright + axe en desktop y móvil, p75 de Hoy 772 ms con 500 tareas. `pnpm verify` en verde. Revisores code/security/test/ux ejecutados al cierre (ver commit `fix(phase-1)`).
- 2026-10-19 · Fase 2 · Gmail (fake, scopes incrementales, sin cuerpos), cliente Anthropic con salida estructurada, pipeline AI-2 con política de inyección y evals (238 casos, 28 hostiles, 100 %), job de extracción con auto-confirmación deshacible y tope de coste, radar de compromisos (API + UI), seguimiento con borradores en Gmail (nunca envío) y recordatorios, silencios, exclusiones, purga y retención. Corregidos dos fallos latentes de la fase 1 descubiertos en el E2E: los `jobId` con `:` (BullMQ 5.81) y los crons entre tenants ciegos bajo RLS (D-037/D-038). E2E fase 2 en desktop y móvil; `pnpm verify` en verde. Revisores code/security/test/ux ejecutados al cierre (hallazgos en «Deuda técnica» y commit de cierre).
