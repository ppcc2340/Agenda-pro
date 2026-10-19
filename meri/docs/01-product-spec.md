# 01 — Especificación de producto

Convención: **MUST** = obligatorio en el MVP; **SHOULD** = deseable; cada funcionalidad tiene ID `F-xx` y criterios de aceptación `AC`.

---

## F-01 Cuenta, workspace y preferencias (MUST)
- Registro/login con Google (OAuth). Un usuario tiene un workspace personal.
- Onboarding ≤ 10 min: zona horaria, horario laboral, bloques de concentración preferidos, duración mínima de bloque, margen de imprevistos (por defecto 20 %), vertical/plantilla.
- **AC1:** un usuario nuevo llega a "Hoy" con calendario conectado en ≤ 10 min.
- **AC2:** preferencias editables y aplicadas por el planificador.
- **AC3:** eliminar cuenta borra datos y revoca tokens (ver F-16).

## F-02 Captura rápida (MUST)
- Cuadro de captura global (atajo `⌘/Ctrl+K`) con lenguaje natural: "Informe para Acme el jueves, 2h".
- Un parser (IA + reglas) propone: título, cliente/proyecto, fecha límite, duración, prioridad. Lo propuesto se muestra como **sugerencia editable** antes de confirmar; una captura rápida con solo título es válida (va a Entrada).
- **AC1:** capturar con solo título crea un elemento en Entrada en < 1 s.
- **AC2:** con lenguaje natural, ≥ 85 % de los campos propuestos correctos en el set de evals de captura.
- **AC3:** sugerencias y datos confirmados se distinguen visualmente.

## F-03 Tareas, estados y proyectos (MUST)
- Estados: `pending`, `scheduled`, `in_progress`, `blocked`, `waiting_on_third_party`, `at_risk`, `completed`.
- Campos: título, notas, cliente, proyecto, prioridad (1–4), fecha límite (blanda/dura), duración estimada, dependencias (`blocked_by`), etiquetas.
- División de tareas en subtareas (manual; sugerencia por IA SHOULD).
- **AC1:** una tarea con dependencia no completada no se programa antes de que termine su dependencia.
- **AC2:** el estado `at_risk` se calcula por reglas (ver F-13), no por IA.

## F-04 Calendario Google (MUST)
- Sincronización bidireccional con Google Calendar: lectura de eventos, escritura de bloques de trabajo en un calendario dedicado "Meri" (por defecto) o el principal (opción).
- Sync incremental con `syncToken`, webhooks (`watch`) + polling de respaldo, control de duplicados e idempotencia.
- **AC1:** cambios en Google se reflejan en ≤ 60 s (webhook) o ≤ 5 min (polling).
- **AC2:** Meri nunca modifica ni borra eventos que no creó (solo bloques propios), salvo confirmación explícita.
- **AC3:** pérdida de conexión o token revocado produce estado "reconectar" visible, sin pérdida de datos.

## F-05 Planificador diario y semanal (MUST)
- Genera plan realista a partir de tareas, eventos, disponibilidad, preferencias y margen. Algoritmo en `docs/04-planner-engine.md`.
- Reprogramación asistida: ante cambios, propone un nuevo plan con **diff** (qué se mueve y por qué). El usuario acepta/rechaza.
- **AC1:** el plan no contiene solapamientos con eventos fijos ni excede la capacidad diaria (con margen).
- **AC2:** determinista: mismas entradas → mismo plan.
- **AC3:** cada bloque tiene una explicación ("Programado hoy porque vence el jueves y tiene 3 h de holgura").
- **AC4:** tests basados en propiedades pasan (ver `docs/10-testing-quality.md`).

## F-06 Vista "Hoy" y navegación (MUST)
Cinco áreas: **Hoy, Entrada, Proyectos y compromisos, Calendario, Centro de control** (búsqueda global/comandos/configuración).
"Hoy" responde: ¿Qué hago ahora? ¿Qué es lo más importante hoy? ¿Qué puede salir mal? ¿Qué espero de otros?
- **AC1:** "Hoy" carga en < 1.5 s (p75) con datos de un usuario con 500 tareas.
- **AC2:** accesible por teclado; PWA instalable; responsive.

## F-07 Gmail + Radar de compromisos (MUST — producto estrella)
- Ingesta de correo (solo lectura + borradores). Detecta:
  - Compromisos del usuario (`owed_by_me`).
  - Compromisos de terceros (`owed_to_me`).
  - Solicitudes recibidas, plazos mencionados, aprobaciones pendientes.
- Clasificación: `explicit`, `inferred`, `suggested`. Solo `explicit` con alta confianza puede auto-confirmarse (opción del usuario); el resto va a **Entrada → Propuestas**.
- Cada propuesta enlaza al hilo original, cita el fragmento relevante (≤ 200 caracteres) y muestra confianza.
- **AC1:** cumple umbrales de evals (precisión/recobrado) de `docs/05-ai-design.md` §7.
- **AC2:** el usuario puede confirmar, editar, descartar; el descarte alimenta mejoras (feedback).
- **AC3:** no se almacena el cuerpo completo de los correos por defecto (ver `docs/06-security-privacy.md` §5).
- **AC4:** correos de newsletters/no-reply/automáticos se filtran por reglas antes de gastar IA.

## F-08 Seguimiento (MUST, versión acotada)
- Detecta: correos enviados sin respuesta tras N días, documentos prometidos que no llegan, compromisos de terceros vencidos.
- Acciones: crear recordatorio, crear tarea "esperando a", **preparar borrador** en Gmail. Nunca enviar.
- **AC1:** un compromiso de tercero vencido genera una única alerta con acción sugerida.
- **AC2:** el usuario puede configurar "silenciar" por contacto/cliente.

## F-09 Clientes/asuntos y segregación (MUST)
- Entidades `client` y `matter/project`. Todo elemento (tarea, compromiso, evento, hilo, tiempo) puede asociarse a un cliente.
- Contexto de IA **siempre acotado a un cliente** cuando el elemento pertenece a uno: nunca mezclar datos de otro cliente en un prompt.
- **AC1:** test automatizado demuestra que el contexto enviado a la IA para el cliente A no contiene ningún dato del cliente B.
- **AC2:** vistas y búsquedas filtrables por cliente.

## F-10 Tiempo facturable inferido (MUST)
- Infiere entradas de tiempo desde eventos de calendario, bloques completados y actividad en tareas. El usuario **revisa y aprueba** (no se factura nada solo).
- Exportación CSV y a Stripe/QuickBooks/Xero (post-MVP; el MVP exporta CSV).
- Detecta "tiempo no registrado" (eventos/bloques sin entrada asociada).
- **AC1:** resumen semanal por cliente con horas confirmadas y horas sugeridas.
- **AC2:** exportación CSV con cliente, asunto, fecha, duración, descripción, estado de aprobación.

## F-11 Briefing de cliente y preparación de reuniones (SHOULD en MVP; MUST en Fase 3)
- Antes de una reunión con un cliente: ficha con pendientes, compromisos vivos, últimas comunicaciones, documentos vinculados, decisiones pendientes, riesgos.
- **AC1:** briefing generado en < 10 s, con enlaces a las fuentes.
- **AC2:** cada afirmación del briefing es trazable a un elemento fuente.

## F-12 Revisión diaria/semanal e informe de valor (MUST)
- Resumen diario (completado, pendientes, reprogramar, bloqueos, nuevos riesgos, prioridades de mañana).
- Informe de valor semanal/mensual: "compromisos salvados", "plazos en riesgo detectados", "horas recuperadas (estimadas, con método visible)".
- **AC1:** el método de cálculo de cada cifra es visible al hacer clic; sin cifras inventadas.

## F-13 Detección de sobrecarga y riesgos (MUST)
- Compara capacidad vs carga; marca `at_risk` por regla: holgura < umbral, dependencias bloqueadas, sin tiempo asignable.
- Muestra el conflicto, tareas afectadas y alternativas (mover, delegar, renegociar fecha, dividir).
- **AC1:** nunca desplaza silenciosamente; siempre muestra diff.
- **AC2:** máximo N alertas/día (configurable, por defecto 5); agrupadas.

## F-14 Registro de auditoría y deshacer (MUST)
- `audit_log` de toda acción automatizada con actor (`user`/`system`/`ai`), motivo, antes/después.
- Deshacer para: reprogramaciones, creación/edición de tareas por automatización, cambios de estado.
- **AC1:** cada acción automatizada tiene entrada de auditoría visible al usuario.

## F-15 Planes, facturación y créditos de IA (MUST)
Ver `docs/08-pricing-billing.md`. Stripe Checkout, portal de cliente, webhooks, derechos (`entitlements`), medición de uso de IA.
- **AC1:** superar el límite de créditos degrada con elegancia (reglas siguen funcionando; IA pausada con aviso).

## F-16 Privacidad: exportación y eliminación (MUST)
- Exportar todos los datos (JSON + CSV) y eliminar cuenta (borrado completo en ≤ 30 días, lógico inmediato).
- Revocar conexiones desde la UI.
- **AC1:** tras eliminar, no queda ningún dato personal salvo registros fiscales obligatorios.

---

## Post-MVP (backlog)
Outlook/Microsoft Graph, Notion, Slack/Teams, voz y dictado, transcripción de reuniones, equipos y delegación a asistentes, CRM (HubSpot/Salesforce), facturación contable (QuickBooks/Xero), API pública y webhooks, SSO/SAML, modo offline móvil.
