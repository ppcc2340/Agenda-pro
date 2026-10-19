# Clave de API de Anthropic

**Variables:** `ANTHROPIC_API_KEY`, `AI_MODE=live` (modelos: `AI_MODEL_FAST`, `AI_MODEL_SMART`)
**Desbloquea:** captura con IA (Fase 1), extracción de compromisos y evals reales (Fase 2), briefings (Fase 3).
**Mientras tanto:** cliente de IA falso con respuestas deterministas y parser por reglas.

## Pasos
1. En la consola de Anthropic crea una clave llamada `meri-dev`.
2. Define un **límite de gasto mensual** bajo para la clave de desarrollo.
3. Copia la clave a `.env` como `ANTHROPIC_API_KEY`. Pon `AI_MODE=live`.
4. Confirma los identificadores de modelo vigentes en la documentación de Anthropic y actualiza `AI_MODEL_FAST` y `AI_MODEL_SMART` si hace falta. El código nunca los fija.
5. `pnpm blockers`, luego `/connect-blocker anthropic`.

## Antes de procesar correos reales
- Revisa la política de retención de datos del plan que uses y, si está disponible, configura retención mínima. Documéntalo en `docs/06-security-privacy.md` §9.
- Ejecuta `pnpm eval` con `AI_MODE=live` para fijar la línea base de calidad y de coste.
- Mantén `AI_MONTHLY_COST_CAP_USD_PER_USER` configurado.

## Verificación de humo (`scripts/smoke/anthropic.ts`)
Una llamada mínima con salida estructurada validada con Zod. Registra tokens y coste en `ai_usage`. Debe costar céntimos.
