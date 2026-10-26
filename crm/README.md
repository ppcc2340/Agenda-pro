# CRM interno

CRM completo para uso interno de la empresa, construido a partir del *Manual de funcionalidades para construir un CRM propio*. Cubre el MVP del manual al completo y varias funciones de la fase V2 (productos y presupuestos con aceptación online, tickets con SLA, lead scoring, listas dinámicas, formularios web, webhooks, API).

- **Backend:** Node.js 22 + Express 5 + SQLite (módulo `node:sqlite`, sin instalar nada más). Un solo archivo de base de datos.
- **Frontend:** React 19 + Vite, diseño propio responsive (escritorio y móvil), español.
- **Cero servicios externos obligatorios.** Email por SMTP opcional; sin SMTP los envíos se registran en modo *fake*.

## Arrancar en 2 minutos

```bash
cd crm
npm install
npm run dev          # API en :3000 y web en :5173 (abre http://localhost:5173)
```

La primera vez se crea el usuario **admin@crm.local / Admin1234!** y se cargan datos de demostración (empresas, contactos, negocios, tareas, tickets, presupuesto, workflows). Otros usuarios demo: `lucia@crm.local` (manager), `carlos@crm.local`, `marta@crm.local`, `javier@crm.local` (comerciales), `ana@crm.local` (soporte), contraseña `Demo1234!`.

Para arrancar **sin** datos de demo: `SEED_DEMO=0 npm run dev` (o en `.env`). Copia `.env.example` a `.env` para ajustar puerto, ruta de la base de datos, secreto, SMTP y URL pública.

### Producción

```bash
npm run build        # compila servidor y web en dist/
npm start            # sirve todo en http://localhost:3000
```

Recomendado: proxy TLS delante (Caddy / nginx), `SESSION_SECRET` propio, `PUBLIC_URL` con el dominio real (se usa en enlaces de emails, formularios y presupuestos) y copia diaria de `data/crm.db`.

### Verificación

```bash
npm run verify       # typecheck + 29 tests de integración + build
```

## Qué incluye (mapa con el manual)

| Módulo del manual | Dónde está |
|---|---|
| 1. Modelo de datos, campos personalizados (MVP) | `server/schema.sql`, Ajustes → Campos personalizados (14 tipos, obligatorios, secciones, dependencias) |
| 2. Perfil 360, vistas y listas, segmentación, deduplicación, RGPD | Ficha de contacto/empresa, tabla con filtros AND/OR + vistas guardadas + columnas + edición masiva + export, Listas, Contactos → Duplicados (fusión reversible 30 días), exportar/anonimizar |
| 3. Leads: captura multicanal, scoring, asignación, cualificación, conversión | Formularios web (`/f/<slug>`, `embed.js`, UTM), API, importación; Ajustes → Lead scoring; round-robin / menos carga / fijo; BANT; botón **Convertir** |
| 4. Pipelines múltiples, kanban, reglas de etapa, estancados, probabilidad, cierre | Negocios (kanban drag & drop con semáforo, tabla, previsión), Ajustes → Pipelines (campos obligatorios por etapa, días esperados), ganado/perdido con motivo obligatorio, reapertura |
| 5. Productos y presupuestos | Productos, líneas de producto en el negocio (importe calculado), presupuestos con numeración, versión, enlace público con seguimiento de vistas, aceptación con firma simple (nombre + IP + fecha), avance de etapa automático |
| 6. Tareas, notas, calendario | Tareas (tipos, prioridad, recurrencia, recordatorios), Mi día, notas fijadas, agenda de reuniones |
| 7. Email | Envío desde la ficha con plantillas y variables, seguimiento de aperturas y clics, firma por usuario, modo SMTP/fake. Sincronización de buzón Gmail/Microsoft = integración externa pendiente (ver más abajo) |
| 8. Workflows | Ajustes → Automatizaciones: frases «Cuando… y solo si… entonces…» con disparadores de cambio, fecha, periodo, botón y subelementos; condiciones Y/O anidadas; ramas, esperas y aprobaciones; recetas; historial, uso y gobierno (ver «Celdas y automatizaciones») |
| 9. Formularios | Constructor de formularios, captcha ligero (honeypot), consentimiento, redirección |
| 10. Tickets | Tickets con estados, prioridad, SLA por prioridad, respuesta por email / nota interna, CSAT |
| 11. Informes y dashboards | Inicio (dashboard por rol/equipo/usuario) e Informes: ventas, pipeline, embudo, actividad, leads, emails, soporte, calidad de datos |
| 13. API, webhooks, importación/exportación, notificaciones, búsqueda global | `docs/API.md`; Ajustes → API keys / Webhooks (HMAC + reintentos); importador CSV con mapeo, previsualización, deduplicación y reversión; campana de notificaciones; `Ctrl K` |
| 14. Usuarios, roles, equipos, 2FA, auditoría, protección de datos | Ajustes → Usuarios / Roles (permisos por objeto y acción, visibilidad míos/equipo/todos) / Equipos; TOTP; bloqueo tras 5 intentos; auditoría por campo; papelera 30 días; retención configurable |
| 15. Calidad de datos | Normalización automática, campos obligatorios por etapa, panel de calidad, duplicados |

### Checklist de aceptación del MVP (manual §18)

Cubierta por los tests de `server/tests/crm.test.ts` y la interfaz: alta de contacto + empresa en un paso, lead de formulario asignado y notificado al instante, cambio de etapa por arrastre registrado (quién y cuándo), imposible marcar perdido sin motivo, manager ve solo su equipo, dashboard con pipeline/ganado/conversión/actividad, importación sin duplicados por email, exportación y borrado/anonimización RGPD, API con API key, auditoría de cambios de importe, workflow «negocio sin actividad 7 días → tarea», funcionamiento en móvil (navegación inferior, kanban táctil).

Pendiente de operación (no de código): copia de seguridad diaria del archivo SQLite y prueba de restauración.

## Demo con tutorial

`crm/demo/crm-tutorial.html` es una demo usable en un solo archivo (sin servidor, datos en el navegador) con un tutorial guiado de 27 pasos que resalta cada función en pantalla: tableros, edición en celda, columnas y etiquetas nuevas, agrupaciones, kanban con etapas editables, reglas «cuando… entonces…», fichas 360, tickets, presupuestos, informes, formularios y roles. Ábrelo con doble clic.

La demo incluye también la pestaña **Contratos (CLM)** con el mismo principio: tablero por estado, solicitud guiada, plantillas y cláusulas, revisión contra playbook, aprobaciones, firma simulada con OTP y evidencias, obligaciones, hitos, pagos, enmiendas, renovaciones, terminación, informes y configuración; el tutorial tiene un capítulo «Contratos» con diez pasos.

## Tableros personalizables (estilo monday)

Cada tablero (Contactos, Empresas, Negocios, Tickets) se adapta sin tocar código, y la configuración se comparte con todo el equipo:

- **Columnas**: botón «+» en la cabecera para añadir columnas de tipo Estado, Texto, Número, Importe, Porcentaje, Fecha, Persona, Casilla, Enlace, Email, Teléfono o Etiquetas múltiples. Menú de cada columna (⌄) para ordenar, renombrar, mover, cambiar el ancho, ocultar o borrar.
- **Etiquetas de estado**: desde cualquier celda de estado, «Editar etiquetas» cambia texto y color; en las columnas creadas por ti también se añaden o quitan opciones.
- **Grupos**: «Agrupar por» etapa, estado, propietario o cualquier columna de tipo Estado. Clic en el nombre del grupo para renombrarlo, paleta para su color, menú para subir, bajar u ocultar.
- **Filas**: «+ Añadir elemento» al pie de cada grupo crea el registro con el valor del grupo; el menú de la fila permite abrir, duplicar, mover a otro grupo o borrar. Todas las celdas se editan al clic.
- **Etapas del pipeline**: en el kanban, menú de cada columna para renombrar, cambiar color, probabilidad, días esperados, reordenar o borrar, y «Añadir etapa» al final.
- **Automatizaciones**: botón en el tablero con reglas «Cuando … entonces …» (estado cambia, se crea un elemento, etapa cambia, sin actividad N días, SLA en riesgo → notificar, asignar, crear tarea, cambiar estado, mover de etapa, etiquetar, enviar email). Se guardan como workflows y se pueden ampliar con condiciones y varias acciones en el editor completo.

API: `GET/PUT /api/boards/:object` (columnas, etiquetas, agrupación), `POST/PUT/DELETE /api/admin/custom-fields`, `POST/PUT/DELETE /api/pipelines/:id/stages`, `POST /api/workflows`.

## Contratos (CLM)

Tablero **Contratos** en `/contratos`, con el mismo principio que el resto (columnas, etiquetas, agrupaciones y reglas editables) y las funciones del manual de CLM:

- **Solicitud (intake)** con asistente: tipo, contraparte, papel propio o externo, importes, plazo y renovación; numeración `PREFIJO-AAAA-00001`.
- **Plantillas y cláusulas**: motor de plantillas (`{{variable|filtro}}`, condicionales, bucles, `{% clause "CODE" %}`), biblioteca de 70 categorías con variantes estándar / alternativa / mínimo aceptable / prohibida.
- **Negociación**: versiones numeradas, comparación de versiones, extracción automática de cláusulas y revisión contra el **playbook** (umbrales, patrones prohibidos, cláusulas obligatorias) con puntuación de riesgo explicable.
- **Aprobaciones** por política (negocio, legal, director legal, finanzas, DPO, dirección) con separación de funciones, delegación y escalado por SLA.
- **Firma electrónica (SES)** con página pública `/s/:token`, código OTP, evidencias y hash SHA-256 de la versión firmada (inmutable).
- **Repositorio, obligaciones, hitos y pagos**: obligaciones recurrentes, alertas de vencimiento y preaviso, calendario de pagos por modelo.
- **Enmiendas, renovaciones y terminación**: contratos hijo (`-A01`, `-R01`), valores efectivos consolidados, cartas de terminación y obligaciones de salida.
- **Tarea diaria**: alertas, renovación tácita por inacción, vencimientos, incumplimientos y recordatorios de firma.
- **Informes**: activos, valor anual, vencimientos a 12 meses, tiempo de ciclo, desviaciones de playbook.

Configuración en `/contratos/configuracion` (tipos, cláusulas, plantillas, playbooks, poderes de firma). API: `/api/clm/*` (contratos, versiones, aprobaciones, sobres de firma, obligaciones, hitos, informes) y firma pública en `/s/:token`.

## Celdas y automatizaciones (modelo monday)

Sigue el manual de automatizaciones y valores:

- **Celda = valor + texto**: `GET/PUT /api/cells/:object/:id` devuelve cada columna como `{id, type, value, text}`. Las automatizaciones y las fórmulas trabajan siempre con el valor.
- **Estados por ID**: las etiquetas tienen un ID estable. Renombrarlas no reescribe datos y no se puede borrar una etiqueta en uso (409). Los **conjuntos de etiquetas compartidos** (Ajustes → Etiquetas) reparten las mismas etiquetas e IDs entre tableros.
- **Nuevos tipos de columna**:
  - estado, línea temporal, valoración y botón;
  - fórmula, con funciones lógicas, numéricas, de texto y de fechas (`WORKDAYS`, `ADD_WORKDAYS`) y referencias `{Columna}` / `{Columna#Start}`;
  - reflejo (*mirror*) sobre relaciones, con agregación (suma, media, mediana, mín/máx, contar, lista, fechas, TODOS/ALGUNO/NINGUNO = valor, % = valor);
  - autonumeración, registro de creación y última actualización.

  Fórmulas y reflejos **sí disparan y condicionan** automatizaciones. Antes de borrar una columna se avisa de lo que depende de ella.
- **Reglas del tablero** (Ajustes → Reglas de tablero): valores por defecto al crear y columnas obligatorias según el estado. Bloquean a las personas, no a las automatizaciones.
- **Motor de automatizaciones**:
  - Disparadores: de X a Y, cualquier columna, persona asignada, sin cambios en N días, botón, nota y subelementos, fecha ± días a una hora (planificador exacto con zona horaria y días laborables), fecha pasada y periódicos.
  - Condiciones Y/O anidadas, incluidos origen, autor y empresa.
  - Acciones: ramas si/si no, esperas, aprobaciones con decisión humana y más de 25 tipos de acción.
- **Identidad y gobierno**:
  - Cada regla se ejecuta como su propietario o como el usuario de servicio «Automatizaciones». Si el propietario se desactiva, la regla se pausa; se puede reasignar.
  - Prioridad y ejecución atómica.
  - Protección de bucles: profundidad máxima configurable y 5 ejecuciones/min por elemento.
  - Contabilidad de acciones con presupuesto mensual, avisos al 60/80/100 % y bloqueo o pausa al agotarse.
  - Historial con exportación CSV y simulación.
- **Recetas** R1–R22 del manual, instalables con un clic: crean las columnas auxiliares y la automatización.

La demo HTML incluye todo lo anterior (columnas de ejemplo, inspector de celdas, editor con ramas, recetas, reloj virtual para probar disparadores de fecha, aprobaciones, uso y gobierno) y un capítulo «Celdas y automatizaciones» de diez pasos en el tutorial.

## Libertad tipo Excel en los tableros

Todas las tablas (contactos, empresas, negocios, tickets, contratos) funcionan como una hoja de cálculo sin perder el aspecto de monday.

- **Etiquetas y estados editables desde la celda**: en el desplegable de cualquier columna de estado, «Editar etiquetas» permite renombrar, cambiar el color, arrastrar para ordenar, añadir y quitar etiquetas allí mismo.
  - **Etiquetas del sistema** (etapa del contacto, estado del lead, tipo de empresa, estado y prioridad del ticket, urgencia…): se pueden renombrar, recolorear, ordenar u ocultar, pero no borrar. Las etiquetas nuevas «se comportan como» una etiqueta base. Por ejemplo, «Cliente VIP ≈ Cliente» o «Esperando proveedor ≈ Pendiente». El registro guarda el estado base, así que informes, SLA y automatizaciones siguen funcionando, y la etiqueta nueva se guarda aparte (`custom._lbl_<campo>`).
  - **Etapas de negocio**: se editan las etapas del pipeline directamente (también se ven en el kanban).
  - **Columnas propias**: las etiquetas tienen ID estable y marca de «hecho».
- **Todas las celdas se editan**:
  - el nombre (F2, doble clic o el lápiz);
  - etiquetas múltiples con sugerencias;
  - empresa relacionada con buscador;
  - texto largo, rango de fechas, fechas y horas, personas, números, casillas.

  Las columnas calculadas muestran un candado y el motivo.
- **Teclado y selección**:
  - flechas, Tab, Enter y F2; escribir sustituye el contenido; Espacio marca casillas o abre etiquetas;
  - rangos con Mayús + clic, Mayús + flechas o arrastrando;
  - barra de estado con recuento, suma, promedio, mínimo y máximo.
- **Copiar, pegar y rellenar**:
  - Ctrl+C, Ctrl+X y Ctrl+V con Excel o Google Sheets (texto tabulado). Se reconocen «1.234,56 €», «31/12/2026», «sí/x», personas por nombre o iniciales y etiquetas por su texto.
  - Si una etiqueta no existe en una columna propia, ofrece crearla. Si se pegan más filas de las que hay, ofrece crear elementos.
  - Pegar una lista en «+ Añadir elemento» crea un elemento por línea.
  - Supr vacía el rango, Ctrl+D rellena hacia abajo, y el cuadradito de la esquina arrastra el relleno y continúa series de números y fechas.
- **Deshacer y rehacer** (Ctrl+Z, Ctrl+Y y botones) de cualquier edición, incluido un pegado o relleno completo como un solo paso. Al guardar, las filas no cambian de sitio.
- **Columnas**:
  - ancho arrastrando el borde de la cabecera y orden arrastrando la cabecera;
  - «Inmovilizar hasta aquí» fija columnas a la izquierda;
  - **Formato…** por columna: decimales, separador de miles, prefijo y sufijo, negativos en rojo, alineación y ajuste de texto;
  - **Cambiar tipo…** convierte los valores (texto ↔ número ↔ estado ↔ fecha ↔ casilla ↔ etiquetas…) con una vista previa de cuántos se convierten y cuántos se pierden. En fórmulas y reflejos, «Convertir en valores» los congela.
- **Pie de cada grupo**: clic para elegir suma, media, mediana, mínimo, máximo, recuento, vacíos, % lleno, valores únicos, distribución o recuento por etiqueta, casillas marcadas o rango de fechas.
- **Formato condicional** (botón «Formato»):
  - Operadores: =, ≠, >, <, ≥, ≤, entre, contiene, vacío, fecha vencida, próximos N días, casilla marcada.
  - Cada regla colorea la celda o la fila entera; las reglas se ordenan y se activan o desactivan.

Todo se guarda por tablero en `board_configs` y es compartido por el equipo. API:

- `POST /api/cells/:objeto/batch` con `{ changes: [{ id, column_id, value }] }` aplica la edición en bloque, valida con el mismo esquema que la ficha y devuelve los errores por celda.
- `POST /api/columns/convert-preview` da la vista previa de un cambio de tipo; `PUT /api/admin/custom-fields/:id` con `type` ejecuta la conversión.

La demo HTML incluye lo mismo y un capítulo del tutorial «Libertad tipo Excel» con diez pasos.

## Integraciones externas (puntos de extensión)

El manual contempla sincronización de Gmail/Microsoft 365, telefonía, WhatsApp, etc. El CRM está preparado para ello sin cambiar el modelo:

- **Email entrante / sincronización de buzón:** crear actividades `type=email` con `direction=inbound` vía `POST /api/v1/activities` (o un adaptador en `server/services/`). El seguimiento de aperturas/clics ya funciona para el correo saliente.
- **Calendario:** las reuniones son actividades `type=meeting` con `occurred_at`; un conector puede crearlas por API.
- **Telefonía / WhatsApp / chat:** idem con `type=call|whatsapp|chat`.
- **Zapier / Make / n8n:** webhooks salientes + API REST + webhook entrante por workflow (`POST /hooks/<id>`).

## Estructura

```
crm/
  server/           API Express + lógica de negocio (TypeScript)
    schema.sql      Esquema SQLite
    services/       contactos, empresas, negocios, tareas, tickets, presupuestos, workflows, scheduler…
    routes/         endpoints REST
    tests/          tests de integración (vitest + supertest)
    seed.ts         bootstrap + datos de demostración
  web/              SPA React (Vite)
    src/pages       Inicio, Mi día, Contactos, Empresas, Negocios, Tareas, Tickets, Listas, Productos, Presupuestos, Informes, Ajustes
    src/components  tabla con filtros/vistas, kanban, línea temporal, formularios, gráficos
  docs/API.md       Referencia de la API
```
