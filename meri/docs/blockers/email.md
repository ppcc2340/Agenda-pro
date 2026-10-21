# Proveedor de correo transaccional (SMTP)

**Variables:** `NOTIFY_MODE=live`, `SMTP_URL` (`smtps://usuario:clave@host:465` o `smtp://usuario:clave@host:587`, con STARTTLS obligatorio salvo hacia localhost) y `MAIL_FROM` (por ejemplo `Meri <avisos@tu-dominio>`).
**Desbloquea:** el resumen diario y los avisos de cuenta (pago fallido, créditos, prueba que termina, conexión caducada) por correo, además de la bandeja de Meri (D-113, ADR 0009).
**Mientras tanto:** `FakeNotifier` registra los correos sin enviarlos; los avisos se ven solo dentro de Meri.
**Depende de:** `domain-brand` (hace falta un dominio propio para firmar el correo).

## Pasos
1. Elige un proveedor que acepte SMTP (Amazon SES, Postmark, Resend, Mailgun…). Cualquiera sirve: el código no depende de él.
2. Verifica el dominio de envío en el proveedor y publica **SPF, DKIM y DMARC** (empieza con `p=quarantine`). Sin ellos Gmail y Outlook mandan los correos a spam.
3. Crea credenciales SMTP de solo envío y guárdalas en el gestor de secretos como `SMTP_URL`. Codifica en la URL los caracteres especiales de la clave (`encodeURIComponent`).
4. `MAIL_FROM` debe ser una dirección de ese dominio. Nunca el Gmail de una persona: Meri jamás envía desde la cuenta del usuario.
5. Añade el proveedor a `docs/compliance/subprocessors.md` (recibe solo la dirección de la persona y un texto con recuentos, nunca contenido de tareas, clientes ni correos) y firma su DPA.
6. `pnpm blockers`, luego `/connect-blocker email`.

## Prueba
`SMOKE_EMAIL_TO=tu@correo pnpm smoke email` envía un resumen de ejemplo. Comprueba en el correo recibido: remitente correcto, `SPF=pass`, `DKIM=pass`, `DMARC=pass`, cabeceras `List-Unsubscribe` y `List-Unsubscribe-Post`, y que el enlace «Dejar de recibir correos de Meri» abre la página de baja.

## Operación
- Rebotes y quejas: el proveedor los gestiona; si una dirección rebota de forma permanente, el envío queda `failed` en `notifications.email_state` y no se reintenta.
- Cada persona elige `off`, `digest` (por defecto) o `all` en Control → Avisos. La baja en un clic desde el cliente de correo pone `off`.
