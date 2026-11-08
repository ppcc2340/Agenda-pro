"""Cancela en Zoho (desde la lista de la Bandeja de salida) y marca 'descartado' en la base.
  python cancelar_desde_lista.py lista.json motivos.json"""
import json, subprocess, sys
from pathlib import Path
AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
from motor import store  # noqa: E402
lista, motivos = sys.argv[1], {str(x["id"]): x["motivo"] for x in json.load(open(sys.argv[2], encoding="utf-8"))}
con = store.conectar(); con.execute("PRAGMA busy_timeout=60000")
proc = subprocess.Popen(["node", str(AQUI / "zoho-web" / "cancelar_lista.js"), lista], stdout=subprocess.PIPE, text=True, cwd=AQUI / "zoho-web")
ok = 0
for linea in proc.stdout:
    linea = linea.strip(); print(linea, flush=True); partes = linea.split(" ", 2)
    if partes[0] == "OK" and len(partes) > 1:   # NO_ESTA = ya enviado o ya cancelado: se concilia después
        con.execute("UPDATE leads SET estado='descartado', message_id=NULL, enviado_el=NULL, respuesta=? WHERE id=?",
                    (f"Descartado: {motivos.get(partes[1], '')}", int(partes[1])))
        con.commit(); ok += 1
proc.wait(); print(f"CANCELACION_TERMINADA ok={ok}", flush=True)
