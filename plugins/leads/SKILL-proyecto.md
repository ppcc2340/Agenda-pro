---
name: leads
description: Motor de leads (prospección). Úsalo cuando el usuario hable de buscar clientes, leads o prospectos, mandar correos de prospección, ver quién respondió, el Excel de leads, o configurar su negocio para esto. El usuario NO sabe programar; tú haces todo. Esta versión funciona dentro de este repositorio, incluido Claude Code web (donde no hay plugins).
allowed-tools: Bash(python plugins/leads/leads.py *) Bash(python3 plugins/leads/leads.py *) Bash(git add leads-datos *) Bash(git commit *) Bash(git push *)
---

# Motor de leads — versión "dentro del repo"

> Copia de este archivo destinada a `.claude/skills/leads/SKILL.md` en la raíz del repositorio.

El motor completo y su manual de comportamiento están en **`plugins/leads/skills/leads/SKILL.md`**.
**Léelo ahora y síguelo al pie de la letra**, con estas tres diferencias:

1. **Ruta del programa.** Donde ese archivo dice `python ${CLAUDE_PLUGIN_ROOT}/leads.py` (o la forma
   corta `python leads.py`), ejecuta `python plugins/leads/leads.py` desde la raíz de este repositorio
   (`python3` si `python` no existe).

2. **Carpeta de datos.** Exporta siempre `LEADS_DIR="$PWD/leads-datos"` (raíz del repo) antes de cada
   comando, por ejemplo:
   `LEADS_DIR="$PWD/leads-datos" python plugins/leads/leads.py buscar`.
   Ahí quedan `config.yaml`, `plantillas/`, `leads.db` y `leads.xlsx`. Cuando el manual hable de
   `~/leads/…`, es `leads-datos/…`.

3. **Persistencia (importante en Claude Code web).** Esta sesión corre en una máquina temporal: lo que
   no se guarde en git se pierde al cerrar. Por eso, **al final de cada tarea que cambie datos**
   (configurar, buscar, marcar enviados, registrar respuestas, editar plantillas, Excel) ejecuta:
   ```
   git add leads-datos && git commit -m "leads: actualizar datos" && git push
   ```
   en la rama en la que estés trabajando. Nunca añadas `leads-datos/.env` (está en `.gitignore`).
   Si el usuario está en Claude Code local no hace daño; si está en la web es lo que salva sus datos.

Todo lo demás —entrevista inicial, confirmación antes de enviar, conector de Gmail, plantillas,
lenguaje sin jerga— es idéntico al archivo del plugin.
