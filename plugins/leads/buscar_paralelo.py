"""Búsqueda grande en paralelo y reanudable (Google Maps + correo desde la web de cada negocio).

  python buscar_paralelo.py --worker K --de N      # procesa las búsquedas K, K+N, K+2N… de config.yaml

Cada búsqueda terminada se anota en $LEADS_DIR/progreso/wK.txt; si el proceso se corta, al relanzarlo
sigue donde quedó. Varios workers escriben en la misma base (modo WAL).
"""
import argparse
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from motor import config, store                      # noqa: E402
from motor.fuentes import maps                       # noqa: E402
from motor.fuentes.correo_rapido import encontrar     # noqa: E402


def conectar():
    con = store.conectar()
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=60000")
    try:
        con.execute("ALTER TABLE leads ADD COLUMN correo_buscado INTEGER")
    except sqlite3.OperationalError:
        pass
    return con


def buscar_correo(id_, web):
    try:
        return id_, encontrar(web)
    except Exception:
        return id_, None


def drenar(con, futuros, esperar=False):
    """Guarda los correos ya encontrados; devuelve (pendientes, cuántos con correo)."""
    quedan, n = [], 0
    for f in futuros:
        if not (esperar or f.done()):
            quedan.append(f)
            continue
        id_, email = f.result()
        for _ in range(5):
            try:
                if email:
                    con.execute("UPDATE leads SET email=?, estado='nuevo', correo_buscado=1 "
                                "WHERE id=? AND estado='sin_correo'", (email, id_))
                    n += 1
                else:
                    con.execute("UPDATE leads SET correo_buscado=1 WHERE id=?", (id_,))
                con.commit()
                break
            except sqlite3.OperationalError:
                continue
    return quedan, n


def por_buscar(con, worker, de):
    return con.execute("SELECT id, web FROM leads WHERE estado='sin_correo' AND web IS NOT NULL "
                       "AND correo_buscado IS NULL AND id % ? = ?", (de, worker)).fetchall()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker", type=int, required=True)
    ap.add_argument("--de", type=int, required=True)
    a = ap.parse_args()
    cfg = config.cargar()
    mias = cfg["busquedas"][a.worker::a.de]
    carpeta = config.RAIZ / "progreso"
    carpeta.mkdir(exist_ok=True)
    prog = carpeta / f"w{a.worker}.txt"
    hechas = set()
    for f in carpeta.glob("w*.txt"):
        hechas |= set(f.read_text(encoding="utf-8").splitlines())
    con = conectar()
    pool = ThreadPoolExecutor(max_workers=12)
    enviados_a_pool = set()
    futuros = []

    def encolar():
        for fila in por_buscar(con, a.worker, a.de):
            if fila["id"] not in enviados_a_pool:
                enviados_a_pool.add(fila["id"])
                futuros.append(pool.submit(buscar_correo, fila["id"], fila["web"]))

    encolar()   # correos pendientes de corridas anteriores
    pendientes = [b for b in mias if f"{b['rubro']}|{b['ciudad']}" not in hechas]
    print(f"worker {a.worker}: {len(pendientes)} búsquedas pendientes de {len(mias)}", flush=True)
    con_correo_total = 0
    for n, b in enumerate(pendientes, 1):
        clave = f"{b['rubro']}|{b['ciudad']}"
        try:
            leads = maps.buscar(b["rubro"], b["ciudad"], cfg["max_por_fuente"])
        except Exception as e:
            print(f"[{n}/{len(pendientes)}] {clave}: error Maps {str(e)[:80]}", flush=True)
            continue
        nuevos = 0
        for l in leads:
            l["plantilla"] = b.get("plantilla")
            for _ in range(5):
                try:
                    nuevos += store.guardar(con, l)
                    break
                except sqlite3.OperationalError:
                    continue
        with prog.open("a", encoding="utf-8") as f:
            f.write(clave + "\n")
        encolar()
        futuros[:], hallados = drenar(con, futuros)
        con_correo_total += hallados
        print(f"[{n}/{len(pendientes)}] {clave}: {len(leads)} encontrados, {nuevos} nuevos · "
              f"correos hallados (acum.) {con_correo_total} · revisando webs {len(futuros)}", flush=True)
    futuros[:], hallados = drenar(con, futuros, esperar=True)
    print(f"FIN worker {a.worker}: correos hallados {con_correo_total + hallados}", flush=True)


if __name__ == "__main__":
    main()
