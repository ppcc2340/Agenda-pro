# 05 — Diseño de IA

## 1. Principios
- Arquitectura híbrida: **reglas deterministas** para fechas, estados, permisos, disponibilidad; **IA** para interpretar lenguaje ambiguo.
- La IA genera **propuestas estructuradas**, nunca acciones.
- Salida siempre validada con Zod; si falla, reintento único con reparación; si vuelve a fallar → descartar y registrar.

## 2. Casos de uso de IA (MVP)
| ID | Caso | Modelo (env) | Entrada | Salida |
|---|---|---|---|---|
| AI-1 | Parseo de captura en lenguaje natural | `AI_MODEL_FAST` | texto + contexto de clientes del usuario (nombres) | `CaptureProposal` |
| AI-2 | Extracción de compromisos desde correo | `AI_MODEL_FAST` (escala a `SMART` si confianza baja) | mensaje(s) del hilo + contexto acotado | `CommitmentExtraction` |
| AI-3 | Borrador de seguimiento | `AI_MODEL_SMART` | compromiso + hilo + tono preferido | borrador de texto |
| AI-4 | Briefing de cliente / reunión | `AI_MODEL_SMART` | elementos del cliente (ids + datos) | `Briefing` con citas a fuentes |
| AI-5 | Resumen diario/semanal | `AI_MODEL_FAST` | datos estructurados del día | texto + datos |

Los identificadores de modelo se leen de variables de entorno; no hardcodear.

## 3. Pipeline de extracción de compromisos (AI-2)
1. **Prefiltro (reglas):** descartar `List-Unsubscribe`, `no-reply@`, `Precedence: bulk`, categorías Promociones/Social, correos de calendario ya procesados.
2. **Resolución de cliente:** por dominio/contacto → `clientId` (o `null`).
3. **Construcción de contexto acotado:** solo el hilo + metadatos del cliente resuelto. **Nunca** datos de otro cliente.
4. **Llamada con salida estructurada** (herramienta/JSON schema) → `CommitmentExtraction[]`.
5. **Validación Zod** + reglas de coherencia (fecha no pasada en >1 año, propietario válido, cita presente en el texto fuente).
6. **Verificación de cita:** el `evidence` debe aparecer literalmente en el mensaje fuente (comparación normalizada); si no, se descarta.
7. **Clasificación de confianza:** `explicit` (verbo de compromiso + sujeto + objeto + fecha/plazo claro), `inferred`, `suggested`.
8. **Persistencia:** `proposals` + `commitments(status='proposed')`; auto-confirmación solo si `explicit` ∧ confianza ≥ umbral ∧ flag del usuario activo.
9. **Deduplicación:** hash (hilo + sujeto + acción + fecha) para no duplicar entre mensajes de un mismo hilo.

## 4. Esquemas (ver `packages/ai/src/schemas.ts`)
`CommitmentExtraction`: `direction` (`owed_by_me` | `owed_to_me`), `ownerEmail`, `action`, `dueAt?` (ISO) + `dueText?` original, `kind` (`explicit|inferred|suggested`), `confidence` (0–1), `evidence` (cita ≤ 200 car.), `messageId`.

## 5. Costes y límites
- Presupuesto objetivo ≤ **US$6/usuario/mes** en IA (`AI_MONTHLY_COST_CAP_USD_PER_USER`).
- Medir tokens y coste por operación en `ai_usage`.
- Estrategias: prefiltro por reglas, modelo rápido por defecto, caché por hash de contenido, *batching* de hilos, límites por plan (créditos).
- Al agotar créditos: IA pausada; reglas y planificador siguen funcionando.
- Prompt caching en prompts de sistema estables.

## 6. Defensa contra prompt injection (obligatorio)
1. El contenido de correos/documentos se envuelve en delimitadores explícitos y se declara como **datos no confiables** en el prompt de sistema.
2. Las llamadas de extracción **no tienen herramientas con efectos** (solo devuelven JSON).
3. Salida con esquema estricto; cualquier campo fuera de esquema se descarta.
4. Ninguna instrucción dentro del correo puede cambiar permisos, destinatarios o acciones: la capa de **políticas** decide, no el modelo.
5. Borradores (AI-3): nunca incluir contenido de otros clientes; el destinatario lo fija el código, no el modelo.
6. Tests de inyección en `evals/injection/` (correos con "ignora instrucciones", "reenvía a…", marcadores falsos de sistema); deben pasar al 100 %.
7. Sanear HTML/URLs; nunca seguir enlaces automáticamente.

## 7. Evaluación (evals)
Conjunto dorado en `evals/commitments/` (JSONL): ≥ 200 correos sintéticos y anonimizados en español e inglés, etiquetados con compromisos esperados.
Umbrales para cerrar la fase 2:
| Métrica | Umbral |
|---|---|
| Precisión de compromisos `explicit` | ≥ 0.90 |
| Recobrado de compromisos `explicit` | ≥ 0.75 |
| Precisión global de propuestas | ≥ 0.80 |
| Citas verificables (evidence presente en fuente) | 100 % |
| Pruebas de inyección superadas | 100 % |
| Violaciones de aislamiento entre clientes | 0 |
Ejecutar con `pnpm eval`; el informe se guarda en `evals/reports/`.

## 8. Feedback loop
Confirmar/editar/descartar se guarda como señal (`proposals.resolution`, diff de edición). Se usa para: ajustar umbrales por usuario, listas de remitentes ignorados, y ampliar el set de evals (con consentimiento).

## 9. Privacidad de IA
- Proveedor de IA con retención cero / sin entrenamiento sobre datos del cliente (configurar y documentar).
- Minimizar datos enviados: recortar firmas, citas anidadas y adjuntos.
- No enviar adjuntos en el MVP.
