#!/usr/bin/env python3
"""Genera leads-skill.zip: una skill autocontenida (SKILL.md + motor) lista para adjuntar e instalar.

Estructura del zip:  leads/SKILL.md, leads/leads.py, leads/motor/, leads/plantillas.default/, ...
Se descomprime en ~/.claude/skills/  →  ~/.claude/skills/leads/SKILL.md
"""
import re
import zipfile
from pathlib import Path

AQUI = Path(__file__).resolve().parent
SALIDA = AQUI.parent.parent / "leads-skill.zip"
INCLUIR = ["leads.py", "requirements.txt", "config.default.yaml", ".env.example", "MANUAL.pdf",
           "LEEME-PRIMERO.txt", "motor", "plantillas.default"]


def skill_autocontenida() -> str:
    s = (AQUI / "skills/leads/SKILL.md").read_text(encoding="utf-8")
    s = s.replace("${CLAUDE_PLUGIN_ROOT}", "${CLAUDE_SKILL_DIR}")
    ini, fin = s.index("**Cómo ejecutar:**"), s.index("## 0. Primera vez")
    s = s[:ini] + '''**Cómo ejecutar:** el programa está junto a este archivo, en `${CLAUDE_SKILL_DIR}/leads.py`.
Cada comando se ejecuta como `python ${CLAUDE_SKILL_DIR}/leads.py <comando>` (si `python` no existe
prueba `python3`; en Windows `py`). Si ves la ruta literalmente como `${CLAUDE_SKILL_DIR}` (sin
sustituir), es la carpeta que contiene este `SKILL.md` (normalmente `~/.claude/skills/leads`).
Los datos del usuario (configuración, mensajes, base, Excel) viven en **`~/leads`** y se crean solos.
Si faltan dependencias de Python, el programa las instala solo al arrancar; si el navegador de Maps
falla, sigue con las otras fuentes y avisa en una línea.

**En este archivo, `python leads.py …` es la forma corta de `python ${CLAUDE_SKILL_DIR}/leads.py …`.**

''' + s[fin:]
    return s


def main():
    SALIDA.unlink(missing_ok=True)
    with zipfile.ZipFile(SALIDA, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("leads/SKILL.md", skill_autocontenida())
        for nombre in INCLUIR:
            ruta = AQUI / nombre
            archivos = [ruta] if ruta.is_file() else sorted(p for p in ruta.rglob("*") if p.is_file())
            for f in archivos:
                if "__pycache__" in f.parts or f.suffix == ".pyc":
                    continue
                z.write(f, "leads/" + str(f.relative_to(AQUI)))
    print(f"{SALIDA} ({SALIDA.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
