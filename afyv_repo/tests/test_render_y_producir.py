import json
import unittest

from tests._util import Base, R, cargar_pedido, HOY_OK
import producir as P


class Render(Base):
    def test_ejemplos_caben_en_todos_los_formatos(self):
        for n in ("ejemplo_general.json", "ejemplo_juridico.json"):
            self.assertEqual(R.medir(self.pedido(n), ["4x5", "1x1", "9x16", "191x1"], reel=True), [], n)

    def test_texto_desmedido_se_detecta(self):
        p = self.pedido("ejemplo_general.json")
        p["slides"][1]["x"] = "Texto de prueba muy largo para forzar el desborde. " * 30
        avisos = R.medir(p, ["4x5"])
        self.assertTrue(avisos and "no cabe" in avisos[0])

    def test_medir_no_deja_estado_sucio(self):
        p = self.pedido("ejemplo_general.json")
        p["slides"][1]["x"] = "Texto de prueba muy largo para forzar el desborde. " * 30
        R.medir(p, ["4x5"])
        self.assertEqual(R.medir(self.pedido("ejemplo_general.json"), ["4x5"]), [])

    def test_sello_refleja_la_norma_de_las_fichas(self):
        p = self.pedido("ejemplo_juridico.json")
        self.assertEqual(R.etiqueta_norma(p), "LEY 19.039")
        b = self.base()
        b["fichas"].append({"id": "F90", "articulo": "1", "ref": "Ley 18.101, art. 1", "norma_numero": "18.101",
                            "tema": "x", "resumen": "x", "citas": ["x"], "datos": [], "estado": "verificada",
                            "fecha_verificacion": HOY_OK})
        self.guardar_base(b)
        p["fichas"].append("F90")
        self.assertIn("18.101", R.etiqueta_norma(p))


class Estructura(unittest.TestCase):
    def setUp(self):
        self.p = cargar_pedido("ejemplo_general.json")

    def test_ejemplos_ok(self):
        self.assertEqual(P.estructura(self.p), [])

    def test_titulo_y_texto_largos(self):
        self.p["slides"][1]["t"] = "x" * 71
        self.p["slides"][1]["x"] = "y" * 221
        self.assertEqual(len(P.estructura(self.p)), 2)

    def test_demasiadas_laminas(self):
        self.p["slides"] = self.p["slides"] * 3
        self.assertTrue(any("entre 1 y" in e for e in P.estructura(self.p)))

    def test_los_asteriscos_de_enfasis_no_cuentan(self):
        self.p["slides"][1]["t"] = "*" + "a" * 70 + "*"
        self.assertEqual(P.estructura(self.p), [])


if __name__ == "__main__":
    unittest.main()
