# Runbook: operar la beta cerrada

Comandos y decisiones de la fase 6 (D-099..D-104). Todos se ejecutan con la conexión propietaria (`DATABASE_ADMIN_URL`) desde una máquina de operación; ninguno imprime direcciones ni contenido, solo recuentos.

## 1. Invitaciones y lista de espera (D-099)
- Activar la beta cerrada: `BETA_INVITE_REQUIRED=1` en la API y en la web (`docs/runbooks/deploy.md`). Las cuentas existentes siguen entrando; una dirección nueva sin invitación ve la lista de espera en `/login` (código `BETA_INVITE_REQUIRED`).
- Invitar: `pnpm beta:invite <correo>`. Avisa al pasar de **100 personas** (cuentas + invitaciones pendientes): es el tope de usuarios de prueba de una app de Google en modo «Testing» (`docs/blockers/google-oauth.md`). Más allá hay que publicar la app (verificación de Google, humano).
- La invitación y la entrada en la lista de espera se borran en la misma transacción en la que se crea la cuenta (`consume_beta_email()`).
- Derecho de supresión de alguien que nunca tuvo cuenta: `pnpm beta:forget <correo>`. Las entradas de la lista de espera caducan solas a los 180 días.
- La lista de espera no se puede leer desde la aplicación (el rol `meri_app` solo inserta). Para escribir a quien está en ella, un humano consulta la tabla con la conexión propietaria y respeta el consentimiento recogido.

## 2. Comentarios y encuesta (D-099, D-101)
- «Enviar comentarios» (barra lateral y «Más») guarda tipo, texto y ruta de la página en `feedback`; 20 por cuenta y día. Se leen con la conexión propietaria; nunca van a analítica ni a la IA.
- La encuesta Sean Ellis aparece en Hoy a partir de 14 días tras el onboarding, una vez por cuenta (si se descarta, a los 30 días, como mucho dos veces).

## 3. Experimento de precio (D-102)
1. Decidir el ancla B (hipótesis por defecto: Pro US$39, Pro+ US$59; `PRICE_ANCHOR_B_PRO_CENTS`, `PRICE_ANCHOR_B_PRO_PLUS_CENTS`).
2. Crear en Stripe los cuatro precios B (mensual y anual de cada plan) y ponerlos en `STRIPE_PRICE_PRO_B`, `STRIPE_PRICE_PRO_ANNUAL_B`, `STRIPE_PRICE_PRO_PLUS_B`, `STRIPE_PRICE_PRO_PLUS_ANNUAL_B` (`pnpm blockers` los lista como opcionales). Sin ellos, el checkout de la cohorte B se rechaza en vez de cobrar el precio A.
3. Activar: `pnpm flags:set price_experiment on`. La API lo lee en ≤ 30 s. Cada cuenta en prueba recibe su cohorte (determinista) la primera vez que ve su plan, y no cambia nunca.
4. Apagar: `pnpm flags:set price_experiment off`. Las cuentas que ya tienen cohorte B la conservan (no se les cambia el precio); las nuevas ven A.
5. Comparar: `pnpm beta:panel` muestra la conversión por cohorte. `/precios` (público) siempre muestra A.

## 4. Panel de decisión e informe (D-100, D-104)
- `pnpm beta:panel` (o `--json`): los seis indicadores de `docs/09-metrics-validation.md` con valor, muestra, umbral y veredicto, y la recomendación = el peor veredicto entre los indicadores con muestra suficiente (10 por defecto, `--min-sample N`). Indica cuántos indicadores la respaldan: con uno o dos, no es una decisión.
- La sesión es de solo lectura. La sección de fiabilidad lee las colas del worker en `WORKER_READY_URL` (por defecto `http://localhost:4100/ready`; en producción, la URL interna del worker).
- `pnpm beta:report` escribe `docs/beta/report-<fecha>.md` (0600, ignorado por git): un **borrador** con agregados. Una persona completa los 10 problemas principales, las entrevistas y la decisión antes de compartirlo.

## 5. Revisión semanal de calidad de IA (D-103)
1. Solo entran cuentas que activaron «Ayudar a mejorar la IA de Meri» (Control → IA; apagado por defecto) y solo propuestas **descartadas o editadas que no vienen del correo** (captura, calendario, planificador). Nunca hilos de Gmail, seguimientos ni vínculos de contactos.
2. `pnpm ai:review-sample [--days 7] [--limit 50]` escribe `<carpeta>/<fecha>.jsonl` (0600, carpeta 0700) con todo el texto censurado: ids, correos, enlaces, RUT, teléfonos, números largos y nombres de clientes y contactos de esa cuenta. Sin ids de workspace. La carpeta está **fuera del repositorio**: `~/meri-review-samples` o `MERI_REVIEW_SAMPLE_DIR`; el comando rechaza una carpeta dentro del repo, así que una muestra no puede acabar en un commit ni en una imagen. Cada cuenta incluida recibe una entrada `ai.review_sampled` en su auditoría.
3. Una persona etiqueta los casos y reescribe los útiles como casos sintéticos en `evals/` (nunca se copia el texto real). Los ficheros de muestra se borran a los 30 días en la siguiente ejecución.

## 6. Qué queda para personas
Reclutar 15–25 clientes de diseño, entrevistas semanales, soporte, decidir el ancla B y activar el experimento, leer el panel, corregir los 10 problemas principales (P6-07) y escribir el informe final con la decisión (P6-08).
