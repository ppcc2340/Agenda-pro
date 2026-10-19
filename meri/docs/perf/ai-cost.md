# Coste de IA proyectado por usuario y mes (fase 2)

Proyección con los precios *placeholder* de `packages/integrations/src/anthropic/prices.ts` (se sustituyen por
`AI_PRICES_JSON` al activar el bloqueo `anthropic`). Tope por usuario: `AI_MONTHLY_COST_CAP_USD_PER_USER` (6 USD por
defecto); al alcanzarlo el pipeline sigue con reglas (`ai.paused`, docs/05 §5).

## Supuestos
| Magnitud | Valor | Fuente |
|---|---|---|
| Correo recibido | 60 mensajes/día laborable | estimación perfil profesional |
| Descartado por prefiltro | 50 % | F-07 AC4 (`evals/commitments/automated.jsonl`: 100 % de automáticos) |
| Hilos con cambios que llegan a AI-2 | 20/día ≈ 440/mes | 22 días |
| Prompt de sistema AI-2 | ≈ 350 tokens, cacheado | `prompts/extract-commitments.ts` (1,4 k caracteres) |
| Contexto por hilo | ≈ 1 200 tokens | cuerpo saneado ≤ 6 000 caracteres; media sintética 80 tokens, se asume hilo real |
| Salida AI-2 | ≈ 200 tokens | 1–3 compromisos JSON |
| Escalado a modelo *smart* | 15 % de hilos | docs/05 §2 (confianza < 0,6) |
| Borradores AI-3 | 20/mes, modelo *smart*, 600 in / 300 out | F-08 |
| Capturas AI-1 | 100/mes, modelo *fast*, 300 in / 80 out | F-02 |

## Cálculo (µUSD = 1e-6 USD)
| Partida | Llamadas | Coste por llamada | Total/mes |
|---|---|---|---|
| AI-2 fast (1 200 in × 1 + 200 out × 5 + 350 caché × 0,1) | 440 | 2 235 µUSD | 0,98 USD |
| AI-2 smart (escalado: 1 200 × 3 + 200 × 15 + 350 × 0,3) | 66 | 6 705 µUSD | 0,44 USD |
| AI-3 smart (600 × 3 + 300 × 15 + 200 caché × 0,3) | 20 | 6 360 µUSD | 0,13 USD |
| AI-1 fast (300 × 1 + 80 × 5 + 200 caché × 0,1) | 100 | 720 µUSD | 0,07 USD |
| **Total** | | | **≈ 1,6 USD/usuario/mes** |

Margen frente al tope de 6 USD: ×3,7. Un usuario con el triple de correo (180/día) se queda en ≈ 4,8 USD.

## Palancas si el coste real supera la proyección
1. Subir el umbral del prefiltro (más categorías Gmail, dominios internos de notificaciones).
2. Reducir el contexto: solo el último mensaje nuevo del hilo cuando el anterior ya se procesó (hoy se envían los
   mensajes cambiados, no todo el hilo).
3. Bajar la fracción de escalado o desactivarlo por preferencia.
4. El tope mensual es por *workspace* y se mide con `ai_usage` (`monthlyAiCostMicroUsd`); `GET /v1/ai/usage` lo expone.

## Medición real
`ai_usage` registra tokens y coste por operación y modelo. Tras conectar el bloqueo `anthropic`, repetir esta tabla
con los datos de un mes y guardar la salida de `pnpm eval` en vivo junto a este documento.
