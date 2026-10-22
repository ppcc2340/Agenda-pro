# 0010. Informe de errores a Sentry sin SDK

- Estado: aceptada
- Fecha: 2026-10-22

## Contexto
La fase 0 dejó los envoltorios de observabilidad (P0-10) con un rastreador que solo escribe en el log. Con `SENTRY_DSN` puesto, la API registraba un aviso y seguía igual. El worker y la web no capturaban nada. Para una beta con un objetivo de disponibilidad del 99,5 % (fase 6), los errores que nadie ve son un hueco del MVP: el runbook de incidentes empieza por «alertas de Sentry», y esas alertas no podían llegar nunca.

## Opciones consideradas
- **SDK oficial** (`@sentry/node`, `@sentry/nextjs`):
  - instrumenta `http`, la consola y las peticiones por defecto, y cualquiera de ellos puede llevar datos personales (cuerpos, cabeceras, consultas, correos en mensajes);
  - en Next añade un cliente al navegador y obliga a abrir `connect-src` en la CSP;
  - para cumplir «sin cuerpos de petición ni tokens» hay que desactivar lo que se activa solo y mantenerlo en cada actualización.
- **Envío propio al endpoint de *envelope* de Sentry** (`POST /api/<proyecto>/envelope/`, formato documentado y estable):
  - solo sale lo que el código construye;
  - sin dependencias nuevas;
  - se prueba por HTTP contra un servidor local.
- **Solo logs y alertas del hosting**: depende del proveedor que se elija, y hoy no hay ninguno.

## Decisión
1. **Rastreador** `createSentryErrorTracker` en `@meri/config/observability`:
   - DSN `https://<clave>@<host>/<proyecto>`; http solo hacia localhost. Un DSN mal formado falla al arrancar (`resolveModes`) sin repetir su valor.
   - Evento: tipo y mensaje del error (y hasta dos `cause`), marcos de la pila, `environment`, `release` (`SENTRY_RELEASE`) y etiquetas de una lista cerrada: `traceId`, `route`, `method`, `statusCode`, `queue`, `jobId`, `attempt`, `workspaceId`, `source`, `digest`.
   - Nunca salen el resto del contexto, propiedades del error (`query`, `parameters` de postgres), cabeceras, cuerpos ni la URL con su consulta. Un valor lanzado que no es un `Error` solo envía su tipo.
   - Los mensajes se limpian: correos, credenciales en URL, `Bearer`/`Basic`, cadenas opacas de 32 caracteres o más y consultas. Los UUID se conservan, porque son ids.
   - Máximo 30 eventos por minuto y proceso; el mismo error (tipo, mensaje y marco superior) una vez por minuto; respeta el 429 con `Retry-After`.
   - No bloquea ni lanza: `captureException` escribe siempre en el log y envía en segundo plano; `flush` espera con un límite de 5 s.
2. **Interruptor**: `ANALYTICS_MODE=live`, el del bloqueo `observability`, que en producción ya exige `SENTRY_DSN`. Un DSN copiado en un `.env` de desarrollo no envía nada.
3. **Dónde se captura**:
   - API: el manejador de errores (500), como antes.
   - Worker: el último intento fallido de cada job, que va a la cola `dead-letter`; los reintentos intermedios solo se registran. También los fallos de los despachadores programados.
   - Web: `instrumentation.ts` con `onRequestError` (renderizado, rutas, acciones), solo en el runtime de Node. Sin cliente en el navegador; la CSP no cambia.
   - API y worker: `uncaughtException` y `unhandledRejection` se informan, se vacían y el proceso sale con 1, como haría Node sin el manejador. La web deja ese caso a Next.

## Consecuencias
- Probado contra un servidor HTTP local que hace de Sentry (`apps/api/src/observability.test.ts`: un 500 real llega con ids y sin datos personales) y con `fetch` simulado. Nunca contra sentry.io: `pnpm smoke observability` es la primera prueba real (humana).
- Sin *breadcrumbs*, sin contexto de usuario, sin agrupación propia (lo hace Sentry), sin trazas de rendimiento ni sourcemaps. Las pilas de la web compilada apuntan a `.next/server`.
- Los errores del navegador no se informan (ni del middleware en edge). Se ven en los logs del servidor cuando afectan a una petición.
- OpenTelemetry sigue sin exportar; con `OTEL_EXPORTER_OTLP_ENDPOINT` se avisa al arrancar (deuda).
- Sentry ya figuraba como subencargado; lo que recibe queda descrito aquí y en `docs/compliance/subprocessors.md`.
