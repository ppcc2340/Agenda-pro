"""Utilidades de test: cada caso trabaja sobre una COPIA temporal de los datos (nunca toca los reales)."""
import copy
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "automatizacion"))

import guardarrail as G  # noqa: E402
import render_v2 as R  # noqa: E402
import verificar_citas as V  # noqa: E402
import verificar_vigencia as VV  # noqa: E402

HOY_OK = "2026-10-17"       # dentro de la ventana de 45 días de las fichas del repo (verificadas 2026-10-15)


def cargar_pedido(nombre):
    p = json.loads((REPO / "pedidos" / nombre).read_text(encoding="utf-8"))
    p.update(id="PED-TEST", fecha=HOY_OK)
    p.setdefault("formato", "Carrusel" if len(p["slides"]) > 1 else "Imagen")
    p.setdefault("pilar", "Marcas" if p.get("modo") == "juridico" else "Servicios")
    return p


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="afyv_test_"))
        for rel in ("base_juridica.json", "fuente_de_verdad.json"):
            shutil.copy(REPO / rel, self.tmp / rel)
        shutil.copytree(REPO / "fuentes", self.tmp / "fuentes")
        shutil.copytree(REPO / "assets", self.tmp / "assets")
        self._orig = (G.RAIZ, V.RAIZ, V.BASE, VV.RAIZ, R.RAIZ)
        G.RAIZ = V.RAIZ = VV.RAIZ = R.RAIZ = self.tmp
        V.BASE = self.tmp / "base_juridica.json"

    def tearDown(self):
        G.RAIZ, V.RAIZ, V.BASE, VV.RAIZ, R.RAIZ = self._orig
        shutil.rmtree(self.tmp, ignore_errors=True)

    def base(self):
        return json.loads((self.tmp / "base_juridica.json").read_text(encoding="utf-8"))

    def guardar_base(self, b):
        (self.tmp / "base_juridica.json").write_text(json.dumps(b, ensure_ascii=False), encoding="utf-8")

    def pedido(self, nombre):
        return copy.deepcopy(cargar_pedido(nombre))
