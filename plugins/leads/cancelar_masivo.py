"""Cancela en Zoho los correos programados de una lista y los marca como descartados en la base.

  python cancelar_masivo.py lista.json [--parte K --de N]
lista.json = [{ id, email, nombre, motivo }]
"""
import argparse
import json
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
from motor import store       # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("lista"); ap.add_argument("--parte", type=int, default=0); ap.add_argument("--de", type=int, default=1)
a = ap.parse_args()
lista = [x for i, x in enumerate(json.load(open(a.lista, encoding="utf-8"))) if i % a.de == a.parte]
con = store.conectar(); con.execute("PRAGMA busy_timeout=60000")
trabajos = [{"id": x["id"], "buscar": x["email"], "asunto": f"Apoyo legal para {x['nombre'].strip()}"} for x in lista]
motivos = {str(x["id"]): x["motivo"] for x in lista}
with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
    json.dump(trabajos, fh, ensure_ascii=False)
ok = 0
proc = subprocess.Popen(["node", str(AQUI / "zoho-web" / "cancelar.js"), fh.name], stdout=subprocess.PIPE, text=True,
                        cwd=AQUI / "zoho-web")
for linea in proc.stdout:
    linea = linea.strip(); partes = linea.split(" ", 2)
    print(linea, flush=True)
    if partes[0] in ("OK", "NO_ESTA") and len(partes) > 1 and partes[1] in motivos:
        con.execute("UPDATE leads SET estado='descartado', message_id=NULL, enviado_el=NULL, respuesta=? WHERE id=?",
                    (f"Descartado: {motivos[partes[1]]}" + (" (no estaba en Zoho)" if partes[0] == "NO_ESTA" else ""),
                     int(partes[1])))
        con.commit(); ok += 1
    if partes[0] == "SIN_SESION":
        sys.exit(3)
proc.wait(); Path(fh.name).unlink(missing_ok=True)
print(f"CANCELACION_TERMINADA ok={ok} de {len(trabajos)}", flush=True)
