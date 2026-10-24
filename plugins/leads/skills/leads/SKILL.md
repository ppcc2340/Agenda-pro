---
name: leads
description: Motor de leads (prospección). Úsalo cuando el usuario hable de buscar clientes, leads o prospectos, mandar correos de prospección, ver quién respondió, el Excel de leads, o configurar su negocio para esto. El usuario NO sabe programar; tú haces todo.
allowed-tools: Bash(python ${CLAUDE_PLUGIN_ROOT}/leads.py *) Bash(python3 ${CLAUDE_PLUGIN_ROOT}/leads.py *) Bash(py ${CLAUDE_PLUGIN_ROOT}/leads.py *)
---

# Motor de leads — manual para Claude

El usuario es una persona de negocio, no programador. **Nunca le pidas que ejecute comandos
ni edite archivos**: lo haces tú y le cuentas el resultado en palabras simples. No menciones
Python, YAML, SQLite ni rutas salvo la del Excel final.

**Cómo ejecutar:** el programa está dentro de este plugin, en `${CLAUDE_PLUGIN_ROOT}/leads.py`.
Cada comando se ejecuta como `python ${CLAUDE_PLUGIN_ROOT}/leads.py <comando>` (si `python` no
existe prueba `python3`, y en Windows `py`). Los datos del usuario (configuración, mensajes, base,
Excel) viven en **`~/leads`** (carpeta `leads` dentro de su carpeta personal; se puede cambiar con
la variable `LEADS_DIR`). Se crea sola la primera vez.
Si faltan dependencias, el programa las instala solo al arrancar; si el navegador de Maps falla,
sigue con las otras fuentes y avisa en una línea.

**En este archivo, `python leads.py …` es la forma corta de `python ${CLAUDE_PLUGIN_ROOT}/leads.py …`.**

## 0. Primera vez: conocer el negocio

Ejecuta `python leads.py` (sin argumentos). Si responde "Aún no sé nada de tu negocio", haz la
**entrevista en un solo mensaje**, con estas preguntas y nada más:

1. ¿Cómo se llama tu empresa y cómo te llamas tú (quien firma)?
2. ¿Qué servicio ofreces? (una frase, como se lo contarías a un cliente)
3. ¿Qué tipo de negocios quieres contactar y en qué ciudad(es)? (p. ej. "clínicas dentales en Santiago")
4. Teléfono y sitio web para la firma del correo (opcional).

Con las respuestas ejecuta:
```
python leads.py configurar --negocio "…" --remitente "…" --servicio "…" --telefono "…" --web "…" \
  --buscar "clínica dental|Santiago, Chile" --buscar "gimnasio|Concepción, Chile"
```
(usa el rubro en singular y la ciudad con país). Luego muestra `python leads.py previa` **no**
(aún no hay leads): muestra `python leads.py plantillas propuesta-breve` con sus datos y pregunta
si el mensaje le gusta o quiere cambiarlo. Después ofrece empezar a buscar.

Cambios posteriores ("agrega cafeterías en Viña", "cambia el servicio a…"):
`configurar --buscar "cafetería|Viña del Mar, Chile" --agregar`, `configurar --servicio "…"`.

## 1. Buscar
- "busca X en Y" → `python leads.py buscar --rubro "X" --ciudad "Y"`
- "busca" / "busca todo" → `python leads.py buscar` (usa las búsquedas guardadas)
- "solo Maps / Instagram" → añade `--fuentes maps` / `--fuentes instagram`
Tarda varios minutos; avisa antes. Al terminar di: cuántos negocios nuevos, cuántos con correo.

## 2. Mensaje
- "qué mensajes hay" → `python leads.py plantillas`; descríbelos en una línea cada uno.
- "muéstrame cómo quedaría" → `python leads.py previa [--id N] [--plantilla X]`
- "usa el mensaje X" → `--plantilla X` en `cola`; si es para siempre: `configurar --plantilla X`
- "cámbialo / hazlo más corto / tutea / escribe uno nuevo" → edita `~/leads/plantillas/<nombre>.txt`
  en **`~/leads/plantillas/`** (línea 1 `Asunto: …`, luego el cuerpo; variables `{nombre} {rubro}
  {ciudad} {remitente} {negocio} {servicio} {telefono} {web}`; para uno nuevo crea otro `.txt` ahí). **Conserva siempre el pie con
  "BAJA"** (obligación legal). Luego `previa` para que lo apruebe.

## 3. Enviar (tú envías, con el conector de Gmail del usuario)
1. `python leads.py cola` → di cuántos correos hay y muestra el primero completo.
2. **Pide confirmación explícita** ("¿Los envío?"). Sin un sí claro en esta conversación, no envíes.
3. `python leads.py cola --json` → por cada elemento envía con la herramienta de **enviar correo
   del conector Gmail**: destinatario `para`, asunto `asunto`, cuerpo `cuerpo` tal cual, texto plano.
   Si el conector solo permite borradores, créalos y avísale que debe pulsar Enviar en Gmail.
4. Tras cada envío correcto: `python leads.py marcar-enviado <id> [--message-id "<id devuelto>"]`.
   Si uno falla, no lo marques y repórtalo al final.
5. Si el conector de Gmail no está autorizado: explícale que debe activarlo en claude.ai →
   Configuración → Conectores → Gmail, y que vuelva a pedírtelo. No propongas el modo smtp
   salvo que él lo pida.

## 4. Respuestas (tú lees, con el conector de Gmail)
1. `python leads.py respuestas --json` → cada lead trae `busqueda_gmail` (ej. `from:x@y.cl after:2026/10/24`).
2. Busca en Gmail con esa consulta. Si hay respuesta, léela y ejecuta
   `python leads.py registrar-respuesta <id> --texto "<primeras líneas>" --asunto "<asunto>"`
   (detecta BAJA y rebotes solo; `--baja` / `--rebote` para forzar). Si no hay, no hagas nada.
3. Cuéntale quién respondió y qué dijeron, en una línea por persona.

## 5. Excel
`python leads.py excel` → entrégale la ruta que imprime (`~/leads/leads.xlsx`) y di qué hoja mirar (Respondieron).

## Otras peticiones del manual (`${CLAUDE_PLUGIN_ROOT}/MANUAL.pdf`; si lo pide, dale esa ruta)
- "sube el límite diario a 60" → edita `correo.max_por_dia` en `~/leads/config.yaml`; advierte del riesgo de spam.
- "marca a X como baja" → busca su id en `python leads.py estado`/`cola`/`respuestas --json` y ejecuta
  `python leads.py registrar-respuesta <id> --baja --texto "pidió no recibir más correos"`.
- "borra todos los leads / empecemos de nuevo" → pide confirmación explícita; luego borra `~/leads/leads.db`
  (la configuración y las plantillas se conservan).
- "manda el seguimiento a los que no respondieron" → aún no está automatizado: explícalo y ofrece
  preparar los correos uno a uno con `previa --id N --plantilla seguimiento` y enviarlos con Gmail.

## "¿Cómo vamos?"
`python leads.py` → resume en 3 líneas y propone el siguiente paso que indica.

## Reglas
1. Nunca envíes sin confirmación explícita en esta conversación; nunca cambies el cuerpo al enviar.
2. No leas ni repitas el contenido de `~/leads/.env`.
3. Si algo falla, explícalo en una frase sin jerga y di qué hiciste para seguir.
4. Cierra siempre con un resumen corto y la pregunta "¿seguimos con …?" según el paso siguiente.
