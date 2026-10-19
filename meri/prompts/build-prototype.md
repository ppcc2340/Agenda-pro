# Protocolo del hito de prototipo

Se ejecuta después de cerrar las fases 0 a 3 y antes de la fase 4. Objetivo: cumplir `PROTOTYPE.md` al completo.

## 0. Orientación
1. Lee `CLAUDE.md`, `STATE.md`, `PROTOTYPE.md`, `docs/11-design-system.md` y `demo/README.md`. Abre `demo/desktop.html` y `demo/mobile.html` (o su fuente en `demo/src/`).
2. Confirma en `STATE.md` que las fases 0 a 3 están cerradas. Si no, detente y dilo.
3. `pnpm verify` en verde antes de empezar.

## 1. Plan
Escribe `docs/prototype/PLAN.md`: para cada criterio de `PROTOTYPE.md`, qué falta, qué archivos se tocan y cómo se verifica (nombre del test E2E). Pásalo por `code-reviewer` y `ux-reviewer`.

## 2. Ejecución
- `pnpm demo` y `pnpm demo:seed` (`scripts/demo.mjs`, `scripts/demo-seed.ts`). La semilla reutiliza los repositorios reales de `packages/db` y pasa por la API cuando exista la ruta.
- Cierra los huecos de interfaz comparando cada área con la demo. Nada hardcodeado: si una pantalla necesita un dato, se calcula con `core` o viene de la API.
- Pruebas E2E en ambos formatos con `DEMO_NOW` fijado y capturas en `docs/prototype/`.
- Commits pequeños (`feat(demo): …`, `test(e2e): …`).

## 3. Revisión
1. `pnpm verify` y `pnpm e2e` en verde.
2. Subagentes `code-reviewer`, `security-auditor`, `test-engineer` y `ux-reviewer`; corrige alto y medio.
3. Recorre los 12 criterios de `PROTOTYPE.md` con evidencia en `docs/prototype/ACCEPTANCE.md`.
4. `STATE.md`: hito cerrado, deuda, siguientes pasos. Commit final: `chore(prototype): close milestone`.

## Condiciones de parada
Las de `prompts/build-phase.md`.
