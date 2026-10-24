"""Configuración guiada: preguntas sencillas → config.yaml. Sin tocar archivos a mano."""
import yaml

from .config import RAIZ

RUTA = RAIZ / "config.yaml"
EJEMPLOS = {"", "mi empresa", "juan pérez", "tu empresa"}

_CABECERA = """\
# Configuración del motor de leads.
# Puedes cambiarla en cualquier momento pidiéndoselo a Claude ("cambia el servicio a…",
# "agrega la búsqueda de gimnasios en Temuco"). Carpeta de datos: la que contiene este archivo.
"""


def esta_configurado(cfg: dict) -> bool:
    neg = cfg.get("negocio") or {}
    return bool(neg.get("nombre", "").strip().lower() not in EJEMPLOS
                and neg.get("servicio", "").strip() and cfg.get("busquedas"))


def guardar(cfg: dict) -> None:
    RUTA.write_text(_CABECERA + yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False, width=100),
                    encoding="utf-8")


def _pregunta(texto: str, actual: str = "") -> str:
    sufijo = f" [{actual}]" if actual else ""
    r = input(f"{texto}{sufijo}: ").strip()
    return r or actual


def interactivo(cfg: dict) -> dict:
    neg = cfg.setdefault("negocio", {})
    print("\nCuéntame de tu negocio (Enter mantiene lo que hay entre corchetes).\n")
    neg["nombre"] = _pregunta("Nombre de tu empresa", neg.get("nombre", ""))
    neg["remitente"] = _pregunta("Tu nombre (quien firma el correo)", neg.get("remitente", ""))
    neg["servicio"] = _pregunta("Qué servicio ofreces (en una frase)", neg.get("servicio", ""))
    neg["telefono"] = _pregunta("Teléfono de contacto", neg.get("telefono", ""))
    neg["web"] = _pregunta("Sitio web (o Enter si no tienes)", neg.get("web", ""))

    print("\n¿Qué tipo de negocios quieres contactar y en qué ciudad?")
    print("Ejemplo: clínica dental → Santiago, Chile. Deja vacío el rubro para terminar.\n")
    busquedas = []
    while True:
        rubro = _pregunta("Tipo de negocio")
        if not rubro:
            break
        ciudad = _pregunta("Ciudad", busquedas[-1]["ciudad"] if busquedas else "")
        busquedas.append({"rubro": rubro, "ciudad": ciudad})
    if busquedas:
        cfg["busquedas"] = busquedas
    return cfg


def desde_argumentos(cfg: dict, a) -> dict:
    """Para que Claude configure sin preguntas: --negocio … --buscar "rubro|ciudad" …"""
    neg = cfg.setdefault("negocio", {})
    for campo, valor in (("nombre", a.negocio), ("remitente", a.remitente), ("servicio", a.servicio),
                         ("telefono", a.telefono), ("web", a.web)):
        if valor is not None:
            neg[campo] = valor
    if a.buscar:
        nuevas = []
        for item in a.buscar:
            rubro, _, ciudad = item.partition("|")
            if not ciudad:
                raise SystemExit(f'--buscar debe ser "rubro|ciudad", recibido: {item}')
            nuevas.append({"rubro": rubro.strip(), "ciudad": ciudad.strip()})
        cfg["busquedas"] = nuevas if not a.agregar else (cfg.get("busquedas") or []) + nuevas
    if a.plantilla:
        cfg.setdefault("correo", {})["plantilla"] = a.plantilla
    if a.modo:
        cfg.setdefault("correo", {})["modo"] = a.modo
    return cfg


def resumen(cfg: dict) -> str:
    neg = cfg.get("negocio", {})
    lineas = [f"Empresa: {neg.get('nombre') or '—'} · Firma: {neg.get('remitente') or '—'}",
              f"Servicio: {neg.get('servicio') or '—'}",
              "Búsquedas:"] + [f"  • {b['rubro']} en {b['ciudad']}" for b in cfg.get("busquedas") or []]
    lineas.append(f"Mensaje: {cfg.get('correo', {}).get('plantilla')} · Correo: {cfg.get('correo', {}).get('modo')}")
    return "\n".join(lineas)
