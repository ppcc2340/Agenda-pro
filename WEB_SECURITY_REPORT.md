# Informe de revisión de seguridad web: Cadenzo / La Mesa Larga

**Fecha:** 2026-11-02
**Alcance:** revisión pasiva. Solo peticiones GET normales (curl, openssl), sin credenciales, sin fuzzing, sin escaneo de puertos ni payloads.

**Objetivos revisados**

| Superficie | Host |
|---|---|
| Sitio de pantallas | `cadenzo-pantallas.netlify.app` |
| API y paneles (staff, kds, admin, soporte) | `api-production-4763.up.railway.app` |

## Resumen

| # | Prioridad | Hallazgo | Sitio |
|---|---|---|---|
| 1 | Alta | Credenciales demo compartidas, con contraseña que no cumple la política del propio frontend | API / admin |
| 2 | Alta | PIN de 4 dígitos con valores triviales (1234, 0000) | API / staff, kds |
| 3 | Media | Sin cabeceras de seguridad (CSP, X-Frame-Options, etc.) | Netlify |
| 4 | Media | Token con apariencia de clave en `<meta name="cadenzo-telemetry">` | API |
| 5 | Baja | Rutas inexistentes devuelven 200 con HTML (incluye robots.txt, sitemap.xml, security.txt) | API |
| 6 | Baja | Falta `security.txt` y `robots.txt` | Ambos |
| 7 | Baja | HSTS sin `preload` | API |
| 8 | Info | Cabecera `Server` revela la plataforma de hosting | Ambos |
| 9 | Info | Certificado del API caduca el 2026-12-26 | API |
| 10 | Info | Revisar CVEs de React 19.3.1 | API |

## Lo que está bien

- **API, cabeceras:** CSP restrictiva (`script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy` y HSTS de un año.
- **Netlify, HSTS:** `max-age=31536000; includeSubDomains; preload`.
- **TLS:** el API negocia TLS 1.2 con ECDHE y AES-256-GCM. Certificado de Netlify válido hasta 2027-03-19.
- **Admin sin sesión:** no emite cookies antes de autenticarse.
- **Soporte:** `/soporte` envía `X-Robots-Tag: noindex, nofollow, noarchive`.
- **Frontend:** la contraseña exige 12 caracteres como mínimo. Solo se usa `dangerouslySetInnerHTML` para el código QR.

## Hallazgos detallados

### 1. Alta: credenciales demo compartidas y contraseña débil

La cuenta `admin@lamesalarga.cl` usa `demo1234`, de 8 caracteres. El esquema de validación del frontend exige al menos 12. Si esa cuenta existe en producción, es un acceso administrativo con contraseña débil y ya compartido en texto plano.

**Riesgo:** toma de control del panel de administración.

**Corrección:**
- Cambiar la contraseña de inmediato y no reutilizar la de demostración.
- Eliminar las cuentas demo de producción o crearlas solo en un entorno de pruebas.
- Hacer que el servidor rechace contraseñas de menos de 12 caracteres, no solo el frontend.

### 2. Alta: PIN de 4 dígitos con valores triviales

Los PIN del personal son de 4 dígitos (10.000 combinaciones). Los ejemplos incluyen `1234` y `0000`. No pude comprobar si hay límite de intentos, porque eso exige probar el login y no lo hice.

**Riesgo:** adivinación de PIN en el panel de meseros o de cocina.

**Corrección (Node/Express, ejemplo orientativo):**

```javascript
// Limitar intentos por IP y por usuario
import rateLimit from 'express-rate-limit';
app.use('/api/auth/pin', rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true }));

// Rechazar PIN triviales al crearlos
const PIN_DEBIL = new Set(['0000', '1111', '1234', '4321', '1212']);
if (PIN_DEBIL.has(pin)) throw new Error('PIN demasiado sencillo');
```

Además conviene subir a 6 dígitos y bloquear la cuenta tras varios fallos. El vínculo por dispositivo ya reduce el riesgo, pero no lo elimina.

### 3. Media: Netlify sin cabeceras de seguridad

La respuesta de `cadenzo-pantallas.netlify.app` solo incluye HSTS. Faltan:

- Content-Security-Policy
- X-Frame-Options
- X-Content-Type-Options
- Referrer-Policy
- Permissions-Policy

El HTML tiene estilos inline y un script inline, así que la CSP necesita un hash para ese script o una excepción acotada. Además, la página carga fuentes de Google.

**Riesgo:** clickjacking del sitio de pantallas y menor defensa frente a XSS.

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

Para obtener el hash del script inline:

```bash
python3 -c "import re,base64,hashlib,sys; h=open(sys.argv[1]).read(); [print(base64.b64encode(hashlib.sha256(m.encode()).digest()).decode()) for m in re.findall(r'<script>([^<]*)</script>', h)]" netlify_root.html
```

Si el sitio muestra errores de CSP tras el cambio, revisa si el script `/.netlify/scripts/hud` de Netlify necesita una excepción.

### 4. Media: token en una etiqueta meta

El HTML del API incluye:

```html
<meta name="cadenzo-telemetry" content="Vrx-vjg0gbl6NJ5jH1QYCFtDZHOqUvh3">
```

No sé si es un identificador público o una clave de escritura. Si es una clave secreta, cualquiera que abra la página puede usarla.

**Corrección:** confirma qué es. Si es secreta, muévela al servidor y deja solo un identificador público en el cliente. Si se quiere rotar, hazlo desde el servicio de telemetría.

### 5. Baja: rutas inexistentes devuelven 200

En el API, `/robots.txt`, `/sitemap.xml`, `/security.txt` y `/.well-known/security.txt` devuelven 200 con el mismo HTML de 1109 bytes. Es el fallback de la SPA. Puede confundir a herramientas automáticas y a quien busque esos archivos.

**Corrección (Express):**

```javascript
// Antes del fallback de la SPA
app.use((req, res, next) => {
  if (/\.(txt|xml)$/.test(req.path) || req.path.startsWith('/.well-known/')) {
    return res.status(404).end();
  }
  next();
});
```

### 6. Baja: faltan security.txt y robots.txt

Ninguno de los dos sitios tiene `security.txt`. Netlify devuelve 404 también para `robots.txt`.

**Corrección:** publica `/.well-known/security.txt` (Netlify: carpeta `public/`; API: carpeta estática):

```text
Contact: mailto:seguridad@lamesalarga.cl
Expires: 2027-11-02T00:00:00Z
Preferred-Languages: es, en
Canonical: https://cadenzo-pantallas.netlify.app/.well-known/security.txt
```

Y un `robots.txt` mínimo. Para el panel de administración conviene `Disallow: /admin` y `Disallow: /soporte`, aunque la protección real debe estar en la autenticación.

### 7. Baja: HSTS sin preload en el API

`max-age=31536000; includeSubDomains` es correcto. Si quieres aparecer en la lista de precarga de navegadores, añade `preload`, pero solo cuando estés seguro de que todo el dominio sirve HTTPS.

### 8. Info: la cabecera Server revela la plataforma

Netlify responde `server: Netlify` y Railway responde `server: railway-hikari`. No revelan versión, pero sí el proveedor. Es un riesgo bajo y difícil de evitar en plataformas gestionadas.

### 9. Info: certificado del API

El certificado del API es de Let's Encrypt y caduca el 2026-12-26. Railway lo renueva automáticamente, pero conviene confirmar que la renovación se completa unos días antes de la caducidad.

### 10. Info: librerías JavaScript

El bundle del API incluye React y react-dom 19.3.1. No conozco ninguna vulnerabilidad pública para esa versión en mis datos, pero no puedo confirmarlo para la fecha de hoy. Revisa el `package.json` del repositorio con `npm audit` o con la base OSV.

La página de Netlify carga Google Fonts desde terceros. No es una vulnerabilidad, pero comparte la IP del visitante con Google.

## No verificado

- **Redirección HTTP a HTTPS:** el proxy de salida no permite peticiones HTTP, así que no pude comprobarla.
- **TLS 1.3:** la sonda por proxy no devolvió resultado. Solo confirmé TLS 1.2.
- **Cookies de sesión:** solo comprobé el estado sin autenticar. Las flags Secure, HttpOnly y SameSite de las cookies de sesión requieren iniciar sesión.
- **Mensajes de error y autenticación:** no probé formularios ni endpoints de login, por las reglas de la revisión.

Para cerrar estos puntos hace falta una revisión autenticada con las cuentas de prueba, y solo si lo autorizas.
