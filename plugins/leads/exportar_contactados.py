"""Excel de contactados (enviados + programados), con enlace a la fuente de cada negocio.

  python exportar_contactados.py [--salida archivo.xlsx]
"""
import argparse
import sqlite3
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from motor import config, plantillas, store      # noqa: E402

CHILE = ZoneInfo("America/Santiago")
AZUL = PatternFill("solid", fgColor="1F3864")
COLORES = {"No enviado (bloqueo Zoho)": "F8CBAD", "Programado": "FFF2CC", "Enviado": "DDEBF7", "Respondió": "C6EFCE", "Pidió baja": "F4CCCC",
           "Rebotó": "E0E0E0", "Por confirmar": "FCE4D6"}
COLUMNAS = [("N°", 6), ("Negocio", 34), ("Rubro", 20), ("Ciudad", 24), ("Correo", 32), ("Teléfono", 16),
            ("Dirección", 40), ("Sitio web", 34), ("Fuente (Google Maps)", 22), ("Programado / enviado (hora Chile)", 22),
            ("Estado", 14), ("Asunto del correo", 40)]


def estado_legible(l, ahora):
    e = l["estado"]
    if e == "revisar":
        return "No enviado (bloqueo Zoho)" if (l["respuesta"] or "").startswith("No enviado") else "Por confirmar"
    if e == "respondio":
        return "Respondió"
    if e == "baja":
        return "Pidió baja"
    if e == "rebote":
        return "Rebotó"
    try:
        cuando = datetime.strptime((l["enviado_el"] or "")[:16], "%Y-%m-%d %H:%M")
    except ValueError:
        return "Enviado"
    return "Programado" if cuando > ahora else "Enviado"


def encabezado(ws, columnas):
    ws.append([c for c, _ in columnas])
    for i, (_, ancho) in enumerate(columnas, 1):
        celda = ws.cell(row=1, column=i)
        celda.font = Font(bold=True, color="FFFFFF"); celda.fill = AZUL
        celda.alignment = Alignment(vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(i)].width = ancho
    ws.freeze_panes = "A2"


def main():
    ap = argparse.ArgumentParser()
    ahora = datetime.now(CHILE).replace(tzinfo=None)
    ap.add_argument("--salida", default=str(config.RAIZ / f"contactados-{ahora:%Y-%m-%d}.xlsx"))
    ap.add_argument("--nota", default="")
    a = ap.parse_args()
    cfg = config.cargar()
    con = store.conectar()
    con.execute("PRAGMA busy_timeout=60000")
    filas = con.execute(
        "SELECT * FROM leads WHERE message_id LIKE '<zoho-prog-%' OR "
        "(estado IN ('enviado','respondio','baja','rebote') AND enviado_el IS NOT NULL) "
        "ORDER BY enviado_el, id").fetchall()

    wb = Workbook()
    ws = wb.active; ws.title = "Contactados"
    encabezado(ws, COLUMNAS)
    por_estado, por_dia, por_ciudad, por_rubro = Counter(), Counter(), Counter(), Counter()
    for n, l in enumerate(filas, 1):
        est = estado_legible(l, ahora)
        try:
            asunto, _ = plantillas.renderizar(plantillas.elegir(l, cfg), l, cfg)
        except SystemExit:
            asunto = ""
        ws.append([n, l["nombre"], l["rubro"], l["ciudad"], l["email"], l["telefono"], l["direccion"],
                   l["web"] or "", "Ver ficha" if l["url_origen"] else "", (l["enviado_el"] or "")[:16], est, asunto])
        r = ws.max_row
        if l["web"]:
            ws.cell(row=r, column=8).hyperlink = l["web"]; ws.cell(row=r, column=8).style = "Hyperlink"
        if l["url_origen"]:
            ws.cell(row=r, column=9).hyperlink = l["url_origen"]; ws.cell(row=r, column=9).style = "Hyperlink"
        ws.cell(row=r, column=11).fill = PatternFill("solid", fgColor=COLORES.get(est, "FFFFFF"))
        por_estado[est] += 1; por_dia[(l["enviado_el"] or "")[:10]] += 1
        por_ciudad[l["ciudad"]] += 1; por_rubro[l["rubro"]] += 1
    ws.auto_filter.ref = f"A1:{get_column_letter(len(COLUMNAS))}{max(ws.max_row, 1)}"

    rs = wb.create_sheet("Resumen", 0)
    rs.column_dimensions["A"].width = 40; rs.column_dimensions["B"].width = 14
    rs.append([f"Campaña de prospección AFyV Legal · generado {ahora:%d-%m-%Y %H:%M} (hora Chile)"])
    rs["A1"].font = Font(bold=True, size=13)
    rs.append([]); rs.append(["Total en la campaña (enviados + programados + no enviados)", len(filas)])
    if a.nota:
        rs.append([]); rs.append(["Nota"]); rs.cell(row=rs.max_row, column=1).font = Font(bold=True)
        for linea in a.nota.split("|"):
            rs.append([linea.strip()])
    for titulo, cont in (("Por estado", por_estado), ("Por día de envío", por_dia),
                         ("Por ciudad", por_ciudad), ("Por rubro", por_rubro)):
        rs.append([]); rs.append([titulo, "Correos"])
        rs.cell(row=rs.max_row, column=1).font = Font(bold=True); rs.cell(row=rs.max_row, column=2).font = Font(bold=True)
        for k, v in sorted(cont.items(), key=lambda x: (-x[1], str(x[0]))):
            rs.append([k or "(sin dato)", v])
    wb.save(a.salida)
    print(f"{a.salida} · {len(filas)} contactados · {dict(por_estado)}")


if __name__ == "__main__":
    main()
