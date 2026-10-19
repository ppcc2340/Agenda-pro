# 09 — Métricas y validación

## Métrica principal ("North Star")
**Compromisos gestionados con éxito por usuario activo semanal** (compromisos confirmados que se cumplen a tiempo o se reprograman proactivamente) + **tiempo semanal dedicado a organizar** (debe bajar).

## Eventos de analítica (PostHog)
`signup`, `onboarding_completed`, `calendar_connected`, `gmail_connected`, `first_plan_generated`, `plan_accepted`, `plan_rejected`, `capture_created`, `proposal_shown`, `proposal_confirmed`, `proposal_edited`, `proposal_dismissed`, `followup_draft_created`, `commitment_fulfilled`, `commitment_at_risk_flagged`, `time_entry_approved`, `time_export`, `value_report_viewed`, `trial_started`, `subscription_started`, `subscription_cancelled` (+ motivo), `integration_error`.
Sin contenido de correos ni nombres de clientes en eventos (solo ids y contadores).

## Métricas
- **Activación:** % que completa onboarding; tiempo hasta el primer resultado útil (objetivo ≤ 15 min); "momento aha" = primer compromiso detectado y confirmado correctamente **o** primer plan aceptado.
- **Retención:** 30/60/90 días; WAU/MAU.
- **Calidad IA:** tasa de confirmación de propuestas, tasa de edición, tasa de descarte, falsos positivos reportados.
- **Valor:** compromisos en riesgo detectados, horas no registradas recuperadas, tiempo de organización.
- **Negocio:** conversión prueba→pago, MRR, CAC, margen bruto, churn.
- **Fiabilidad:** errores de sync, latencia, éxito de jobs.

## Umbrales de decisión (cerrar la beta y decidir)
Definidos de antemano; ajustar con el equipo antes de la Fase 6.
| Indicador | Avanzar | Iterar | Pivotar/Parar |
|---|---|---|---|
| Retención a 60 días (de usuarios activados) | ≥ 45 % | 25–45 % | < 25 % |
| Conversión prueba→pago | ≥ 25 % | 10–25 % | < 10 % |
| Propuestas confirmadas sin editar | ≥ 60 % | 40–60 % | < 40 % |
| Usuarios que mantienen Gmail conectado a 30 días | ≥ 80 % | 60–80 % | < 60 % |
| "Muy decepcionado si desapareciera" (encuesta Sean Ellis) | ≥ 40 % | 25–40 % | < 25 % |
| Margen bruto por usuario | ≥ 70 % | 55–70 % | < 55 % |

## Programa de validación (Fase 6)
- 15–25 **clientes de diseño** que pagan desde el inicio (con descuento).
- Entrevistas semanales + revisión de uso real.
- Pruebas de precio (dos anclas) con grupos distintos.
- Registro de motivos de cancelación y de herramientas sustituidas.
