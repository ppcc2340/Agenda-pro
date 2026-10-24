"""Google Maps: Places API si hay GOOGLE_API_KEY; si no, scraping con Playwright."""
import re
from urllib.parse import quote

import requests

from ..config import env
from .comun import UA, navegador, pausa


def buscar(rubro: str, ciudad: str, maximo: int = 20) -> list[dict]:
    if env("GOOGLE_API_KEY"):
        return _places_api(rubro, ciudad, maximo)
    return _scraping(rubro, ciudad, maximo)


# ── Opción 1: Places API (New) · estable, requiere clave con facturación ──
def _places_api(rubro, ciudad, maximo):
    leads, token = [], None
    while len(leads) < maximo:
        cuerpo = {"textQuery": f"{rubro} en {ciudad}", "pageSize": min(20, maximo - len(leads))}
        if token:
            cuerpo["pageToken"] = token
        try:
            r = requests.post(
                "https://places.googleapis.com/v1/places:searchText", json=cuerpo, timeout=20,
                headers={"X-Goog-Api-Key": env("GOOGLE_API_KEY"),
                         "X-Goog-FieldMask": "nextPageToken,places.displayName,places.websiteUri,"
                                             "places.nationalPhoneNumber,places.formattedAddress,"
                                             "places.googleMapsUri"})
            datos = r.json() if r.ok else {}
        except requests.RequestException:
            break
        for p in datos.get("places", []):
            leads.append({
                "nombre": p.get("displayName", {}).get("text", ""), "rubro": rubro,
                "ciudad": ciudad, "fuente": "maps", "web": p.get("websiteUri"),
                "telefono": p.get("nationalPhoneNumber"), "direccion": p.get("formattedAddress"),
                "url_origen": p.get("googleMapsUri"),
            })
        token = datos.get("nextPageToken")
        if not token:
            break
    return leads[:maximo]


# ── Opción 2: scraping con navegador · gratis, más lento, puede romperse ──
def _scraping(rubro, ciudad, maximo):
    from playwright.sync_api import sync_playwright

    leads = []
    url = f"https://www.google.com/maps/search/{quote(rubro + ' ' + ciudad)}?hl=es"
    with sync_playwright() as p:
        nav = navegador(p)
        pag = nav.new_page(user_agent=UA, locale="es-CL")
        pag.goto(url, wait_until="domcontentloaded", timeout=60000)
        _aceptar_cookies(pag)
        try:
            pag.wait_for_selector('div[role="feed"]', timeout=20000)
        except Exception:
            nav.close()
            return leads

        # Desplaza el listado hasta reunir suficientes fichas
        enlaces: dict[str, str] = {}
        for _ in range(12):
            for a in pag.query_selector_all('div[role="feed"] a.hfpxzc'):
                href, nombre = a.get_attribute("href"), a.get_attribute("aria-label")
                if href and nombre and href not in enlaces:
                    enlaces[href] = nombre
            if len(enlaces) >= maximo:
                break
            pag.evaluate('document.querySelector(\'div[role="feed"]\').scrollBy(0, 3000)')
            pag.wait_for_timeout(1500)

        # Abre cada ficha para sacar web, teléfono y dirección
        for href, nombre in list(enlaces.items())[:maximo]:
            lead = {"nombre": nombre, "rubro": rubro, "ciudad": ciudad, "fuente": "maps",
                    "url_origen": href}
            try:
                pag.goto(href, wait_until="domcontentloaded", timeout=45000)
                pag.wait_for_timeout(2000)
                web = pag.query_selector('a[data-item-id="authority"]')
                tel = pag.query_selector('button[data-item-id^="phone:tel:"]')
                dire = pag.query_selector('button[data-item-id="address"]')
                lead["web"] = web.get_attribute("href") if web else None
                if tel:
                    lead["telefono"] = (tel.get_attribute("data-item-id") or "")[10:] or None
                if dire:
                    lead["direccion"] = re.sub(r"^\S+\s", "", dire.get_attribute("aria-label") or "")
            except Exception:
                pass
            leads.append(lead)
            pausa(1, 2)
        nav.close()
    return leads


def _aceptar_cookies(pag):
    for texto in ("Aceptar todo", "Accept all", "Acepto"):
        try:
            pag.get_by_role("button", name=texto).first.click(timeout=3000)
            return
        except Exception:
            continue
