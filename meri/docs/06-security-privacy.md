# 06 — Seguridad, privacidad y cumplimiento

La confianza es condición de adopción: acceso a correo y calendario profesionales.

## 1. Autorización y permisos
- Consentimiento explícito por servicio; scopes mínimos.
- Gmail MVP: `gmail.readonly` + `gmail.compose` (borradores). **Sin `gmail.send`.**
- Calendar: `calendar.events` + `calendar.readonly` (preferible un calendario dedicado "Meri").
- Permisos de lectura y escritura diferenciados y visibles en UI.
- Nivel de autonomía configurable (`suggest_only` por defecto → `auto_low_risk`).

## 2. Tokens y secretos
- Tokens OAuth cifrados con **cifrado de sobre**: DEK por workspace (AES-256-GCM) cifrada con KMS (AWS/GCP; `local` solo en dev).
- Rotación de claves; nunca registrar tokens en logs.
- Revocación de conexión: borra tokens y llama al endpoint de revocación del proveedor.

## 3. Aislamiento
- RLS por `workspace_id` + filtros en repositorios.
- Tests automáticos de aislamiento multi-tenant y **entre clientes** (contexto de IA).
- Jobs fijan `app.workspace_id` antes de cualquier acceso a datos.

## 4. Cifrado y transporte
- TLS 1.2+ siempre; HSTS; cookies `HttpOnly`, `Secure`, `SameSite=Lax`.
- Cifrado en reposo en la base de datos y backups; columnas sensibles con cifrado a nivel de aplicación (tokens, citas/snippets si el cliente lo exige).

## 5. Minimización y retención
- No almacenar cuerpos de correo por defecto; solo ids, metadatos mínimos y `snippet` citado (≤ 200 car.).
- Retención configurable de snippets/propuestas descartadas (por defecto 90 días).
- Sin adjuntos en el MVP.

## 6. Auditoría
`audit_log` inmutable de acciones automatizadas, accesos a integraciones y cambios de permisos. Visible al usuario.

## 7. Seguridad de aplicación
- Validación Zod en todos los bordes; consultas parametrizadas (Drizzle).
- CSP estricta, protección CSRF, rate limiting por usuario/IP, límites de tamaño.
- Dependencias: `pnpm audit` y Dependabot; SBOM en CI.
- Webhooks: verificar firma (Stripe) / canal y token (Google).
- Secretos solo por variables de entorno/gestor de secretos.
- Prompt injection: ver `docs/05-ai-design.md` §6.

## 8. Verificación de Google (camino crítico — empezar en la Fase 0)
Los scopes de Gmail son **restringidos**: Google exige verificación de la app y, para almacenar/servir datos desde servidores, una **evaluación de seguridad anual (CASA)** realizada por un evaluador autorizado. Puede tardar semanas o meses.
Preparar desde el inicio:
- Política de privacidad pública y términos de servicio.
- Justificación de cada scope y vídeo de demostración.
- Dominio verificado, pantalla de consentimiento completa.
- Cumplimiento de la política de uso limitado de datos de usuario de Google (no usar datos de Gmail para publicidad ni entrenar modelos generales).
Mientras tanto: modo de pruebas con hasta 100 usuarios de prueba para la beta cerrada.

## 9. Cumplimiento
- **GDPR/LGPD/CCPA:** base legal, DPA, derechos de acceso/exportación/eliminación (F-16), registro de tratamiento, subencargados listados (proveedor IA, hosting, Stripe, analítica).
- **Residencia de datos:** opción de región UE (post-MVP).
- **SOC 2 Tipo I** como objetivo tras la beta (política, controles, evidencias desde el principio).
- Para abogados: confidencialidad cliente-abogado; documento "Cómo protegemos la información de tus clientes".

## 10. Respuesta a incidentes
Runbook en `docs/runbooks/incident-response.md`: detección (Sentry/alertas), contención (revocar tokens, rotar claves), notificación (≤ 72 h GDPR), post-mortem sin culpables.

## 11. Responsabilidad por errores
Términos de servicio claros; confirmación obligatoria para acciones de impacto; registro de cambios y deshacer; avisos de que las fechas legales/plazos procesales deben verificarse (el producto asiste, no sustituye el criterio profesional).
