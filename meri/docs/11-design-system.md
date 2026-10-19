# 11 — Sistema de diseño (extraído de la demo)

La referencia viva son `demo/desktop.html` y `demo/mobile.html`. Este documento resume las decisiones para reproducirlas en `apps/web` con Tailwind y shadcn/ui.

## Idea central
**Cada cliente tiene su color y ese color recorre toda la interfaz.** Es la forma visible de la segregación por cliente: un bloque, una tarea o un compromiso se reconoce por su color antes de leerlo. Lo demás es silencioso.

**Sólido es confirmado. Punteado es sugerido.** Todo lo que propone Meri (IA) usa borde punteado y fondo ámbar suave hasta que el usuario lo confirma. Esta regla no se rompe en ninguna pantalla.

## Color (claro / oscuro)
| Token | Claro | Oscuro | Uso |
|---|---|---|---|
| `--bg` | `#E9EEF1` | `#08121A` | Fondo de la app |
| `--panel` | `#F5F8F9` | `#0F1C27` | Superficies suaves |
| `--raised` | `#FFFFFF` | `#142431` | Tarjetas, inputs |
| `--ink` | `#0F1E2E` | `#E7EFF3` | Texto principal |
| `--ink2` / `--ink3` | `#44566A` / `#74869A` | `#A7B9C6` / `#7C91A1` | Texto secundario y terciario |
| `--rule` | `#D2DBE1` | `#233545` | Líneas |
| `--sea` | `#0E6B74` | `#5CC9CF` | Acción principal, «ahora» |
| `--risk` | `#BF3A4A` | `#F0707F` | Riesgo y vencido |
| `--sug` | `#9A6A0C` | `#E3B04B` | Sugerido por IA |
| `--ok` | `#2A7B58` | `#5CC79B` | Aprobado, cumplido |
| Clientes | azul `#3A6EDB`, verde `#2F8A5C`, ámbar `#B07414`, magenta `#B0407E` | versiones más claras | Color por cliente. A partir del quinto cliente, generar tonos con el mismo croma |

La barra lateral de escritorio es siempre oscura (`#0F1E2E`).

## Tipografía
- Títulos: **Bricolage Grotesque** 600/700, interlineado ajustado.
- Cuerpo: **Instrument Sans** 400/500/600.
- Cifras con `font-variant-numeric: tabular-nums`.
- Pilas de respaldo del sistema siempre definidas.

## Estructura
- Cinco áreas: **Hoy, Entrada, Proyectos y compromisos, Calendario, Centro de control**. En móvil: Hoy, Entrada, Agenda, Compromisos, Más.
- «Hoy» se organiza con las cuatro preguntas como títulos: *¿Qué hago ahora? ¿Qué es lo más importante hoy? ¿Qué podría salir mal? ¿Qué estoy esperando de otras personas?*
- Elemento memorable: la **línea del día** (calendario fijo arriba, plan de Meri abajo, línea de «ahora», margen para imprevistos rayado).
- Listas separadas por líneas finas, no por tarjetas idénticas. Una sola tarjeta destacada: «Ahora».

## Texto de interfaz
- Español neutro, frases en minúscula inicial salvo la primera palabra, verbos claros.
- Un botón dice exactamente qué hace y el aviso posterior usa el mismo verbo («Confirmar» produce «Confirmado»).
- Los errores y avisos explican qué pasó y cómo seguir. Sin disculpas vagas.
- Los estados vacíos invitan a actuar («Todo al día. Cuando llegue un correo con un compromiso, aparecerá aquí»).
- Nunca prometer lo que Meri no hace: «Meri solo crea borradores. Tú decides cuándo enviarlo».

## Interacciones que deben conservarse
- Captura global con `Ctrl/⌘ K` y vista previa de lo que Meri entendió (cliente, fecha, duración como chips punteados).
- Reorganizar siempre muestra el **diff** (qué se mueve y por qué) y se puede deshacer.
- Toda acción automatizada queda en «Actividad» con botón Deshacer.
- El tiempo inferido nunca se aprueba solo.
- Cada punto de un briefing enlaza a su fuente y usa solo datos de un cliente.

## Calidad mínima
Teclado completo, foco visible, `prefers-reduced-motion`, contraste AA en ambos temas, responsive hasta 360 px.

## Pendientes de diseño para Claude Code
Estados de carga y error, onboarding, pantalla de planes y precios, vista de cliente con línea de tiempo, accesibilidad auditada con axe.
