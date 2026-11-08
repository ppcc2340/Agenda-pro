"""Programa una campaña grande en Zoho Mail (envío programado, sale desde los servidores de Zoho).

  python programar_masivo.py --lote 120            # programa los próximos 120 correos de la campaña

Reparte los envíos en horarios fijos (hora de Chile) sin repetir correo ni horario. Cada correo
programado queda en la base con estado "enviado", la fecha/hora programada en `enviado_el` y
`message_id` = <zoho-prog-SLOT-ID@…>. Reanudable: al relanzarlo sigue con los huecos libres.
"""
import argparse
import json
import re
import sqlite3
import subprocess
import sys
import tempfile
import zlib
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
from motor import config, plantillas, store       # noqa: E402

CHILE = ZoneInfo("America/Santiago")
RE_MAIL = re.compile(r"^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$")
RE_SLOT = re.compile(r"<zoho-prog-(\d+)-")


def horarios(dias, desde, hasta, por_dia):
    """Lista de (fecha, hora, minuto) en orden; índice = slot."""
    h0, m0 = map(int, desde.split(":")); h1, m1 = map(int, hasta.split(":"))
    ventana = (h1 * 60 + m1) - (h0 * 60 + m0)
    salida = []
    for d in dias:
        for i in range(por_dia):
            minutos = h0 * 60 + m0 + (i * ventana) // por_dia
            salida.append((d, minutos // 60, minutos % 60))
    return salida


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lote", type=int, default=120)
    ap.add_argument("--total", type=int, default=1500)
    ap.add_argument("--dias", default="2026-11-09,2026-11-10,2026-11-11")
    ap.add_argument("--desde", default="08:00")
    ap.add_argument("--hasta", default="18:00")
    ap.add_argument("--parte", type=int, default=0, help="para correr varios a la vez: esta parte…")
    ap.add_argument("--de", type=int, default=1, help="…de este total (reparte horarios y leads)")
    a = ap.parse_args()
    dias = a.dias.split(",")
    por_dia = -(-a.total // len(dias))
    plan = horarios(dias, a.desde, a.hasta, por_dia)[:a.total]

    cfg = config.cargar()
    con = store.conectar()
    con.execute("PRAGMA journal_mode=WAL"); con.execute("PRAGMA busy_timeout=60000")

    usados = set()
    for (mid,) in con.execute("SELECT message_id FROM leads WHERE message_id LIKE '<zoho-prog-%'"):
        m = RE_SLOT.match(mid)
        if m:
            usados.add(int(m.group(1)))
    limite = datetime.now(CHILE).replace(tzinfo=None) + timedelta(minutes=20)
    libres = [s for s in range(len(plan)) if s % a.de == a.parte and s not in usados
              and datetime.strptime(f"{plan[s][0]} {plan[s][1]:02d}:{plan[s][2]:02d}", "%Y-%m-%d %H:%M") > limite]
    print(f"Programados: {len(usados)} de {a.total} · horarios libres: {len(libres)}", flush=True)
    if not libres:
        print("CAMPAÑA_COMPLETA", flush=True)
        return

    ya = {r[0] for r in con.execute(
        "SELECT lower(email) FROM leads WHERE email IS NOT NULL AND (message_id IS NOT NULL "
        "OR estado IN ('enviado','respondio','baja','rebote','revisar'))")}
    lote = []
    for l in store.listar(con, "nuevo"):
        e = (l["email"] or "").strip().lower()
        if zlib.crc32(e.encode()) % a.de != a.parte:   # mismo correo → siempre la misma parte
            continue
        if not RE_MAIL.match(e) or e in ya:
            store.actualizar(con, l["id"], estado="duplicado" if e in ya else "correo_invalido")
            continue
        ya.add(e)
        lote.append(l)
        if len(lote) >= min(a.lote, len(libres)):
            break
    if not lote:
        print("SIN_CANDIDATOS (no hay leads nuevos con correo; falta búsqueda)", flush=True)
        return

    trabajos, por_id = [], {}
    for l, s in zip(lote, libres):
        nombre_pl = plantillas.elegir(l, cfg)
        asunto, cuerpo = plantillas.renderizar(nombre_pl, l, cfg)
        f, h, m = plan[s]
        trabajos.append({"id": l["id"], "para": l["email"].strip(), "asunto": asunto, "cuerpo": cuerpo,
                         "fecha": f, "hora": f"{h:02d}", "minuto": f"{m:02d}"})
        por_id[str(l["id"])] = (s, f"{f} {h:02d}:{m:02d}", nombre_pl, l["nombre"])
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
        json.dump(trabajos, fh, ensure_ascii=False)

    ok = fallos = seguidos = 0
    proc = subprocess.Popen(["node", str(AQUI / "zoho-web" / "programar.js"), fh.name],
                            stdout=subprocess.PIPE, text=True, cwd=AQUI / "zoho-web")
    for linea in proc.stdout:
        linea = linea.strip()
        partes = linea.split(" ", 3)
        if partes[0] == "SIN_SESION":
            print("SIN_SESION", flush=True); proc.kill(); sys.exit(3)
        if partes[0] not in ("OK", "FALLO") or len(partes) < 2 or partes[1] not in por_id:
            if linea: print(linea, flush=True)
            continue
        s, cuando, pl, nombre = por_id[partes[1]]
        if partes[0] == "OK":
            store.actualizar(con, int(partes[1]), estado="enviado", enviado_el=cuando, plantilla=pl,
                             message_id=f"<zoho-prog-{s}-{partes[1]}@afyvlegal.com>")
            ok += 1; seguidos = 0
            print(f"✔ {cuando} {nombre}", flush=True)
        else:
            fallos += 1; seguidos += 1
            if "[confirmar]" in linea:   # pudo quedar programado: reservar horario y revisar a mano
                store.actualizar(con, int(partes[1]), estado="revisar", enviado_el=cuando,
                                 message_id=f"<zoho-prog-{s}-{partes[1]}-revisar>")
            print(f"✘ {linea}", flush=True)
            if seguidos >= 5:
                print("DEMASIADOS_FALLOS_SEGUIDOS: detengo el lote", flush=True)
                proc.kill(); break
    proc.wait()
    Path(fh.name).unlink(missing_ok=True)
    total = con.execute("SELECT COUNT(*) FROM leads WHERE message_id LIKE '<zoho-prog-%' AND estado!='revisar'").fetchone()[0]
    print(f"LOTE_TERMINADO ok={ok} fallos={fallos} programados_total={total}", flush=True)


if __name__ == "__main__":
    main()
