# Fase 2 — Gmail y Radar de compromisos (producto estrella)

**Objetivo:** detectar compromisos propios y de terceros en el correo, con propuestas verificables y seguimiento accionable.
**Lee:** `docs/01-product-spec.md` (F-07, F-08), `docs/05-ai-design.md` (todo), `docs/06-security-privacy.md` §5, §8.

## Tareas
- [x] P2-01 **Conector Gmail:** OAuth (readonly + compose), carga inicial 30 días, `history.list`, `watch` Pub/Sub + polling, cuotas, backoff. `FakeGmail` para tests/dev.
- [x] P2-02 **`threads_index` y minimización:** guardar solo metadatos + `snippet` citado; nunca cuerpos.
- [x] P2-03 **Prefiltro por reglas** (newsletters, no-reply, bulk, promos) con tests.
- [x] P2-04 **`packages/ai`:** cliente Anthropic con reintentos, medición de coste/tokens (`ai_usage`), *prompt caching*, modelos por env, salida estructurada + Zod + reparación.
- [x] P2-05 **Pipeline de extracción (AI-2)** completo (docs/05 §3): contexto acotado, verificación de cita, deduplicación, clasificación de confianza.
- [x] P2-06 **Defensa contra inyección** (docs/05 §6) + suite `evals/injection/`.
- [x] P2-07 **Set de evals:** crear generador/semilla de ≥ 200 correos sintéticos es/en en `evals/commitments/*.jsonl` con etiquetas; runner `pnpm eval` que calcula precisión/recobrado y escribe informe.
- [x] P2-08 **Bandeja de propuestas (UI):** confirmar/editar/descartar con teclado; mostrar cita + enlace al hilo + confianza; feedback guardado.
- [x] P2-09 **Radar de compromisos (UI):** vistas "Debo" / "Me deben"; estados; vencimientos; vínculo a tareas.
- [x] P2-10 **Seguimiento (F-08):** job `followups.scan`; reglas (sin respuesta tras N días, vencidos); acciones: recordatorio, tarea "esperando a", **borrador en Gmail** (AI-3). Silenciar por contacto/cliente. **Nunca enviar.**
- [x] P2-11 **Auto-confirmación opcional** (flag `gmail_autoconfirm`) solo para `explicit` ∧ confianza alta.
- [x] P2-12 **Notificaciones agrupadas** de propuestas nuevas.
- [x] P2-13 **Controles de privacidad:** pausar ingesta, excluir remitentes/etiquetas, desconectar y purgar.

## Fuera de alcance
Outlook, adjuntos, envío de correo, clientes avanzados (Fase 3).
