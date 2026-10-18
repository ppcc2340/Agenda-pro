"""
Comprueba que CADA cita literal de base_juridica.json exista, palabra por palabra, en el texto fuente
(extracto oficial guardado en fuentes/ o un PDF/TXT que tú entregues).

Si todas las citas de una ficha existen -> la ficha queda 'verificada' con la fecha de hoy.
Si alguna no existe -> 'rechazada' y NINGUNA publicación puede usarla.

Uso:  python automatizacion/verificar_citas.py [ruta_fuente.txt|.pdf] [--norma=19.039]
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
BASE = RAIZ / "base_juridica.json"


def normalizar(t: str) -> str:
    t = t.replace("\u00ad", "")                      # guiones blandos
    t = re.sub(r"\s+", " ", t)                        # saltos de línea/espacios múltiples
    return t.strip()


def limpiar_encabezados(t: str) -> str:
    """Quita encabezados/pies de página de los PDF de LeyChile (BCN) que cortan los artículos entre páginas."""
    t = re.sub(r"^.*Biblioteca del Congreso Nacional de Chile.*p[áa]gina\s+\d+\s+de\s+\d+.*$", " ", t, flags=re.M | re.I)
    t = re.sub(r"^\s*[^\n]{3,70},\s*\(\d{4}\)\s*$", " ", t, flags=re.M)          # p. ej. "DFL 4, ECONOMÍA, (2022)"
    t = re.sub(r"^\s*https?://www\.leychile\.cl/?\s*$", " ", t, flags=re.M)
    return t


def leer_fuente(ruta: Path) -> str:
    return limpiar_encabezados(_leer_crudo(ruta))


def _leer_crudo(ruta: Path) -> str:
    if ruta.suffix.lower() == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError:
            sys.exit("Para leer PDF instala: pip install pypdf")
        return "\n".join((p.extract_text() or "") for p in PdfReader(str(ruta)).pages)
    return ruta.read_text(encoding="utf-8")


def verificar(ruta_fuente: Path, hoy: str = None, norma_numero: str = "19.039") -> dict:
    """Verifica SOLO las fichas de esa norma (las fichas sin 'norma_numero' son de la Ley 19.039)."""
    base = json.loads(BASE.read_text(encoding="utf-8"))
    texto = normalizar(leer_fuente(ruta_fuente))
    hoy = hoy or date.today().isoformat()
    resumen = {"verificadas": 0, "rechazadas": 0, "detalle": []}
    for f in base["fichas"]:
        if f.get("norma_numero", "19.039") != norma_numero:
            continue
        faltan = [c for c in f["citas"] if normalizar(c) not in texto]
        f["estado"] = "rechazada" if faltan else "verificada"
        f["fecha_verificacion"] = hoy if not faltan else f.get("fecha_verificacion", "")
        if faltan:
            resumen["rechazadas"] += 1
            resumen["detalle"].append({"id": f["id"], "citas_no_encontradas": faltan})
        else:
            resumen["verificadas"] += 1
    if resumen["rechazadas"] == 0 and norma_numero == "19.039":
        base["_meta"]["fecha_verificacion_texto"] = hoy
    BASE.write_text(json.dumps(base, ensure_ascii=False, indent=2), encoding="utf-8")
    return resumen


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    num = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--norma=")), "19.039")
    ruta = Path(args[0]) if args else RAIZ / "fuentes" / "extracto_ley19039_marcas.txt"
    r = verificar(ruta, norma_numero=num)
    print(f"Norma {num} · fichas verificadas: {r['verificadas']} · rechazadas: {r['rechazadas']}")
    for d in r["detalle"]:
        print("  ✗", d["id"], "ya no coincide con el texto entregado:", d["citas_no_encontradas"])
    sys.exit(1 if r["rechazadas"] else 0)
