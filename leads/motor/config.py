import os
from pathlib import Path

import yaml
from dotenv import load_dotenv

RAIZ = Path(__file__).resolve().parent.parent
load_dotenv(RAIZ / ".env")


def cargar(ruta: Path | None = None) -> dict:
    ruta = ruta or RAIZ / "config.yaml"
    with open(ruta, encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    cfg.setdefault("fuentes", ["google", "maps", "instagram"])
    cfg.setdefault("max_por_fuente", 20)
    cfg.setdefault("buscar_correo_en_web", True)
    cfg.setdefault("correo", {})
    cfg.setdefault("excel", {"archivo": "leads.xlsx"})
    return cfg


def env(nombre: str, defecto: str = "") -> str:
    return os.environ.get(nombre, defecto).strip()
