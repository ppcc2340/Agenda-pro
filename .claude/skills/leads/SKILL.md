---
name: leads
description: Motor de leads en `leads/`. Úsalo cuando el usuario pida buscar clientes/leads/prospectos (Google, Google Maps, Instagram), enviar correos de prospección, revisar quién respondió o exportar leads a Excel.
---

# Motor de leads

Todo vive en `leads/`. Se opera con `python leads.py <comando>` desde esa carpeta.
Config en `leads/config.yaml`; credenciales en `leads/.env` (nunca las leas en voz alta ni las copies a otro lado).

## Traducir la petición a comandos

| El usuario dice… | Ejecuta |
|---|---|
| "busca X en Y" | `python leads.py buscar --rubro "X" --ciudad "Y"` |
| "busca lo de la config" | `python leads.py buscar` |
| "solo en maps / instagram" | añade `--fuentes maps` o `--fuentes instagram` |
| "mándales el correo" | primero `python leads.py enviar` (vista previa), muéstrala y **pide confirmación**; luego `python leads.py enviar --confirmar` |
| "quién respondió" | `python leads.py respuestas` |
| "pásalo a Excel" | `python leads.py excel` y entrega la ruta de `leads/leads.xlsx` |
| "haz todo" | `buscar` → `enviar` (previa) → confirmar → `enviar --confirmar` → `respuestas` → `excel` |
| "cómo vamos" | `python leads.py estado` |

Si el usuario quiere cambiar el servicio ofrecido, el texto del correo o los rubros/ciudades,
edita `leads/config.yaml` (no el código).

## Reglas

1. **Nunca** ejecutes `enviar --confirmar` sin que el usuario haya visto la vista previa y dicho que sí en esta conversación.
2. Si `.env` no existe, cópialo desde `.env.example` y pide al usuario que complete `EMAIL_USER` / `EMAIL_PASS` (contraseña de aplicación de Gmail).
3. Si una fuente falla (Maps/Instagram cambian su HTML a menudo), informa y sigue con las demás; sugiere `GOOGLE_API_KEY` para la variante estable.
4. Al terminar, resume en 3-4 líneas: cuántos leads nuevos, cuántos con correo, cuántos enviados, cuántos respondieron, y la ruta del Excel.
