# 04 — Motor de planificación (determinista)

Vive en `packages/core/src/planner`. **Funciones puras, sin I/O, sin IA.** La IA puede *proponer* duración/prioridad al capturar, pero el plan lo calcula este motor.

## Contrato
Ver `packages/core/src/planner/types.ts`:
`plan(input: PlanInput): PlanResult`

## Entradas
- Tareas pendientes (prioridad, fecha límite blanda/dura, duración estimada, dependencias, cliente, tipo: `deep` | `shallow`).
- Eventos fijos (calendario externo) y bloques Meri existentes.
- Ventana de planificación (hoy, semana).
- Preferencias (horario laboral, bloques de concentración, duración mínima/máxima de bloque, buffer entre bloques, margen de imprevistos, zona horaria).
- Reloj inyectado (`now`) para determinismo.

## Salidas
- `blocks`: bloques programados con `taskId`, `start`, `end`, `reason` (explicación estructurada).
- `unscheduled`: tareas que no caben + motivo.
- `conflicts`: sobrecargas, fechas imposibles, dependencias circulares.
- `risks`: tareas en riesgo con holgura calculada.
- `diff` (cuando se compara con el plan vigente): `moved`, `added`, `removed`.

## Algoritmo (v1)
1. **Normalizar**: validar con Zod, detectar ciclos en dependencias (error `CIRCULAR_DEPENDENCY`).
2. **Capacidad**: por día, minutos laborables − eventos fijos − buffers; aplicar `contingency` (p. ej. 20 % se reserva y **no** se asigna).
3. **Orden topológico** de tareas respetando `blocked_by`.
4. **Puntuación** (mayor = antes):
   ```
   score = w_p * priorityWeight
         + w_d * deadlineUrgency
         + w_c * costOfDelay
         + w_b * unblocksOthers
         - w_s * slackBonus
   ```
   - `deadlineUrgency = 1 / max(slackHours, 0.25)` acotado; fecha dura multiplica por 2.
   - `slack = horas laborables disponibles hasta la fecha límite − trabajo pendiente acumulado de mayor puntuación`.
   - Pesos por defecto en `core/planner/weights.ts`; documentados y testeados.
5. **Colocación (greedy con retroceso limitado)**:
   - Tareas `deep` → bloques de concentración preferidos; ≥ `minDeepBlock` minutos.
   - Tareas `shallow` → huecos cortos; se agrupan en bloques de "administración".
   - Dividir tareas largas en bloques ≥ `minBlock`; añadir `transition buffer`.
   - Nunca colocar antes de que terminen sus dependencias (+ buffer).
6. **Verificación de factibilidad**: si una tarea con fecha límite no cabe → `conflicts` con alternativas (mover otra, dividir, ampliar fecha, delegar). **No** desplazar tareas de mayor puntuación silenciosamente.
7. **Estabilidad**: al replanificar, penalizar mover bloques ya aceptados (coste de movimiento) para evitar "temblor" del calendario. Bloques anclados por el usuario (`pinned`) son inamovibles.
8. **Explicaciones**: cada bloque lleva `reason` estructurado, ej. `{ code: 'DEADLINE_SLACK_LOW', params: { due: '...', slackHours: 3 } }`, que la UI traduce (i18n).

## Cálculo de riesgo (`at_risk`)
`slackHours < riskThreshold` (por defecto 4 h laborables) **o** dependencia bloqueada con fecha cercana **o** sin capacidad asignable antes de la fecha límite.

## Propiedades que deben cumplirse (tests con fast-check)
1. Sin solapamientos entre bloques ni con eventos fijos.
2. Ningún bloque fuera del horario laboral.
3. Capacidad diaria con contingencia nunca excedida.
4. Dependencias respetadas.
5. Determinismo: misma entrada → mismo resultado.
6. Idempotencia: `plan(plan(x).blocks as pinned)` no cambia nada.
7. Estabilidad: un cambio pequeño de entrada mueve un número acotado de bloques.
8. Suma de minutos asignados por tarea ≤ duración estimada.

## Evolución (post-MVP)
Modelo de estimación personalizado (real vs estimado por tipo de tarea), aprendizaje de horas productivas, optimización por restricciones (CP-SAT) si el greedy resulta insuficiente.
