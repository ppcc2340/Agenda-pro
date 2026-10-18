"""
Agrega fichas nuevas a base_juridica.json SOLO si sus citas existen, palabra por palabra, en el texto de la ley que
el usuario entregó (PDF o TXT), y si cada cifra o plazo declarado aparece dentro de esas citas.
Claude redacta las fichas (fichas_nuevas.json); este programa decide si se aceptan.

Uso:  python automatizacion/agregar_fichas.py fichas_nuevas.json ley.pdf --norma "Ley 18.101" --numero 18.101 [--id-norma 29726]
fichas_nuevas.json = lista de {articulo, ref, tema, resumen, citas[], datos[], normas_mencionadas[]}
"""
import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from guardarrail import NUM  # noqa: E402
from verificar_citas import BASE, leer_fuente, normalizar  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fichas")
    ap.add_argument("fuente")
    ap.add_argument("--norma", required=True)
    ap.add_argument("--numero", required=True)
    ap.add_argument("--id-norma", default="")
    a = ap.parse_args()
    nuevas = json.loads(Path(a.fichas).read_text(encoding="utf-8"))
    texto = normalizar(leer_fuente(Path(a.fuente)))
    base = json.loads(BASE.read_text(encoding="utf-8"))
    hoy, sig, ok, mal = date.today().isoformat(), len(base["fichas"]) + 1, 0, 0
    for p in nuevas:
        citas = p.get("citas") or []
        faltan = [c for c in citas if normalizar(c) not in texto]
        unidas = " ".join(citas).lower()
        sin_dato = []
        for d in p.get("datos", []):
            m = re.match(r"(\d+)", d)
            n = int(m.group(1)) if m else None
            pal = next((k for k, v in NUM.items() if v == n), None)
            if not (m and (m.group(1) in unidas or (pal and re.search(r"\b" + pal + r"\b", unidas)))):
                sin_dato.append(d)
        if not citas or faltan or sin_dato:
            mal += 1
            print(f"✗ rechazada «{p.get('tema')}»:", "sin citas" if not citas else "", faltan, sin_dato)
            continue
        p.update(id=f"F{sig:02d}", norma=a.norma, norma_numero=a.numero, estado="verificada", fecha_verificacion=hoy,
                 normas_mencionadas=p.get("normas_mencionadas", []), datos=p.get("datos", []),
                 observacion=p.get("observacion", "") or "Verificada contra el texto aportado por el usuario; revisión del abogado pendiente.")
        base["fichas"].append(p)
        print(f"✓ {p['id']} · {p['ref']} · {p['tema']}")
        sig += 1
        ok += 1
    base["_meta"].setdefault("otras_normas", {})[a.numero] = {"norma": a.norma, "id_norma_bcn": a.id_norma,
                                                              "texto_aportado": Path(a.fuente).name, "fecha": hoy}
    BASE.write_text(json.dumps(base, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{ok} fichas agregadas · {mal} rechazadas. Entrega el base_juridica.json actualizado para reemplazarlo en el proyecto.")
    sys.exit(1 if mal and not ok else 0)


if __name__ == "__main__":
    main()
