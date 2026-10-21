# Paquete de verificación de Google (P5-07)

Lo que hay que presentar a Google para la verificación OAuth y la evaluación CASA, escrito a partir de lo que el código hace hoy. Este documento prepara el paquete; **presentarlo es trabajo humano** (cuenta de Google Cloud, dominio, vídeo, evaluador). Bloqueo: [`docs/blockers/google-oauth.md`](blockers/google-oauth.md).

## 1. Estado y camino crítico

| Paso | Quién | Estado | Depende de |
|---|---|---|---|
| Dominio propio verificado en Search Console | humano | pendiente | [`domain-brand.md`](blockers/domain-brand.md) |
| Política de privacidad y términos públicos en el dominio | código hecho (`/privacy`, `/terms`); revisión legal humana | borrador | dominio, revisión legal |
| Pantalla de consentimiento (tipo Externo) con los scopes de §3 | humano | pendiente | dominio |
| Modo **Testing** con ≤ 100 usuarios de prueba (beta cerrada) | humano | posible ya | proyecto OAuth |
| Adaptadores Google en vivo | código (fase 6) | pendiente | proyecto OAuth |
| Vídeo de demostración (§5) | humano, con el guion de §5 | pendiente | adaptadores en vivo, dominio |
| Envío a verificación de scopes sensibles y restringidos | humano | pendiente | todo lo anterior |
| Evaluación de seguridad CASA (scopes restringidos de Gmail) | evaluador autorizado + humano | pendiente | verificación iniciada |

Plazos orientativos: la verificación de scopes sensibles tarda días o semanas; con scopes restringidos, Google añade CASA (semanas o meses, renovación anual). Mientras tanto, la beta corre en **Testing** (los *refresh tokens* caducan a los 7 días: la UI ya marca la conexión como caducada y pide reconectar).

## 2. Datos de la aplicación para el formulario

- **Nombre:** Meri. **Logo:** `apps/web/public/icon.svg` exportado a PNG de 120×120 (sin marcas de Google).
- **Correo de soporte y de contacto del desarrollador:** los define el humano (no hay uno en el repo).
- **Página principal:** `https://<dominio>/` (pantalla de inicio de sesión con descripción del producto).
- **Política de privacidad:** `https://<dominio>/privacy` · **Términos:** `https://<dominio>/terms` · **Seguridad:** `https://<dominio>/seguridad`.
- **Dominios autorizados:** el dominio de la web y el de la API (si es otro subdominio, basta el dominio raíz).
- **URIs de redirección:** `https://<dominio>/api/auth/callback/google` (inicio de sesión) y `https://<api>/v1/integrations/google/callback` (conexión de Calendar/Gmail).

## 3. Scopes y justificación

Dos flujos separados (ADR 0007): el **inicio de sesión** solo pide identidad; la **conexión** de Calendar o Gmail pide sus scopes de forma incremental, con PKCE y acceso *offline*, cuando el usuario la activa en Control.

| Scope | Clase | Para qué lo usa Meri | Por qué no basta uno menor |
|---|---|---|---|
| `openid`, `email`, `profile` | no sensible | Crear la cuenta y reconocer al usuario (`sub` de Google, solo con `email_verified`). | — |
| `calendar.readonly` | sensible | Leer los eventos de los calendarios del usuario para planificar alrededor de sus reuniones y detectar conflictos y sobrecarga; listar calendarios. Nunca modifica estos eventos. | `calendar.events.readonly` no lista calendarios; `freebusy` no da títulos ni asistentes, necesarios para el tiempo por cliente (F-14) y las preparaciones. |
| `calendar.app.created` | sensible | Crear el calendario dedicado «Meri» y crear, mover y borrar en él los bloques de trabajo que el usuario confirma. | Es el mínimo que permite `calendars.insert`; además limita la escritura a calendarios creados por Meri: las reuniones de terceros quedan fuera por permiso (D-093). |
| `gmail.readonly` | **restringido** | Detectar compromisos y seguimientos en los hilos del usuario (radar de compromisos, F-07/F-08) y vincular hilos a clientes. Se guarda solo id, metadatos mínimos y una cita ≤ 200 caracteres; nunca cuerpos completos ni adjuntos. | `gmail.metadata` no da el texto del mensaje, sin el que no se puede detectar «te lo envío el viernes». |
| `gmail.compose` | **restringido** | Crear **borradores** de seguimiento cuando el usuario lo pide expresamente (`POST /v1/commitments/:id/followup-draft`). El usuario revisa y envía desde Gmail. | Es el único scope que permite crear borradores. Meri **nunca envía**: no pide `gmail.send` y el CI rechaza cualquier ruta de envío. |

Scopes prohibidos por código (`FORBIDDEN_SCOPES` en `packages/integrations/src/oauth/scopes.ts`, con test): `gmail.send`, `https://mail.google.com/`, `gmail.modify`, `calendar`, `calendar.events`.

## 4. Uso limitado de datos de usuario (Limited Use)

Cada requisito de la política, con dónde se cumple:

| Requisito | Cómo lo cumple Meri | Evidencia |
|---|---|---|
| Usar los datos solo para funciones visibles al usuario | Los datos de Gmail/Calendar alimentan solo el plan, el radar de compromisos, las preparaciones de reunión y el tiempo por cliente que el usuario ve. | `docs/01-product-spec.md`; texto en `/privacy` (`privacy.p3`). |
| No transferir a terceros salvo para prestar el servicio, por seguridad o por ley | Subencargados: hosting, base de datos, proveedor de IA (solo fragmentos saneados y minimizados), Stripe y analítica (estos dos sin datos de Google). | `docs/compliance/subprocessors.md`. |
| No usar para publicidad | No hay publicidad. La analítica solo lleva ids de workspace y enumerados, nunca contenido (D-065). | `packages/integrations/src/analytics`, D-065. |
| No permitir que humanos lean los datos | No hay herramienta interna para leer contenido de usuarios; el contexto de lectura admin (`app.workspace_id='*'`) solo lo usan la copia de seguridad, la purga y su verificación; los registros censuran tokens y secretos y los handlers solo registran ids y recuentos, nunca contenido de correos. Excepciones: consentimiento explícito del usuario, seguridad o ley. | `docs/threat-model.md`; `REDACTED_PATHS` en `packages/config` (test `logger.test.ts`). |
| No usar para entrenar modelos generales | El proveedor de IA se configura sin retención ni entrenamiento sobre datos del cliente (docs/05 §9). Las evals usan **solo datos sintéticos** (`evals/`); el feedback de propuestas nunca exporta texto de correos. | `docs/05-ai-design.md` §9; `evals/`. |
| Seguridad y cifrado | Tokens con cifrado de sobre y KMS (ADR 0007); RLS por workspace; TLS y HSTS; auditoría inmutable. | ADR 0007; `docs/threat-model.md`. |
| Borrado a petición | Revocar la conexión borra los tokens y llama a la revocación de Google; borrar la cuenta purga todo a los 30 días con verificación. | `docs/compliance/deletion-verification.md`. |

**Declaración para la política de privacidad** (ya incluida en `/privacy`): «El uso y la transferencia a cualquier otra aplicación de la información recibida de las API de Google se ajustará a la Política de datos de usuario de los servicios de API de Google, incluidos los requisitos de uso limitado».

## 5. Guion del vídeo de demostración

Requisitos de Google: en inglés o con subtítulos, mostrar la pantalla de consentimiento completa con el **ID de cliente visible** en la URL, y enseñar el uso de cada scope. Unos 4 minutos, grabado sobre producción o staging en vivo.

1. **Inicio de sesión** (0:00–0:30): abrir `https://<dominio>/login`, «Continuar con Google»; enseñar la URL de consentimiento con `client_id` y los scopes `openid email profile`.
2. **Conectar Calendar** (0:30–1:15): Control → Conexiones → Conectar Google Calendar; pantalla de consentimiento con `calendar.readonly` y `calendar.app.created`; volver a Meri y ver «Conectado».
3. **Uso de `calendar.readonly`** (1:15–1:45): Hoy y Calendario muestran las reuniones del usuario y el plan alrededor de ellas; explicar que esos eventos nunca se editan.
4. **Uso de `calendar.app.created`** (1:45–2:15): aceptar un plan; en Google Calendar aparece el calendario «Meri» con los bloques; mover un bloque desde Meri y deshacerlo.
5. **Conectar Gmail** (2:15–2:45): Control → Correo; consentimiento con `gmail.readonly` y `gmail.compose`; enseñar las exclusiones y la retención.
6. **Uso de `gmail.readonly`** (2:45–3:15): Entrada → radar de compromisos con la cita de origen; confirmar uno; enseñar «Por qué» (la cita) y que no se guarda el cuerpo.
7. **Uso de `gmail.compose`** (3:15–3:45): en un compromiso vencido, «Preparar seguimiento» → crear borrador; abrir Gmail → Borradores y ver que **no se ha enviado nada**.
8. **Control del usuario** (3:45–4:15): Control → Permisos (lo concedido en lenguaje llano), Actividad, revocar la conexión, exportar datos.

## 6. Checklist CASA (scopes restringidos)

CASA se basa en OWASP ASVS. Evidencias ya existentes en el repositorio y lo que queda para humanos:

| Área ASVS | Evidencia en el repo | Pendiente humano |
|---|---|---|
| V1 Arquitectura y modelo de amenazas | `docs/02-architecture.md`, `docs/threat-model.md` (STRIDE) | — |
| V2/V3 Autenticación y sesiones | Auth.js con Google y `email_verified`; `authTime`, caducidad absoluta de 14 días, revocación global; cookies `HttpOnly`/`Secure`/`SameSite=Lax` (ADR 0007) | — |
| V4 Control de acceso | RLS forzada por workspace; matriz de autorización sobre las 81 rutas (`apps/api/src/routes/authz-matrix.test.ts`) | — |
| V5 Validación y codificación | Zod en todos los bordes; saneado de correo con pruebas de propiedades; celdas CSV neutralizadas; CSP con nonce | — |
| V6 Criptografía | Cifrado de sobre AES-256-GCM, AWS KMS con contexto de cifrado, rotación con *compare-and-swap*, copias cifradas | Crear la clave KMS y su política |
| V7 Errores y registros | problem+json sin detalles internos; pino con censura; auditoría inmutable | Sentry en vivo |
| V8 Protección de datos | Minimización (sin cuerpos), retención configurable, exportación y supresión verificada | — |
| V9 Comunicaciones | HSTS, TLS en el proveedor de hosting | Configurar TLS 1.2+ en el dominio |
| V10 Código malicioso y dependencias | gitleaks, `pnpm audit` bloqueante, CodeQL, SBOM CycloneDX | Activar GitHub Advanced Security si el repo es privado |
| V12/V13 Ficheros y API | Límites de tamaño, rate limit en Redis, CSRF en dos capas, webhooks firmados | — |
| V14 Configuración | Arranque que falla sin credenciales en `live`; `fake` prohibido en producción | Gestor de secretos en producción |
| Escaneo dinámico (DAST) que pide el evaluador | — | Ejecutarlo sobre staging cuando exista (con el evaluador o su herramienta) |
| Política de respuesta a incidentes | `docs/runbooks/incident-response.md` | Nombrar responsables y canal |

Para cada hallazgo del evaluador: abrir una tarea, corregir, añadir un test que lo cubra y adjuntar el commit como evidencia.

## 7. Qué no hace el código (trabajo humano)

Crear el proyecto de Google Cloud y la pantalla de consentimiento, verificar el dominio, grabar el vídeo, presentar la solicitud, contratar al evaluador CASA, la revisión legal de la política y los términos, y responder a Google durante la revisión. Ninguno de estos pasos se automatiza ni se simula.
