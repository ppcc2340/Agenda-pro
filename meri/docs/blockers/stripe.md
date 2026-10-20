# Cuenta de Stripe (modo test)

**Variables:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_PRO_ANNUAL`, `STRIPE_PRICE_PRO_PLUS`, `STRIPE_PRICE_PRO_PLUS_ANNUAL`, `STRIPE_PRICE_CREDITS_500`, `STRIPE_PRICE_CREDITS_2000`, `STRIPE_MODE=live`
**Desbloquea:** cobros, créditos y portal de cliente (Fase 4).
**Mientras tanto:** facturación simulada, planes y créditos locales sin cobrar.

## Pasos (todo en modo **test**)
1. Crea la cuenta de Stripe y quédate en modo de pruebas.
2. Productos (precios = hipótesis de `packages/core/src/billing/plans.ts`, se validan en la beta):
   - «Meri Pro»: recurrente mensual US$29 y anual US$288 → `STRIPE_PRICE_PRO`, `STRIPE_PRICE_PRO_ANNUAL`.
   - «Meri Pro+»: recurrente mensual US$49 y anual US$492 → `STRIPE_PRICE_PRO_PLUS`, `STRIPE_PRICE_PRO_PLUS_ANNUAL`.
   - «Créditos de IA»: dos precios de pago único (500 y 2 000 créditos) → `STRIPE_PRICE_CREDITS_500`, `STRIPE_PRICE_CREDITS_2000`. Importes iguales a los que muestra la app (`CREDIT_PACK_PRICE_CENTS` en `packages/core/src/billing/credits.ts`: US$9 y US$29); si cambian, cambia también esa constante.
3. Copia la clave secreta de test a `STRIPE_SECRET_KEY`.
4. Webhooks. En local: `stripe listen --forward-to localhost:4000/webhooks/stripe` y copia el `whsec_...` a `STRIPE_WEBHOOK_SECRET`. Eventos: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
5. Activa el **Customer Portal** (cancelar, cambiar plan, método de pago) y **Stripe Tax**.
6. Pon `STRIPE_MODE=live`. En modo test el «live» de Meri sigue usando claves `sk_test_`.
7. `pnpm blockers`, luego `/connect-blocker stripe`.

## Prueba
Tarjeta `4242 4242 4242 4242`, cualquier fecha futura y CVC. Debe completar el ciclo prueba, cobro, renovación y cancelación sin duplicar eventos.

## Para cobrar de verdad (más adelante)
Completa la verificación del negocio en Stripe, crea las claves de producción y guárdalas en el gestor de secretos, no en `.env`.
