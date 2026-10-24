"""Rutas y configuración.

  CODIGO = carpeta del plugin (este código, plantillas de fábrica, config por defecto). No se escribe.
  DATOS  = carpeta del usuario con su config.yaml, plantillas/, leads.db, leads.xlsx y .env.
           Por defecto ~/leads (o la variable LEADS_DIR). Se crea sola la primera vez.
"""
import os
import shutil
from pathlib import Path

import yaml
from dotenv import load_dotenv

CODIGO = Path(__file__).resolve().parent.parent
DATOS = Path(os.environ.get("LEADS_DIR") or Path.home() / "leads").expanduser()
RAIZ = DATOS  # alias usado por el resto de módulos


def preparar_datos() -> bool:
    """Crea ~/leads con config y plantillas de fábrica si no existen. True si era la primera vez."""
    primera = not (DATOS / "config.yaml").exists()
    DATOS.mkdir(parents=True, exist_ok=True)
    if primera:
        shutil.copy(CODIGO / "config.default.yaml", DATOS / "config.yaml")
    plantillas = DATOS / "plantillas"
    if not plantillas.exists():
        shutil.copytree(CODIGO / "plantillas.default", plantillas)
    if not (DATOS / ".env").exists() and (CODIGO / ".env.example").exists():
        shutil.copy(CODIGO / ".env.example", DATOS / ".env.example")
    return primera


preparar_datos()
load_dotenv(DATOS / ".env")


def cargar(ruta: Path | None = None) -> dict:
    ruta = ruta or DATOS / "config.yaml"
    with open(ruta, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    cfg.setdefault("negocio", {})
    cfg.setdefault("busquedas", [])
    cfg.setdefault("fuentes", ["google", "maps", "instagram"])
    cfg.setdefault("max_por_fuente", 20)
    cfg.setdefault("buscar_correo_en_web", True)
    cfg.setdefault("correo", {})
    cfg.setdefault("excel", {"archivo": "leads.xlsx"})
    return cfg


def env(nombre: str, defecto: str = "") -> str:
    return os.environ.get(nombre, defecto).strip()
