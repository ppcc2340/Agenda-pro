# 10 — Pruebas, calidad y Definition of Done

## Pirámide
- **Unitarias (core):** Vitest. Cobertura objetivo ≥ 90 % en `packages/core`.
- **Propiedades:** fast-check para el planificador (ver `docs/04`).
- **Integración (API + DB):** Vitest + Postgres real (testcontainers o servicio en CI). Incluir siempre un test de aislamiento multi-tenant por endpoint.
- **Contratos de integraciones:** conectores contra *fakes* + grabaciones (nock/msw); pruebas de manejo de `410`, `429`, `401`, expiración de canal.
- **E2E:** Playwright (onboarding, captura, plan, aceptar reprogramación, confirmar propuesta, exportar tiempo).
- **IA:** `pnpm eval` (umbrales en `docs/05` §7) + pruebas de inyección + pruebas de aislamiento entre clientes.
- **Accesibilidad:** axe en E2E.
- **Carga ligera:** k6 sobre "Hoy" y sync con 500 tareas / 5 000 eventos.

## Seguridad en CI
`pnpm audit`, escaneo de secretos (gitleaks), SAST (CodeQL), SBOM.

## Definition of Done (por funcionalidad)
- [ ] Criterios de aceptación de la spec cumplidos y verificados.
- [ ] Tests unitarios/integración añadidos y en verde.
- [ ] Test de aislamiento multi-tenant si toca datos.
- [ ] Validación Zod en todos los bordes.
- [ ] Acciones automatizadas con `audit_log` y deshacer (si aplica).
- [ ] i18n `es`/`en` (sin textos hardcodeados).
- [ ] Accesibilidad básica (teclado, foco, contraste).
- [ ] Eventos de analítica añadidos (sin datos sensibles).
- [ ] Documentación actualizada (`docs/`, `STATE.md`).
- [ ] `pnpm verify` en verde.

## Observabilidad
Logs estructurados con `workspaceId`/`jobId`/`traceId`; trazas OpenTelemetry en sync y IA; alertas: cola atrasada, tasa de error > 2 %, coste de IA diario > umbral, token revocado masivo.
