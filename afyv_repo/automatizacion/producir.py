"""
Produce SOLO lo que se pide: una o varias publicaciones descritas en un JSON (pedido).
No genera calendarios, no completa meses, no inventa publicaciones extra.

Uso:  python automatizacion/producir.py pedido.json [--formatos 4x5,1x1,9x16,191x1] [--reel] [--solo-validar]
  - Por defecto entrega 4x5 (+ PDF de LinkedIn si es carrusel). Las demás proporciones y el reel solo si se piden.
  - Si el guardarraíl rechaza algo, NO se genera ninguna imagen: se informa el motivo.
Salida: salida/pedidos/<ID>/  (imágenes por formato, linkedin.pdf, reel.mp4, textos.md)
"""
import argparse
import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import guardarrail as G  # noqa: E402
import limites as L  # noqa: E402
import linter_estilo as E  # noqa: E402
import render_v2 as R  # noqa: E402

RAIZ = G.RAIZ
SAL = RAIZ / "salida" / "pedidos"
HIST = RAIZ / "salida" / "historial_pedidos.json"
AVISO_GEN = "Información general sobre nuestros servicios; no constituye asesoría legal."
AVISO_JUR = "(Información general con fines informativos. No constituye asesoría legal y cada situación debe evaluarse particularmente)"
H_IG, H_LI = "#pymes #emprendedores #chile #emprendimientochile #abogados #santiago", "#Pymes #Emprendedores #Chile"


def alt_text(p):
    n = len(p["slides"]) + (1 if p["formato"] == "Carrusel" else 0)
    partes = [f"Carrusel de {n} láminas de AFyV Legal." if p["formato"] == "Carrusel" else "Imagen de AFyV Legal."]
    for i, s in enumerate(p["slides"], 1):
        partes.append(f"Lámina {i}: {s['t'].replace('*', '')}. {s['x']}" + (f" Fuente: {s['ref']}." if s.get("ref") else ""))
    return " ".join(partes)[:1500]


def estructura(p):
    err = []
    sl = p.get("slides") or []
    if not 1 <= len(sl) <= L.MAX_SLIDES:
        err.append(f"debe tener entre 1 y {L.MAX_SLIDES} diapositivas")
    for k, s in enumerate(sl, 1):
        if not s.get("t") or len(s["t"].replace("*", "")) > L.TITULO_MAX:
            err.append(f"diapositiva {k}: título vacío o de más de {L.TITULO_MAX} caracteres")
        if len(s.get("x", "")) > L.TEXTO_MAX:
            err.append(f"diapositiva {k}: texto de más de {L.TEXTO_MAX} caracteres")
    if p.get("formato") == "Imagen" and len(sl) != 1:
        err.append("una Imagen debe tener exactamente 1 diapositiva")
    if not 150 <= len(p.get("ig", "")) <= L.IG_MAX_DURO:
        err.append(f"el caption de Instagram debe tener entre 150 y {L.IG_MAX_DURO} caracteres")
    if not L.LI_MIN <= len(p.get("li", "")) <= L.LI_MAX:
        err.append(f"el post de LinkedIn debe tener entre {L.LI_MIN} y {L.LI_MAX} caracteres")
    return err


def completar(p, hist):
    p.setdefault("id", f"PED-{len(hist) + 1:03d}")
    p.setdefault("fecha", date.today().isoformat())
    p.setdefault("formato", "Carrusel" if len(p.get("slides", [])) > 1 else "Imagen")
    p.setdefault("pilar", "Marcas" if p.get("modo") == "juridico" else "Marca")
    p.setdefault("hashtags_ig", H_IG)
    p.setdefault("hashtags_li", H_LI)
    if p.get("modo") == "juridico":
        p.setdefault("aviso", AVISO_JUR)
    return p


def textos_md(p, archivos):
    aviso = p.get("aviso", AVISO_GEN)
    o = [f"# {p['id']} · {p['tema']}", f"Pilar: {p['pilar']} · Fecha sugerida: {p['fecha']} · Tipo: "
         + ("jurídica (respaldada)" if p.get("modo") == "juridico" else "general"), "",
         "## Instagram / Reel (caption)", "", f"{p['ig']}\n\n{aviso}\n\n{p['hashtags_ig']}", "",
         "## LinkedIn", "", f"{p['li']}\n\n{aviso}\n\n{p['hashtags_li']}", "",
         "## Texto alternativo (accesibilidad)", "", alt_text(p), "", "## Archivos", ""]
    for k, v in archivos.items():
        o.append(f"- {k}: " + (", ".join(v) if isinstance(v, list) else v))
    if p.get("modo") == "juridico":
        base = json.loads((RAIZ / "base_juridica.json").read_text(encoding="utf-8"))
        fich = {f["id"]: f for f in base["fichas"]}
        o += ["", "## Verificación jurídica (para revisión del abogado)", "",
              f"Norma(s): {base['_meta']['norma']}. {base['_meta']['estado_vigencia']}", "",
              "| Lámina | Afirmación publicada | Referencia | Ficha | Cita literal verificada | Verificada |", "|---|---|---|---|---|---|"]
        for k, s in enumerate(p["slides"], 1):
            if not s.get("ref"):
                continue
            ids = [i for i in p["fichas"] if i in fich and (fich[i]["ref"] in s["ref"] or s["ref"].endswith("art. " + fich[i]["articulo"]))]
            for i in ids or [""]:
                f = fich.get(i, {})
                o.append(f"| {k} | {s['x']} | {s['ref']} | {i} | {' / '.join(f.get('citas', []))} | {f.get('fecha_verificacion', '')} |")
        sens = [f"{i}: {fich[i]['observacion']}" for i in p["fichas"] if i in fich and fich[i].get("observacion")]
        if sens:
            o += ["", "**Datos a contrastar antes de publicar:**"] + [f"- {x}" for x in sens]
    return "\n".join(o) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pedido")
    ap.add_argument("--formatos", default="4x5")
    ap.add_argument("--reel", action="store_true")
    ap.add_argument("--solo-validar", action="store_true")
    a = ap.parse_args()
    datos = json.loads(Path(a.pedido).read_text(encoding="utf-8"))
    posts = datos if isinstance(datos, list) else [datos]
    hist = json.loads(HIST.read_text(encoding="utf-8")) if HIST.exists() else []
    SAL.mkdir(parents=True, exist_ok=True)
    R.SALIDA = SAL
    formatos = [f for f in a.formatos.split(",") if f]
    malos = 0
    for p in posts:
        p = completar(p, hist)
        errores_estilo, avisos_estilo = E.revisar_post(p)
        problemas = estructura(p) + G.revisar_post(p) + errores_estilo
        if not problemas:       # el desborde se mide solo si lo anterior pasó (renderizar cuesta)
            problemas += [f"desborde: {x}" for x in R.medir(p, formatos, reel=a.reel)]
        if problemas:
            malos += 1
            print(f"✗ {p['id']} · {p['tema']}: NO se genera. Motivos:")
            for x in problemas:
                print("   -", x)
            continue
        for x in avisos_estilo:
            print("   aviso de estilo:", x)
        if a.solo_validar:
            print(f"✓ {p['id']} · {p['tema']}: aprobado por guardarraíl, estilo y maquetación (no se generaron imágenes)")
            continue
        archivos = R.renderizar(p, formatos, reel=a.reel)
        (SAL / p["id"] / "textos.md").write_text(textos_md(p, archivos), encoding="utf-8")
        (SAL / p["id"] / "post.json").write_text(json.dumps(p, ensure_ascii=False, indent=2), encoding="utf-8")
        hist.append({"id": p["id"], "tema": p["tema"], "fecha": p["fecha"], "modo": p.get("modo", "general"),
                     "fichas": p.get("fichas", []), "formatos": formatos + (["reel"] if a.reel else [])})
        HIST.write_text(json.dumps(hist, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✓ {p['id']} · {p['tema']} → salida/pedidos/{p['id']}/  ({', '.join(formatos + (['reel'] if a.reel else []))})")
    sys.exit(1 if malos else 0)


if __name__ == "__main__":
    main()
