# Aceptación — Fase 6

Cierre de la **parte técnica**: 2026-10-21. Los cinco criterios de la fase miden una beta con personas reales (clientes de diseño, uptime en producción, una decisión de negocio): ninguno se puede cumplir sin desplegar y sin usuarios, así que **todos quedan abiertos**. Debajo de cada uno, lo que ya está construido y probado para que se cumpla, y lo que falta y quién lo hace.

- [ ] **≥ 15 clientes de diseño usando el producto semanalmente.** *Humano: reclutar, invitar, acompañar.*
  - Construido: beta cerrada con invitación (`BETA_INVITE_REQUIRED=1`, `pnpm beta:invite <correo>` con aviso al pasar de 100 personas, el tope de una app de Google en modo «Testing»), lista de espera pública en `/login` con consentimiento, honeypot y límites, «Enviar comentarios» en la barra lateral y en «Más», encuesta Sean Ellis en Hoy, `pnpm beta:forget`. Tests: `apps/api/src/routes/beta.test.ts`, `surveys.test.ts`, `packages/db/src/repos/beta.test.ts`, `scripts/test/beta-admin.test.ts`, E2E `apps/web/e2e/phase-6.spec.ts` (desktop y móvil).
  - Hallazgo del E2E: el middleware de la web mandaba `POST /api/v1/waitlist` sin sesión a `/login`, así que la lista de espera no llegaba nunca a la API. Corregido (`97025e2`) con test.
  - Falta: dominio, proyecto OAuth de Google en vivo con las personas añadidas como usuarios de prueba, despliegue (`docs/runbooks/deploy.md`), soporte por correo (dominio pendiente).
- [ ] **Panel de decisión con todos los indicadores y umbrales, actualizado automáticamente.** *Parte técnica lista; falta programarlo en producción.*
  - `pnpm beta:panel [--json] [--min-sample N]` calcula en cada ejecución, desde la base (sesión de solo lectura), los seis indicadores de `docs/09` con valor, muestra, umbral y veredicto, y la recomendación = el peor veredicto entre los indicadores con muestra suficiente; añade retención 30/90, conversión por cohorte de precio y fiabilidad (colas del worker, cuentas degradadas o sin acceso). Lógica pura en `packages/core/src/beta/decision.ts` (tests de bordes), agregados en `packages/db/src/repos/beta-metrics.ts` (tests con datos sembrados: activación por propuesta, compromiso confirmado o plan aceptado; cuentas borradas fuera), `scripts/test/beta-panel.test.ts`.
  - Falta: ejecutarlo cada semana contra producción (cron del despliegue o una persona) y leerlo.
- [ ] **Informe de beta redactado con recomendación fundamentada en datos.** *Humano.*
  - `pnpm beta:report` escribe `docs/beta/report-<fecha>.md` (0600, fuera de git) con los agregados del panel y las secciones que completa una persona: 10 problemas principales, entrevistas y decisión.
- [ ] **Uptime ≥ 99,5 % durante la beta; incidentes con post-mortem.** *Humano: no hay producción.*
  - Preparado: imágenes no-root fijadas por digest para api, worker, web y migraciones (`Dockerfile`, `.github/workflows/images.yml` las construye y arranca), `pnpm check:migrations` en CI, `/health` y `/ready`, runbooks de despliegue, incidentes, caída de proveedor y recuperación (fase 5).
  - Falta: hosting, alertas reales (Sentry/monitor externo, bloqueo `observability`) y medición durante la beta.
- [ ] **Decisión registrada en `STATE.md` (avanzar a Fase 7 / iterar / pivotar).** *Humano, con el informe de la beta.*

## Qué se construyó para la beta (P6-01..P6-06)

| Tarea | Estado | Evidencia |
|---|---|---|
| Adaptadores de Google en vivo (requisito de la beta) | ✅ código y tests contra un simulador; ❌ nunca contra Google | `packages/integrations/src/google/*.test.ts`, `packages/jobs/src/live-path.test.ts`, `pnpm smoke google-oauth` (humano, con credenciales) |
| P6-01 despliegue | preparado, no ejecutado | `Dockerfile`, `images.yml`, `check:migrations`, `docs/runbooks/deploy.md` |
| P6-02 programa de beta | ✅ técnica | ver arriba |
| P6-03 panel de decisión | ✅ técnica | ver arriba |
| P6-04 Sean Ellis + cancelación | ✅ | `surveys.test.ts`; la encuesta de cancelación es de la fase 4 |
| P6-05 experimento de precio | ✅ técnica | `packages/core/src/billing/cohorts.test.ts`, `apps/api/src/routes/price-cohorts.test.ts`, `scripts/test/flags-set.test.ts` |
| P6-06 revisión de calidad de IA | ✅ herramienta; el etiquetado es humano | `packages/core/src/beta/review-sample.test.ts`, `scripts/test/review-sample.test.ts` |
| P6-07 estabilización, P6-08 informe | humano | dependen de la beta |

## Cierre del MVP (2026-10-21)

Plan y decisiones en `PLAN-mvp-final.md` (D-113..D-117) y ADR 0009. Es el único hueco de código del MVP que quedaba (D-020): la entrega de avisos por correo transaccional propio, con preferencia y baja en un clic. Además se cerró la deuda asequible de la fase 6.

| Pieza | Evidencia |
|---|---|
| Adaptador SMTP | `packages/integrations/src/notify/smtp.test.ts` contra un servidor SMTP real en proceso: autenticación, cabeceras RFC 8058, inyección de cabeceras, 5xx en RCPT TO definitivo, autenticación/remitente/red reintentables, TLS exigido fuera de localhost |
| Qué se envía y cómo se escribe | `packages/core/src/notify/email.test.ts`: preferencia, plurales, escape; propiedad de que ningún parámetro salvo los recuentos llega al correo |
| Entrega | `packages/jobs/src/handlers/notify-email.test.ts`; `apps/worker/src/dispatchers.test.ts` (paridad del SQL con `emailAllowed` en off/digest/all); `packages/db/src/repos/notification-email.test.ts` (una sola vez, RLS) |
| Aviso de conexión perdida | `packages/jobs/src/google-access.test.ts` (uno por transición) |
| Baja en un clic | `packages/config/src/crypto/unsubscribe.test.ts` (1 000 casos); `apps/api/src/routes/email.test.ts` (form, multipart, JSON, GET 303, tokens falsos, idempotencia, auditoría, aislamiento); matriz de autorización `signed` |
| Web | E2E `apps/web/e2e/phase-6.spec.ts`: preferencia en Control, página de baja con enlace inválido y válido, POST de servidor de correo por el origen web; middleware |
| Deuda de la fase 6 | Tope de lista de espera en Redis (`beta.test.ts`, también con Redis caído), `pnpm demo --build`, E2E de Sean Ellis y `/precios`, foco del rail, nota de cohorte |

Sin probar contra un proveedor real: `pnpm smoke email` es la primera prueba real (humana, `docs/blockers/email.md`).

## Revisores

code-reviewer, security-auditor, test-engineer y ux-reviewer sobre la fase completa. Altos y medios corregidos en `1d743e7` (Google), `946461b` (beta, facturación, migraciones, Docker) y `97025e2` (web). Sobre el cierre del MVP, otra ronda de los cuatro, con altos y medios corregidos en `f45b723`. Los bajos están en «Deuda técnica» de `STATE.md`.

## Verificación

| Comprobación | Resultado |
|---|---|
| `pnpm verify` (lint, typecheck, test, build, dependency-cruiser, `check:migrations`, scripts) | ✅ 724 tests (api 174, core 144, integrations 117, jobs 80, scripts 66, db 45, config 30, web 28, ai 20, worker 20) sobre `f45b723` |
| Cobertura | `core` 96,1 % líneas / 92,4 % ramas; `api` 98,2 % / 86,2 % |
| `pnpm e2e` (desktop + móvil, axe AA) | ✅ 57 passed, 4 skipped («solo desktop» en móvil), 7,6 min, build de `f45b723`. La ejecución anterior tuvo un fallo intermitente («Más → Valor y revisión», navegación que no terminó bajo carga) que no se repitió aislado (2/2) ni en esta ejecución; anotado en la deuda |
| `pnpm eval` (adaptador de IA simulado) | 100 % en captura, prefiltro, compromisos (238), inyección (28) y briefings (12) |
