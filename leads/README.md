# Motor de leads — guía rápida

Encuentra posibles clientes en **Google, Google Maps e Instagram**, les escribe **desde tu
Gmail** ofreciendo tus servicios y te deja en un **Excel** quiénes respondieron.
No necesitas saber programar: **se lo pides a Claude en palabras normales** y él hace todo.

## Antes de empezar (una sola vez, 2 minutos)

1. Activa el **conector de Gmail** en claude.ai → Configuración → Conectores → Gmail.
   Así Claude puede enviar y leer correos desde tu cuenta, sin guardar contraseñas en ningún sitio.
2. Abre este proyecto con Claude Code y escribe:

   > **configura el motor de leads**

   Claude te hará 4 preguntas (tu empresa, qué ofreces, a qué negocios quieres llegar y en qué
   ciudad, y tu firma) y lo deja listo. Lo que falte por instalar se instala solo.

## Qué le dices a Claude

| Quieres… | Dile… |
|---|---|
| Encontrar clientes | «busca clínicas dentales en Santiago» · «busca todo lo que tengo configurado» |
| Ver / cambiar el mensaje | «qué mensajes hay» · «muéstrame cómo quedaría» · «hazlo más corto y tutea» · «escribe un mensaje nuevo para gimnasios» |
| Mandar los correos | «envíales el correo» → Claude te muestra la lista, **te pide confirmación** y los envía desde tu Gmail |
| Saber quién contestó | «revisa quién respondió» |
| Tener el Excel | «pásamelo a Excel» → te da el archivo `leads.xlsx` |
| Saber cómo vas | «¿cómo vamos con los leads?» |
| Cambiar el negocio / rubros | «agrega cafeterías en Viña del Mar» · «cambia el servicio a …» |

## El Excel

| Hoja | Qué tiene |
|---|---|
| **Respondieron** | Solo los que contestaron, con fecha y qué dijeron |
| **Enviados** | Todo lo enviado y su estado (enviado / respondió / baja / rebote) |
| **Todos los leads** | Toda la base, incluidos los que aún no tienen correo |

## Cosas buenas que ya hace solo

- No repite negocios ya guardados ni escribe dos veces a la misma persona.
- Tope de 40 correos al día para cuidar tu reputación en Gmail.
- Todos los mensajes llevan al pie «responda BAJA»; quien lo pide queda marcado y no se le
  vuelve a escribir (es obligatorio por ley en Chile, Ley 19.496 art. 28 B).
- Si un sitio web no muestra el correo, lo busca en su página de contacto.
- Si Instagram o Maps fallan ese día, sigue con las demás fuentes y te avisa.

---

<details>
<summary><b>Para personas técnicas</b> (terminal, modo sin Claude, claves opcionales)</summary>

```bash
cd leads
python leads.py                       # estado y siguiente paso
python leads.py configurar            # preguntas guiadas (o con --negocio … --buscar "rubro|ciudad")
python leads.py buscar [--rubro X --ciudad Y] [--fuentes google,maps,instagram]
python leads.py plantillas [nombre]   # mensajes en plantillas/*.txt (línea 1 = Asunto)
python leads.py previa [--id N] [--plantilla X]
python leads.py cola [--json]         # modo gmail: correos listos para que Claude envíe
python leads.py marcar-enviado ID [--message-id X]
python leads.py respuestas [--json]   # gmail: qué buscar · smtp: lee la bandeja por IMAP
python leads.py registrar-respuesta ID --texto "…" [--asunto S] [--baja|--rebote]
python leads.py excel · estado · instalar
```

**Modo smtp (sin Claude):** `correo.modo: smtp` en `config.yaml`, copia `.env.example` → `.env`
con `EMAIL_USER`/`EMAIL_PASS` (contraseña de aplicación de Gmail); entonces `enviar --confirmar`
envía solo y `respuestas` lee por IMAP.

**Fuentes:** Google → Custom Search si hay `GOOGLE_API_KEY`+`GOOGLE_CSE_ID`, si no DuckDuckGo
(HTTP y, ante captcha, navegador). Maps → Places API si hay `GOOGLE_API_KEY`, si no Playwright
sobre maps.google.com (`CHROMIUM_PATH` para un Chrome ya instalado). Instagram → buscador
`site:instagram.com` + biografía pública (desde IPs de servidor Instagram la bloquea; el perfil
se guarda igual). Web del lead → portada y /contacto buscando `mailto:`.
`personalizar_con_ia: true` + `ANTHROPIC_API_KEY` → Claude añade un párrafo de apertura a medida.
El scraping depende del HTML de Google/Meta y puede romperse; las variantes con API son estables.
Datos en `leads.db` (SQLite), deduplicados por nombre+ciudad.
</details>
