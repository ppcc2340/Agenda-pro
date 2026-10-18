#!/usr/bin/env python3
"""
CLI única de AFyV Legal. Reemplaza a montar.py: el repositorio ya trae la estructura armada.

  python afyv.py validar  pedidos/mi_pedido.json [--formatos 4x5,1x1] [--reel]   (no genera imágenes)
  python afyv.py generar  pedidos/mi_pedido.json [--formatos 4x5,1x1] [--reel]
  python afyv.py verificar ley.pdf --norma 19.039        (citas vs. un PDF/TXT de leychile.cl)
  python afyv.py fichas   fichas_nuevas.json ley.pdf --norma "Ley 18.101" --numero 18.101 [--id-norma 29726]
  python afyv.py vigencia [--archivo ley.xml]            (descarga de la BCN y compara; ver verificar_vigencia.py)
  python afyv.py estado                                   (cuánto falta para que venzan las fichas)
  python afyv.py lint     pedidos/mi_pedido.json         (solo estilo)
  python afyv.py test                                     (suite completa)

Regla n.º 1 del proyecto: se produce SOLO lo que se pide. Esta CLI no tiene comandos que armen calendarios ni series.
"""
import subprocess
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
AUT = RAIZ / "automatizacion"


def correr(script, *args):
    return subprocess.call([sys.executable, str(AUT / script), *args], cwd=RAIZ)


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, resto = argv[1], argv[2:]
    if cmd == "validar":
        return correr("producir.py", *resto, "--solo-validar")
    if cmd == "generar":
        return correr("producir.py", *resto)
    if cmd == "verificar":
        ley = [a for a in resto if not a.startswith("--")]
        norma = resto[resto.index("--norma") + 1] if "--norma" in resto else "19.039"
        return correr("verificar_citas.py", *(ley[:1] if ley[:1] != [norma] else []), f"--norma={norma}")
    if cmd == "fichas":
        return correr("agregar_fichas.py", *resto)
    if cmd == "vigencia":
        return correr("verificar_vigencia.py", *resto)
    if cmd == "estado":
        return correr("verificar_vigencia.py", "--estado")
    if cmd == "lint":
        return correr("linter_estilo.py", *resto)
    if cmd == "test":
        return subprocess.call([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."], cwd=RAIZ)
    print(f"Comando desconocido: {cmd}\n{__doc__}")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
