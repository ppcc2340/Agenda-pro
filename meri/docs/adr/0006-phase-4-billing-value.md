# 0006. Facturación, créditos de IA, informe de valor y analítica: contrato de la fase 4

- Estado: aceptada
- Fecha: 2026-10-20

## Contexto
La fase 4 (F-12, F-15, docs/08, docs/09) añade el ciclo comercial (prueba, cobro, renovación, cancelación, reactivación), los créditos de IA como unidad de consumo, el informe de valor, la revisión diaria y semanal y la analítica de producto. `docs/13` solo nombraba checkout, portal, suscripción, webhook de Stripe, informe de valor y `billing.usage_rollup`. La revisión del plan (`phases/04-billing-value/PLAN.md`, sección «Revisión») fijó cómo tratar el orden de los webhooks, la retención al cambiar de plan y los créditos con IA simulada.

## Opciones consideradas
- **Prueba**: tarjeta obligatoria en el alta (docs/08 literal) frente a prueba local de 14 días con «Añadir tarjeta» que conserva la fecha de fin. Pedir tarjeta antes de conectar el calendario rompe el onboarding y el prototipo; se elige la segunda: la tarjeta se pide dentro de la prueba y, sin ella, la prueba termina en acceso inactivo (IA y altas de clientes en pausa, nada se borra).
- **Periodo de créditos**: periodo de facturación de Stripe frente a mes natural UTC. Se elige el mes natural (`ai_usage.period` ya existe): reversible, sin depender de webhooks para reiniciar.
- **Estado de la suscripción desde el webhook**: aplicar el cuerpo del evento frente a releer el objeto canónico. Stripe no garantiza el orden; se relee.

## Decisión
1. **Catálogo en `core`** (`billing/plans.ts`): prueba (= Pro con 300 créditos), Pro, Pro+; precios mostrados como hipótesis; `entitlementsFor(plan)` escribe `entitlements`; `accessFor(subscription, now)` da el acceso efectivo. Cancelar, impagar o borrar la suscripción no reduce los `entitlements`: el acceso lo decide `accessFor`.
2. **Rutas** (`docs/13`): `POST /v1/billing/checkout { plan, interval }`, `POST /v1/billing/portal`, `GET /v1/billing/subscription`, `POST /v1/billing/cancel { reason, comment? }`, `POST /v1/billing/reactivate`, `POST /v1/billing/credit-packs { pack }` (todas con `Idempotency-Key` las que crean o cobran), `GET /v1/billing/fake/complete?session=` (solo `STRIPE_MODE=fake` fuera de producción), `POST /webhooks/stripe`, `GET /v1/value-report?period=&date=`, `GET /v1/reviews/daily?date=`, `GET /v1/reviews/weekly?week=`, `GET /v1/time-entries/export.csv?month=` (requiere `advanced_exports`). `GET /v1/ai/usage` añade créditos y acceso.
3. **Webhooks**: firma `t=…,v1=` HMAC-SHA256 (tolerancia 5 min) en vivo y en simulado; `stripe_events` (id del evento) da la idempotencia en la misma transacción que los efectos; para `customer.subscription.*` e `invoice.*` se relee la suscripción canónica y el workspace sale de **sus** metadatos; `subscriptions.last_event_at` descarta eventos más antiguos; respuestas 400 (firma), 200 sin efectos (workspace ausente, desconocido, borrado o de otro cliente), 5xx (error transitorio).
4. **Créditos**: coste por operación de docs/08, cobrado una vez por unidad desde el catálogo (0 si se usaron reglas), comprobado con IA simulada o real; avisos al 80 % y 100 % una vez por mes; paquetes válidos hasta fin del mes natural de compra. El tope en USD por workspace se mantiene debajo, solo con IA real. El presupuesto se comprueba antes de la llamada y el uso se registra después: con jobs concurrentes el gasto puede superar ligeramente el saldo (límite blando aceptado).
5. **Retención**: `data.retention` no purga con acceso inactivo y, tras bajar de plan, mantiene 30 días la retención anterior.
6. **Colas**: `billing.usage_rollup` pasa a ser por workspace (`{ period }`, diario y al cerrar el mes): consolida créditos, coste, ingreso estimado y margen en `billing_rollups` y envía `trial.ending` 3 días antes del fin de una prueba sin tarjeta. `daily.close { date }`: cierre del día a la hora de fin de jornada.
7. **Valor**: `value_events` solo desde hechos verificables (`commitment_saved`, `deadline_risk_flagged`, `untracked_time_recovered`), con código de método estable y una fila por entidad; deshacer la aprobación de tiempo borra su evento.
8. **Analítica**: `track` tipado con esquema por evento (solo ids, enums, números y booleanos), emitido tras el commit; adaptador PostHog en vivo.

## Consecuencias
- Migración `0015` con `credit_grants`, `billing_rollups`, `cancellation_feedback`, columnas nuevas en `subscriptions` y `entitlements`, índice único de `value_events` y recálculo de `ai_usage.credits` y `entitlements` desde el catálogo.
- `DELETE /v1/account` cancela la suscripción en el proveedor; `cancellation_feedback` entra en la exportación.
- Nuevas variables (`blockers.json`): `STRIPE_PRICE_PRO_PLUS`, `STRIPE_PRICE_PRO_PLUS_ANNUAL`, `STRIPE_PRICE_CREDITS_500`, `STRIPE_PRICE_CREDITS_2000`; `POSTHOG_HOST` e `INFRA_COST_USD_PER_USER` opcionales.

## Revisión al cierre (2026-10-20)
Los revisores de seguridad, código, tests y UX de la fase pidieron estos cambios, ya incorporados al contrato:
- **Claves de idempotencia por intención**: cancelar, reactivar y crear sesiones reenvían al proveedor la `Idempotency-Key` del cliente (cancelar → reactivar → cancelar ya no reutiliza la primera respuesta). El cliente de Stripe se crea con clave `customer-<workspace>` antes del primer checkout.
- **Paquetes solo pagados**: `BillingProvider.getCheckoutSession(id)` relee la sesión; sin `payment_status = paid` no hay créditos (pagos asíncronos: `checkout.session.async_payment_succeeded`). Un evento de paquete inventado para una sesión que el proveedor no conoce no concede nada (el secreto del modo simulado es público).
- **Suscripciones huérfanas y duplicadas**: un evento de una suscripción viva cuyo workspace está borrado o no existe la cancela en el proveedor (respaldo de `DELETE /v1/account`); una segunda suscripción viva del mismo workspace se cancela y se audita. Métodos nuevos del proveedor: `ensureCustomer`, `getCheckoutSession`, `cancelSubscription(id, { atPeriodEnd, idempotencyKey })`, `resumeSubscription(id, { idempotencyKey })`; tiempo máximo de 10 s por llamada.
- **Acceso**: las funciones de pago (`advanced_exports`, briefings sin límite) y las altas de clientes exigen acceso activo además del derecho del plan; comprar paquetes también.
- **Retención**: la preferencia del usuario sigue aplicándose con acceso inactivo (solo se suspende la purga por plan); la regla del punto 5 se mantiene para bajar de plan.
- **Encuesta de cancelación opcional**: `reason` por defecto `other`; nunca bloquea cancelar.
- **Precio de los paquetes**: `CREDIT_PACK_PRICE_CENTS` en `core` (hipótesis: 500 créditos US$9, 2 000 créditos US$29), mostrado en el diálogo de compra.
- **E2E**: `pnpm e2e:fixture --exhaust-credits=<correo>` agota los créditos de una cuenta de prueba (`@meri.local`, nunca en producción) para el escenario «IA en pausa».
