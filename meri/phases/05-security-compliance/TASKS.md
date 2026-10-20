# Fase 5 — Seguridad, cumplimiento y verificación OAuth

**Lee:** `docs/06-security-privacy.md` completo, `docs/10-testing-quality.md`.

## Tareas
- [x] P5-01 **Revisión de amenazas (STRIDE)** del flujo de correo/IA/calendar; documento en `docs/threat-model.md`.
- [ ] P5-02 **Hardening:** CSP estricta, CSRF, rate limiting, límites de tamaño, cabeceras de seguridad, validación de redirecciones OAuth, rotación de sesiones.
- [ ] P5-03 **Cifrado:** integrar KMS real (proveedor elegido), rotación de claves con re-cifrado, copia de seguridad cifrada, prueba de restauración.
- [ ] P5-04 **Privacidad F-16:** exportación completa (JSON+CSV), eliminación de cuenta (job `data.delete_account`) con verificación, revocación de conexiones desde UI, retención configurable.
- [ ] P5-05 **Auditoría visible** al usuario: pantalla de actividad y permisos.
- [ ] P5-06 **Pruebas de seguridad:** gitleaks, CodeQL, `pnpm audit`, SBOM, test de autorización (IDOR) por endpoint, fuzzing de parsers de correo/calendario.
- [ ] P5-07 **Verificación de Google:** preparar paquete (política de privacidad, términos, justificación de scopes, vídeo de demo, dominio verificado, uso limitado de datos) y checklist para la evaluación CASA. Documentar en `docs/google-verification.md`.
- [ ] P5-08 **Documentación de cumplimiento:** registro de tratamiento, lista de subencargados, DPA plantilla, página "Cómo protegemos tus datos".
- [ ] P5-09 **Runbooks completos:** incidentes, rotación de claves, caída de proveedor, restauración de backups.
- [ ] P5-10 **Pruebas de recuperación ante desastres** (RPO/RTO documentados).

## Fuera de alcance
SOC 2 formal (preparar controles y evidencias, no auditoría).
