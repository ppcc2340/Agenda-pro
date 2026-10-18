"""verificar_vigencia, sin red: se simula la respuesta de LeyChile con un XML armado desde el extracto local."""
import json
import unittest
import urllib.error
import xml.etree.ElementTree as ET
from datetime import date

from tests._util import Base, REPO, VV, V


def xml_de(texto, version="2022-08-06"):
    raiz = ET.Element("Norma", {"normaId": "1179684", "fechaVersion": version})
    for linea in texto.split("\n"):
        if linea.strip():
            ET.SubElement(raiz, "Parrafo").text = linea
    return ET.tostring(raiz, encoding="utf-8")


class Vigencia(Base):
    def extracto(self):
        return (REPO / "fuentes" / "extracto_ley19039_marcas.txt").read_text(encoding="utf-8")

    def correr(self, contenido, **kw):
        arch = self.tmp / "ley.xml"
        arch.write_bytes(contenido)
        return VV.verificar_vigencia(archivo=str(arch), hoy="2026-10-20", **kw)

    def test_texto_igual_todo_vigente(self):
        r = self.correr(xml_de(self.extracto()))
        self.assertEqual(r["codigo"], 0, r["mensajes"])
        self.assertEqual(r["resumen"]["rechazadas"], 0)
        b = self.base()
        self.assertEqual(b["_meta"]["version_bcn"], "2022-08-06")
        self.assertTrue(all(f["fecha_verificacion"] == "2026-10-20" for f in b["fichas"]))

    def test_articulo_modificado_rechaza_ficha(self):
        modificado = self.extracto().replace("dentro del plazo de 30 días contado", "dentro del plazo de 20 días contado")
        r = self.correr(xml_de(modificado))
        self.assertEqual(r["codigo"], 1)
        estados = {f["id"]: f["estado"] for f in self.base()["fichas"]}
        self.assertEqual(estados["F02"], "rechazada")
        self.assertEqual(estados["F05"], "verificada")      # las demás siguen bien

    def test_ficha_rechazada_la_bloquea_el_guardarrail(self):
        from tests._util import G, HOY_OK, cargar_pedido
        modificado = self.extracto().replace("son fatales y de días hábiles", "son fatales y corridos")
        self.correr(xml_de(modificado))
        problemas = G.revisar_post(cargar_pedido("ejemplo_juridico.json"), HOY_OK)
        self.assertTrue(any("no verificada" in x for x in problemas))

    def test_cambio_de_version_avisa_aunque_citas_coincidan(self):
        self.assertEqual(self.correr(xml_de(self.extracto(), "2022-08-06"))["codigo"], 0)
        r = self.correr(xml_de(self.extracto(), "2026-11-01"))
        self.assertEqual(r["codigo"], 3)
        self.assertTrue(any("actualización" in m for m in r["mensajes"]))

    def test_sin_red(self):
        def falla(_id):
            raise urllib.error.URLError("sin red")
        r = VV.verificar_vigencia(descargar_fn=falla)
        self.assertEqual(r["codigo"], 2)

    def test_xml_invalido_y_texto_corto(self):
        self.assertEqual(self.correr(b"<html>no es xml")["codigo"], 2)
        self.assertEqual(self.correr(xml_de("Artículo 1.- Algo breve."))["codigo"], 2)

    def test_no_modifica_fichas_si_no_se_pudo_obtener_el_texto(self):
        antes = self.base()
        self.correr(b"basura")
        self.assertEqual(self.base(), antes)

    def test_estado_dias_restantes(self):
        e = VV.estado_fichas(date(2026, 11, 20))     # 36 días desde 2026-10-15; quedan 9
        self.assertTrue(all(f["quedan"] == 9 for f in e["fichas"]))
        e = VV.estado_fichas(date(2026, 12, 1))      # 47 días -> vencidas
        self.assertTrue(all(f["quedan"] < 0 for f in e["fichas"]))

    def test_texto_desde_xml_con_namespace(self):
        x = b'<n:Norma xmlns:n="urn:x" n:fechaVersion="2024-01-01"><n:P>Hola mundo</n:P></n:Norma>'
        texto, meta = VV.texto_desde_xml(x)
        self.assertIn("Hola mundo", texto)
        self.assertEqual(meta.get("fechaversion"), "2024-01-01")


if __name__ == "__main__":
    unittest.main()
