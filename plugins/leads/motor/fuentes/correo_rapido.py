"""Búsqueda de correo en el sitio web de un negocio, pensada para correr en muchos hilos a la vez."""
import re

import requests

from .comun import CABECERAS, extraer_emails

_RUTAS = ("", "/contacto", "/contact", "/contactanos")


def encontrar(web: str, timeout: int = 8) -> str | None:
    if not web:
        return None
    base = web.split("?")[0].rstrip("/")
    if not base.startswith("http"):
        base = "https://" + base
    for ruta in _RUTAS:
        try:
            r = requests.get(base + ruta, headers=CABECERAS, timeout=timeout, allow_redirects=True)
        except requests.RequestException:
            if ruta == "":
                return None          # el sitio no responde: no insistir con más páginas
            continue
        if r.status_code >= 400 or "html" not in r.headers.get("content-type", "html"):
            continue
        html = r.text[:600000]
        mailto = re.findall(r'mailto:([^"\'?>\s]+)', html)
        emails = extraer_emails(" ".join(mailto)) or extraer_emails(html)
        if emails:
            return emails[0]
    return None
