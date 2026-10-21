# Runbook: respuesta a incidentes

Objetivo: detectar, contener, notificar y aprender (docs/06 §10). Runbooks relacionados: [`key-rotation.md`](key-rotation.md), [`provider-outage.md`](provider-outage.md), [`backup-restore.md`](backup-restore.md), [`disaster-recovery.md`](disaster-recovery.md). Modelo de amenazas: [`docs/threat-model.md`](../threat-model.md).

## 0. Roles

| Rol | Responsabilidad | Quién |
|---|---|---|
| Responsable del incidente | Decide, coordina y cierra | _humano: nombrar_ |
| Operación | Ejecuta contención y recuperación | _humano_ |
| Comunicación | Usuarios, autoridad, proveedores | _humano_ |

Con un equipo de una persona, la misma persona lleva los tres roles y sigue la lista en orden.

## 1. Detección

- Alertas de Sentry (errores nuevos o picos), tasa de error de la API > 2 % en 5 min.
- `/ready` del worker: colas atrasadas o trabajos en `dead-letter`.
- Revocaciones o `needs_reauth` masivos en `integration_accounts`; coste diario de IA por encima del umbral.
- Fallos del CI de seguridad (gitleaks, `pnpm audit`, CodeQL) en `main`.
- Avisos externos: usuario, investigador de seguridad, proveedor (Google, Stripe, AWS).

Quien lo detecta abre el incidente en el canal de incidentes con hora (UTC), síntoma, alcance estimado y enlace a la evidencia.

## 2. Clasificación

| Nivel | Ejemplos | Respuesta | Comunicación |
|---|---|---|---|
| S1 | Acceso a datos de una cuenta desde otra; fuga de tokens o de claves; secreto en el repositorio; acción automática sobre una reunión de terceros o un correo enviado | Contención inmediata (≤ 1 h) | Usuarios afectados y autoridad (≤ 72 h) si hay datos personales |
| S2 | Caída total de API, worker o base de datos | Recuperar el servicio (RTO ≤ 4 h) | Estado a los usuarios |
| S3 | Proveedor degradado (Google 429/401, IA lenta) | Ver [`provider-outage.md`](provider-outage.md) | Si dura > 30 min |

Ante la duda, clasificar más alto y bajar después.

## 3. Contención

Elegir lo que aplique; anotar en la línea de tiempo cada acción con su hora.

- **Tokens de Google comprometidos:** rotación tras compromiso ([`key-rotation.md`](key-rotation.md) §3): `pnpm keys:rotate --reencrypt`, cuentas a `needs_reauth`, revocación en Google.
- **Clave KMS comprometida:** desactivarla en KMS, clave nueva, `--reencrypt`, copia nueva y retirar las copias antiguas.
- **Sesiones comprometidas:** rotar `AUTH_SECRET` (cierra todas las sesiones). Para una sola cuenta, el usuario (o soporte en su nombre) usa «Cerrar sesión en todos los dispositivos» (`POST /v1/account/sessions/revoke`).
- **Secreto en el repositorio:** rotar el secreto primero (el historial de git ya está comprometido); después limpiar el historial con quien administre el repositorio.
- **Sospecha de fallo de aislamiento:** desplegar en modo solo lectura (detener el worker y revertir el último despliegue); comprobar `select rolname, rolbypassrls from pg_roles where rolname = 'meri_app'` (debe ser `false`) y que las políticas `ws_isolation` siguen activas en todas las tablas; ejecutar `pnpm --filter @meri/api exec vitest run src/routes/authz-matrix.test.ts` contra el código desplegado.
- **Acción automática indebida** (p. ej. un bloque que pisa una reunión): la auditoría (`audit_log`) dice qué hizo y permite deshacerlo desde Actividad; desactivar la autonomía (`suggest_only`) para las cuentas afectadas.
- **IA comportándose mal** (inyección que se cuela en propuestas): todo sigue pasando por confirmación del usuario; apagar los flags `ai_capture` y `ai_briefings` (tabla `feature_flags`) y bajar `AI_MONTHLY_COST_CAP_USD_PER_USER` al mínimo para cortar llamadas (`AI_MODE=fake` está prohibido en producción); no existe aún un interruptor único para la extracción de compromisos (deuda técnica) y añadir el caso a `evals/` antes de reabrir.
- **Abuso o tráfico anómalo:** bajar `RATE_LIMIT_PER_MINUTE` y bloquear en el proveedor de hosting.

## 4. Erradicación y recuperación

- Corregir la causa con un test que reproduzca el fallo (nunca solo configuración manual).
- Si hubo pérdida o corrupción de datos: [`backup-restore.md`](backup-restore.md) o [`disaster-recovery.md`](disaster-recovery.md).
- Antes de reabrir: `pnpm verify`, `pnpm smoke <id>` de los servicios afectados y prueba manual de una cuenta de prueba.

## 5. Notificación

- **Autoridad de control:** ≤ 72 h desde que se tiene constancia de una violación de datos personales (art. 33 RGPD), salvo que sea improbable que suponga un riesgo. Si no se tiene toda la información, notificar por fases.
- **Usuarios afectados:** sin dilación indebida cuando el riesgo sea alto (art. 34): qué pasó, qué datos, qué hicimos, qué deben hacer (p. ej. revisar la actividad, reconectar Google). Desde `seguridad@` del dominio ([`domain-brand.md`](../blockers/domain-brand.md)).
- **Clientes con DPA:** en ≤ 48 h (cláusula 4 de [`dpa-template.md`](../compliance/dpa-template.md)).
- **Google:** si afecta a datos de las API de Google, según las condiciones de la verificación ([`google-verification.md`](../google-verification.md)).
- Plantilla mínima: fecha y hora, naturaleza, categorías y número aproximado de interesados y registros, consecuencias probables, medidas tomadas y propuestas, contacto.

## 6. Post-mortem (sin culpables)

En ≤ 5 días laborables, en `docs/postmortems/<fecha>-<titulo>.md`: cronología, impacto, causa raíz, qué funcionó, qué no, acciones con responsable y fecha. Cada acción técnica se convierte en una tarea con test. Revisar si el modelo de amenazas necesita una amenaza nueva.
