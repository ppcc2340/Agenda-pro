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
| 8. Workflows | Ajustes → Workflows: 18 disparadores, 13 acciones, condiciones, retrasos, reinscripción, historial, simulación, webhook entrante. 6 automatizaciones predefinidas |
| 9. Formularios | Constructor de formularios, captcha ligero (honeypot), consentimiento, redirección |
| 10. Tickets | Tickets con estados, prioridad, SLA por prioridad, respuesta por email / nota interna, CSAT |
| 11. Informes y dashboards | Inicio (dashboard por rol/equipo/usuario) e Informes: ventas, pipeline, embudo, actividad, leads, emails, soporte, calidad de datos |
| 13. API, webhooks, importación/exportación, notificaciones, búsqueda global | `docs/API.md`; Ajustes → API keys / Webhooks (HMAC + reintentos); importador CSV con mapeo, previsualización, deduplicación y reversión; campana de notificaciones; `Ctrl K` |
| 14. Usuarios, roles, equipos, 2FA, auditoría, protección de datos | Ajustes → Usuarios / Roles (permisos por objeto y acción, visibilidad míos/equipo/todos) / Equipos; TOTP; bloqueo tras 5 intentos; auditoría por campo; papelera 30 días; retención configurable |
| 15. Calidad de datos | Normalización automática, campos obligatorios por etapa, panel de calidad, duplicados |

### Checklist de aceptación del MVP (manual §18)

Cubierta por los tests de `server/tests/crm.test.ts` y la interfaz: alta de contacto + empresa en un paso, lead de formulario asignado y notificado al instante, cambio de etapa por arrastre registrado (quién y cuándo), imposible marcar perdido sin motivo, manager ve solo su equipo, dashboard con pipeline/ganado/conversión/actividad, importación sin duplicados por email, exportación y borrado/anonimización RGPD, API con API key, auditoría de cambios de importe, workflow «negocio sin actividad 7 días → tarea», funcionamiento en móvil (navegación inferior, kanban táctil).

Pendiente de operación (no de código): copia de seguridad diaria del archivo SQLite y prueba de restauración.

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
