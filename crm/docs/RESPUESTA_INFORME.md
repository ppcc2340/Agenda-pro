# Respuesta al informe técnico y funcional (26/10/2026)

Este documento recorre el informe punto por punto y dice, para cada uno, en qué estado queda el producto.

**Decisión de partida:** se mantiene SQLite como base de datos y se cierran las brechas sobre la arquitectura que ya existe. Lo acordó el responsable antes de empezar.

El informe evaluaba la demo HTML (`demo/crm-tutorial.html`). La Parte A pedía convertirla en un producto con servidor, y ese producto ya existía: el CRM de `crm/`, con API, base de datos, motor de automatizaciones y planificador en el servidor. Por eso:

- **Parte A:** se aplica al CRM real.
- **Parte B (funciones):** se aplica al CRM real y, donde tiene sentido simularlo, también a la demo.

Leyenda:

| Estado | Significado |
| --- | --- |
| ✅ ya existía | Estaba hecho antes de este informe |
| 🆕 hecho | Implementado ahora |
| 🟡 parcial | Implementado en parte; se indica qué falta |
| ⏳ pendiente | No implementado; se indica qué hace falta (normalmente credenciales o infraestructura externa) |

## Parte A · Técnica

### A1. Principios y decisiones

| Decisión del informe | Estado | Cómo queda |
| --- | --- | --- |
| TypeScript en todo el stack | ✅ ya existía | Servidor Express 5 + web React 19, ambos en TypeScript estricto |
| Estado S → modelo de datos en base de datos | ✅ ya existía | 60+ tablas SQL; el cliente pide datos por tablero a la API |
| Render por componentes | ✅ ya existía | React; la tabla actualiza solo la celda editada y no mueve las filas al guardar |
| Motor de automatizaciones en servidor | ✅ ya existía | Se ejecuta en el servidor con eventos, planificador `automation_schedule`, aprobaciones, presupuesto y protección de bucles |
| CLM con archivos y SHA-256 | ✅ ya existía | Versiones con `sha256`; aprobaciones ligadas al hash; versión firmada bloqueada |
| Eliminar simulaciones | 🟡 parcial | Email por SMTP real (o modo de prueba), seguimiento de aperturas y clics propio, firma con OTP por email y evidencias. Pendiente: proveedor eIDAS y buzón conectado (ver A8) |
| Identificadores en servidor | ✅ ya existía | UUID generados en el servidor (`crypto.randomUUID`) |
| Catálogo de idiomas | 🟡 parcial | `es.json` y `en.json` para la interfaz común; las páginas interiores siguen en español |
| **PostgreSQL** | ⏳ pendiente (decisión) | Se mantiene SQLite. Ver la nota de migración al final |

### A2. Arquitectura

La arquitectura actual es más sencilla que la del informe:

- **Navegador / PWA:** se conecta a la API con una cookie de sesión `HttpOnly` o con una API key.
- **API Express:** escribe en SQLite y emite eventos de dominio por un único punto, `emit`.
- **Consumidores de esos eventos:** automatizaciones, webhooks salientes, auditoría y, nuevo, los cambios en vivo por SSE.
- **Planificador interno:** sustituye a la cola Redis y a los workers.
- **Imagen Docker:** 🆕 hecha.
- **CI:** 🆕 hecha.

Para pasar a varias instancias del servidor harían falta PostgreSQL y una cola externa. Está descrito en la nota final.

### A3. Modelo de datos

- ✅ **Ya existía:**
  - Tablas para todas las colecciones de la demo, con `workspace_id` (el tenant) en cada una.
  - Opciones de estado con id estable.
  - Borrado lógico con `deleted_at`.
  - Historial de etapas.
  - Secuencias de numeración.
- 🆕 **Hecho ahora:**
  - `contacts.emails` y `contacts.phones`: varios por contacto.
  - Columnas de recurrencia y duración en `tasks`.
  - Columnas de la encuesta de satisfacción (CSAT) en `tickets`.
  - Encadenado del registro de auditoría: `audit_log.seq`, `prev_hash` y `chain_hash`.
  - Códigos de recuperación de la verificación en dos pasos.
  - Tablas de analítica: `saved_reports`, `dashboards`, `report_schedules`, `metric_alerts` y `user_quotas`.
- ⏳ **Pendiente:**
  - `import-legacy-state.ts`, para importar el estado de `localStorage` de la demo.
  - Motivo: la demo es un escaparate con datos de ejemplo, no hay datos reales que migrar. Si alguien la hubiera usado en serio, se puede escribir con el mismo esquema zod.

### A4. Backend y API

| Punto | Estado | Detalle |
| --- | --- | --- |
| Multi-tenant | ✅ ya existía | Todas las consultas filtran por `workspace_id` desde el contexto de la sesión. Las pruebas comprueban la visibilidad por rol. RLS es propio de PostgreSQL (ver la nota) |
| Contraseñas | ✅ / 🆕 | Hash `scrypt` (Argon2id no está en Node 22 sin módulos nativos; scrypt también es *memory-hard*). 🆕 Mínimo 12 caracteres, letras y números, sin contraseñas comunes ni el propio email |
| Bloqueo por intentos | ✅ ya existía | 5 fallos bloquean la cuenta 15 minutos, más un límite de peticiones por IP |
| TOTP | ✅ / 🆕 | Ya existía. 🆕 10 códigos de recuperación de un solo uso. 🆕 2FA obligatoria por rol (Ajustes → Roles); en producción, por defecto para admin y legal. 🆕 Pantalla guiada si falta activarla |
| Sesiones | ✅ ya existía | Cookie `HttpOnly`, `SameSite=Lax` y `Secure` en producción; se guardan en base de datos y se revocan individualmente (Ajustes → Mi perfil). Cumple lo que pide el informe con JWT + refresh rotatorio, con revocación inmediata |
| OAuth/OIDC Google y Microsoft, SAML | ⏳ pendiente | Necesita registrar la aplicación en Google Cloud y Entra ID (client id y secreto) |
| Autorización en servidor | ✅ ya existía | Roles con permisos por objeto y acción, visibilidad propia/equipo/todo, usuario de servicio para las automatizaciones |
| Permisos por campo y compartir registros | ⏳ pendiente | Está diseñado: `field_permissions` y `record_shares`. Es lo siguiente en la lista de administración |
| API versionada `/api/v1` | ✅ / 🆕 | Ya existía. 🆕 **OpenAPI 3.1** generada de las rutas y de los mismos esquemas que validan (`/api/v1/openapi.json`) y lector en `/api/docs` |
| PATCH con If-Match / ETag | 🆕 hecho | El GET devuelve `ETag`. PUT/PATCH/DELETE con `If-Match` desfasado responde **412** y no pisa el cambio de otra persona |
| Celdas | ✅ ya existía | API de celdas y edición en bloque validada con el esquema de cada objeto |
| Paginación por cursor | 🆕 hecho | `?limit=&cursor=` → `next_cursor`; el cursor deja de valer si cambian los filtros o el orden. `page` se mantiene por compatibilidad |
| Búsqueda | ✅ ya existía | Búsqueda global (Ctrl+K); ahora incluye todos los emails y teléfonos |
| Importación | ✅ ya existía | Contactos, empresas y negocios, con mapeo y duplicados |
| Webhooks | ✅ ya existía | Firma `x-crm-signature: sha256=HMAC`, identificador de entrega y reintentos escalonados, tras los cuales se marca como fallida |
| Auditoría | ✅ / 🆕 | Ya existía con filtros. 🆕 Solo inserción (triggers impiden UPDATE y DELETE), cadena de hashes y botón «Verificar integridad» |

### A5. Frontend

| Punto | Estado |
| --- | --- |
| Componentes con actualización por celda | ✅ ya existía |
| Edición optimista sin perder el foco | ✅ ya existía (tabla tipo Excel) |
| Sondeos sustituidos por eventos | 🆕 hecho. `GET /api/events` (Server-Sent Events): cada cambio avisa a las demás sesiones del espacio de trabajo y la tabla se recarga en silencio sin mover filas ni cortar una edición. El canal no expone datos: solo tipo, objeto e id |
| Debounce en búsqueda | ✅ ya existía (250 ms) |
| Virtualización de filas | 🟡 parcial. Se carga por páginas de 100 (o cursor de hasta 500). La virtualización completa queda para tableros de más de 10.000 filas visibles |
| Responsive, accesibilidad, modo oscuro e i18n | 🆕 hecho; ver la sección «Interfaz» al final |
| Fuente autoalojada | 🆕 hecho. Figtree se sirve desde el propio servidor (`@fontsource-variable/figtree`), funciona sin red y cumple la CSP |
| CSP y enlaces seguros | 🆕 hecho. Detalle en A9 |

### A6. Motor de automatizaciones

Ya cumplía casi todo antes de este informe:

- se ejecuta en el servidor;
- tiene planificador con zona horaria y días laborables;
- esperas y aprobaciones se reanudan desde el planificador;
- presupuesto mensual configurable;
- corta las cadenas a profundidad 10 y limita a 5 ejecuciones por minuto y registro;
- idempotencia por evento.

🆕 Ahora las automatizaciones también avisan a los tableros abiertos (SSE).

La simulación sobre un registro ya existía.

### A7. CLM

| Punto | Estado |
| --- | --- |
| Archivos y SHA-256 | ✅ ya existía (hash de cada versión) |
| Aprobaciones ligadas al hash | ✅ ya existía (se invalidan si cambia la versión) |
| Firmado inmutable | ✅ ya existía (versión bloqueada; los campos se restringen tras enviar a firma) |
| Planificador de hitos con alertas | ✅ ya existía (en servidor) |
| Retención y bloqueo legal | ✅ ya existía (`retention_until`, `legal_hold`) |
| DOCX y PDF del contrato | ⏳ pendiente. El generador PDF nuevo sirve de base; DOCX necesita una plantilla con docxtemplater o Gotenberg |
| Firma eIDAS con proveedor | ⏳ pendiente. Necesita contrato y credenciales de Signaturit, DocuSign, Yousign o Validated ID. Hoy: firma simple con OTP por email y evidencias |
| Extracción con modelo de lenguaje | ⏳ pendiente. Necesita elegir un proveedor de IA con residencia en la UE |

### A8. Integraciones

| Integración | Estado | Qué falta |
| --- | --- | --- |
| Email saliente | ✅ ya existía | SMTP real (`EMAIL_MODE=smtp`) con seguimiento propio de aperturas y clics |
| Buzón Gmail / Microsoft 365 (OAuth, sincronización) | ⏳ pendiente | Proyecto en Google Cloud y Entra ID con los scopes `gmail.*` y `Mail.*`, y un dominio público para los webhooks |
| Calendario y página de reservas | ⏳ pendiente | Mismas credenciales OAuth |
| Formulario web público | ✅ ya existía | `embed.js`, consentimiento, UTM, captcha *honeypot* y asignación rotativa |
| Portal del presupuesto | ✅ / 🆕 | Ya existía. 🆕 Ver la sección «Presupuestos» de la Parte B |
| Webhooks salientes y API pública | ✅ / 🆕 | Ya existía. 🆕 OpenAPI |
| Zapier / Make / n8n | ⏳ pendiente | Se pueden conectar ya con webhooks + API key; el conector oficial requiere publicarlo en cada plataforma |
| Telefonía, WhatsApp, contabilidad | ⏳ pendiente | El informe las coloca en «evitar por ahora» |

### A9. Seguridad: lista del informe

- [x] Contraseñas con hash *memory-hard* (scrypt) y mínimo de 12 caracteres 🆕. La comprobación contra HIBP queda ⏳ (requiere salida a internet).
- [x] TOTP obligatorio por rol 🆕 y códigos de recuperación 🆕.
- [x] Sesión con cookie `HttpOnly`, `Secure` y `SameSite=Lax`, revocable.
- [~] Aislamiento por tenant en todas las consultas. RLS de PostgreSQL ⏳.
- [x] Autorización en servidor (roles, visibilidad, permisos por objeto). Permisos por campo ⏳.
- [x] HSTS 🆕. TLS lo pone el proxy delante (Caddy o Nginx).
- [x] CSP `default-src 'self'` en la aplicación 🆕.
- [x] `X-Frame-Options: DENY` salvo los formularios incrustables 🆕.
- [x] Página pública del presupuesto escapada 🆕. Antes insertaba nombres y notas sin escapar.
- [x] Límite de peticiones por IP y bloqueo tras fallos.
- [x] Auditoría solo-inserción con cadena de hashes 🆕.
- [x] Copias: el volumen `/data` del contenedor. Copia diaria recomendada con `sqlite3 crm.db ".backup"`.
- [x] RGPD: exportación de una persona, solicitudes, anonimización, retención y consentimiento con fecha y origen.
- [x] Escaneo de dependencias en CI 🆕. Al activarlo encontró vulnerabilidades altas en zod 3 y nodemailer 7; se actualizaron a zod 4.6.7 y nodemailer 10.2.1 y `npm audit` queda en 0.
- [x] Secretos fuera del código (`.env` y variables del contenedor). En producción ya no hay contraseña inicial por defecto: se pasa `ADMIN_PASSWORD` o se genera una aleatoria 🆕.
- [x] Páginas públicas con tokens aleatorios de 24 bytes y sin enumeración.
- [ ] Prueba de intrusión ⏳ (antes de abrir el CRM a externos).

### A10. Calidad

- **Pruebas:** 81 con vitest + supertest.
  - Cubren permisos y visibilidad, automatizaciones (bucles, presupuesto, fechas), CLM, columnas y fórmulas, la tabla tipo Excel y la analítica.
  - 🆕 También la plataforma: OpenAPI, ETag/412, cursor, auditoría encadenada, SSE, política de contraseñas, códigos de recuperación y 2FA obligatoria.
  - 🆕 Y las funciones nuevas: PDF, varios emails, recurrencias y CSAT.
- **E2E con Playwright:** tabla tipo Excel, etiquetas, pegado, deshacer, analítica, y la demo a 1440 y 390 px.
- **CI** 🆕 (`.github/workflows/crm-ci.yml`): `npm run verify` (tipos + pruebas + build), `npm audit` y construcción y arranque de la imagen Docker.
- **Observabilidad** 🆕:
  - `x-request-id` en cada respuesta.
  - Una línea JSON por petición, con `request_id`, `tenant_id`, `user_id` y duración.
  - Los errores 500 devuelven el `request_id` para encontrarlos en el log.

### A11. Orden de ejecución

Los sprints 0–7 del informe quedan cubiertos con la arquitectura actual; también el sprint 11 (webhooks + OpenAPI) y la parte de seguridad del 13. Faltan los sprints que dependen de terceros:

- 9: buzón conectado;
- 10: firma con proveedor;
- 12: calendario.

## Parte B · Funcional

### Prioridades del informe (B17)

| «Hacer primero» | Estado |
| --- | --- |
| Formulario web público | ✅ ya existía (`embed.js`) |
| PDF de presupuesto | 🆕 hecho: generador PDF propio. Detalle en «Presupuestos» |
| Recurrencia de tareas | 🆕 ampliada: diaria, días laborables, semanal (cada N o días concretos), mensual (mes natural, fin de mes), anual; hora y duración |
| Campos obligatorios por etapa | ✅ ya existía (por etapa y por reglas del tablero) |
| Varios emails y teléfonos | 🆕 hecho: lista con etiqueta y principal; duplicados, búsqueda y fusión los tienen en cuenta |
| Varios pipelines | ✅ ya existía |

«Planificar»:

- ⏳ **Pendientes por credenciales externas:** buzón conectado, firma eIDAS y calendario.
- ✅ **Ya existían:** alertas en servidor, API pública y webhooks.
- 🆕 **Hecho ahora:** constructor de informes.

### Áreas (B2–B16)

| Área | Antes | Ahora | Qué cambió |
| --- | --- | --- | --- |
| Tableros y personalización | 3 | 4 | Tabla tipo Excel, etiquetas editables también en estados del sistema, vistas guardadas, formato condicional, cambio de tipo con conversión |
| Contactos y empresas | 2 | 3 | Varios emails y teléfonos; jerarquía de empresas (ya existía `parent_id` y árbol); fusión con deshacer; bloqueo de duplicados en todos los emails |
| Leads y captación | 2 | 3 | Formulario público, puntuación con decaimiento configurable (se recalcula a diario), rotativo y SLA de primer contacto |
| Pipeline y negocios | 3 | 3 | Varios pipelines, obligatorios por etapa, contactos con rol, previsión por categorías 🆕 y cuotas 🆕 |
| Tareas y actividades | 2 | 3 | Hora, duración y recurrencias completas. Pendiente: sincronizar con calendario |
| Email | 1 | 2 | SMTP real con seguimiento propio (ya existía); encuesta CSAT. Pendiente: buzón y secuencias |
| Presupuestos | 2 | 3 | Ver «Presupuestos» |
| Soporte | 2 | 3 | Tickets con SLA, respuesta por email, notas internas, CSAT enviado al resolver 🆕 con aviso al agente si la nota es ≤ 2 |
| CLM | 3 | 3 | Ya muy completo; pendientes DOCX y firma eIDAS |
| Automatizaciones | 3 | 4 | Ya corrían en servidor; ahora con avisos en vivo y OpenAPI para integraciones |
| Informes y paneles | 2 | 4 | 🆕 Ver «Informes y paneles» |
| Administración y permisos | 2 | 3 | Roles editables, 2FA por rol 🆕, auditoría verificable 🆕. Pendientes: permisos por campo y SSO |
| Importación, exportación, API | 1 | 3 | Importación de contactos, empresas y negocios; API con OpenAPI 🆕; webhooks |
| Móvil, accesibilidad, idiomas | 1 | 3 | Ver «Interfaz»: móvil, ARIA, modo oscuro, español e inglés en la interfaz común |
| IA | 0 | 0 | ⏳ Requiere elegir un proveedor con residencia en la UE |

### Presupuestos

Generador PDF propio, sin dependencias.

- **Contenido del PDF:** membrete, cliente, líneas con descuento e IVA, totales y condiciones, con tildes y €.
- **Huella:** el pie lleva la huella SHA-256 del contenido.
- **Descarga:** desde la ficha del negocio y desde el enlace público del cliente.
- **Aceptación:** guarda la huella del documento visto, además del nombre, la IP y el navegador.

### Informes y paneles

- **Constructor de informes:**
  - 7 objetos, filtros, hasta 2 agrupaciones (incluidas fechas por día, semana, mes, trimestre o año) y hasta 4 métricas.
  - Gráfico o tabla, guardar y compartir, y exportar a CSV para Excel.
- **Paneles por rol:** widgets que se arrastran y cambian de tamaño, con filtros globales.
- **Análisis comercial:**
  - embudo etapa a etapa con días por etapa;
  - previsión frente a lo real;
  - cuotas por persona y mes;
  - motivos de pérdida.
- **Informes programados por email y alertas sobre métricas.**

## Interfaz: móvil, accesibilidad, modo oscuro e idiomas

🆕 Hecho en el CRM real y en la demo:

- **Modo oscuro:** Sistema, Claro u Oscuro, en el menú de usuario; se recuerda entre sesiones.
- **Contraste de las etiquetas:** el texto de cada etiqueta de color se elige según la luminancia del fondo (texto oscuro sobre amarillo y lima).
- **Móvil:** cortes a 1280, 960 y 720 px.
  - Por debajo de 960 px el menú lateral pasa a ser un cajón.
  - Por debajo de 720 px las tablas se ven como tarjetas con hasta 3 campos elegidos por tablero, los diálogos ocupan toda la pantalla y los botones miden al menos 44 px.
  - A 390 px ninguna de las 15 rutas tiene desplazamiento horizontal.
- **Accesibilidad:**
  - tabla con roles `grid`, `row`, `gridcell` y `columnheader`, `aria-sort` y celda seleccionada;
  - diálogos con `aria-modal`, foco atrapado que vuelve a su sitio al cerrar, y Escape;
  - menús que se manejan con las flechas;
  - avisos con `aria-live`;
  - etiquetas en los botones de solo icono;
  - enlace «Saltar al contenido»;
  - animaciones desactivadas si el sistema pide movimiento reducido.
- **Revisión con axe-core:** las incidencias graves pasan de unas 3.200 a 185. Todas las que quedan son de contraste en colores de etiqueta intermedios (morado, gris) que el usuario puede cambiar desde «Editar etiquetas».
- **Idiomas:** `t()` con catálogos en español e inglés para el menú, la barra superior, la búsqueda, el inicio de sesión, los diálogos comunes y la barra de las tablas. Fechas e importes siguen el idioma elegido.
  - 🟡 Las páginas interiores siguen en español.
- **Atajos de teclado:**
  - g+c, g+e, g+n, g+t, g+h, g+a para navegar;
  - `n` para crear un elemento nuevo, `/` para buscar, `?` para ver la ayuda.

## Nota: migración a PostgreSQL (cuando haga falta)

SQLite aguanta bien un CRM interno: un solo servidor, decenas de usuarios a la vez y cientos de miles de registros, con copias triviales.

Conviene pasar a PostgreSQL cuando se dé una de estas situaciones:

- haga falta más de una instancia del servidor;
- se quiera RLS en la propia base;
- se quiera búsqueda `tsvector`.

El código está preparado:

- todo el SQL pasa por `server/db.ts`;
- las consultas usan parámetros;
- el `workspace_id` ya está en cada tabla.

Pasos para migrar:

1. Pasar `Db` a `pg` con la interfaz asíncrona.
2. Convertir los servicios a `async`.
3. Añadir políticas RLS con `current_setting('app.tenant_id')`.
4. Sustituir el planificador interno por BullMQ sobre Redis.

Las pruebas de integración actuales sirven de red de seguridad.
