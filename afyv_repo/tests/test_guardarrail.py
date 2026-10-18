"""El guardarraíl no puede debilitarse sin que estos tests fallen."""
import unittest

from tests._util import Base, G, HOY_OK


class General(Base):
    def test_ejemplo_general_aprueba(self):
        self.assertEqual(G.revisar_post(self.pedido("ejemplo_general.json"), HOY_OK), [])

    def _con(self, texto):
        p = self.pedido("ejemplo_general.json")
        p["slides"][1]["x"] = texto
        return G.revisar_post(p, HOY_OK)

    def test_rechaza_plazo_numerico(self):
        self.assertTrue(self._con("Tienes 30 días para reclamar."))

    def test_rechaza_cita_de_ley_y_articulo(self):
        self.assertTrue(self._con("Según la Ley 18.101 puedes arrendar."))
        self.assertTrue(self._con("Lo dice el artículo 24."))

    def test_rechaza_precio_inventado(self):
        self.assertTrue(any("precio no autorizado" in x for x in self._con("Marca por $9.990 sin IVA.")))

    def test_acepta_precio_de_la_fuente(self):
        self.assertEqual(self._con("Diagnóstico de marca: $29.990 sin IVA."), [])

    def test_rechaza_promesas_superlativos_y_comparaciones(self):
        for t in ("Garantizamos tu registro.", "Somos el mejor estudio.", "Mejor que otros estudios.", "100% efectivo"):
            self.assertTrue(self._con(t), t)

    def test_rechaza_afirmaciones_juridicas(self):
        for t in ("La ley establece que debes pagar.", "Es ilegal despedir así.", "El contrato es nulo.", "No necesitas abogado."):
            self.assertTrue(self._con(t), t)


class Juridico(Base):
    def test_ejemplo_juridico_aprueba(self):
        self.assertEqual(G.revisar_post(self.pedido("ejemplo_juridico.json"), HOY_OK), [])

    def _mod(self, fn):
        p = self.pedido("ejemplo_juridico.json")
        fn(p)
        return G.revisar_post(p, HOY_OK)

    def test_rechaza_articulo_fuera_de_las_fichas(self):
        r = self._mod(lambda p: p["slides"][1].update(ref="Ley 19.039, art. 99"))
        self.assertTrue(any("artículo 99" in x for x in r))

    def test_rechaza_plazo_que_no_esta_en_fichas(self):
        r = self._mod(lambda p: p["slides"][2].update(x="La oposición debe presentarse dentro de 60 días."))
        self.assertTrue(any("60 días" in x for x in r))

    def test_rechaza_ley_ajena(self):
        r = self._mod(lambda p: p["slides"][1].update(x="Según la Ley 18.101 puedes oponerte."))
        self.assertTrue(any("18.101" in x for x in r) or r)

    def test_rechaza_lamina_sin_ref(self):
        r = self._mod(lambda p: p["slides"][2].pop("ref"))
        self.assertTrue(any("sin referencia" in x for x in r))

    def test_rechaza_sin_aviso(self):
        self.assertTrue(any("aviso" in x for x in self._mod(lambda p: p.pop("aviso"))))

    def test_rechaza_consejo_individual(self):
        r = self._mod(lambda p: p.update(ig=p["ig"] + "\nDebes presentar la oposición ya."))
        self.assertTrue(any("consejo individual" in x for x in r))

    def test_rechaza_jurisprudencia(self):
        r = self._mod(lambda p: p.update(li=p["li"] + " Los tribunales han resuelto lo contrario."))
        self.assertTrue(r)

    def test_rechaza_ficha_inexistente_y_sin_fichas(self):
        self.assertTrue(any("inexistente" in x for x in self._mod(lambda p: p["fichas"].append("F99"))))
        self.assertTrue(any("sin fichas" in x for x in self._mod(lambda p: p.update(fichas=[]))))

    def test_rechaza_ficha_vencida(self):
        p = self.pedido("ejemplo_juridico.json")
        r = G.revisar_post(p, "2026-12-30")      # >45 días desde 2026-10-15
        self.assertTrue(any("vencida" in x for x in r))

    def test_rechaza_ficha_rechazada(self):
        b = self.base()
        for f in b["fichas"]:
            if f["id"] == "F02":
                f["estado"] = "rechazada"
        self.guardar_base(b)
        r = G.revisar_post(self.pedido("ejemplo_juridico.json"), HOY_OK)
        self.assertTrue(any("no verificada" in x for x in r))


if __name__ == "__main__":
    unittest.main()
