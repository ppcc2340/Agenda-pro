#!/usr/bin/env python3
"""Motor de leads — buscar → enviar → respuestas → excel.

  python leads.py buscar [--rubro X --ciudad Y] [--fuentes google,maps,instagram]
  python leads.py plantillas [nombre]        # lista plantillas o muestra una
  python leads.py previa [--id N] [--plantilla X]   # cómo quedaría el correo
  python leads.py cola [--json]              # modo gmail: correos listos para que Claude envíe
  python leads.py marcar-enviado ID [--message-id X]
  python leads.py enviar [--confirmar]       # modo smtp: envía directo
  python leads.py respuestas [--json]        # gmail: qué buscar · smtp: lee la bandeja
  python leads.py registrar-respuesta ID --texto "..." [--asunto S] [--baja|--rebote]
  python leads.py excel                      # exporta leads.xlsx
  python leads.py estado                     # resumen
"""
import argparse
import importlib

from motor import config, correo, excel, plantillas, respuestas, store
from motor.fuentes.web import encontrar_email


# ── buscar ──────────────────────────────────────────────────────────────
def cmd_buscar(con, cfg, a):
    fuentes = a.fuentes.split(",") if a.fuentes else cfg["fuentes"]
    busquedas = cfg["busquedas"]
    if a.rubro and a.ciudad:
        busquedas = [{"rubro": a.rubro, "ciudad": a.ciudad, "plantilla": a.plantilla}]
    total = 0
    for b in busquedas:
        print(f"\n▶ {b['rubro']} — {b['ciudad']}")
        for nombre in fuentes:
            try:
                modulo = importlib.import_module(f"motor.fuentes.{nombre}")
                leads = modulo.buscar(b["rubro"], b["ciudad"], cfg["max_por_fuente"])
            except Exception as e:  # una fuente caída no detiene las demás
                print(f"  {nombre:10} error: {e}")
                continue
            for l in leads:
                l["plantilla"] = b.get("plantilla")
            nuevos = sum(store.guardar(con, l) for l in leads)
            total += nuevos
            print(f"  {nombre:10} {len(leads):3} encontrados, {nuevos:3} nuevos")

    if cfg.get("buscar_correo_en_web"):
        sin = [l for l in store.listar(con, "sin_correo") if l["web"]]
        if sin:
            print(f"\n▶ Buscando correo en {len(sin)} sitios web…")
            for l in sin:
                email = encontrar_email(l["web"])
                if email:
                    store.actualizar(con, l["id"], email=email, estado="nuevo")
                    print(f"  ✔ {l['nombre']}: {email}")
    print(f"\nNuevos leads: {total}")
    cmd_estado(con, cfg, a)


# ── plantillas y vista previa ───────────────────────────────────────────
def cmd_plantillas(con, cfg, a):
    if a.nombre:
        asunto, cuerpo = plantillas.cargar(a.nombre)
        print(f"Archivo: {plantillas.ruta(a.nombre)}\nAsunto: {asunto}\n\n{cuerpo}")
        return
    actual = cfg["correo"].get("plantilla")
    print("Plantillas (carpeta plantillas/):")
    for n in plantillas.listar():
        print(f"  {'●' if n == actual else '○'} {n}")
    print(f"\nVariables: {', '.join('{'+v+'}' for v in plantillas.VARIABLES)}")
    print("Cambia la predeterminada en config.yaml → correo.plantilla, o usa --plantilla en cada comando.")


def cmd_previa(con, cfg, a):
    lead = store.por_id(con, a.id) if a.id else next(iter(correo.pendientes(con, cfg, 1)), None)
    if lead is None:
        raise SystemExit("No hay ningún lead con correo pendiente. Ejecuta antes `buscar`.")
    correo.imprimir_correo(correo.componer(lead, cfg, a.plantilla))


# ── enviar ──────────────────────────────────────────────────────────────
def cmd_cola(con, cfg, a):
    correo.cola(con, cfg, a.plantilla, a.limite, a.json)


def cmd_marcar_enviado(con, cfg, a):
    correo.marcar_enviado(con, cfg, a.id, a.message_id, a.plantilla)


def cmd_enviar(con, cfg, a):
    if cfg["correo"].get("modo", "gmail") != "smtp":
        print("Modo gmail: los correos los envía Claude con su conector. Usa `cola` para verlos\n"
              "y `marcar-enviado ID` tras cada envío. Para enviar directo pon correo.modo: smtp.")
        return
    n = correo.enviar_smtp(con, cfg, a.confirmar, a.plantilla, a.limite)
    if a.confirmar:
        print(f"\nEnviados: {n}")


# ── respuestas ──────────────────────────────────────────────────────────
def cmd_respuestas(con, cfg, a):
    if cfg["correo"].get("modo", "gmail") != "smtp":
        respuestas.para_revisar(con, a.json)
        return
    n = respuestas.revisar(con, dias=a.dias)
    print(f"\nRespuestas nuevas: {n}")


def cmd_registrar(con, cfg, a):
    estado = "baja" if a.baja else "rebote" if a.rebote else None
    respuestas.registrar(con, a.id, a.texto, a.asunto or "", estado)


# ── excel / estado ──────────────────────────────────────────────────────
def cmd_excel(con, cfg, a):
    print(f"Excel generado: {excel.exportar(con, cfg['excel']['archivo'])}")


def cmd_estado(con, cfg, a):
    r = store.resumen(con)
    print("\n── Estado ──")
    for k in ("total", "nuevo", "sin_correo", "enviado", "respondio", "baja", "rebote"):
        print(f"  {k:11} {r[k]}")
    print(f"  modo correo {cfg['correo'].get('modo', 'gmail')} · plantilla {cfg['correo'].get('plantilla')}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    def pl(x):
        x.add_argument("--plantilla", help="nombre de plantilla (ver `plantillas`)")

    s = sub.add_parser("buscar"); s.add_argument("--rubro"); s.add_argument("--ciudad")
    s.add_argument("--fuentes", help="google,maps,instagram"); pl(s)
    s = sub.add_parser("plantillas"); s.add_argument("nombre", nargs="?")
    s = sub.add_parser("previa"); s.add_argument("--id", type=int); pl(s)
    s = sub.add_parser("cola"); s.add_argument("--json", action="store_true")
    s.add_argument("--limite", type=int); pl(s)
    s = sub.add_parser("marcar-enviado"); s.add_argument("id", type=int)
    s.add_argument("--message-id"); pl(s)
    s = sub.add_parser("enviar"); s.add_argument("--confirmar", action="store_true")
    s.add_argument("--limite", type=int); pl(s)
    s = sub.add_parser("respuestas"); s.add_argument("--json", action="store_true")
    s.add_argument("--dias", type=int, default=30)
    s = sub.add_parser("registrar-respuesta"); s.add_argument("id", type=int)
    s.add_argument("--texto", required=True); s.add_argument("--asunto")
    s.add_argument("--baja", action="store_true"); s.add_argument("--rebote", action="store_true")
    sub.add_parser("excel"); sub.add_parser("estado")

    a = p.parse_args()
    cfg = config.cargar()
    con = store.conectar()
    {"buscar": cmd_buscar, "plantillas": cmd_plantillas, "previa": cmd_previa, "cola": cmd_cola,
     "marcar-enviado": cmd_marcar_enviado, "enviar": cmd_enviar, "respuestas": cmd_respuestas,
     "registrar-respuesta": cmd_registrar, "excel": cmd_excel, "estado": cmd_estado}[a.cmd](con, cfg, a)


if __name__ == "__main__":
    main()
