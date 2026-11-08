"""Envía ya los programados de la Bandeja de salida (uno cada N s) y registra la hora real en la base.
  python enviar_ahora.py excluir.json [segundos]"""
import subprocess, sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
from motor import store  # noqa: E402
con = store.conectar(); con.execute("PRAGMA busy_timeout=60000")
seg = sys.argv[2] if len(sys.argv) > 2 else "15"
proc = subprocess.Popen(["node", str(AQUI / "zoho-web" / "enviar_ahora.js"), sys.argv[1], seg], stdout=subprocess.PIPE,
                        text=True, cwd=AQUI / "zoho-web")
for linea in proc.stdout:
    linea = linea.strip(); print(linea, flush=True)
    if linea.startswith("OK "):
        email = linea.split(" ", 1)[1].strip().lower()
        ahora = datetime.now(ZoneInfo("America/Santiago")).strftime("%Y-%m-%d %H:%M")
        con.execute("UPDATE leads SET enviado_el=?, estado=CASE WHEN estado='nuevo' THEN 'enviado' ELSE estado END "
                    "WHERE lower(trim(email))=? AND message_id LIKE '<zoho-prog-%'", (ahora, email))
        con.commit()
proc.wait()
