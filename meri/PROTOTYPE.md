# PROTOTYPE.md — Hito de prototipo (ordenador y móvil)

Definición exacta de lo que `pnpm demo` debe entregar. Es obligatorio y **no depende de ninguna credencial externa**: todo corre contra los adaptadores `Fake*` (`GOOGLE_MODE=fake`, `AI_MODE=fake`, `STRIPE_MODE=fake`, `ANALYTICS_MODE=noop`, `KMS_PROVIDER=local`).

## Qué es
Dos prototipos **funcionales y terminados** de la misma aplicación (`apps/web` + `apps/api` + `apps/worker`) con datos de ejemplo:

| Prototipo | Dónde | Formato |
|---|---|---|
| Ordenador | `http://localhost:3000/` | Barra lateral oscura con las cinco áreas (Hoy, Entrada, Proyectos y compromisos, Calendario, Centro de control). Viewport de referencia 1280×800. |
| Móvil | `http://localhost:3000/` con viewport ≤ 520 px, y `http://localhost:3000/mobile` (marco de teléfono para verlo desde un ordenador) | Barra de pestañas inferior (Hoy, Entrada, Agenda, Compromisos, Más) y botón `+` de captura. Viewport de referencia 390×844. |

La referencia visual, de navegación y de textos es `demo/desktop.html` y `demo/mobile.html` con `docs/11-design-system.md`.

## Regla de oro
**Los prototipos usan la lógica real.** El planificador de `packages/core`, el pipeline de extracción de `packages/ai`, la base de datos con RLS y la API son los de producción. Solo los servicios externos (Google, IA, Stripe, analítica, KMS) son simulados. Está prohibido hardcodear resultados en la interfaz para que parezca que funciona.

## `pnpm demo`
1. Comprueba Postgres y Redis (`DATABASE_URL`, `REDIS_URL`); si faltan, explica cómo levantarlos (`docker compose up -d`).
2. Aplica migraciones y ejecuta `pnpm demo:seed`: crea de forma **determinista** el workspace de ejemplo (usuario `demo@meri.local`, cuatro clientes con color: Acme Corp, Estudio Norte, Luna Legal y Beta Logística; eventos, tareas, compromisos, propuestas, entradas de tiempo y actividad equivalentes a los de `demo/src/shared.js`, fechados en la semana actual).
3. Arranca web, api y worker en modo `fake` con `DEMO_MODE=1` (inicio de sesión automático con el usuario de ejemplo; en cualquier otro modo el login es el normal).
4. Imprime las dos URLs. `DEMO_NOW` permite congelar el reloj (lo usan las pruebas E2E para capturas estables).

## Criterios de aceptación (todos obligatorios, en ambos formatos salvo que se indique)
1. **Hoy** muestra la línea del día (calendario fijo arriba, plan de Meri abajo, línea de «ahora», margen rayado) calculada por `core.planner` sobre los datos sembrados, y las cuatro preguntas con contenido real. Pulsar un bloque muestra «por qué está aquí» (explicación estructurada traducida).
2. **Captura** (`Ctrl/⌘ K` en ordenador, botón `+` en móvil): «Informe para Acme el jueves, 2 h» muestra la vista previa con chips punteados (cliente, fecha, duración) producida por el parser real (reglas + IA simulada) y crea una propuesta en Entrada en < 1 s. Deshacer desde el aviso funciona.
3. **Entrada**: confirmar, editar y descartar propuestas por teclado y ratón. Lo confirmado pasa a Compromisos o a tareas; el descarte queda registrado como feedback.
4. **Reorganizar**: «Ver cómo reorganizar» muestra el **diff** real del planificador (qué se mueve y por qué); aceptar escribe solo bloques Meri en `FakeCalendar`, registra la acción en Actividad y se puede deshacer, restaurando el estado anterior.
5. **Compromisos**: vistas Debo / Me deben con filtro por cliente; «Preparar seguimiento» genera un borrador y «Guardar borrador en Gmail» crea un borrador en `FakeGmail`. **No existe ninguna ruta que envíe correo.**
6. **Tiempo**: entradas sugeridas desde eventos y bloques completados; aprobar una o todas; exportar CSV con las columnas documentadas. Nada se aprueba solo.
7. **Clientes**: «Generar briefing» produce puntos con fuente enlazada usando solo datos de ese cliente (test de aislamiento).
8. **Calendario / Agenda**: semana (ordenador) y día con tira de días (móvil), reuniones fijas y bloques Meri diferenciados.
9. **Centro de control / Más**: autonomía (solo sugerir / bajo riesgo), conexiones con su permiso, créditos de IA, actividad con Deshacer, privacidad (pausar lectura, exportar, eliminar) con los textos de la demo.
10. **Calidad**: tema claro y oscuro; `es` y `en`; teclado completo y foco visible; `axe` sin violaciones serias o críticas; responsive hasta 360 px; `prefers-reduced-motion` respetado.
11. **Pruebas E2E** (Playwright) que recorren los puntos 1 a 9 en los dos formatos (`apps/web/e2e/desktop.spec.ts` y `apps/web/e2e/mobile.spec.ts`), ejecutables con `pnpm e2e`, y capturas de cada área en `docs/prototype/desktop-*.png` y `docs/prototype/mobile-*.png`.
12. `pnpm verify` en verde con el prototipo incluido.

## Qué no es
No es un despliegue ni una beta: no hay dominio, ni credenciales reales, ni cobros. Todo lo que diga «Demo» o «sin conectar» en Conexiones es correcto hasta que una persona incorpore los bloqueos (`pnpm blockers`).
