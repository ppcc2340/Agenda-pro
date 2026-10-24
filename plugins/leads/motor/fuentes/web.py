"""Visita el sitio web de un lead y busca su correo (portada + página de contacto)."""
import re

from .comun import extraer_emails, obtener, pausa

_RUTAS = ("", "/contacto", "/contact", "/contactanos", "/nosotros", "/about")


def encontrar_email(web: str) -> str | None:
    if not web:
        return None
    base = web.rstrip("/")
    if not base.startswith("http"):
        base = "https://" + base
    for ruta in _RUTAS:
        html = obtener(base + ruta)
        if not html:
            continue
        # mailto: primero (más fiable), luego cualquier correo en el texto
        mailto = re.findall(r'mailto:([^"\'?>\s]+)', html)
        emails = extraer_emails(" ".join(mailto)) or extraer_emails(html)
        if emails:
            return emails[0]
        pausa(0.5, 1)
    return None
