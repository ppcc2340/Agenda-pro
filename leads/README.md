# Motor de leads

Busca clientes potenciales en **Google, Google Maps e Instagram**, les envía un correo
ofreciendo tus servicios **desde tu Gmail a través de Claude** y vuelca en un **Excel
ordenado** quiénes respondieron.

```
buscar  →  elegir mensaje  →  enviar (Gmail)  →  respuestas  →  excel
```

## Instalación (una vez)

```bash
cd leads
pip install -r requirements.txt
python -m playwright install chromium     # para Google Maps sin API key
```

Edita `config.yaml` con los datos de tu negocio y los rubros/ciudades a buscar.
Si usarás Claude con el conector de Gmail, no necesitas nada más.

## Uso con Claude Code (recomendado)

Dentro del repo basta con pedirlo; la skill `/leads` sabe qué hacer:

> "busca clínicas dentales en Santiago"
> "muéstrame los mensajes disponibles" · "cambia el mensaje: más corto y tutea"
> "envíales el correo" → Claude muestra la cola, te pide confirmación y envía con **tu Gmail**
> "revisa quién respondió y pásamelo a Excel"

Claude envía y lee con el **conector de Gmail de claude.ai** (actívalo en Configuración →
Conectores). No hay que guardar contraseñas en ningún sitio.

## Uso por terminal

```bash
python leads.py buscar                              # todas las búsquedas de config.yaml
python leads.py buscar --rubro "gimnasio" --ciudad "Concepción, Chile" --fuentes maps
python leads.py plantillas                          # mensajes disponibles
python leads.py plantillas propuesta-breve          # ver uno
python leads.py previa --id 3 --plantilla seguimiento
python leads.py cola                                # correos listos (modo gmail)
python leads.py marcar-enviado 3                    # tras enviarlo desde Gmail
python leads.py respuestas                          # qué buscar en Gmail
python leads.py registrar-respuesta 3 --texto "Sí, nos interesa" --asunto "Re: Propuesta"
python leads.py excel                               # genera leads.xlsx
python leads.py estado
```

### Modo smtp (sin Claude)

Pon `correo.modo: smtp` en `config.yaml`, copia `.env.example` a `.env` con `EMAIL_USER` y
`EMAIL_PASS` (contraseña de aplicación de Gmail) y entonces:

```bash
python leads.py enviar              # vista previa, no envía
python leads.py enviar --confirmar  # envía con pausa entre correos y límite diario
python leads.py respuestas          # lee la bandeja por IMAP y cruza automáticamente
```

## Mensajes (plantillas)

Cada mensaje es un archivo en `plantillas/`. La primera línea es el asunto, el resto el cuerpo:

```
Asunto: Propuesta para {nombre}

Hola, equipo de {nombre}:
...
```

Variables: `{nombre} {rubro} {ciudad} {remitente} {negocio} {servicio} {telefono} {web}`.

- Incluidas: `propuesta-breve` (predeterminada), `presentacion-servicios`, `seguimiento`.
- Edítalas o crea otras; el programa las detecta solas.
- Predeterminada: `correo.plantilla` en `config.yaml`. Por búsqueda: `plantilla:` en cada
  entrada de `busquedas`. Puntual: `--plantilla X` en `previa`, `cola` o `enviar`.
- `personalizar_con_ia: true` + `ANTHROPIC_API_KEY` → Claude añade un párrafo de apertura
  a medida de cada lead.

## El Excel (`leads.xlsx`)

| Hoja | Contenido |
|---|---|
| **Respondieron** | Solo los que contestaron, con fecha y resumen de su respuesta |
| **Enviados** | Todo lo enviado y su estado (enviado / respondió / baja / rebote) |
| **Todos los leads** | La base completa, incluidos los que aún no tienen correo |

Columnas: Nombre · Rubro · Ciudad · Correo · Teléfono · Web · Instagram · Dirección · Fuente ·
Estado · Plantilla · Enviado · Respondió · Respuesta. Con filtros, encabezado fijo y color por estado.

## Fuentes

| Fuente | Con clave de API (`.env`) | Sin clave (por defecto) |
|---|---|---|
| **Google** | Custom Search (`GOOGLE_API_KEY` + `GOOGLE_CSE_ID`) | DuckDuckGo (HTTP y, si pide captcha, navegador). Google bloquea el scraping directo. |
| **Google Maps** | Places API New (`GOOGLE_API_KEY`), rápido y estable | Navegador headless (Playwright) sobre maps.google.com |
| **Instagram** | — | Buscador `site:instagram.com` + biografía pública. Sin login. Desde IPs de servidor Instagram bloquea la biografía; el perfil se guarda igual para contactar por DM. |
| **Web del lead** | — | Visita portada y /contacto buscando `mailto:` o correos |

Los leads se deduplican por nombre + ciudad en `leads.db` (SQLite). Si una fuente falla, las demás siguen.

## Avisos

- El scraping de Maps e Instagram depende de su HTML y puede romperse cuando cambien la
  página; las variantes con API son estables.
- Si `playwright install` no es posible, apunta `CHROMIUM_PATH` en `.env` a un Chrome instalado.
- El correo comercial está regulado (en Chile, Ley 19.496 art. 28 B: identificar al remitente
  y ofrecer baja; las plantillas ya lo hacen). Mantén volúmenes bajos y respeta las bajas:
  quien responde "BAJA" queda marcado y no vuelve a entrar en la cola.
