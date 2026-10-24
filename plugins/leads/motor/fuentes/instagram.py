"""Instagram: localiza perfiles públicos del rubro y saca correo/web de la biografía.

No requiere iniciar sesión: usa el buscador (site:instagram.com) y lee la etiqueta
pública og:description de cada perfil. Desde IPs de centros de datos Instagram suele
bloquear esa lectura (429 → login); desde una conexión doméstica normalmente funciona.
Aunque no se obtenga el correo, el perfil queda guardado para contactar por mensaje directo.
"""
import re
from html import unescape

from .comun import buscar_web, extraer_emails, obtener, pausa

_RE_PERFIL = re.compile(r"https?://(?:www\.)?instagram\.com/([A-Za-z0-9_.]{2,30})/?(?:\?|$)")
_NO_PERFIL = {"p", "reel", "reels", "explore", "accounts", "stories", "tv", "about", "legal"}


def buscar(rubro: str, ciudad: str, maximo: int = 20) -> list[dict]:
    leads: list[dict] = []
    vistos: set[str] = set()
    for r in buscar_web(f"site:instagram.com {rubro} {ciudad}", maximo * 2):
        m = _RE_PERFIL.match(r["url"])
        if not m or m.group(1).lower() in _NO_PERFIL or m.group(1) in vistos:
            continue
        usuario = m.group(1)
        vistos.add(usuario)
        nombre = _nombre(r["titulo"])
        lead = {"nombre": f"{nombre} (@{usuario})" if nombre else f"@{usuario}", "rubro": rubro, "ciudad": ciudad,
                "fuente": "instagram", "instagram": f"https://instagram.com/{usuario}",
                "url_origen": r["url"]}
        emails = extraer_emails(r["resumen"])
        if not emails:
            bio = _biografia(lead["instagram"])
            emails = extraer_emails(bio)
            web = re.search(r"https?://(?!(?:www\.)?instagram\.com)[^\s\"')]+", bio)
            if web:
                lead["web"] = web.group(0)
        lead["email"] = emails[0] if emails else None
        leads.append(lead)
        if len(leads) >= maximo:
            break
        pausa(1, 2)
    return leads


def _nombre(titulo: str) -> str:
    # "Clínica Sonrisa (@clinicasonrisa) • Instagram photos" → "Clínica Sonrisa"
    return re.split(r"\s*[(@•|]", titulo or "", 1)[0].strip()[:60]


def _biografia(url: str) -> str:
    html = obtener(url)
    m = re.search(r'property="og:description"\s+content="([^"]*)"', html)
    return unescape(m.group(1)) if m else ""
