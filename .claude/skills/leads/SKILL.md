---
name: leads
description: Motor de leads en `leads/`. Úsalo cuando el usuario pida buscar clientes/leads/prospectos (Google, Google Maps, Instagram), redactar o elegir el mensaje, enviar correos de prospección (vía conector de Gmail), revisar quién respondió o exportar leads a Excel.
---

# Motor de leads

Todo vive en `leads/`. Se opera con `cd leads && python leads.py <comando>`.
Configuración en `leads/config.yaml`; mensajes en `leads/plantillas/*.txt`.
Nunca leas en voz alta ni copies el contenido de `leads/.env`.

## Flujo completo (modo gmail, el predeterminado)

```
buscar → plantillas/previa → cola → [Gmail: enviar] → marcar-enviado → respuestas → [Gmail: buscar] → registrar-respuesta → excel
```

En modo gmail **tú (Claude) eres quien envía y lee el correo** con el conector de Gmail
del usuario. El programa solo prepara la cola y lleva el registro.

### 1. Buscar
| El usuario dice… | Ejecuta |
|---|---|
| "busca X en Y" | `python leads.py buscar --rubro "X" --ciudad "Y"` |
| "busca lo de la config" | `python leads.py buscar` |
| "solo en maps / instagram" | añade `--fuentes maps` o `--fuentes instagram` |

### 2. Mensaje (elegir / editar)
| El usuario dice… | Haz |
|---|---|
| "qué mensajes hay" | `python leads.py plantillas` y muéstraselas |
| "muéstrame el mensaje X" | `python leads.py plantillas X` |
| "cómo quedaría el correo" | `python leads.py previa [--id N] [--plantilla X]` |
| "usa el mensaje X" | `--plantilla X` en `cola`, o cambia `correo.plantilla` en `config.yaml` si es permanente |
| "cambia el mensaje / escribe uno nuevo" | Edita `leads/plantillas/<nombre>.txt` (primera línea `Asunto: …`, luego el cuerpo; variables `{nombre} {rubro} {ciudad} {remitente} {negocio} {servicio} {telefono} {web}`). Para uno nuevo crea otro `.txt` en la misma carpeta. Mantén siempre el pie con "BAJA". Luego muestra `previa` para que lo apruebe. |

### 3. Enviar (con el conector de Gmail)
1. `python leads.py cola` → muestra al usuario cuántos correos hay y el primero completo.
2. **Pide confirmación explícita** ("¿envío estos N correos?"). Sin un sí claro en esta conversación, no envíes.
3. `python leads.py cola --json` → por cada elemento, envía con la herramienta de **enviar correo del conector Gmail** (`para`, `asunto`, `cuerpo` tal cual, texto plano). Si el conector solo permite crear borradores, créalos y díselo al usuario.
4. Tras cada envío correcto: `python leads.py marcar-enviado <id> [--message-id "<id devuelto>"]`. Si uno falla, no lo marques y repórtalo.
5. Si el conector de Gmail no está autorizado, dile al usuario que lo active en los conectores de claude.ai; alternativa: `correo.modo: smtp` en `config.yaml` con `EMAIL_USER`/`EMAIL_PASS` en `.env` y entonces `python leads.py enviar --confirmar` envía solo.

### 4. Respuestas (con el conector de Gmail)
1. `python leads.py respuestas --json` → lista leads enviados con `busqueda_gmail` (ej. `from:x@y.cl after:2026/10/24`).
2. Por cada uno, busca en Gmail con esa consulta. Si hay respuesta, lee el mensaje y ejecuta
   `python leads.py registrar-respuesta <id> --texto "<primeras líneas>" --asunto "<asunto>"`
   (detecta BAJA y rebotes solo; puedes forzar con `--baja` o `--rebote`). Si no hay respuesta, no hagas nada.
3. Resume al usuario quién respondió y qué dijeron.

### 5. Excel
`python leads.py excel` → entrega la ruta `leads/leads.xlsx` (hojas Respondieron / Enviados / Todos).

### Estado
`python leads.py estado`

## Reglas
1. Nunca envíes sin que el usuario haya visto `cola`/`previa` y confirmado en esta conversación.
2. Respeta `max_por_dia` (la `cola` ya lo aplica); no inventes destinatarios ni modifiques el cuerpo al enviar.
3. Si `.env` no existe y se necesita (claves opcionales o modo smtp), cópialo de `.env.example` y pide los datos.
4. Si una fuente falla (Maps/Instagram cambian su HTML), informa y sigue con las demás; sugiere `GOOGLE_API_KEY` para la variante estable.
5. Al terminar, resume en 3-4 líneas: leads nuevos, con correo, enviados, respondieron, y la ruta del Excel.
