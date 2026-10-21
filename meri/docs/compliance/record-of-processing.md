# Registro de actividades de tratamiento (art. 30 RGPD)

> Borrador técnico escrito desde lo que el código hace. **Requiere revisión legal humana** antes de la beta: base jurídica, plazos legales de conservación de facturación y datos del responsable.

## Roles

- **Meri como responsable** de los datos de la cuenta del usuario (identidad, facturación, uso).
- **Meri como encargado** de los datos de terceros que aparecen en el correo y el calendario del usuario (sus clientes y contactos): el usuario profesional es el responsable y Meri trata esos datos por su cuenta (DPA en [`dpa-template.md`](dpa-template.md)).

Responsable / encargado: _razón social, domicilio y contacto del delegado de protección de datos: pendiente (humano)_.

## Actividades

| # | Actividad | Rol | Interesados | Categorías de datos | Base jurídica (propuesta) | Conservación | Destinatarios |
|---|---|---|---|---|---|---|---|
| 1 | Cuenta e inicio de sesión | responsable | usuarios | email, nombre, imagen de perfil, `sub` de Google, zona horaria, idioma, preferencias | contrato (art. 6.1.b) | mientras la cuenta exista; purga a los 30 días de borrarla | hosting, base de datos |
| 2 | Planificación del trabajo | encargado y responsable | usuarios, sus clientes | tareas, proyectos, clientes, bloques del plan, eventos del calendario (título, horario, asistentes) | contrato | mientras la cuenta exista; los eventos se resincronizan desde Google | hosting, base de datos, proveedor de IA (si la función está activa) |
| 3 | Radar de compromisos y seguimientos | encargado | contactos del usuario | índice de hilos (id, asunto, participantes, fecha), cita ≤ 200 caracteres, compromisos detectados; **nunca cuerpos ni adjuntos** | contrato; interés legítimo del usuario para sus contactos | retención configurable 7–365 días (90 por defecto) para hilos, propuestas descartadas o caducadas y citas | proveedor de IA (fragmentos saneados), hosting |
| 4 | Tiempo por cliente | encargado | usuarios, clientes | entradas de tiempo inferidas o confirmadas | contrato | mientras la cuenta exista | hosting |
| 5 | Facturación | responsable | usuarios | id de cliente de Stripe, plan, estado, créditos, encuesta de cancelación | contrato; obligación legal para facturas | mientras la cuenta exista; Stripe conserva facturas según su obligación legal (revisión legal) | Stripe |
| 6 | Seguridad y auditoría | responsable | usuarios | `audit_log` (acción, entidad, antes/después), registros técnicos sin contenido | interés legítimo (seguridad) | auditoría: mientras la cuenta exista; registros técnicos según el proveedor (≤ 30 días recomendado) | hosting, Sentry |
| 7 | Analítica de producto | responsable | usuarios | id de workspace y eventos enumerados, sin contenido (D-065) | interés legítimo / consentimiento según jurisdicción (revisión legal) | según PostHog (configurable) | PostHog |
| 8 | Notificaciones | responsable | usuarios | contenido del aviso (títulos de tareas o compromisos) | contrato | bandeja interna: mientras la cuenta exista | proveedor de push o correo transaccional (cuando se active) |
| 9 | Copias de seguridad | responsable / encargado | todos los anteriores | volcado cifrado completo | interés legítimo (continuidad) | ≤ 30 días; la restauración reaplica supresiones | almacenamiento de copias (humano) |
| 10 | Beta cerrada: lista de espera e invitaciones (fase 6, D-099) | responsable | personas que piden acceso | correo, idioma, fecha de consentimiento | consentimiento (casilla en `/login`) | lista de espera: 180 días o hasta crear la cuenta; invitación: hasta crear la cuenta; borrado a petición (`pnpm beta:forget`) | hosting |
| 11 | Comentarios y encuestas en la app (fase 6, D-099, D-101) | responsable | usuarios | tipo y texto del comentario, ruta de la página (sin parámetros); respuesta Sean Ellis y comentario ≤ 500 | interés legítimo (mejorar el producto) | mientras la cuenta exista | hosting; nunca a analítica ni a la IA |

## Medidas técnicas y organizativas (art. 32)

Resumen; detalle en [`docs/threat-model.md`](../threat-model.md) y ADR 0007:

- Aislamiento por workspace con RLS forzada y matriz de autorización sobre todas las rutas.
- Tokens OAuth con cifrado de sobre (AES-256-GCM) y KMS; rotación con re-cifrado; copias cifradas (`MERI-BACKUP-1`).
- Minimización: sin cuerpos de correo, sin adjuntos, citas acotadas, retención configurable.
- Auditoría inmutable de toda acción automática, visible al usuario y deshacible.
- Derechos de acceso y portabilidad (exportación JSON/ZIP) y de supresión verificada ([`deletion-verification.md`](deletion-verification.md)).
- CSP con nonce, CSRF en dos capas, rate limit, HSTS, cookies seguras.
- Respuesta a incidentes con notificación ≤ 72 h ([`docs/runbooks/incident-response.md`](../runbooks/incident-response.md)).

## Transferencias internacionales

Dependen de la región de cada subencargado ([`subprocessors.md`](subprocessors.md)). La región UE es post-MVP (docs/06 §9). Pendiente humano: cláusulas contractuales tipo o marco de privacidad de datos UE-EE. UU. con cada proveedor.
