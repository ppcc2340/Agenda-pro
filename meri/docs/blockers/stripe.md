# Cuenta de Stripe (modo test)

**Variables:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_PRO_ANNUAL`, `STRIPE_MODE=live`
**Desbloquea:** cobros, créditos y portal de cliente (Fase 4).
**Mientras tanto:** facturación simulada, planes y créditos locales sin cobrar.

## Pasos (todo en modo **test**)
1. Crea la cuenta de Stripe y quédate en modo de pruebas.
2. Productos: «Meri Pro» con dos precios recurrentes, mensual (hipótesis US$29) y anual (hipótesis US$288). Copia los IDs `price_...` a `STRIPE_PRICE_PRO` y `STRIPE_PRICE_PRO_ANNUAL`. Los precios son hipótesis: se validan en la beta.
3. Copia la clave secreta de test a `STRIPE_SECRET_KEY`.
4. Webhooks. En local: `stripe listen --forward-to localhost:4000/webhooks/stripe` y copia el `whsec_...` a `STRIPE_WEBHOOK_SECRET`. Eventos: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
5. Activa el **Customer Portal** (cancelar, cambiar plan, método de pago) y **Stripe Tax**.
6. Pon `STRIPE_MODE=live`. En modo test el «live» de Meri sigue usando claves `sk_test_`.
7. `pnpm blockers`, luego `/connect-blocker stripe`.

## Prueba
Tarjeta `4242 4242 4242 4242`, cualquier fecha futura y CVC. Debe completar el ciclo prueba, cobro, renovación y cancelación sin duplicar eventos.

## Para cobrar de verdad (más adelante)
Completa la verificación del negocio en Stripe, crea las claves de producción y guárdalas en el gestor de secretos, no en `.env`.
