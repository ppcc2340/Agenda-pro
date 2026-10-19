# 12 — Estándares de ingeniería

Nivel objetivo: código que un equipo senior aceptaría en producción. Estos estándares son verificables; el subagente `code-reviewer` los aplica.

## 1. Arquitectura
- Capas del `docs/02`: UI → API → `core` (puro) → `db`. `core` no importa de `db`, `ai`, `integrations` ni de ningún framework.
- Dependencias entre paquetes en un solo sentido (`core` ← `db` ← `api`/`worker`). Prohibidos los ciclos. Verificar con `dependency-cruiser` en CI.
- Cada integración detrás de una interfaz con adaptador `Fake*` (ver `docs/blockers/README.md`). Inyección de dependencias explícita, sin singletons globales mutables.
- Inyectar el reloj (`now`) y los generadores de IDs. Prohibido `Date.now()` o `Math.random()` en `core`.
- Funciones pequeñas con un propósito. Archivos < 300 líneas como guía. Sin código muerto.

## 2. TypeScript
- `strict`, `noUncheckedIndexedAccess`, sin `any` implícito. `any` explícito solo con comentario `// reason:`.
- Tipos de dominio derivados de Zod (`z.infer`). Un esquema por frontera: HTTP, cola, IA, webhooks, variables de entorno.
- Tipos de marca (`Brand`) para ids (`WorkspaceId`, `ClientId`) para que el compilador impida mezclarlos.
- Errores esperables como valores (`Result<T, E>`) en `core`; excepciones solo para lo inesperado. Jerarquía de errores de aplicación con `code` estable.

## 3. API (ver `docs/13-api-contract.md`)
- REST versionado `/v1`, JSON, esquemas Zod, OpenAPI generado y publicado en CI.
- Errores `application/problem+json` (RFC 9457) con `code` estable, nunca mensajes internos.
- Paginación por cursor. Idempotencia con `Idempotency-Key` en POST que crean o cobran.
- Autorización en cada ruta (middleware + comprobación del recurso). Ningún endpoint devuelve datos de otro `workspace_id`.
- Rate limiting por usuario e IP. Tamaño máximo de petición. Timeouts en todo I/O externo.

## 4. Base de datos
- Migraciones versionadas, reversibles o con justificación. Nunca editar una migración ya aplicada.
- RLS activado y probado (ver `docs/03`). La aplicación se conecta con un rol sin `BYPASSRLS`.
- Índices para cada consulta frecuente. Revisar planes (`EXPLAIN`) de las rutas críticas. Sin N+1 (cargas por lotes).
- Transacciones para operaciones de varias tablas. Bloqueo optimista (`updated_at`/versión) donde haya edición concurrente.
- Datos de prueba solo por *seeds*. Nunca datos reales.

## 5. Jobs y colas
- Idempotentes: reintentar no duplica efectos (claves de idempotencia, `dedupe_hash`, `UPSERT`).
- Reintentos con *backoff* exponencial y *jitter*, límite de intentos y cola de errores (DLQ) observada.
- Cada job fija el contexto de workspace antes de acceder a datos y registra `jobId`, `workspaceId`, `traceId`.
- Límites de concurrencia por cuenta de integración para respetar cuotas de Google.

## 6. Integraciones y resiliencia
- Tipos de error: `AuthExpired`, `RateLimited`, `Transient`, `Permanent`. Cada uno con tratamiento definido.
- *Circuit breaker* y *backoff*. Un fallo de un conector nunca tumba el producto.
- Sincronización incremental, idempotente, tolerante a duplicados y a eventos fuera de orden.

## 7. IA
- Salidas estructuradas validadas con Zod. Un reintento con reparación y después descarte registrado.
- Prompts versionados en archivos (`packages/ai/src/prompts/`), con pruebas de regresión en `evals/`.
- Contexto siempre acotado a un cliente. Defensa contra inyección según `docs/05` §6. Registro de tokens y coste en `ai_usage`.

## 8. Seguridad
- Secretos solo por entorno o gestor de secretos. Cifrado de sobre para tokens. Nada sensible en logs (lista de campos censurados).
- Validar y sanear toda entrada. CSP estricta, CSRF, cookies `HttpOnly`/`Secure`/`SameSite`.
- Dependencias fijadas, `pnpm audit` y Dependabot. Escaneo de secretos y SAST en CI.

## 9. Observabilidad
- Logs estructurados (pino) con `traceId`, `workspaceId`, `userId`. Niveles coherentes. Sin datos personales en claro.
- Trazas OpenTelemetry en HTTP, jobs, IA y sincronizaciones. Métricas: latencia, errores, tamaño de colas, coste de IA.
- Alertas definidas como código (`infra/alerts.md` con umbrales de `docs/10`).

## 10. Pruebas (ver `docs/10`)
- Pirámide: unitarias, propiedades, integración con Postgres real, contratos, E2E, evals de IA.
- Una prueba por criterio de aceptación. Las pruebas son deterministas (sin dormir, sin red real, reloj inyectado).
- Cobertura: `core` ≥ 90 %, `api` ≥ 80 %. La cobertura es suelo, no objetivo: importa que las pruebas puedan fallar.

## 11. Interfaz
- Next.js App Router, componentes de servidor por defecto, estado de servidor con TanStack Query, formularios con React Hook Form y Zod.
- Todos los textos por i18n (`es`, `en`). Sin cadenas literales en componentes.
- Estados de carga, vacío y error en cada vista. Optimistic UI con reversión en acciones reversibles.
- Accesibilidad AA: teclado, foco, roles, contraste, `prefers-reduced-motion`. `axe` en E2E.
- Presupuestos: «Hoy» p75 < 1,5 s; JS inicial < 200 KB gzip; CLS < 0,1.

## 12. Git y revisión
- Rama principal protegida. Ramas `feat/…`, `fix/…`. Conventional Commits. Commits pequeños y atómicos.
- PR con la plantilla (`.github/pull_request_template.md`): qué, por qué, cómo se probó, riesgos, capturas.
- Cambios de arquitectura registrados como ADR en `docs/adr/` (`/new-adr`).
- CI obligatorio: lint, tipos, pruebas, build, auditoría, secretos, migraciones sobre base limpia.

## 13. Documentación
- `README` por paquete (propósito, uso, límites). Comentarios para el *porqué*, no el *qué*.
- OpenAPI y runbooks al día. `STATE.md` actualizado al cerrar cada tarea o fase.

## 14. Definition of Done global
Todo lo de `docs/10-testing-quality.md` más: revisado por `code-reviewer`, auditado por `security-auditor` si toca datos o integraciones, y sin deuda de severidad alta o media.
