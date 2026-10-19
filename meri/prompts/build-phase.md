# Protocolo de construcción de una fase

Variable: **PHASE** = número de fase (0 a 6). Trabajas con contexto limpio: no asumas nada que no esté en el repo.

## 0. Orientación (obligatorio)
1. Lee `CLAUDE.md`, `STATE.md`, `docs/12-engineering-standards.md`.
2. Lee `phases/<PHASE>-*/TASKS.md` y `ACCEPTANCE.md`, y solo los documentos de `docs/` que esa fase cita.
3. Confirma que la fase anterior está cerrada en `STATE.md` (si PHASE > 0). Si no lo está, detente y dilo.
4. Ejecuta `pnpm install` (si hace falta) y `pnpm verify`. La línea base debe estar en verde antes de empezar. Si no lo está, arréglala primero.

## 1. Plan
Escribe `phases/<PHASE>-*/PLAN.md`: análisis breve, pasos numerados con archivos a crear o modificar, cómo verificar cada paso, riesgos. Una tarea `P<PHASE>-NN` de `TASKS.md` puede ocupar varios pasos. Pasa el plan por el subagente `code-reviewer` y corrige lo que señale. **No esperes aprobación humana**: sigue, salvo que se dé una condición de parada (ver abajo).

## 2. Ejecución
- Una tarea cada vez, en el orden de `TASKS.md`. Tests junto con el código (TDD cuando sea lógica de `core`).
- Commits pequeños con Conventional Commits. Un commit por tarea como mínimo.
- Al terminar cada tarea: `pnpm verify`, marca su casilla `- [x]` en `TASKS.md` y haz commit.
- Sigue los estándares de `docs/12-engineering-standards.md` y el contrato de `docs/13-api-contract.md`.
- Las integraciones se desarrollan contra los adaptadores `Fake*` (ver `docs/blockers/README.md`). Nunca bloquees el avance por una credencial.
- La interfaz reproduce la experiencia de `demo/desktop.html` y `demo/mobile.html` con `docs/11-design-system.md`.

## 3. Revisión de la fase
Cuando todas las tareas estén marcadas:
1. `pnpm verify` en verde, con cobertura de `packages/core` ≥ 90 %.
2. Lanza los subagentes `security-auditor`, `test-engineer` y (si hay UI) `ux-reviewer`. Corrige todo hallazgo de severidad alta o media. Anota el resto como deuda técnica en `STATE.md`.
3. Recorre `phases/<PHASE>-*/ACCEPTANCE.md`. Cada criterio con evidencia (nombre del test, comando o ruta del archivo). Marca ✅ o ❌. Si hay ❌, arréglalo y repite.
4. Actualiza `STATE.md`: fase cerrada, decisiones, deuda técnica, siguientes pasos, una línea en el registro de sesiones.
5. Commit final: `chore(phase-<PHASE>): close phase`.

## Condiciones de parada (solo estas)
- Una decisión de producto con consecuencias de negocio o legales que no está en la spec. Antes de parar: elige la opción más simple y reversible, regístrala en un ADR (`/new-adr`) y **continúa**. Para solo si la decisión es irreversible.
- Una acción destructiva o de coste real fuera del entorno local (desplegar, cobrar, enviar correos, borrar datos).
- Tres intentos fallidos seguidos de arreglar el mismo error. Documenta qué probaste en `STATE.md` y para.
- `pnpm verify` roto y sin causa clara tras investigar.

## Prohibido
Leer `.env`; hacer commit de secretos; saltarse tests o `--no-verify`; desactivar reglas de lint o tipos para que pase; introducir `any` sin justificación; borrar tests que fallan; dar una tarea por hecha sin evidencia.
