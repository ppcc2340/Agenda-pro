# 0009. Correo transaccional de Meri

- Estado: aceptada
- Fecha: 2026-10-21

## Contexto
D-020 dejó para la fase 6 la entrega fuera de la aplicación: «correo transaccional propio, nunca el Gmail del usuario». Al cerrar la parte técnica de la fase 6 solo existía `FakeNotifier`. El resumen diario y los avisos de cuenta (pago fallido, créditos, prueba que termina, conexión caducada) solo se veían abriendo Meri, y para una beta eso basta para perder el hábito de uso. Detalle en `phases/06-beta-validation/PLAN-mvp-final.md` (D-113..D-116).

## Opciones consideradas
- **API HTTP de un proveedor** (Postmark, Resend, SES) frente a **SMTP**:
  - una API ata el código a un proveedor;
  - SMTP lo acepta cualquiera, y con un servidor SMTP en proceso se prueba el protocolo real, no un simulador.
- **Enviar desde cada sitio que crea un aviso** (8) frente a **un despachador** que recoge los avisos nuevos:
  - lo primero obliga a tocar cada handler, y un fallo de envío se pierde tras el commit;
  - lo segundo reintenta con la cola y deja los handlers como estaban.
- **Copiar el aviso en el correo** frente a **recuentos y enlace**:
  - el correo pasa por un subencargado y queda en buzones fuera de nuestro control;
  - solo recuentos y enlace evitan enviarle datos de clientes.

## Decisión
1. **Adaptador** `SmtpNotifier` (`nodemailer`):
   - `NOTIFY_MODE=fake|live`, `SMTP_URL`, `MAIL_FROM`; bloqueo `email`.
   - TLS obligatorio salvo hacia localhost.
   - Asunto en una sola línea sin caracteres de control, destinatario validado, sin acceso a ficheros ni URL.
   - Una respuesta 5xx o un fallo de autenticación es `Permanent`; una 4xx o un fallo de red, `Transient`.
2. **Preferencia** `preferences.email_notifications`:
   - `off`: nada.
   - `digest` (por defecto): resumen diario, facturación y conexiones.
   - `all`: todo.
   - La regla vive en `core` (`emailAllowed`).
3. **Contenido**: `renderNotificationEmail` en `core`, en es/en según `users.locale`. Solo recuentos numéricos y un enlace a la página que corresponde; los parámetros que no son números nunca se imprimen y todo se escapa.
4. **Entrega**:
   - Despachador cada minuto: avisos de las últimas 2 h sin `email_state`, con preferencia que lo permita, de workspaces vivos.
   - Un job `notify.email` por aviso (`jobId` por id). El job vuelve a comprobar todo dentro de la transacción del workspace, envía y marca `sent`, `skipped` o `failed`.
   - Garantía de al menos una vez: puede repetir un correo si cae entre enviar y marcar.
5. **Destinatario**: el propietario del workspace. Nunca la cuenta de demo, una cuenta borrada ni un workspace borrado.
6. **Baja en un clic** (RFC 8058):
   - `List-Unsubscribe` y `List-Unsubscribe-Post`. Token HMAC con clave HKDF propia de `AUTH_SECRET` sobre el id del workspace, sin caducidad.
   - `POST /v1/email/unsubscribe?t=` es público y sin CSRF: el token es la autorización y la acción solo reduce envíos.
   - Pone `off`, audita y responde igual siempre.
   - Un GET nunca da de baja: la página `/correo/baja` pide confirmar con un botón.

## Consecuencias
- Un subencargado nuevo (proveedor de correo), que recibe dirección y recuentos.
- Producción exige `NOTIFY_MODE=live`, así que el lanzamiento depende del dominio con SPF, DKIM y DMARC (`docs/blockers/email.md`).
- Probado contra un servidor SMTP real en proceso; nunca contra un proveedor (`pnpm smoke email` es la primera prueba real, humana).
- Deuda: plantillas HTML con marca, gestión de rebotes por webhook del proveedor, push web o móvil (post-MVP).
