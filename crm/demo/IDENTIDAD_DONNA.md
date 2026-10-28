# Donna · identidad visual

## Por qué es distinta de monday
monday se reconoce por el azul `#0073ea`, una paleta arcoíris de estados en **píldoras rellenas** que ocupan toda la celda, grupos con una **barra de color** a la izquierda y un título del mismo color, carriles de kanban con cabecera rellena, tipografía Figtree y radios de 4 px por todas partes. Donna da la vuelta a cada uno de esos rasgos:

| Rasgo | monday | Donna |
|---|---|---|
| Color principal | azul eléctrico `#0073ea` | verde petróleo `#0e7c7b` (tinta `#0a5f5e`), un solo acento ámbar `#e9a23b` («el punto») |
| Neutros | grises fríos azulados (`#f6f7fb`, `#323338`) | neutros cálidos, de papel: fondo `#f6f5f2`, barra lateral `#f1efea`, tinta `#1f1d1a` |
| Estados | píldora rellena de color saturado con texto blanco | **punto de color + etiqueta tenue** (`.dv-tint`): fondo al 14 % del color sobre la superficie y texto del mismo tono oscurecido hasta 4,5:1; el color elegido por el usuario se respeta como acento, no como relleno |
| Grupos | barra lateral de color y título coloreado | título en tinta con un punto del color del grupo; la columna `.gbar` queda blanca con un filete interior al 55 % |
| Kanban | cabecera rellena de color | carril neutro (`--surface2`), cabecera transparente con punto de color y línea inferior |
| Tipografía | Figtree (geométrica) | sistema sans para el cuerpo (`ui-sans-serif, system-ui, …`) y **serifa humanista** para títulos de página, diálogos, paneles y la palabra «Donna» (`Iowan Old Style, Palatino, Georgia`) |
| Formas | radio 4 px, sombras difusas | controles 6 px, tarjetas 14 px, diálogos 18 px; bordes de 1 px en lugar de sombras; sombra solo en capas flotantes |
| Tablas | líneas de rejilla iguales | cabecera en mayúscula pequeña, líneas verticales casi invisibles (`--line3`), bloque con borde redondeado |
| Barra lateral | blanca, iconos cuadrados de color | tono papel, puntos de color de 9 px, sección en mayúscula espaciada, activo = tarjeta blanca |
| Iconos | mezcla de trazos (2 / 2,4 / 2,5) y emoji | una sola familia de línea: trazo 1,75, extremos redondeados, 16 px en botones y 18 px en barras |
| Movimiento | — | 120–180 ms, anulado con `prefers-reduced-motion` |

## El logotipo
Símbolo: una **D** de trazo redondeado sobre un cuadrado de esquinas 9/32 en verde petróleo, con un **punto ámbar** en el hueco de la letra. El punto es el motivo que se repite en toda la interfaz (estados, grupos, carriles, fechas, barra lateral): Donna «señala» las cosas. Se lee a 16 px (favicon) y a 40 px (carga). Palabra: «Donna» en serifa, peso 600, espaciado −0,015 em.

`dvLogo(variant, size)` devuelve SVG en línea: `mark` (símbolo), `full` (símbolo + palabra), `mono` (un solo color, `currentColor`, para impresión), `dark` (tono para fondos oscuros), `boot` (40 px) y `favicon` (data: URI). En la barra superior, la pantalla de carga, la contraseña y el rescate el símbolo se aplica por CSS sobre `.logo .dots` y `.dx-boot-dots` (los tres puntos de antes quedan ocultos).

## Tokens (`:root`, oscuro en `[data-theme="dark"]`)
- Color: `--primary #0e7c7b / #167d79`, `--primary-h`, `--primary-s #e2f1ef / #163431`, `--ux-ink-primary #0a5f5e / #6fd6cf` (texto y enlaces), `--dv-accent #e9a23b`, `--dv-ok #1f9d6a`, `--dv-warn #e9a23b`, `--dv-err #d13a50`, `--dv-info`.
- Neutros: `--bg`, `--bg2` (barra lateral), `--surface`, `--surface2`, `--hover`, `--ink`, `--ink2`, `--ink3`, `--line`, `--line2`, `--line3`.
- Espaciado (escala de 4 px): `--dv-sp1 4 · sp2 8 · sp3 12 · sp4 16 · sp5 20 · sp6 24 · sp8 32`.
- Letra: `--dv-fs-xs 12 · sm 13 · md 14 · lg 16 · xl 22 · xxl 28`; títulos con serifa.
- Radios: `--dv-r1 6 · r2 10 · r3 14 · r4 18`. Sombras: `--dv-sh1` (reposo), `--shadow` (flotante).
- Controles: `--dv-ctl 34 px` (28 pequeño, 44 en móvil), `--dv-ico 16`, `--dv-ico-lg 18`.

## Componentes (todos por CSS sobre las clases existentes)
Botones (primario / secundario-contorno / fantasma / peligro; `sm`), entradas y selectores (36 px, foco con anillo), chips y etiquetas (`.tag`, `.xl-chip`, `.amu-chip`: 999 px), estados (`.pill` → `.dv-tint`), tarjetas (`.card .chart .kpi .auto .rule .recipe .kcard …`), tablas (`.tbl`, `table.t` con cabecera fija), menús (`.dd`), diálogos (`.modal`), paleta, toasts (tinta con filete de color), pestañas (`.views`, `.ptabs`, `.stabs`), interruptores (`.switch` en verde petróleo), insignias, vacíos (`.ux-empty`), paso a paso del contrato (`.steps`: hecho = tenue, actual = relleno), constructor Cuando/Si/Entonces (`.amu-*`: numeración en círculo, piezas con borde).

## Móvil
Navegación inferior de 5 objetivos de 44 px (Inicio, Mi día, Contratos, Buscar, Menú) a ≤ 720 px; los flotantes (tutorial, selección, deshacer, avisos) suben 60 px. Las tablas siguen siendo tarjetas con un filete fino del color del grupo.
