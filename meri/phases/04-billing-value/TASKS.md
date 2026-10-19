# Fase 4 — Facturación, créditos de IA e informes de valor

**Lee:** `docs/08-pricing-billing.md`, `docs/01-product-spec.md` (F-12, F-15), `docs/09-metrics-validation.md`.

## Tareas
- [ ] P4-01 **Stripe:** productos/precios (mensual/anual), Checkout con prueba de 14 días **con tarjeta**, Customer Portal, Stripe Tax; webhooks con verificación de firma e idempotencia.
- [ ] P4-02 **Entitlements:** `requireEntitlement`, `max_clients`, `ai_credits_monthly`, `retention_days`; sincronización desde webhooks.
- [ ] P4-03 **Créditos de IA:** medición (`ai_usage`), consumo por operación, avisos al 80 %/100 %, degradación elegante (reglas siguen funcionando), compra de paquetes.
- [ ] P4-04 **Tope de coste** por usuario y alarma de margen.
- [ ] P4-05 **Informe de valor (F-12):** `value_events` con método de cálculo; informe semanal/mensual: compromisos salvados, plazos en riesgo detectados, horas recuperadas (estimadas, método visible); sin cifras sin fuente.
- [ ] P4-06 **Revisión diaria/semanal (F-12):** resumen de cierre de día y revisión semanal (tendencias de carga, estimado vs real).
- [ ] P4-07 **Analítica:** todos los eventos de `docs/09` instrumentados (sin datos sensibles); panel interno (SQL/Metabase) con los indicadores.
- [ ] P4-08 **Flujo de cancelación** con encuesta de motivo.
- [ ] P4-09 **Páginas de precios** y comparador de planes en la web.

## Fuera de alcance
Plan de equipos y enterprise.
