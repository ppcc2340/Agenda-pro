# Cómo hacer que Claude Code construya Meri

Hay dos formas. La primera es la recomendada.

## Opción A. Una fase por sesión (recomendada)

Contexto limpio en cada fase y revisión humana entre fases.

```bash
cd meri
git init && git add -A && git commit -m "chore: initial spec"
claude
```

Dentro de Claude Code, una fase cada vez:

```
/build-phase 0
```

Cuando termine, revisa `STATE.md` y `git log`, haz `/clear` y sigue con `/build-phase 1`, y así hasta la 5. La fase 6 es técnica y de operación.

## Opción B. Todo de una vez, sin supervisión

```bash
scripts/build-all.sh          # fases 0 a 5
scripts/build-all.sh 2 4      # solo de la 2 a la 4
```

Lanza una sesión de Claude Code por fase, verifica entre fases (`pnpm verify`, `STATE.md` y árbol limpio) y se detiene al primer fallo. Revisa `claude --help` por si tu versión cambió algún flag. Pensado para un entorno aislado (contenedor o máquina de desarrollo), nunca con credenciales de producción.

## Prompt de arranque (si prefieres pegarlo tú)

```
Eres el ingeniero principal de Meri. Lee CLAUDE.md, STATE.md y docs/12-engineering-standards.md.
Construye el MVP completo por fases, de la 0 a la 5, siguiendo prompts/build-phase.md.
Reglas: trabaja de forma autónoma, una tarea cada vez, con pruebas junto al código y commits
pequeños. Desarrolla contra los adaptadores fake: no te detengas por credenciales. Reproduce la
interfaz de demo/ con docs/11-design-system.md. Antes de cerrar cada fase pasa los subagentes
code-reviewer, security-auditor y test-engineer, y recorre ACCEPTANCE.md con evidencia.
Para solo en las condiciones de parada del protocolo. Empieza por la fase indicada en STATE.md.
```

## Qué esperar

- Se construyen las fases 0 a 5 completas contra servicios simulados: el producto funciona de punta a punta con datos de ejemplo, con pruebas, seguridad y CI.
- Quedan para una persona, y no bloquean nada, los bloqueos de `blockers.json` (dominio, Google, Anthropic, Stripe, observabilidad, KMS). Cuando los tengas: `/connect-blocker <id>`.
- Verificación de Google (semanas), beta con usuarios reales y validación de precios son trabajo humano. La fase 6 deja listo todo lo técnico.

## Seguimiento

```bash
pnpm status      # progreso por fase
pnpm blockers    # bloqueos humanos pendientes
```

## Límites honestos

Claude Code puede construir y probar mucho, pero no sustituye: una revisión humana de seguridad antes de manejar correo real, la evaluación CASA de Google, el análisis legal de privacidad y términos, ni la validación con clientes. Las evals de IA contra el servicio real solo corren cuando conectes la clave de Anthropic; hasta entonces miden contra el cliente simulado.
