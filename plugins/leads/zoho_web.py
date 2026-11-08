"""Envío y lectura de correos con Zoho Mail **web** (navegador), para sesiones de Claude en la nube
donde los puertos de correo (SMTP/IMAP) están bloqueados. No guarda contraseñas: usa la sesión del
navegador en ~/.zoho-web (se abre una vez con un código de un solo uso; ver zoho-web/login.js).

  python zoho_web.py estado                         # ¿hay sesión abierta en Zoho?
  python zoho_web.py enviar [--limite N] [--plantilla X]             # solo muestra qué se enviaría
  python zoho_web.py enviar --confirmar [--limite N] [--plantilla X] # envía y marca como enviados
  python zoho_web.py respuestas                     # lee respuestas y rebotes y los registra

Usa la misma carpeta de datos que leads.py (variable LEADS_DIR).
"""
import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

AQUI = Path(__file__).resolve().parent
JS = AQUI / "zoho-web"
LEADS = [sys.executable, str(AQUI / "leads.py")]


def leads(*args: str, salida_json: bool = False):
    r = subprocess.run(LEADS + list(args), capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(r.stdout + r.stderr)
    return json.loads(r.stdout[r.stdout.index("["):]) if salida_json else r.stdout


def node(script: str, *args: str) -> list[str]:
    r = subprocess.run(["node", str(JS / script), *args], capture_output=True, text=True, cwd=JS)
    lineas = [l for l in r.stdout.splitlines() if l.strip()]
    if any(l.startswith("SIN_SESION") for l in lineas):
        raise SystemExit("SIN_SESION: hay que iniciar sesión en Zoho (zoho-web/login.js con código de un solo uso).")
    if r.returncode != 0:
        raise SystemExit("Error del navegador: " + (r.stdout + r.stderr)[-800:])
    return lineas


def config() -> dict:
    sys.path.insert(0, str(AQUI))
    from motor import config as c
    return c.cargar()


def cmd_estado(_):
    print(node("estado.js")[-1])


def cmd_enviar(a):
    extra = (["--plantilla", a.plantilla] if a.plantilla else []) + (["--limite", str(a.limite)] if a.limite else [])
    correos = leads("cola", "--json", *extra, salida_json=True)
    if not correos:
        print("No hay correos en cola (sin leads nuevos con correo, o se alcanzó el máximo diario).")
        return
    if not a.confirmar:
        print(f"Se enviarían {len(correos)} correos. Primero:\n")
        c = correos[0]
        print(f"Para: {c['para']}\nAsunto: {c['asunto']}\n\n{c['cuerpo']}")
        print("\nNada enviado. Repite con --confirmar para enviar.")
        return
    pausa = str(config()["correo"].get("segundos_entre_envios", 45))
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(correos, f, ensure_ascii=False)
    por_id = {str(c["id"]): c for c in correos}
    ok, fallos = 0, []
    for linea in node("enviar.js", f.name, pausa):
        partes = linea.split(" ", 2)
        if partes[0] == "OK" and partes[1] in por_id:
            mid = f"<zoho-web-{partes[1]}-{int(time.time())}@{por_id[partes[1]]['para'].split('@')[-1]}>"
            leads("marcar-enviado", partes[1], "--message-id", mid,
                  *(["--plantilla", a.plantilla] if a.plantilla else []))
            ok += 1
            print(f"✔ {por_id[partes[1]]['nombre']} <{por_id[partes[1]]['para']}>")
        elif partes[0] == "FALLO":
            fallos.append(linea)
            print(f"✘ {linea}")
    Path(f.name).unlink(missing_ok=True)
    print(f"\nEnviados: {ok} · Fallidos: {len(fallos)}")


def cmd_respuestas(_):
    enviados = leads("respuestas", "--json", salida_json=True)
    if not enviados:
        print("No hay correos enviados esperando respuesta.")
        return
    busquedas = [{"id": l["id"], "desde": l["email"], "max": 2} for l in enviados]
    busquedas += [{"id": "rebotes", "desde": d, "max": 15} for d in ("mailer-daemon", "postmaster")]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(busquedas, f, ensure_ascii=False)
    resultados = [json.loads(l) for l in node("leer.js", f.name) if l.startswith("{")]
    Path(f.name).unlink(missing_ok=True)
    nombres = {l["id"]: l["nombre"] for l in enviados}
    registrados = set()
    for r in resultados:
        if r["id"] == "rebotes":
            continue
        if r.get("encontrados"):
            m = r["encontrados"][0]
            print(leads("registrar-respuesta", str(r["id"]), "--texto", m["texto"][:1500] or "(sin texto)",
                        "--asunto", m["asunto"]).strip())
            registrados.add(r["id"])
    for r in (x for x in resultados if x["id"] == "rebotes"):
        for m in r.get("encontrados", []):
            for l in enviados:
                if l["id"] not in registrados and l["email"].lower() in m["texto"].lower():
                    print(leads("registrar-respuesta", str(l["id"]), "--rebote", "--texto", m["texto"][:400],
                                "--asunto", m["asunto"]).strip())
                    registrados.add(l["id"])
    errores = [r for r in resultados if r.get("error")]
    print(f"\nRevisados: {len(enviados)} · Con novedad: {len(registrados)}"
          + (f" · Búsquedas con error: {len(errores)}" if errores else ""))
    sin = [nombres[i] for i in nombres if i not in registrados]
    if sin and len(sin) <= 10:
        print("Sin respuesta aún: " + ", ".join(sin))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("estado")
    s = sub.add_parser("enviar"); s.add_argument("--confirmar", action="store_true")
    s.add_argument("--limite", type=int); s.add_argument("--plantilla")
    sub.add_parser("respuestas")
    a = ap.parse_args()
    {"estado": cmd_estado, "enviar": cmd_enviar, "respuestas": cmd_respuestas}[a.cmd](a)


if __name__ == "__main__":
    main()
