"""
Guardarraíl determinista de AFyV Legal.

Regla de oro: la IA puede hablar de la MARCA, los SERVICIOS, los PRECIOS, el PROCESO,
el EQUIPO y de CÓMO ELEGIR un estudio. La IA NO puede afirmar contenido jurídico
sustantivo (normas, plazos legales, derechos, obligaciones, jurisprudencia, riesgos
legales concretos) ni prometer resultados.

Este módulo es la primera línea de defensa (reglas fijas, sin IA). Después hay una
segunda revisión con un modelo "juez" (ver generar_contenido.py).
"""
import json
import re
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent

# --- Patrones que delatan contenido jurídico sustantivo ---------------------------
PATRONES_JURIDICOS = [
    (r"\bart(?:[íi]culo|\.)s?\s*\d", "cita un artículo"),
    (r"\bley\s*(?:n[°ºo.]*\s*)?\d", "cita una ley por número"),
    (r"\b(?:d\.?l\.?|d\.?f\.?l\.?|d\.?s\.?)\s*(?:n[°º.]*\s*)?\d", "cita un decreto/DFL/DL"),
    (r"\bc[óo]digo\s+(?:civil|del\s+trabajo|de\s+comercio|penal|procesal|tributario)", "cita un código"),
    (r"\brol\s*(?:n[°º.]*\s*)?\d", "cita un rol/causa"),
    (r"\bfallo\b|\bsentencia\b|\bcorte\s+(?:suprema|de\s+apelaciones)\b", "menciona fallos o cortes"),
    (r"\bseg[úu]n\s+la\s+ley\b|\bla\s+ley\s+(?:establece|dice|exige|obliga|permite|proh[íi]be|dispone)\b",
     "afirma qué dice la ley"),
    (r"\bes\s+obligatorio\b|\bestás?\s+obligad[oa]\b|\bpor\s+ley\s+(?:debes|tienes|est[áa]s)\b", "afirma una obligación legal"),
    (r"\bes\s+ilegal\b|\bes\s+legal\b|\bes\s+nul[oa]\b|\bnulidad\b", "califica legalidad"),
    (r"\btienes\s+derecho\b|\bpuedes\s+demandar\b|\bpuedes\s+reclamar\b|\bpuedes\s+exigir\b", "afirma derechos o acciones"),
    (r"\bprescrib|\bcaduc|\bmultas?\b|\bsanci[óo]n|\bdelito|\binconstitucional", "habla de consecuencias legales"),
    (r"\b\d+\s*(?:d[íi]as|meses|años)\b", "menciona un plazo numérico"),
    (r"\bno\s+necesitas\s+(?:un\s+)?abogado\b", "desincentiva asesoría profesional"),
]

# --- Promesas, superlativos y comparaciones (ética publicitaria) -------------------
PATRONES_PUBLICITARIOS = [
    (r"garantiz|aseguramos|aseguramos\s+el|éxito\s+asegurado|sin\s+riesgo|siempre\s+ganas|ganamos\s+tu", "promesa de resultado"),
    (r"\b100\s?%", "porcentaje absoluto"),
    (r"\bel\s+mejor\b|\blos\s+mejores\b|\bl[íi]deres?\b|\bn[úu]mero\s+(?:uno|1)\b|\b#1\b", "superlativo"),
    (r"a\s+diferencia\s+de\s+otros|mejor\s+que\s+(?:otros|la\s+competencia)", "comparación con terceros"),
]

RE_PRECIO = re.compile(r"\$\s?\d[\d.]*")


def precios_permitidos() -> set:
    """Todos los montos que aparecen en fuente_de_verdad.json (únicos precios que se pueden mencionar)."""
    fuente = json.loads((RAIZ / "fuente_de_verdad.json").read_text(encoding="utf-8"))
    montos = set()
    for srv in fuente["servicios"].values():
        for _, precio in srv["items"]:
            for m in RE_PRECIO.findall(precio):
                montos.add(m.replace(" ", ""))
    return montos


def revisar_texto(texto: str) -> list:
    """Devuelve la lista de violaciones encontradas en un texto (vacía = aprobado)."""
    problemas = []
    bajo = texto.lower()
    for patron, motivo in PATRONES_JURIDICOS + PATRONES_PUBLICITARIOS:
        m = re.search(patron, bajo, flags=re.IGNORECASE)
        if m:
            problemas.append(f"{motivo}: «{m.group(0)}»")
    permitidos = precios_permitidos()
    for m in RE_PRECIO.findall(texto):
        if m.replace(" ", "") not in permitidos:
            problemas.append(f"precio no autorizado: «{m}»")
    return problemas


def _limpio(t: str) -> str:
    return (t or "").replace("*", "")      # *énfasis* del diseño no cuenta como texto


def revisar_post(post: dict, hoy=None) -> list:
    """Revisa todos los textos de un post. Modo 'juridico' = solo lo respaldado por fichas verificadas."""
    if post.get("modo") == "juridico":
        return revisar_post_juridico(post, hoy)
    textos = [post.get("ig", ""), post.get("li", "")]
    for s in post.get("slides", []):
        textos.append(s.get("t", ""))
        textos.append(s.get("x", ""))
    problemas = []
    for t in textos:
        problemas += revisar_texto(_limpio(t))
    return problemas


# ───────────────────────── MODO JURÍDICO ─────────────────────────
import os  # noqa: E402
from datetime import date  # noqa: E402

NUM = {"un": 1, "una": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6, "siete": 7, "ocho": 8, "nueve": 9,
       "diez": 10, "quince": 15, "veinte": 20, "treinta": 30, "cuarenta": 40, "sesenta": 60, "noventa": 90}
RE_CANT = re.compile(r"\b(\d+|" + "|".join(NUM) + r")\s*(%|(?:utm|unidades tributarias mensuales|d[ií]as|meses|a[ñn]os)\b)",
                     re.IGNORECASE)
_ART = r"\d+(?:\s*bis(?:\s+[A-Z]\b)?)?"
RE_ART = re.compile(r"\b(?:[Aa]rts?\.|[Aa]rt[íi]culos?)\s*(" + _ART + r"(?:\s*(?:,|y)\s*" + _ART + r")*)")
RE_LEY = re.compile(r"\b[Ll]ey\s*(?:N[°º.]*\s*)?(\d{1,2}\.\d{3})")
EXTRA_JUR = [
    (r"\bdebes\b|\btienes que\b|\bte conviene\b|\brecomendamos que\b", "consejo individual (debe ser información general)"),
    (r"jurisprudencia|\blos tribunales (?:han|suelen)\b|\bla corte (?:suprema|de apelaciones)\b", "jurisprudencia no incluida en la base verificada"),
]


def _na(a: str) -> str:
    return re.sub(r"\s+", "", a).lower()


def _cant(n: str, u: str) -> str:
    n = int(n) if n.isdigit() else NUM[n.lower()]
    u = u.lower()
    u = {"unidades tributarias mensuales": "UTM", "utm": "UTM", "dias": "días", "anos": "años"}.get(u, u)
    return f"{n}%" if u == "%" else f"{n} {u}"


def _fecha_hoy(hoy=None):
    if hoy:
        return hoy if isinstance(hoy, date) else date.fromisoformat(hoy)
    return date.fromisoformat(os.environ["AFYV_HOY"]) if os.environ.get("AFYV_HOY") else date.today()


def revisar_post_juridico(post: dict, hoy=None) -> list:
    base = json.loads((RAIZ / "base_juridica.json").read_text(encoding="utf-8"))
    fichas = {f["id"]: f for f in base["fichas"]}
    max_dias = base["_meta"].get("dias_maximos_sin_reverificar", 45)
    hoy = _fecha_hoy(hoy)
    problemas, usadas = [], []
    ids = post.get("fichas") or []
    if not ids:
        problemas.append("publicación jurídica sin fichas de respaldo")
    for i in ids:
        f = fichas.get(i)
        if not f:
            problemas.append(f"ficha inexistente: {i}")
            continue
        if f.get("estado") != "verificada":
            problemas.append(f"ficha no verificada: {i}")
            continue
        try:
            dias = (hoy - date.fromisoformat(f["fecha_verificacion"])).days
        except Exception:
            dias = 10**6
        if dias > max_dias:
            problemas.append(f"ficha {i} vencida: {dias} días sin reverificar vigencia (máx. {max_dias})")
        usadas.append(f)
    arts = {_na(f["articulo"]) for f in usadas}
    leyes = {"19.039"} | {n for f in usadas for n in f.get("normas_mencionadas", [])} | {f["norma_numero"] for f in usadas if f.get("norma_numero")}
    datos = {d for f in usadas for d in f.get("datos", [])}

    textos = [post.get("ig", ""), post.get("li", ""), post.get("cta_texto") or ""]
    sl = post.get("slides", [])
    for k, s in enumerate(sl):
        textos += [s.get("t", ""), s.get("x", ""), s.get("ref", ""), s.get("nota", "")]
        if k >= 1 and not s.get("ref"):
            problemas.append(f"diapositiva {k + 1} sin referencia a la norma")
    if not post.get("aviso"):
        problemas.append("falta aviso de información general")

    for t in map(_limpio, textos):
        for patron, motivo in PATRONES_PUBLICITARIOS + EXTRA_JUR:
            m = re.search(patron, t.lower(), flags=re.IGNORECASE)
            if m:
                problemas.append(f"{motivo}: «{m.group(0)}»")
        for bloque in RE_ART.findall(t):
            for a in re.findall(_ART, bloque):
                if _na(a) not in arts:
                    problemas.append(f"cita artículo {a.strip()} que no está en las fichas usadas")
        for n in RE_LEY.findall(t):
            if n not in leyes:
                problemas.append(f"cita Ley {n} que no está en las fichas usadas")
        for n, u in RE_CANT.findall(t):
            c = _cant(n, u)
            if c not in datos:
                problemas.append(f"cifra o plazo «{c}» que no consta en las fichas usadas")
        for m in RE_PRECIO.findall(t):
            if m.replace(" ", "") not in precios_permitidos():
                problemas.append(f"precio no autorizado: «{m}»")
    # sin duplicados, en orden
    return list(dict.fromkeys(problemas))


if __name__ == "__main__":
    import sys
    ruta = Path(sys.argv[1]) if len(sys.argv) > 1 else RAIZ / "salida" / "contenido.json"
    posts = json.loads(ruta.read_text(encoding="utf-8"))
    malos = 0
    for p in posts:
        pr = revisar_post(p)
        if pr:
            malos += 1
            print(f"✗ {p['id']} · {p['tema']}")
            for x in pr:
                print("    -", x)
    print(f"\n{len(posts) - malos}/{len(posts)} publicaciones aprobadas por el guardarraíl.")
    sys.exit(1 if malos else 0)
