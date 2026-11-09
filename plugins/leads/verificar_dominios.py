"""Comprueba que el dominio de cada correo pendiente reciba correo (registro MX o A), vía DNS sobre HTTPS.
Marca 'correo_invalido' los que no existen, para no generar rebotes. Uso: python verificar_dominios.py"""
import json, sqlite3, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from motor import store  # noqa: E402

def resolver(dominio):
    for tipo in ("MX", "A"):
        try:
            with urllib.request.urlopen(f"https://dns.google/resolve?name={dominio}&type={tipo}", timeout=15) as r:
                d = json.load(r)
            if d.get("Status") == 3:            # NXDOMAIN: el dominio no existe
                return dominio, False
            if any(a.get("type") in (15, 1) for a in d.get("Answer", [])):
                return dominio, True
        except Exception:
            return dominio, None                # sin respuesta: no se descarta
    return dominio, False

con = store.conectar(); con.execute("PRAGMA busy_timeout=60000")
filas = con.execute("SELECT id, email FROM leads WHERE email IS NOT NULL AND estado IN ('nuevo','enviado') "
                    "AND (enviado_el IS NULL OR enviado_el >= '2026-11-09')").fetchall()
dominios = sorted({f["email"].split("@")[-1].strip().lower() for f in filas})
with ThreadPoolExecutor(max_workers=12) as pool:
    estado = dict(pool.map(resolver, dominios))
malos = {d for d, ok in estado.items() if ok is False}
n = 0
for f in filas:
    if f["email"].split("@")[-1].strip().lower() in malos:
        con.execute("UPDATE leads SET respuesta='Dominio sin correo (no existe o no recibe correo)' WHERE id=?", (f["id"],)); n += 1
con.commit()
print(f"dominios revisados {len(dominios)} · sin correo {len(malos)} · sin respuesta {sum(1 for v in estado.values() if v is None)} · leads afectados {n}")
json.dump(sorted(malos), open(Path(store.DB).parent / "dominios_sin_correo.json", "w"))
