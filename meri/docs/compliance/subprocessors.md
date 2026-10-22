# Subencargados del tratamiento

> Lista técnica: qué proveedor recibe qué datos y por qué, según el código. La elección final de hosting y la firma de cada DPA son **trabajo humano**. Cualquier alta o baja se avisa a los clientes con 30 días de antelación (DPA, cláusula 6).

| Proveedor | Función | Datos que recibe | Modo en el código | Ubicación | Estado |
|---|---|---|---|---|---|
| Hosting de contenedores (Fly.io, Render o Railway, docs/02) | Ejecutar web, API y worker | Todos los datos en tránsito | — | por decidir | humano: elegir y firmar DPA |
| Postgres gestionado (Neon o Supabase, docs/02) | Base de datos y PITR | Todos los datos persistidos (tokens cifrados) | `DATABASE_URL` | por decidir | humano |
| Redis gestionado (Upstash u otro) | Colas y rate limit | Cargas de jobs (ids, sin contenido de correo), contadores con TTL de 1 min | `REDIS_URL` | por decidir | humano |
| Anthropic | Modelo de IA (captura, compromisos, borradores, preparaciones) | Fragmentos de correo saneados y minimizados, títulos de eventos y tareas necesarios para cada operación; nunca adjuntos | `AI_MODE=live` | EE. UU. | humano: activar retención cero y sin entrenamiento ([`docs/blockers/anthropic.md`](../blockers/anthropic.md)) |
| Proveedor de correo transaccional (SMTP: SES, Postmark, Resend u otro; D-113) | Enviar el resumen diario y los avisos de cuenta | Dirección e idioma del propietario, recuentos y enlaces; **nunca** contenido de tareas, clientes ni correos | `NOTIFY_MODE=live` | por decidir | humano: elegir, verificar el dominio (SPF, DKIM, DMARC) y firmar DPA ([`docs/blockers/email.md`](../blockers/email.md)) |
| Stripe | Pagos y suscripciones | Email, id de workspace (metadato), plan; datos de tarjeta solo en Stripe | `STRIPE_MODE=live` | EE. UU./UE | humano ([`stripe.md`](../blockers/stripe.md)) |
| AWS KMS | Envolver claves de cifrado | Solo claves de datos (32 bytes) y el contexto `purpose`; ningún dato personal | `KMS_PROVIDER=aws` | región elegida | humano ([`kms.md`](../blockers/kms.md)) |
| Sentry | Errores | Tipo, mensaje limpio (sin correos, credenciales ni consultas) y pila del error; ids de traza, workspace, ruta y job. Nunca cuerpos, cabeceras ni cookies (ADR 0010) | `SENTRY_DSN` | por decidir | humano ([`observability.md`](../blockers/observability.md)) |
| PostHog | Analítica de producto | Id de workspace y eventos enumerados, sin contenido (D-065) | `ANALYTICS_MODE=live` | UE recomendado | humano |
| Google (Gmail, Calendar) | **Fuente** de datos elegida por el usuario, no subencargado | Las peticiones a sus API | `GOOGLE_MODE=live` | — | verificación: [`docs/google-verification.md`](../google-verification.md) |
| Almacenamiento de copias con bloqueo de objetos | Copias cifradas `MERI-BACKUP-1` | Volcado cifrado (sin la clave) | `pnpm backup` | por decidir | humano |

Proveedores **excluidos por diseño**: ninguna red publicitaria; ningún servicio que envíe correo desde la cuenta del usuario (solo borradores).
