#!/usr/bin/env python3
"""Motor de leads — un solo comando, cuatro pasos.

  python leads.py buscar                 # Google + Maps + Instagram → base local
  python leads.py enviar [--confirmar]   # correos a los leads nuevos (sin flag = vista previa)
  python leads.py respuestas             # lee la bandeja y marca quién respondió
  python leads.py excel                  # exporta leads.xlsx
  python leads.py todo [--confirmar]     # los cuatro pasos seguidos
  python leads.py estado                 # resumen rápido
"""
import argparse
import importlib

from motor import config, excel, respuestas, store
from motor.correo import enviar_pendientes
from motor.fuentes.web import encontrar_email


def cmd_buscar(con, cfg, args):
    fuentes = args.fuentes.split(",") if args.fuentes else cfg["fuentes"]
    busquedas = cfg["busquedas"]
    if args.rubro and args.ciudad:
        busquedas = [{"rubro": args.rubro, "ciudad": args.ciudad}]
    total_nuevos = 0
    for b in busquedas:
        print(f"\n▶ {b['rubro']} — {b['ciudad']}")
        for nombre in fuentes:
            try:
                modulo = importlib.import_module(f"motor.fuentes.{nombre}")
                leads = modulo.buscar(b["rubro"], b["ciudad"], cfg["max_por_fuente"])
            except Exception as e:  # una fuente caída no detiene las demás
                print(f"  {nombre:10} error: {e}")
                continue
            nuevos = sum(store.guardar(con, l) for l in leads)
            total_nuevos += nuevos
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
    print(f"\nNuevos leads: {total_nuevos}")
    cmd_estado(con, cfg, args)


def cmd_enviar(con, cfg, args):
    n = enviar_pendientes(con, cfg, confirmar=args.confirmar, limite=args.limite)
    if args.confirmar:
        print(f"\nEnviados: {n}")


def cmd_respuestas(con, cfg, args):
    n = respuestas.revisar(con, dias=args.dias)
    print(f"\nRespuestas nuevas: {n}")


def cmd_excel(con, cfg, args):
    ruta = excel.exportar(con, cfg["excel"]["archivo"])
    print(f"Excel generado: {ruta}")


def cmd_estado(con, cfg, args):
    r = store.resumen(con)
    print("\n── Estado ──")
    for k in ("total", "nuevo", "sin_correo", "enviado", "respondio", "baja", "rebote"):
        print(f"  {k:11} {r[k]}")


def cmd_todo(con, cfg, args):
    cmd_buscar(con, cfg, args)
    cmd_enviar(con, cfg, args)
    if args.confirmar:
        cmd_respuestas(con, cfg, args)
    cmd_excel(con, cfg, args)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("buscar", help="buscar leads en las fuentes")
    b.add_argument("--rubro"); b.add_argument("--ciudad")
    b.add_argument("--fuentes", help="google,maps,instagram")

    e = sub.add_parser("enviar", help="enviar correos a leads nuevos")
    e.add_argument("--confirmar", action="store_true", help="enviar de verdad")
    e.add_argument("--limite", type=int)

    r = sub.add_parser("respuestas", help="leer respuestas de la bandeja")
    r.add_argument("--dias", type=int, default=30)

    sub.add_parser("excel", help="exportar a Excel")
    sub.add_parser("estado", help="resumen")

    t = sub.add_parser("todo", help="buscar + enviar + respuestas + excel")
    t.add_argument("--confirmar", action="store_true")
    t.add_argument("--rubro"); t.add_argument("--ciudad"); t.add_argument("--fuentes")
    t.add_argument("--limite", type=int); t.add_argument("--dias", type=int, default=30)

    args = p.parse_args()
    cfg = config.cargar()
    con = store.conectar()
    {"buscar": cmd_buscar, "enviar": cmd_enviar, "respuestas": cmd_respuestas,
     "excel": cmd_excel, "estado": cmd_estado, "todo": cmd_todo}[args.cmd](con, cfg, args)


if __name__ == "__main__":
    main()
