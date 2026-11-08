"""Mueve correos programados a otra hora: los borra de la Bandeja de salida y los vuelve a programar
con el mismo texto. Uso: python reprogramar.py plan.json [--parte K --de N]
plan.json = [{ id, email, nuevo: "AAAA-MM-DD HH:MM" }]"""
import argparse, json, subprocess, sys, tempfile
from pathlib import Path
AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
from motor import config, plantillas, store  # noqa: E402

ap = argparse.ArgumentParser(); ap.add_argument("plan"); ap.add_argument("--parte", type=int, default=0); ap.add_argument("--de", type=int, default=1)
a = ap.parse_args()
plan = [x for i, x in enumerate(json.load(open(a.plan, encoding="utf-8"))) if i % a.de == a.parte]
cfg = config.cargar(); con = store.conectar(); con.execute("PRAGMA busy_timeout=60000")

def correr(script, datos):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
        json.dump(datos, fh, ensure_ascii=False)
    p = subprocess.Popen(["node", str(AQUI / "zoho-web" / script), fh.name], stdout=subprocess.PIPE, text=True, cwd=AQUI / "zoho-web")
    for linea in p.stdout:
        yield linea.strip()
    p.wait(); Path(fh.name).unlink(missing_ok=True)

# 1) borrar de la bandeja de salida
borrados = set()
for l in correr("cancelar_lista.js", [{"id": x["id"], "email": x["email"]} for x in plan]):
    print("BORRAR", l, flush=True)
    if l.startswith("OK "): borrados.add(int(l.split()[1]))
# 2) volver a programar los borrados en su nueva hora
trabajos = []
for x in plan:
    if x["id"] not in borrados: continue
    lead = store.por_id(con, x["id"])
    asunto, cuerpo = plantillas.renderizar(plantillas.elegir(lead, cfg), lead, cfg)
    f, hm = x["nuevo"].split(" "); h, m = hm.split(":")
    trabajos.append({"id": x["id"], "para": lead["email"].strip(), "asunto": asunto, "cuerpo": cuerpo, "fecha": f, "hora": h, "minuto": m})
nuevo = {str(x["id"]): x["nuevo"] for x in plan}
ok = 0
for l in correr("programar.js", trabajos):
    print("PROGRAMAR", l, flush=True)
    partes = l.split(" ")
    if partes[0] == "OK" and len(partes) > 1:
        con.execute("UPDATE leads SET estado='enviado', enviado_el=?, respuesta=NULL WHERE id=?", (nuevo[partes[1]], int(partes[1])))
        con.commit(); ok += 1
    elif partes[0] == "FALLO" and len(partes) > 1:
        con.execute("UPDATE leads SET estado='revisar', respuesta=? WHERE id=?", (f"Reprogramación pendiente ({nuevo[partes[1]]}): {l[:150]}", int(partes[1])))
        con.commit()
print(f"REPROGRAMACION_TERMINADA borrados={len(borrados)} programados={ok} de {len(plan)}", flush=True)
