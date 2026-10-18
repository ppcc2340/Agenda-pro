import unittest

from tests._util import Base, cargar_pedido
import linter_estilo as E


class Linter(Base):
    def test_ejemplos_sin_errores(self):
        for n in ("ejemplo_general.json", "ejemplo_juridico.json"):
            self.assertEqual(E.revisar_post(cargar_pedido(n))[0], [], n)

    def test_muletillas(self):
        for t in ("En el mundo actual todo cambia.", "Descubre tu marca.", "Sumérgete en el derecho.", "No es solo un logo, es identidad."):
            self.assertTrue(E.revisar_texto(t, "ig")[0], t)

    def test_clave_repetido(self):
        self.assertTrue(E.revisar_texto("Es clave actuar. Lo clave es el plazo.", "ig")[0])
        self.assertFalse(E.revisar_texto("Es clave actuar a tiempo.", "ig")[0])

    def test_tuteo(self):
        self.assertTrue(E.revisar_texto("Contáctenos para su registro.", "ig")[0])
        self.assertTrue(E.revisar_texto("Usted puede escribirnos.", "li")[0])
        self.assertFalse(E.revisar_texto("Escríbenos cuando quieras.", "li")[0])

    def test_linkedin_sin_emojis_pero_con_vinetas(self):
        self.assertTrue(E.revisar_texto("Hola 🚀 mundo", "li")[0])
        self.assertFalse(E.revisar_texto("• Punto uno\n• Punto dos", "li")[0])

    def test_emojis_por_linea_y_variaciones(self):
        self.assertTrue(E.revisar_texto("🚀 Hola\n📌✅ Dos juntos", "ig")[0])
        self.assertFalse(E.revisar_texto("🚀 Hola\n✍️ Uno con variación\n1️⃣ Keycap", "ig")[0])

    def test_exclamaciones(self):
        self.assertTrue(E.revisar_texto("¡Hola!! Vamos", "ig")[0])

    def test_enfasis_del_diseno_no_cuenta(self):
        self.assertEqual(E.revisar_texto("Esto es *clave* y *clave*", "slide")[0] != [], True)  # sí cuenta la palabra
        self.assertFalse(E.revisar_texto("Plazo de *30 días*", "slide")[0])

    def test_legibilidad_ordena_bien(self):
        facil = "Tu marca es tu nombre. Es lo que te distingue. Cuídala."
        dificil = ("La conceptualización institucionalizada de los procedimientos administrativos jurisdiccionales "
                   "complejiza considerablemente la implementación extrajudicial de mecanismos compensatorios.")
        self.assertGreater(E.legibilidad(facil), E.legibilidad(dificil))
        self.assertLess(E.legibilidad(dificil), 40)

    def test_silabas(self):
        casos = {"marca": 2, "oposición": 4, "abogado": 4, "país": 2, "buey": 1, "Diario": 2}
        for w, n in casos.items():
            self.assertEqual(E.silabas(w), n, w)


if __name__ == "__main__":
    unittest.main()
