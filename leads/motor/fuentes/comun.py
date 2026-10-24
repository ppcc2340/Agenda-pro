import random
import re
import time
from html import unescape
from urllib.parse import quote, unquote

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
CABECERAS = {"User-Agent": UA, "Accept-Language": "es-CL,es;q=0.9,en;q=0.8"}

RE_EMAIL = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
RE_TEL = re.compile(r"(\+?\d[\d\s\-().]{7,}\d)")
_EXT_BASURA = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js")


def pausa(a: float = 1.0, b: float = 3.0) -> None:
    time.sleep(random.uniform(a, b))


def obtener(url: str, timeout: int = 15) -> str:
    try:
        r = requests.get(url, headers=CABECERAS, timeout=timeout, allow_redirects=True)
        if r.ok and "text" in r.headers.get("content-type", ""):
            return r.text
    except requests.RequestException:
        pass
    return ""


def extraer_emails(texto: str) -> list[str]:
    vistos, salida = set(), []
    for e in RE_EMAIL.findall(texto or ""):
        e = e.strip(".").lower()
        if e.endswith(_EXT_BASURA) or "example" in e or "sentry" in e or "wix" in e:
            continue
        if e not in vistos:
            vistos.add(e)
            salida.append(e)
    return salida


def dominio(url: str) -> str:
    m = re.match(r"https?://(?:www\.)?([^/]+)", url or "")
    return m.group(1).lower() if m else ""


def buscar_web(consulta: str, maximo: int = 20) -> list[dict]:
    """Búsqueda web genérica: Google Custom Search si hay clave, si no DuckDuckGo HTML."""
    from ..config import env
    clave, cse = env("GOOGLE_API_KEY"), env("GOOGLE_CSE_ID")
    resultados: list[dict] = []
    if clave and cse:
        for inicio in range(1, maximo + 1, 10):
            try:
                r = requests.get("https://www.googleapis.com/customsearch/v1",
                                 params={"key": clave, "cx": cse, "q": consulta, "start": inicio,
                                         "num": min(10, maximo - len(resultados))},
                                 timeout=15)
                items = r.json().get("items", []) if r.ok else []
            except requests.RequestException:
                items = []
            for it in items:
                resultados.append({"titulo": it.get("title", ""), "url": it.get("link", ""),
                                   "resumen": it.get("snippet", "")})
            if len(items) < 10 or len(resultados) >= maximo:
                break
        return resultados[:maximo]

    # Alternativa sin clave: DuckDuckGo (HTML simple, tolera scraping moderado)
    html = ""
    try:
        r = requests.post("https://html.duckduckgo.com/html/", data={"q": consulta},
                          headers=CABECERAS, timeout=20)
        html = r.text if r.ok else ""
    except requests.RequestException:
        pass
    bloques = re.findall(
        r'<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.*?)</a>.*?'
        r'class="result__snippet"[^>]*>(.*?)</a>', html, flags=re.S)
    for href, titulo, resumen in bloques:
        url = href
        m = re.search(r"uddg=([^&]+)", href)
        if m:
            url = unquote(m.group(1))
        resultados.append({"titulo": _limpiar(titulo), "url": url, "resumen": _limpiar(resumen)})
        if len(resultados) >= maximo:
            break
    if resultados:
        return resultados

    # Último recurso: DuckDuckGo con navegador real (supera el desafío anti-bot)
    return _ddg_navegador(consulta, maximo)


def navegador(p):
    """Lanza Chromium headless. CHROMIUM_PATH permite usar un binario ya instalado."""
    from ..config import env
    return p.chromium.launch(headless=True, executable_path=env("CHROMIUM_PATH") or None)


def _ddg_navegador(consulta: str, maximo: int) -> list[dict]:
    from playwright.sync_api import sync_playwright
    resultados = []
    with sync_playwright() as p:
        nav = navegador(p)
        pag = nav.new_page(user_agent=UA, locale="es-CL")
        try:
            pag.goto(f"https://duckduckgo.com/?q={quote(consulta)}&ia=web",
                     wait_until="domcontentloaded", timeout=60000)
            pag.wait_for_selector('[data-testid="result-title-a"]', timeout=20000)
            for _ in range(3):  # "Más resultados"
                if len(pag.query_selector_all('[data-testid="result-title-a"]')) >= maximo:
                    break
                try:
                    pag.get_by_role("button", name="More results").click(timeout=3000)
                    pag.wait_for_timeout(1500)
                except Exception:
                    break
            for art in pag.query_selector_all("article"):
                a = art.query_selector('[data-testid="result-title-a"]')
                sn = art.query_selector('[data-result="snippet"]')
                if a and a.get_attribute("href"):
                    resultados.append({"titulo": a.inner_text().strip(), "url": a.get_attribute("href"),
                                       "resumen": sn.inner_text().strip() if sn else ""})
                if len(resultados) >= maximo:
                    break
        except Exception:
            pass
        nav.close()
    return resultados


def _limpiar(s: str) -> str:
    return unescape(re.sub(r"<[^>]+>", "", s)).strip()
