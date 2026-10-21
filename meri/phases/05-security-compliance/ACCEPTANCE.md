# Aceptación — Fase 5

Cierre: 2026-10-21. Cada criterio con su evidencia; los que dependen de una persona (staging, revisión de Google, evaluador CASA) quedan abiertos con lo que ya está preparado.

- [x] **F-16 AC1 verificado: tras eliminar cuenta no queda dato personal (consulta de verificación documentada).**
  - `apps/api/src/routes/account-erasure.test.ts`: una cuenta construida por las rutas reales llena **todas** las tablas clasificadas (el test exige que ninguna esté vacía antes), se borra, no se purga dentro de la ventana, se purga con el job `data.delete_account` y `remainingPersonalRows` da **0 filas en cada tabla**; el cliente de Stripe queda borrado; reintentar es inocuo. Un fallo del proveedor no purga nada y el reintento completa ambos pasos.
  - Clasificación obligatoria de las 33 tablas (`packages/db/src/purge.ts`, test que falla con una tabla nueva sin clasificar); `purge_workspace()` SECURITY DEFINER con recibo sin datos personales (migración 0018).
  - Consulta y procedimiento documentados: `docs/compliance/deletion-verification.md` (Postgres y fuera de Postgres: Stripe, Redis, copias, analítica, Sentry, IA). La restauración reaplica las supresiones (`scripts/test/backup-restore.test.ts`).
- [x] **Tests IDOR/autorización pasan en el 100 % de los endpoints.**
  - `apps/api/src/routes/authz-matrix.test.ts` sobre las **81 rutas registradas** (falla si una ruta no está clasificada): sin sesión y con cuenta borrada → 401; sin CSRF o desde otro sitio → 403; también con la ruta codificada (`/%761/…`, el fallo que encontraron los revisores y que está corregido); B con los ids de A en ruta, cuerpo y query → denegado o aislado, sin fugas y sin cambiar a A.
  - Cada denegación tiene **control positivo**: la misma petición del dueño de los ids (fixtures nuevos) responde 2xx; las cuatro que no pueden tenerlo dicen por qué y dónde está su control. Los controles destaparon siete casos que pasaban solo porque la petición era inválida para todos; corregidos.
- [x] **Sin secretos en repo (gitleaks limpio); sin vulnerabilidades altas/críticas abiertas.**
  - gitleaks 8.21.2 sobre **todo el historial** con `.gitleaks.toml`: `no leaks found` (se reescribieron dos fixtures con forma de clave y se añadieron sus valores falsos exactos a la lista permitida).
  - `pnpm audit --prod --audit-level=high`: `No known vulnerabilities found`.
  - CI: gitleaks y audit bloqueantes, CodeQL `security-extended` (`.github/workflows/codeql.yml`), SBOM CycloneDX como artefacto, token de mínimo privilegio y acciones de terceros fijadas por SHA; `scripts/test/workflows.test.ts` lo comprueba. **Hallazgo:** `ci.yml` no era YAML válido desde la fase 0 (GitHub no podía ejecutarlo); corregido y cubierto por el mismo test.
  - Pendiente humano: activar GitHub Advanced Security si el repositorio es privado (CodeQL lo necesita).
- [ ] **Rotación de claves ejecutada en staging sin pérdida de acceso a datos.** *Bloqueo humano: no existe staging ni clave KMS real.* Preparado y probado en local: `pnpm keys:rotate` (reenvolver) y `--reencrypt` con *compare-and-swap* (`packages/jobs/src/security/rotate-keys.test.ts`, `scripts/test/keys-rotate.test.ts`: tokens legibles con la clave nueva, sin pérdida, idempotente, carrera con el worker); runbook `docs/runbooks/key-rotation.md`.
- [x] **Restauración de backup probada y tiempo medido.** `pnpm dr:drill --report` → `docs/runbooks/dr-drill-2026-10-20.md` (10 748 filas, copia 418 ms + restauración 838 ms, recuentos verificados). Tests: formato `MERI-BACKUP-1` contra manipulación (`backup-format.test.ts`), restauración idéntica, filas de inquilinos conocidos presentes tras restaurar, archivo corrupto que no toca la base destino, reaplicación de supresiones (`backup-restore.test.ts`). RPO ≤ 24 h y RTO ≤ 4 h documentados en `docs/runbooks/disaster-recovery.md`.
- [ ] **Paquete de verificación de Google completo y revisado.** El paquete está completo en `docs/google-verification.md` (justificación por scope, uso limitado, guion del vídeo, checklist CASA con evidencias) y los scopes se estrecharon (D-093). *Bloqueo humano:* dominio verificado, grabar el vídeo con los adaptadores en vivo (fase 6), revisión legal y envío a Google.
- [x] **Modelo de amenazas y runbooks revisados.** `docs/threat-model.md` y `docs/runbooks/{incident-response,key-rotation,provider-outage,backup-restore,disaster-recovery}.md` revisados por el subagente de seguridad; `scripts/test/doc-paths.test.ts` exige que toda ruta citada exista (encontró tres rutas imprecisas en el modelo de amenazas).
- [x] **`pnpm verify` en verde; `STATE.md` actualizado.** Ver la sección de verificación abajo.

## Verificación

| Comprobación | Resultado |
|---|---|
| `pnpm verify` (lint, typecheck, test, build, dependency-cruiser, scripts) | ✅ 36/36 tareas de Turbo + 39 tests de scripts (core 116, api 146, db 33, integrations 61, config 25, jobs 58, ai 20, worker 16, web 26), sobre `c0d5007`; el último cambio (`98e5685`, web) pasó lint, typecheck, tests de la web y dependency-cruiser |
| `pnpm e2e` (desktop + móvil, axe AA) | ✅ 41 passed, 4 skipped (casos «solo desktop» en el proyecto móvil), 5,7 min, sobre build de `98e5685`. La primera pasada encontró un fallo real (las no-op de la demo bloqueaban a toda cuenta en un servidor de demo, no solo a la cuenta de demo), corregido en `98e5685` |
| `pnpm eval` | 100 % en los cinco conjuntos (captura, prefiltro, compromisos, inyección, briefings) |

## Revisores al cierre

code-reviewer, security-auditor, test-engineer y ux-reviewer sobre `e4b9681..HEAD`. Altos y medios corregidos:
- **Seguridad/código (alto):** la puerta de autenticación y el CSRF se saltaban con una ruta codificada (`/%761/…`) → deciden por la ruta resuelta (`d9edc30`).
- **Código (medio):** el simulacro tragaba el error al borrar su copia en claro → falla nombrando la base (`9d9134c`).
- **Tests (altos):** matriz sin control positivo y copia verificada contra sí misma → controles positivos y filas conocidas tras restaurar (`678731e`, `9d9134c`); medios: verificación de supresión tabla a tabla, orden con Stripe, comparación del `state` de OAuth, archivo corrupto (`b641d0f`, `4b0cacf`).
- **UX (altos y medios):** afirmaciones públicas que no eran ciertas todavía, retención mostrada distinta de la aplicada, acortar retención y cerrar todas las sesiones sin confirmación, textos de permisos (`a03b6f8`).
- Bajos atendidos: contraseña de la base en argumentos de `pg_dump`, `TRUNCATE` de la auditoría, permisos del token de CI y acciones fijadas, unidad de `authTime`, cambio de correo de una cuenta borrada, deriva de `docs/13`. El resto, en «Deuda técnica» de `STATE.md`.
