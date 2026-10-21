# Fase 6 — Beta cerrada e instrumentación de validación

**Lee:** `docs/09-metrics-validation.md`, `docs/08-pricing-billing.md`.

## Tareas
Evidencia de cada tarea en `ACCEPTANCE.md`.
- [ ] P6-01 **Entorno de producción/staging** con despliegue automatizado, migraciones seguras, alertas, backups. *Preparado, no desplegado (humano): imágenes, `check:migrations`, `images.yml`, `docs/runbooks/deploy.md`.*
- [ ] P6-02 **Programa de beta:** lista de espera/invitaciones, modo de pruebas de Google (≤ 100 usuarios), onboarding guiado, soporte (chat/email), canal de feedback in-app. *Lista de espera, invitaciones, feedback in-app y onboarding hechos y probados; el modo de pruebas de Google y el soporte por correo dependen del dominio y del proyecto OAuth (humano).*
- [x] P6-03 **Panel de decisión:** indicadores y umbrales de `docs/09` calculados automáticamente (retención 30/60/90, conversión, confirmación de propuestas, Gmail conectado a 30 días, margen).
- [x] P6-04 **Encuesta Sean Ellis** y de cancelación in-app.
- [x] P6-05 **Experimentos de precio:** dos anclas por cohortes (flags).
- [x] P6-06 **Revisión semanal de calidad de IA:** muestra de propuestas descartadas/editadas → ampliar evals (con consentimiento). *Herramienta y consentimiento; etiquetar y ampliar evals es humano.*
- [ ] P6-07 **Estabilización:** corregir los 10 problemas principales de retención/fiabilidad detectados. *Depende de la beta.*
- [ ] P6-08 **Informe final de beta** con recomendación (avanzar / iterar / pivotar) según los umbrales. *Borrador generado por `pnpm beta:report`; la redacción y la decisión son humanas.*

## Fuera de alcance
Marketing masivo; equipos y enterprise.
