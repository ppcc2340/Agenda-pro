"""Instala lo que falte (dependencias de Python y el navegador) sin que el usuario haga nada."""
import importlib.util
import subprocess
import sys
from pathlib import Path

# Sin importar motor.config: este módulo debe funcionar aunque falte pyyaml o dotenv.
CODIGO = Path(__file__).resolve().parent.parent

_MODULOS = {"requests": "requests", "openpyxl": "openpyxl", "yaml": "pyyaml",
            "dotenv": "python-dotenv", "playwright": "playwright", "anthropic": "anthropic"}


def faltantes() -> list[str]:
    return [paq for mod, paq in _MODULOS.items() if importlib.util.find_spec(mod) is None]


def instalar(todo: bool = False) -> None:
    pendientes = faltantes()
    if pendientes or todo:
        print("Instalando componentes de Python…")
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", str(CODIGO / "requirements.txt")],
                       check=True)
    print("Comprobando el navegador para Google Maps…")
    r = subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print("  (no se pudo instalar el navegador; Google Maps funcionará solo con GOOGLE_API_KEY)")
    print("✔ Todo listo.")
