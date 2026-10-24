"""Plantillas de correo: archivos de texto en plantillas/. Primera línea = Asunto."""
from pathlib import Path

from .config import RAIZ

CARPETA = RAIZ / "plantillas"
VARIABLES = ("nombre", "rubro", "ciudad", "remitente", "negocio", "servicio", "telefono", "web")


def listar() -> list[str]:
    return sorted(p.stem for p in CARPETA.glob("*.txt"))


def ruta(nombre: str) -> Path:
    return CARPETA / f"{nombre}.txt"


def cargar(nombre: str) -> tuple[str, str]:
    """Devuelve (asunto, cuerpo) crudos, con las {variables} sin sustituir."""
    archivo = ruta(nombre)
    if not archivo.exists():
        raise SystemExit(f"No existe la plantilla '{nombre}'. Disponibles: {', '.join(listar())}")
    texto = archivo.read_text(encoding="utf-8")
    primera, _, resto = texto.partition("\n")
    if not primera.lower().startswith("asunto:"):
        raise SystemExit(f"La plantilla '{nombre}' debe empezar con una línea 'Asunto: …'")
    return primera.split(":", 1)[1].strip(), resto.lstrip("\n")


def renderizar(nombre: str, lead, cfg: dict) -> tuple[str, str]:
    asunto, cuerpo = cargar(nombre)
    neg = cfg["negocio"]
    valores = {
        "nombre": lead["nombre"], "rubro": lead["rubro"] or "", "ciudad": lead["ciudad"] or "",
        "remitente": neg.get("remitente", ""), "negocio": neg.get("nombre", ""),
        "servicio": neg.get("servicio", ""), "telefono": neg.get("telefono", ""),
        "web": neg.get("web", ""),
    }
    try:
        return asunto.format(**valores), cuerpo.format(**valores)
    except KeyError as e:
        raise SystemExit(f"La plantilla '{nombre}' usa una variable desconocida: {{{e.args[0]}}}. "
                         f"Válidas: {', '.join('{'+v+'}' for v in VARIABLES)}")


def elegir(lead, cfg: dict, forzada: str | None = None) -> str:
    """Prioridad: --plantilla > plantilla de la búsqueda del lead > plantilla por defecto."""
    return forzada or lead["plantilla"] or cfg["correo"].get("plantilla") or (listar() or ["propuesta-breve"])[0]
