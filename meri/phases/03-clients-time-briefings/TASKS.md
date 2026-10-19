# Fase 3 — Clientes, tiempo inferido y briefings

**Lee:** `docs/01-product-spec.md` (F-09, F-10, F-11), `docs/05-ai-design.md` §3–4, §6.

## Tareas
- [x] P3-01 **Clientes y asuntos:** CRUD, asociación a tareas/compromisos/eventos/hilos; resolución automática por dominio/contacto con confirmación; límites por plan (`max_clients`).
- [ ] P3-02 **Aislamiento de contexto de IA:** `ContextBuilder` que construye el contexto **solo** del cliente objetivo; tests que prueban ausencia de datos de otros clientes (property tests con datos aleatorios).
- [ ] P3-03 **Filtros y búsqueda por cliente** (búsqueda global ⌘K con scope).
- [ ] P3-04 **Tiempo inferido (F-10):** inferir desde eventos, bloques completados y actividad; pantalla de revisión semanal (aprobar/editar/rechazar en lote); detección de tiempo no registrado; redondeos configurables (6/15 min); exportación CSV.
- [ ] P3-05 **Briefing de cliente/reunión (F-11, AI-4):** ficha con pendientes, compromisos, últimas comunicaciones, decisiones pendientes y riesgos; **cada afirmación enlaza a su fuente**; generación en < 10 s; disparo automático antes de reuniones con cliente (configurable).
- [ ] P3-06 **Post-reunión:** formulario rápido para registrar acuerdos → compromisos/tareas propuestas (sin transcripción).
- [ ] P3-07 **Plantillas por vertical** (abogados, consultores): etiquetas, tipos de asunto, plazos típicos, vocabulario; onboarding ≤ 10 min.
- [ ] P3-08 **Vista por cliente:** línea de tiempo, riesgos, horas del mes.

## Fuera de alcance
Facturación contable, CRM, transcripción de audio.
