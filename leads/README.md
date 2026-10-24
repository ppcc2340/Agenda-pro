# Motor de leads

Busca clientes potenciales en **Google, Google Maps e Instagram**, les envía un correo
ofreciendo tus servicios y vuelca en un **Excel ordenado** quiénes respondieron.
Un solo archivo de configuración, un solo comando, cuatro pasos.

```
buscar  →  enviar  →  respuestas  →  excel
```

## Instalación (una vez)

```bash
cd leads
pip install -r requirements.txt
python -m playwright install chromium     # solo si usarás Google Maps sin API key
cp .env.example .env                       # y rellena tu correo
```

Edita `config.yaml`: datos de tu negocio, qué rubros/ciudades buscar y la plantilla del correo.

## Uso

```bash
python leads.py buscar                      # busca en todas las fuentes de config.yaml
python leads.py buscar --rubro "gimnasio" --ciudad "Concepción, Chile" --fuentes maps
python leads.py enviar                      # vista previa, NO envía nada
python leads.py enviar --confirmar          # envía (respeta max_por_dia)
python leads.py respuestas                  # lee tu bandeja y marca quién respondió
python leads.py excel                       # genera leads.xlsx
python leads.py todo --confirmar            # todo seguido
python leads.py estado                      # resumen
```

### Con Claude Code

Dentro del repo basta con pedirlo en lenguaje natural; la skill `/leads` traduce:

> "busca dentistas en Santiago y mándales el correo"
> "revisa quién respondió y pásamelo a Excel"

## El Excel (`leads.xlsx`)

| Hoja | Contenido |
|---|---|
| **Respondieron** | Solo los leads que contestaron, con fecha y resumen de su respuesta |
| **Enviados** | Todo lo que se envió y su estado (enviado / respondió / baja / rebote) |
| **Todos los leads** | La base completa, incluidos los que aún no tienen correo |

Columnas: Nombre · Rubro · Ciudad · Correo · Teléfono · Web · Instagram · Dirección · Fuente · Estado · Enviado · Respondió · Respuesta.

## Cómo funciona cada fuente

| Fuente | Con clave de API | Sin clave (por defecto) |
|---|---|---|
| **Google** | Google Custom Search (`GOOGLE_API_KEY` + `GOOGLE_CSE_ID`) | DuckDuckGo (HTTP y, si pide captcha, con navegador). Google bloquea el scraping directo. |
| **Google Maps** | Places API New (`GOOGLE_API_KEY`), rápido y estable | Navegador headless (Playwright) sobre maps.google.com |
| **Instagram** | — | Buscador `site:instagram.com` + biografía pública (`og:description`). Sin login. Desde IPs de servidores Instagram bloquea la biografía; el perfil se guarda igual para contactar por DM. |
| **Web del lead** | — | Visita portada y /contacto buscando `mailto:` o correos |

Los leads se deduplican por nombre + ciudad en `leads.db` (SQLite). Si una fuente falla,
las demás continúan.

## Correo

- SMTP con STARTTLS (Gmail con contraseña de aplicación, u otro proveedor).
- `max_por_dia` y `segundos_entre_envios` protegen la reputación de tu dominio.
- Sin `--confirmar` nunca envía: solo muestra una vista previa.
- Las respuestas se cruzan por `In-Reply-To` y, si falta, por remitente.
- Si contestan "BAJA" / "unsubscribe" se marcan como `baja` y no se les vuelve a escribir.
- `personalizar_con_ia: true` + `ANTHROPIC_API_KEY` hace que Claude escriba un párrafo
  de apertura a medida de cada lead.

## Avisos

- Si `python -m playwright install chromium` no es posible, apunta `CHROMIUM_PATH` en `.env`
  a un Chromium/Chrome ya instalado.
- El scraping de Google Maps e Instagram depende de su HTML: puede dejar de funcionar
  cuando cambien la página. Las variantes con API son estables.
- El envío masivo de correos comerciales está regulado (en Chile, Ley 19.496 art. 28 B:
  identificar al remitente e incluir forma de darse de baja; la plantilla ya lo hace).
  Mantén volúmenes bajos y respeta las bajas.
