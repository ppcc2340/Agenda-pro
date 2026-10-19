# 08 — Precios, planes y facturación

> Hipótesis iniciales. Validar con clientes reales en la Fase 6 antes de fijar precios definitivos.

## Principios
- Ancla más alta que Reclaim/Todoist: el usuario objetivo factura por hora.
- Prueba **con tarjeta** (14 días, integración completa) en vez de freemium abierto; el freemium atrae usuarios que no integran ni pagan.
- Precio alineado con el coste de IA mediante **créditos**.
- Plan anual con descuento.

## Planes (hipótesis)
| Plan | Precio/mes | Contenido |
|---|---:|---|
| Prueba | US$0 (14 días, con tarjeta) | Todo lo de Pro con créditos limitados |
| **Pro** | US$29 (anual US$24) | Planificador, calendario, radar de compromisos (Gmail), seguimiento, tiempo inferido, hasta N clientes, créditos de IA base |
| **Pro+** | US$49 | Más créditos, briefings ilimitados, retención ampliada, exportaciones avanzadas |
| Equipos (post-MVP) | US$25–40/usuario, mínimo 3 | Espacios compartidos, delegación |
| Enterprise (post-MVP) | A medida | SSO, residencia de datos, DPA, soporte |

Add-ons (post-MVP): transcripción de reuniones, asistente humano delegado, retención extendida.

## Créditos de IA
- 1 crédito ≈ unidad abstracta mapeada a coste (tokens ponderados por modelo). Documentar en `ai_usage`.
- Ejemplo: Pro = 1 500 créditos/mes; Pro+ = 5 000.
- Consumo: extracción de correo (1/hilo), captura NL (0.2), borrador (3), briefing (5), resumen (1).
- Límite blando al 80 % (aviso), duro al 100 % (IA pausada; reglas siguen funcionando); opción de comprar paquetes.
- **Control de coste:** tope por usuario `AI_MONTHLY_COST_CAP_USD_PER_USER`; alarma interna si el margen bruto por usuario baja de 70 %.

## Implementación
- Stripe Products/Prices (mensual y anual), Checkout, Customer Portal.
- Webhooks → `subscriptions` y `entitlements` (fuente de verdad local de derechos).
- `entitlements`: `max_clients`, `ai_credits_monthly`, `features[]`, `retention_days`.
- Middleware `requireEntitlement(feature)` en la API.
- Rollup mensual de uso (`billing.usage_rollup`) y reinicio de créditos al renovar.
- Impuestos: Stripe Tax; factura con datos fiscales.
- Cancelación en un clic (Portal); encuesta de motivo (alimenta `docs/09`).

## Métricas de negocio ligadas al precio
Conversión prueba→pago, ARPU, margen bruto por usuario (ingresos − IA − infra − Stripe), CAC, churn, ahorro percibido. Ver `docs/09-metrics-validation.md`.
