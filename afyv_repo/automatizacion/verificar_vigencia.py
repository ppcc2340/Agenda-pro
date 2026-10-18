"""
Verifica la VIGENCIA de las fichas jurídicas contra el texto oficial de LeyChile (BCN).

Qué hace:
  1. Descarga el XML de la norma desde LeyChile (o lee uno local con --archivo, útil sin red y en tests).
  2. Extrae el texto y lo guarda en fuentes/<idNorma>_bcn.txt (caché auditable).
  3. Corre verificar_citas.verificar(): cada cita literal debe seguir existiendo palabra por palabra.
     - Todas existen  -> la ficha queda 'verificada' con la fecha de hoy.
     - Alguna falta   -> 'rechazada': el artículo cambió o se derogó. Ninguna pieza puede usarla.
  4. Lee la fecha de versión que informa la BCN y la compara con la última registrada en
     base_juridica.json -> _meta.version_bcn. Si cambió, AVISA aunque las citas sigan coincidiendo
     (una ley modificada puede mantener un artículo y cambiar otro que afecta el contexto).

Salida (código de retorno):  0 todo vigente · 1 hay fichas rechazadas · 2 no se pudo obtener el texto
                             3 la BCN informa una versión distinta a la registrada (revisar a mano)

Uso:
  python automatizacion/verificar_vigencia.py                      # norma 19.039 (idNorma de _meta)
  python automatizacion/verificar_vigencia.py --archivo ley.xml    # sin red
  python automatizacion/verificar_vigencia.py --estado             # solo informa cuánto falta para vencer

IMPORTANTE: la URL y la estructura del XML de LeyChile están escritas según la documentación pública
y NO se han probado contra el servicio real desde este entorno (sin red). La primera ejecución en
Claude Code con red debe revisarse a mano; ver tests/test_vigencia.py para el comportamiento esperado.
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import limites as L  # noqa: E402
import verificar_citas as V  # noqa: E402

URL_XML = "https://www.leychile.cl/Consulta/obtxml?opt=7&idNorma={id}"
RAIZ = V.RAIZ


def descargar(id_norma: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(URL_XML.format(id=id_norma), headers={"User-Agent": "AFyV-verificador/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 (URL fija, https)
        return r.read()


def texto_desde_xml(contenido: bytes) -> tuple:
    """(texto plano, metadatos). Independiente de namespaces: junta todo el texto de los nodos."""
    raiz = ET.fromstring(contenido)

    def local(tag):
        return tag.split("}")[-1]

    partes = []
    for nodo in raiz.iter():
        if nodo.text and nodo.text.strip():
            partes.append(nodo.text.strip())
    texto = "\n".join(partes)

    meta = {}
    for nodo in raiz.iter():
        for k, v in nodo.attrib.items():
            if local(k).lower() in ("fechaversion", "fecha_version", "fechapublicacion", "derogado", "normaid"):
                meta.setdefault(local(k).lower(), v)
    if re.search(r"\bderogad[oa]\b", texto[:3000], re.I):
        meta["aviso_derogada"] = "El encabezado del texto menciona «derogado/a»: revisar a mano."
    return texto, meta


def leer_base() -> dict:
    return json.loads(V.BASE.read_text(encoding="utf-8"))


def estado_fichas(hoy: date = None) -> dict:
    """Días restantes antes de que cada ficha venza (para `afyv estado`)."""
    hoy = hoy or date.today()
    base = leer_base()
    maximo = base["_meta"].get("dias_maximos_sin_reverificar", 45)
    filas = []
    for f in base["fichas"]:
        try:
            dias = (hoy - date.fromisoformat(f["fecha_verificacion"])).days
        except Exception:
            dias = 10**6
        filas.append({"id": f["id"], "ref": f["ref"], "estado": f.get("estado"), "dias_desde": dias,
                      "quedan": maximo - dias})
    return {"maximo": maximo, "fichas": filas}


def imprimir_estado(hoy: date = None) -> int:
    e = estado_fichas(hoy)
    vencidas = [f for f in e["fichas"] if f["quedan"] < 0]
    por_vencer = [f for f in e["fichas"] if 0 <= f["quedan"] <= L.DIAS_AVISO_PREVIO]
    malas = [f for f in e["fichas"] if f["estado"] != "verificada"]
    print(f"Fichas: {len(e['fichas'])} · plazo máximo sin reverificar: {e['maximo']} días")
    if malas:
        print("✗ No verificadas:", ", ".join(f["id"] for f in malas))
    if vencidas:
        print("✗ VENCIDAS (el guardarraíl las rechaza):", ", ".join(f"{f['id']} ({-f['quedan']} d)" for f in vencidas))
    if por_vencer:
        print(f"⚠ Vencen en ≤{L.DIAS_AVISO_PREVIO} días:", ", ".join(f"{f['id']} ({f['quedan']} d)" for f in por_vencer))
    if not (malas or vencidas or por_vencer):
        print(f"✓ Todas vigentes; la más antigua tiene {max(f['dias_desde'] for f in e['fichas'])} días.")
    return 1 if (malas or vencidas) else 0


def verificar_vigencia(archivo: str = None, hoy: str = None, descargar_fn=descargar) -> dict:
    """Devuelve {'codigo': int, 'mensajes': [...], 'resumen': {...}}. No imprime; lo hace main()."""
    base = leer_base()
    meta_base = base["_meta"]
    id_norma = meta_base["id_norma_bcn"]
    msgs = []
    try:
        contenido = Path(archivo).read_bytes() if archivo else descargar_fn(id_norma)
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return {"codigo": 2, "mensajes": [f"No se pudo obtener el texto de la BCN: {e}. "
                                          "Descarga el PDF de leychile.cl y usa verificar_citas.py a mano."], "resumen": {}}
    try:
        texto, meta_bcn = texto_desde_xml(contenido)
    except ET.ParseError as e:
        return {"codigo": 2, "mensajes": [f"La respuesta no es un XML válido ({e}). ¿Cambió el formato de la BCN?"], "resumen": {}}
    if len(texto) < 2000:
        return {"codigo": 2, "mensajes": [f"El texto obtenido es demasiado corto ({len(texto)} car.): no es una ley completa."], "resumen": {}}

    cache = RAIZ / "fuentes" / f"{id_norma}_bcn.txt"
    cache.parent.mkdir(exist_ok=True)
    cache.write_text(texto, encoding="utf-8")

    resumen = V.verificar(cache, hoy=hoy, norma_numero="19.039")
    for d in resumen["detalle"]:
        msgs.append(f"✗ Ficha {d['id']} ya no coincide con el texto oficial: {d['citas_no_encontradas']}")
    codigo = 1 if resumen["rechazadas"] else 0

    if meta_bcn.get("aviso_derogada"):
        msgs.append("⚠ " + meta_bcn["aviso_derogada"])
        codigo = codigo or 3

    base = leer_base()          # verificar() reescribió el archivo; leer de nuevo antes de anotar
    version_bcn = meta_bcn.get("fechaversion") or meta_bcn.get("fecha_version")
    previa = base["_meta"].get("version_bcn")
    if version_bcn:
        if previa and previa != version_bcn:
            msgs.append(f"⚠ La BCN informa la versión {version_bcn}; la última registrada era {previa}. "
                        "Hubo una actualización del texto: revisa qué cambió aunque las citas sigan coincidiendo.")
            codigo = codigo or 3
        base["_meta"]["version_bcn"] = version_bcn
    else:
        msgs.append("ℹ El XML no trae fecha de versión; no se puede detectar modificaciones por ese medio.")
    base["_meta"]["ultima_verificacion_vigencia"] = hoy or date.today().isoformat()
    V.BASE.write_text(json.dumps(base, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"codigo": codigo, "mensajes": msgs, "resumen": resumen}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archivo", help="XML local de LeyChile (evita la descarga)")
    ap.add_argument("--estado", action="store_true", help="solo informa fechas de vencimiento de las fichas")
    a = ap.parse_args()
    if a.estado:
        sys.exit(imprimir_estado())
    r = verificar_vigencia(a.archivo)
    res = r["resumen"]
    if res:
        print(f"Fichas verificadas: {res['verificadas']} · rechazadas: {res['rechazadas']}")
    for m in r["mensajes"]:
        print(m)
    if r["codigo"] == 0:
        print("✓ Texto oficial coincide con todas las citas. Fechas de verificación actualizadas.")
    sys.exit(r["codigo"])


if __name__ == "__main__":
    main()
