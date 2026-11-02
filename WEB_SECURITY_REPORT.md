# Informe de seguridad web: Cadenzo / La Mesa Larga

**Fecha:** 2026-11-02
**Alcance:** revisión pasiva. Solo peticiones GET normales, sin credenciales, sin fuzzing, sin escaneo de puertos ni payloads.

| Superficie | Host |
|---|---|
| Sitio de pantallas | `cadenzo-pantallas.netlify.app` |
| API y paneles (staff, kds, admin, soporte) | `api-production-4763.up.railway.app` |

**Nota de seguridad:** las credenciales de demostración y los PIN de ejemplo que se compartieron en el chat no se reproducen aquí. Deben cambiarse en producción. El historial del repositorio ya contiene un commit anterior con esos valores (`c36a49d`), por lo que hay que rotarlos igualmente.

## Veredicto

El backend aplica bien la autenticación: los endpoints protegidos devuelven 401 sin sesión y no hay CORS abierto. El riesgo real está en el acceso del personal. El PIN es el único secreto que protege comandas y cocina, tiene entre 4 y 6 dígitos y su defensa depende de un identificador de dispositivo que vive en el navegador. Además, el sitio de Netlify no tiene defensas en el navegador.

## Prioridades

| # | Prioridad | Hallazgo | Sitio |
|---|---|---|---|
| 1 | Crítica | Credencial de administrador de demostración compartida y con contraseña débil | API / admin |
| 2 | Alta | PIN del personal de 4 a 6 dígitos sin prueba de límite de intentos | API / staff, kds |
| 3 | Media | El dispositivo de personal es de confianza durante 180 días y se revoca solo a mano | API / staff, kds |
| 4 | Media | Netlify sin CSP, X-Frame-Options ni otras cabeceras | Netlify |
| 5 | Media | Token con apariencia de clave en `<meta name="cadenzo-telemetry">` | API |
| 6 | Media | Endpoint `/health` revela entorno y estado de la base de datos | API |
| 7 | Baja | Endpoint de errores de cliente (`monitoring/client-errors`) con método abierto | API |
| 8 | Baja | Mensajes de error distintos según el caso en `/auth/me` y `/sessions/me` | API |
| 9 | Baja | Rutas inexistentes devuelven 200 con HTML | API |
| 10 | Baja | Faltan `security.txt` y `robots.txt` | Ambos |
| 11 | Info | Cabecera `Server` revela el proveedor de hosting | Ambos |
| 12 | Info | Certificado del API caduca el 2026-12-26 | API |
| 13 | Info | Revisar CVEs de React 19.3.1 | API |

## Lo que está bien

- **Protección de endpoints:** `floor`, `kitchen`, `orders`, `admin/*` y `support/tickets` devuelven 401 sin sesión.
- **Sin mapas de código fuente expuestos:** los `.map` devuelven el HTML de la SPA, no el código original.
- **Sin CORS abierto:** el API no devuelve `Access-Control-Allow-Origin` a un origen ajeno.
- **Listado de personal protegido:** `auth/pin-users` responde con el mismo error de dispositivo para un slug válido y para uno inventado, así que no sirve para enumerar.
- **CSP del API:** restrictiva, con `script-src 'self'`, `connect-src 'self'` y `frame-ancestors 'none'`.
- **HSTS, nosniff, X-Frame-Options y Referrer-Policy** presentes en el API.
- **TLS:** el API negocia TLS 1.2 con ECDHE y AES-256-GCM. El certificado de Netlify es válido hasta 2027-03-19.
- **dangerouslySetInnerHTML:** el único uso de `dangerouslySetInnerHTML` que encontré es el código QR.

## Hallazgos detallados

### 1. Crítica: credencial de administrador de demostración

La cuenta de administración usa una contraseña de demostración de 8 caracteres. El frontend exige 12 como mínimo, así que la validación no se aplica a esa cuenta. Como se pegó en un chat, debe considerarse pública.

**Riesgo:** control total del panel de administración: menú, precios, personal y ajustes del local.

**Corrección inmediata:**
- Cambiar la contraseña hoy.
- Revisar en los registros de acceso si alguien entró con ella.
- Eliminar las cuentas de demostración de producción.
- Aplicar el mínimo de 12 caracteres también en el servidor, no solo en el cliente.

### 2. Alta: PIN de 4 a 6 dígitos sin límite demostrado

El cliente acepta PIN de 4 a 6 dígitos. Con 4 dígitos son 10.000 combinaciones. No pude confirmar si el servidor limita intentos, porque eso exige probar el login y no lo hice.

**Riesgo:** adivinación del PIN de un mesero o de cocina para operar comandas.

**Corrección (Node/Express, ejemplo orientativo):**

```javascript
import rateLimit from 'express-rate-limit';
app.use('/api/v1/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true }));
```

Además: subir el mínimo a 6 dígitos en el servidor, rechazar PIN triviales al crearlos, bloquear temporalmente la cuenta tras varios fallos y registrar los intentos fallidos.

### 3. Media: confianza de dispositivo de 180 días

Tras un login de administración, el servidor emite `__Host-cadenzo_device` con `HttpOnly`, `Secure`, `SameSite=Lax` y 180 días de vida. Es el mecanismo que permite el PIN en ese equipo. Un equipo habilitado sigue dentro durante medio año sin volver a pedir correo y contraseña.

Además, el cliente guarda un UUID propio en `localStorage` (`cadenzo.device`) y lo envía en algunos flujos. No pude confirmar si el servidor lo usa para decidir algo, así que lo trato como dato de telemetría, no como control.

**Riesgo:** un equipo robado, perdido o que sale del local conserva acceso por PIN durante meses, y el personal que se va no pierde el acceso al equipo.

**Corrección:**
- Reducir la vida de la cookie a 30 días o menos, o renovarla solo con actividad.
- Revocar el dispositivo al desactivar a un miembro del personal, y ofrecer una lista de dispositivos habilitados en el panel de administración.
- No usar el UUID de `localStorage` como identificador de confianza.

### 4. Media: Netlify sin defensas en el navegador

La respuesta de `cadenzo-pantallas.netlify.app` solo incluye HSTS. Sin CSP, cualquier script inyectado se ejecuta sin restricción. Sin `X-Frame-Options` ni `frame-ancestors`, cualquier web puede embeber la pantalla.

**Corrección en `netlify.toml` (probar antes en un preview):**

```toml
[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Permissions-Policy = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
    Content-Security-Policy = "default-src 'self'; script-src 'self' 'sha256-REEMPLAZAR'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
```

El hash del script inline se calcula sobre el HTML descargado. Si el HUD de Netlify (`/.netlify/scripts/hud`) se bloquea, añade la excepción necesaria.

### 5. Media: token con apariencia de clave en el HTML

El HTML del API incluye una etiqueta `<meta name="cadenzo-telemetry">` con un valor de 32 caracteres. No sé si es identificador público o clave de escritura. Hasta confirmarlo, debe tratarse como expuesto.

**Corrección:** confirmar su función, rotarlo en el servicio de telemetría y, si es secreto, moverlo al servidor.

### 6. Media: `/health` revela entorno y estado de la base de datos

`/api/v1/health` responde sin autenticación con `"env":"production"`, el estado de la base de datos y si los pagos están habilitados. Son datos útiles para un atacante que prepare un ataque, aunque no den acceso.

**Corrección:** devolver solo `{"ok":true}` públicamente y reservar el detalle para una ruta interna con autenticación o una IP de monitorización.

### 7. Baja: endpoint de errores de cliente

`/api/v1/monitoring/client-errors` existe y el cliente lo usa para reportar errores. Un GET devuelve 405, así que el POST es público. No lo probé por ser una escritura. Un endpoint de ingesta abierto puede llenar los registros o inyectar datos falsos.

**Corrección:** limitar tamaño y frecuencia por IP, validar el esquema y no mostrar esos datos sin escapar en el panel de administración.

### 8. Baja: mensajes de error distintos

`/auth/me` responde "inicia sesión" y `/sessions/me` responde "token de mesa inválido o expirado". La diferencia permite saber qué mecanismo se usó, aunque no revela secretos. Unificar los mensajes en una respuesta genérica.

### 9. Baja: rutas inexistentes devuelven 200

En el API, `robots.txt`, `sitemap.xml` y `security.txt` devuelven 200 con el HTML de la SPA. Puede confundir a herramientas automáticas.

**Corrección (Express):**

```javascript
app.use((req, res, next) => {
  if (/\.(txt|xml)$/.test(req.path) || req.path.startsWith('/.well-known/')) return res.status(404).end();
  next();
});
```

### 10. Baja: faltan security.txt y robots.txt

Ninguno de los dos sitios tiene `security.txt`. Netlify devuelve 404 también para `robots.txt`.

**Corrección:** publicar `/.well-known/security.txt`:

```text
Contact: mailto:seguridad@lamesalarga.cl
Expires: 2027-11-02T00:00:00Z
Preferred-Languages: es, en
```

### 11. Info: cabecera Server

Netlify responde `server: Netlify` y Railway `server: railway-hikari`. No revelan versión. Es riesgo bajo y difícil de evitar en plataformas gestionadas.

### 12. Info: certificado del API

Let's Encrypt, caduca el 2026-12-26. Railway lo renueva automáticamente. Confirma que la renovación se completa antes de la fecha.

### 13. Info: librerías JavaScript

El bundle incluye React y react-dom 19.3.1. No conozco una vulnerabilidad pública para esa versión, pero no puedo confirmarlo a fecha de hoy. Revisa el `package.json` con `npm audit` o con la base OSV.

## Verificado con sesión de administración

- **Cookie de sesión:** `__Host-cadenzo_staff` con `HttpOnly`, `Secure`, `SameSite=Lax` y 12 horas. Bien configurada.
- **Cierre de sesión:** `auth/logout` responde 204 y la cookie deja de valer (401 en `auth/me`).
- **Listado del personal:** `admin/staff` devuelve banderas `hasPin` y `hasPassword`, no hashes. Correcto.
- **Caché:** las respuestas de `admin/staff` y `admin/settings` llevan `Cache-Control: no-store`. Correcto.
- **Permisos:** la cuenta de administración tiene un conjunto amplio de permisos (descuentos, edición de menú, auditoría, personal). Conviene revisar si todos son necesarios para un administrador de día a día.

## No verificado

- **Límite de intentos del PIN y del login:** no probado a propósito. Hacer intentos fallidos contra cuentas reales de servicio podría bloquear a meseros en turno. Hay que probarlo en un entorno de pruebas o con una cuenta creada solo para esto.
- **Rol del UUID de `localStorage`:** no confirmado. Ver punto 3.
- **Redirección HTTP a HTTPS:** el proxy de salida no permite HTTP.
- **TLS 1.3:** la sonda por proxy no devolvió resultado.
- **Endpoints POST:** no probados, por ser escrituras.

Para cerrar estos puntos hace falta una revisión autenticada con cuentas de prueba, solo con tu autorización.

## Anexo: pruebas de carga y límites de tasa

- **Prueba realizada:** 30 peticiones GET secuenciales a `/api/v1/health` desde un único origen. Todas devolvieron 200 y ninguna 429.
- **Lectura:** no hay límite de tasa visible en ese endpoint. `/health` no es el de mayor riesgo, así que el resultado no dice nada sobre el login ni el PIN.
- **No realizado:** prueba de saturación. Se hará solo en un entorno de pruebas o fuera del horario de servicio, porque una caída en producción afecta a comandas y cocina.
- **Código del API:** no está en este repositorio. `meri/` es un proyecto distinto con un esqueleto de API, así que no pude auditar el código del API de Cadenzo ni ejecutar `npm audit` sobre él.
