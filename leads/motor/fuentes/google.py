"""Google (búsqueda web): encuentra sitios de negocios del rubro en la ciudad."""
from .comun import buscar_web, dominio, extraer_emails, pausa

_EXCLUIR = ("google.", "facebook.", "instagram.", "linkedin.", "youtube.", "wikipedia.",
            "yelp.", "tripadvisor.", "paginasamarillas", "amarillas.", "mercadolibre.",
            "cylex", "infobel", "foursquare")
_GENERICOS = {"contacto", "contact", "inicio", "home", "nosotros", "servicios", "bienvenidos"}


def buscar(rubro: str, ciudad: str, maximo: int = 20) -> list[dict]:
    leads: list[dict] = []
    vistos: set[str] = set()
    for r in buscar_web(f"{rubro} {ciudad} contacto", maximo * 2):
        dom = dominio(r["url"])
        if not dom or dom in vistos or any(x in dom for x in _EXCLUIR):
            continue
        vistos.add(dom)
        nombre = r["titulo"].split("|")[0].split(" - ")[0].strip()
        if len(nombre) < 4 or nombre.lower() in _GENERICOS:
            nombre = dom.split(".")[0].capitalize()
        emails = extraer_emails(r["resumen"])
        leads.append({
            "nombre": nombre[:80], "rubro": rubro, "ciudad": ciudad, "fuente": "google",
            "web": f"https://{dom}", "email": emails[0] if emails else None,
            "url_origen": r["url"],
        })
        if len(leads) >= maximo:
            break
    pausa()
    return leads
