"""
Motor de diseño AFyV (v2). Convierte salida/contenido.json en piezas listas para publicar:

  salida/diseno/<ID>/4x5/NN.jpg      Instagram feed (carrusel)           1080x1350
  salida/diseno/<ID>/1x1/NN.jpg      Instagram/Facebook/LinkedIn cuadrado 1080x1080
  salida/diseno/<ID>/9x16/NN.jpg     Historias / fondos de Reel           1080x1920
  salida/diseno/<ID>/191x1/portada.jpg  LinkedIn/Twitter (enlace)         1200x627
  salida/diseno/<ID>/linkedin.pdf    Carrusel como documento de LinkedIn
  salida/diseno/<ID>/reel.mp4        Reel 9:16 animado (sin audio)

Lenguaje visual (tomado de afyvlegal.com): papel crema, numeración de títulos y cláusulas (Título I · / §),
sello de "entregable firmado", "Nota del equipo", fuente citada al pie. Detalles de mano: grano de papel,
subrayado trazado a mano, sello con tinta desgastada y notas levemente inclinadas.

Uso:  python automatizacion/render_v2.py [--solo AFV-021] [--sin-reel] [--formatos 4x5,1x1,9x16,191x1]
"""
import argparse
import json
import math
import random
import shutil
import subprocess
import sys
import tempfile
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageColor, ImageDraw, ImageFilter, ImageFont

RAIZ = Path(__file__).resolve().parent.parent
ASSETS = RAIZ / "assets"
SALIDA = RAIZ / "salida" / "diseno"

_marca = json.loads((ASSETS / "marca.json").read_text(encoding="utf-8"))
TOK = _marca["colores"]
SERIES = _marca["series"]
FORMATOS = {"4x5": (1080, 1350), "1x1": (1080, 1080), "9x16": (1080, 1920)}
AVISO_CORTO = "Información general; no constituye asesoría legal."
AVISOS = []            # desbordes detectados durante el render (ver medir())
_CTX = {"pieza": ""}   # contexto para describir dónde ocurrió
CONTACTO = {"WhatsApp": "+56 9 8171 4111", "Correo": "contacto@afyvlegal.com", "Web": "afyvlegal.com"}


# ───────────────────────── tipografía y utilidades ─────────────────────────
def ruta_fuente(nombre):
    """Busca la tipografía en assets/ y, si no está, en las fuentes del sistema (Google Fonts)."""
    for d in (ASSETS, Path("/usr/share/fonts/truetype/google-fonts"), Path("/usr/share/fonts/truetype/lora"),
              Path("/usr/share/fonts/truetype/poppins")):
        if (d / nombre).exists():
            return str(d / nombre)
    raise FileNotFoundError(f"No encuentro la tipografía {nombre}. Cópiala a assets/ (Lora y Poppins son libres, Google Fonts).")


@lru_cache(None)
def lora(size, peso=700, cursiva=False):
    f = ImageFont.truetype(ruta_fuente("Lora-Italic-Variable.ttf" if cursiva else "Lora-Variable.ttf"), size)
    try:
        f.set_variation_by_axes([peso])
    except Exception:
        pass
    return f


@lru_cache(None)
def poppins(size, medio=False):
    return ImageFont.truetype(ruta_fuente("Poppins-Medium.ttf" if medio else "Poppins-Regular.ttf"), size)


def rgb(c):
    return ImageColor.getrgb(c)


def tokens(texto):
    """Divide en palabras; *así* marca énfasis (puede abarcar varias palabras)."""
    out, abierto = [], False
    for w in (texto or "").split():
        n = w.count("*")
        e = abierto or n > 0
        if n == 1:
            abierto = not abierto
        out.append((w.replace("*", ""), e or w.startswith("$")))
    return out


def envolver(d, toks, fuente, ancho, fuente_em=None):
    lineas, actual, wa = [], [], 0.0
    esp = d.textlength(" ", font=fuente)
    for palabra, em in toks:
        f = fuente_em if (em and fuente_em) else fuente
        w = d.textlength(palabra, font=f)
        extra = esp if actual else 0
        if actual and wa + extra + w > ancho:
            lineas.append(actual)
            actual, wa, extra = [], 0.0, 0
        actual.append((palabra, em, w))
        wa += extra + w
    if actual:
        lineas.append(actual)
    return lineas


def subrayado(d, x0, x1, y, color, rng, grosor=6):
    """Subrayado como de marcador: dos pasadas, ligeramente irregulares."""
    for pasada in range(2):
        pts, x, k = [], x0 - 4 + rng.uniform(-3, 3), 0
        fin = x1 + 4 + rng.uniform(-4, 4)
        while x < fin:
            pts.append((x, y + math.sin(k * 0.9 + pasada) * 1.8 + rng.uniform(-1.3, 1.3) + pasada * 5))
            x += 12
            k += 1
        pts.append((fin, y + rng.uniform(-1.5, 1.5) + pasada * 5))
        d.line(pts, fill=color, width=max(2, int(grosor - pasada * 2.5)), joint="curve")


def bloque(d, texto, fab, x, y, ancho, alto, tam_max, tam_min, inter, color, color_em=None, fab_em=None,
           subrayar=False, visible=None, rng=None, acento=None):
    toks = tokens(texto)
    f = fe = None
    for tam in range(tam_max, tam_min - 1, -2):
        f = fab(tam)
        fe = fab_em(tam) if fab_em else None
        lineas = envolver(d, toks, f, ancho, fe)
        if len(lineas) * tam * inter <= alto:
            break
    if f is not None and len(lineas) * tam * inter > alto * 1.02 and visible is None:
        AVISOS.append(f"{_CTX['pieza']}: el texto no cabe ni con la letra mínima ({tam}px, {len(lineas)} líneas "
                      f"para {int(alto)}px de alto): «{texto.replace('*', '')[:50]}…»")
    total = len(toks)
    limite = total if visible is None else math.ceil(visible * total - 1e-9)
    n, yy = 0, y
    esp = d.textlength(" ", font=f)
    for ln in lineas:
        xx = x
        for palabra, em, w in ln:
            n += 1
            if n <= limite:
                d.text((xx, yy), palabra, font=(fe if (em and fe) else f), fill=(color_em if (em and color_em) else color))
                if em and subrayar and not palabra.startswith("$"):
                    subrayado(d, xx, xx + w, yy + tam * 1.03, acento or rgb(TOK["acento"]), rng)
            xx += w + esp
        yy += int(tam * inter)
    return yy, tam


# ───────────────────────── papel, sello, nota ─────────────────────────
_textura = {}


def papel(W, H, color):
    if (W, H) not in _textura:
        r = np.random.default_rng(11)
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        dist = ((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2
        mult = (1 - 0.04 * np.clip(dist - 0.25, 0, None))[..., None].astype(np.float32)
        _textura[(W, H)] = (mult, r.normal(0, 1, (H, W, 1)).astype(np.float32))
    mult, grano = _textura[(W, H)]
    base = np.empty((H, W, 3), np.float32)
    base[...] = rgb(color)
    return Image.fromarray(np.clip(base * mult + grano * 1.7, 0, 255).astype("uint8"))


def pegar(img, capa, centro):
    img.paste(capa, (int(centro[0] - capa.width / 2), int(centro[1] - capa.height / 2)), capa)


def sello(img, centro, texto, tam, angulo, color, semilla, alfa=1.0, escala=1.0):
    """Sello de goma: 'tam' ≈ ancho aproximado del sello. Tinta desgastada y ligeramente inclinado."""
    f = poppins(max(12, int(tam * 0.15)), True)
    tmp = ImageDraw.Draw(Image.new("L", (4, 4)))
    lineas = texto.split("\n")
    track = tam * 0.012
    anchos = [tmp.textlength(l, font=f) + len(l) * track for l in lineas]
    w, h = int(max(anchos) + tam * 0.34), int(len(lineas) * tam * 0.24 + tam * 0.26)
    capa = Image.new("RGBA", (w + 24, h + 24), (0, 0, 0, 0))
    d = ImageDraw.Draw(capa)
    col = rgb(color) + (255,)
    d.rounded_rectangle([12, 12, w + 12, h + 12], radius=int(tam * 0.06), outline=col, width=max(3, int(tam * 0.022)))
    d.rounded_rectangle([20, 20, w + 4, h + 4], radius=int(tam * 0.04), outline=col, width=max(1, int(tam * 0.008)))
    y = 12 + (h - len(lineas) * tam * 0.22) / 2
    for l, a in zip(lineas, anchos):
        x = 12 + (w - a) / 2
        for ch in l:                                  # letras con tracking
            d.text((x, y), ch, font=f, fill=col)
            x += d.textlength(ch, font=f) + track
        y += tam * 0.24
    arr = np.array(capa)
    r = np.random.default_rng(semilla)
    ruido = Image.fromarray((r.random(arr.shape[:2]) * 255).astype("uint8")).filter(ImageFilter.GaussianBlur(1.3))
    nm = np.asarray(ruido).astype(np.float32)
    nm = (nm - nm.min()) / (nm.max() - nm.min() + 1e-6)
    arr[..., 3] = (arr[..., 3] * np.where(nm > 0.32, 1.0, 0.22) * alfa).astype("uint8")   # tinta desgastada
    capa = Image.fromarray(arr)
    if escala != 1.0:
        capa = capa.resize((int(capa.width * escala), int(capa.height * escala)), Image.LANCZOS)
    pegar(img, capa.rotate(angulo, expand=True, resample=Image.BICUBIC), centro)


def texto_inclinado(img, xy, texto, fuente, color, angulo):
    tmp = ImageDraw.Draw(Image.new("L", (4, 4)))
    w, h = int(tmp.textlength(texto, font=fuente)) + 20, int(fuente.size * 1.5)
    capa = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(capa).text((10, 4), texto, font=fuente, fill=rgb(color) + (255,))
    capa = capa.rotate(angulo, expand=True, resample=Image.BICUBIC)
    img.paste(capa, (int(xy[0]), int(xy[1])), capa)


def postit(img, x, y, ancho, texto, s, angulo=-1.6):
    f = lora(int(30 * s), 500, True)
    tmp = ImageDraw.Draw(Image.new("L", (4, 4)))
    lineas = envolver(tmp, tokens(texto), f, ancho - 48 * s)
    alto = int(len(lineas) * 30 * s * 1.35 + 40 * s)
    capa = Image.new("RGBA", (int(ancho) + 16, alto + 16), (0, 0, 0, 0))
    d = ImageDraw.Draw(capa)
    d.rectangle([10, 12, ancho + 10, alto + 12], fill=(0, 0, 0, 38))                 # sombra suave
    d.rectangle([6, 6, ancho + 2, alto + 2], fill=rgb(TOK["nota"]) + (255,))
    yy = 6 + 20 * s
    for ln in lineas:
        d.text((6 + 24 * s, yy), " ".join(w for w, _, _ in ln), font=f, fill=rgb(TOK["tinta"]) + (255,))
        yy += 30 * s * 1.35
    capa = capa.rotate(angulo, expand=True, resample=Image.BICUBIC)
    img.paste(capa, (int(x), int(y)), capa)
    return alto


def _semilla(post):
    """Semilla estable para el desgaste del sello; funciona con cualquier ID (antes exigía terminar en dígitos)."""
    import zlib
    return zlib.crc32(str(post.get("id", "")).encode()) % 1000


def etiqueta_norma(post):
    """Texto del sello según las fichas realmente usadas (antes decía siempre 'LEY 19.039')."""
    try:
        base = json.loads((RAIZ / "base_juridica.json").read_text(encoding="utf-8"))
        fich = {f["id"]: f for f in base["fichas"]}
        nums = []
        for i in post.get("fichas", []):
            n = fich.get(i, {}).get("norma_numero", "19.039")
            if n not in nums:
                nums.append(n)
    except Exception:
        nums = ["19.039"]
    if not nums:
        nums = ["19.039"]
    return ("LEY " + nums[0]) if len(nums) == 1 else ("LEYES " + " · ".join(nums[:3]))


def romano(n):
    return ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII"][n]


def serie(post):
    s = SERIES.get(post["pilar"], "· " + post["pilar"])
    return s, s.split(" ")[0]          # "I · Marcas", "I"


# ───────────────────────── composición de páginas ─────────────────────────
def kt(W, H):
    return 1.3 if H / W > 1.6 else 1.0          # en 9:16 el texto se agranda para no dejar vacíos


def geometria(W, H):
    s = W / 1080
    alta = H / W > 1.6
    top = int(0.125 * H) if alta else int(0.07 * H)
    bottom = int(0.17 * H) if alta else int(0.07 * H)
    return s, int(0.085 * W), top, bottom


def cabecera(img, d, W, s, mx, top, oscuro, derecha):
    tinta = TOK["papel"] if oscuro else TOK["tinta"]
    logo = ASSETS / "logo.png"
    if logo.exists():
        lg = Image.open(logo).convert("RGBA")
        lg.thumbnail((int(300 * s), int(70 * s)))
        img.paste(lg, (mx, top), lg)
    else:
        d.text((mx, top), "AFyV", font=lora(int(54 * s)), fill=tinta)
        d.text((mx + int(150 * s), top + int(22 * s)), "L E G A L", font=poppins(int(21 * s), True),
               fill=TOK["acento_claro"] if oscuro else TOK["acento"])
    if derecha:
        f = poppins(int(22 * s), True)
        d.text((W - mx - d.textlength(derecha, font=f), top + int(18 * s)), derecha, font=f,
               fill=TOK["acento_claro"] if oscuro else TOK["gris"])
    d.line([(mx, top + int(88 * s)), (W - mx, top + int(88 * s))], fill=TOK["acento"] if oscuro else TOK["regla"], width=2)


def pie(d, W, H, s, mx, bottom, oscuro):
    y = H - bottom
    c = "#cfd9d3" if oscuro else TOK["gris"]
    d.line([(mx, y - int(16 * s)), (W - mx, y - int(16 * s))], fill=TOK["acento"] if oscuro else TOK["regla"], width=2)
    d.text((mx, y), "afyvlegal.com  ·  @afyvlegal", font=poppins(int(22 * s), True), fill=c)
    f = poppins(int(18 * s))
    d.text((W - mx - d.textlength(AVISO_CORTO, font=f), y + int(3 * s)), AVISO_CORTO, font=f, fill=c)


def marca_agua(img, W, H, numeral, color):
    capa = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    f = lora(int(W * 0.62), 700, True)
    ImageDraw.Draw(capa).text((int(W * 0.50), int(H * 0.42)), numeral, font=f, fill=rgb(color) + (22,))
    img.paste(capa, (0, 0), capa)


def portada(post, W, H, vis, rng):
    s, mx, top, bottom = geometria(W, H)
    img = papel(W, H, TOK["papel"])
    _, num = serie(post)
    marca_agua(img, W, H, num, TOK["acento"])
    d = ImageDraw.Draw(img)
    n = len(post["slides"]) + (1 if post["formato"] == "Carrusel" else 0)
    cabecera(img, d, W, s, mx, top, False, f"Título {serie(post)[0]}".upper())
    sl = post["slides"][0]
    yb = top + int(130 * s)
    d.text((mx, yb), f"({post['id'][-3:]})", font=lora(int(34 * s), 500, True), fill=TOK["acento"])
    y0 = yb + int(70 * s)
    vt = None if vis is None else vis.get("t", 1)
    vx = None if vis is None else vis.get("x", 1)
    k = kt(W, H)
    yf, _ = bloque(d, sl["t"], lambda z: lora(z), mx, y0, W - 2 * mx, int(0.36 * H), int(112 * s * min(k, 1.18)), int(56 * s), 1.12,
                   TOK["tinta"], TOK["tinta"], None, True, vt, rng)
    bloque(d, sl["x"], poppins, mx, yf + int(26 * s), W - 2 * mx, int(0.15 * H), int(40 * s * k), int(28 * s), 1.4,
           TOK["gris"], TOK["acento"], lambda z: poppins(z, True), False, vx, rng)
    if post["formato"] == "Carrusel":
        yd = H - bottom - int(0.085 * H)
        d.text((mx, yd), "Desliza", font=poppins(int(30 * s), True), fill=TOK["acento"])
        ax, ay = mx + int(120 * s), yd + int(18 * s)
        d.line([(ax, ay), (ax + 48 * s, ay)], fill=TOK["acento"], width=4)
        d.line([(ax + 36 * s, ay - 12 * s), (ax + 48 * s, ay), (ax + 36 * s, ay + 12 * s)], fill=TOK["acento"], width=4)
    else:
        d.text((mx, H - bottom - int(0.085 * H)), f"WhatsApp {CONTACTO['WhatsApp']}  ·  {CONTACTO['Correo']}",
               font=poppins(int(26 * s), True), fill=TOK["acento"])
    if post.get("modo") == "juridico":
        sello(img, (W - mx - 0.19 * W, H - bottom - 0.15 * H), "VERIFICADO\n" + etiqueta_norma(post), 0.21 * W, -7, TOK["acento"],
              _semilla(post), 0.95)
    pie(d, W, H, s, mx, bottom, False)
    if vis and vis.get("prog"):
        barra(d, W, mx, top, s, vis["prog"])
    return img


def barra(d, W, mx, top, s, prog):
    i, n = prog
    y = top - int(26 * s)
    d.line([(mx, y), (W - mx, y)], fill=TOK["regla"], width=5)
    d.line([(mx, y), (mx + (W - 2 * mx) * (i + 1) / n, y)], fill=TOK["acento"], width=5)


def contenido(post, idx, W, H, vis, rng):
    s, mx, top, bottom = geometria(W, H)
    img = papel(W, H, TOK["papel"])
    d = ImageDraw.Draw(img)
    n = len(post["slides"]) + 1
    d.rectangle([0, 0, int(14 * s), H], fill=TOK["acento"])
    cabecera(img, d, W, s, mx, top, False, f"{idx + 1}/{n}")
    sl = post["slides"][idx]
    hb = top + int(100 * s) + (int(0.10 * H) if H / W > 1.6 else 0)     # en 9:16 el bloque baja para no dejar vacío abajo
    texto_inclinado(img, (mx - 6, hb + int(0.012 * H)), f"§ {idx}", lora(int(58 * s), 600, True), TOK["acento"], 2.0)
    yt = hb + int(0.012 * H) + int(84 * s)
    vt = None if vis is None else vis.get("t", 1)
    vx = None if vis is None else vis.get("x", 1)
    k = kt(W, H)
    alto_t = max(int(230 * s), min(int(0.2 * H), int(520 * s)))
    yf, _ = bloque(d, sl["t"], lambda z: lora(z), mx, yt, W - 2 * mx, alto_t, int(92 * s * k), int(46 * s), 1.14,
                   TOK["tinta"], TOK["tinta"], None, True, vt, rng)
    ref = sl.get("ref")
    nota = sl.get("nota")
    ref_top = H - bottom - int(0.17 * H) if ref else H - bottom - int(0.04 * H)
    nota_alto = int(120 * s * min(kt(W, H), 1.2)) if nota else 0
    fin_cuerpo = ref_top - nota_alto - int(26 * s)
    bloque(d, sl["x"], poppins, mx, yf + int(24 * s), W - 2 * mx, max(int(120 * s), fin_cuerpo - yf - int(24 * s)),
           int(50 * s * k), int(27 * s), 1.45, TOK["tinta"], TOK["acento"], lambda z: poppins(z, True), False, vx, rng)
    if nota and (vis is None or vis.get("nota", True)):
        postit(img, mx, ref_top - nota_alto - int(10 * s), W - 2 * mx - int(40 * s), nota, s * min(k, 1.2))
    if ref and (vis is None or vis.get("ref", True)):
        d.line([(mx, ref_top + int(12 * s)), (mx, ref_top + int(100 * s))], fill=TOK["acento"], width=5)
        d.text((mx + int(24 * s), ref_top + int(8 * s)), "F U E N T E", font=poppins(int(20 * s), True), fill=TOK["acento"])
        d.text((mx + int(24 * s), ref_top + int(46 * s)), ref, font=poppins(int(30 * s), True), fill=TOK["tinta"])
    pie(d, W, H, s, mx, bottom, False)
    if vis and vis.get("prog"):
        barra(d, W, mx, top, s, vis["prog"])
    return img


def cierre(post, W, H, vis, rng):
    s, mx, top, bottom = geometria(W, H)
    img = papel(W, H, TOK["acento"])
    d = ImageDraw.Draw(img)
    n = len(post["slides"]) + 1
    cabecera(img, d, W, s, mx, top, True, f"{n}/{n}")
    hb = top + int(150 * s)
    d.text((mx, hb), post.get("cta_titulo") or "¿Hablamos?", font=lora(int(124 * s)), fill=TOK["papel"])
    d.line([(mx, hb + int(160 * s)), (mx + int(90 * s), hb + int(160 * s))], fill=TOK["acento_claro"], width=5)
    txt = post.get("cta_texto") or "Cuéntanos qué necesitas. Te respondemos con una propuesta de precio fijo y alcance claro."
    yf, _ = bloque(d, txt, poppins, mx, hb + int(196 * s), W - 2 * mx, int(0.2 * H), int(44 * s), int(30 * s), 1.4,
                   "#e8f0eb", "#ffffff", lambda z: poppins(z, True), False, None, rng)
    y = yf + int(34 * s)
    for k, v in CONTACTO.items():
        d.text((mx, y), k.upper(), font=poppins(int(21 * s), True), fill=TOK["acento_claro"])
        d.text((mx, y + int(30 * s)), v, font=poppins(int(42 * s), True), fill=TOK["papel"])
        y += int(112 * s)
    pie(d, W, H, s, mx, bottom, True)
    est = (1.0, 1.0) if vis is None else vis.get("sello", (1.0, 1.0))
    if est is not None:
        sello(img, (W - mx - 0.20 * W, H - bottom - 0.20 * H), "FIRMADO\nAFyV LEGAL", 0.23 * W, -8, TOK["papel"],
              77, 0.95 * est[1], est[0])
    return img


def paisaje(post, rng):
    """LinkedIn/Twitter 1200x627: portada horizontal."""
    W, H = 1200, 627
    img = papel(W, H, TOK["papel"])
    _, num = serie(post)
    capa = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(capa).text((int(W * 0.66), -int(H * 0.18)), num, font=lora(int(H * 1.25), 700, True),
                              fill=rgb(TOK["acento"]) + (22,))
    img.paste(capa, (0, 0), capa)
    d = ImageDraw.Draw(img)
    mx, top, s = 64, 44, 0.8
    cabecera(img, d, W, s, mx, top, False, f"Título {serie(post)[0]}".upper())
    sl = post["slides"][0]
    yf, _ = bloque(d, sl["t"], lambda z: lora(z), mx, 150, 700, 280, 78, 40, 1.12, TOK["tinta"], TOK["tinta"], None, True, None, rng)
    bloque(d, sl["x"], poppins, mx, yf + 14, 640, 90, 28, 20, 1.4, TOK["gris"], TOK["acento"], lambda z: poppins(z, True), False, None, rng)
    d.text((mx, H - 52), "afyvlegal.com  ·  @afyvlegal", font=poppins(18, True), fill=TOK["gris"])
    if post.get("modo") == "juridico":
        sello(img, (W - 170, H - 150), "VERIFICADO\n" + etiqueta_norma(post), 170, -7, TOK["acento"], _semilla(post), 0.95)
    return img


def pagina(post, idx, formato, vis=None):
    W, H = FORMATOS[formato]
    rng = random.Random(f"{post['id']}-{idx}")
    n = len(post["slides"])
    if idx == 0:
        return portada(post, W, H, vis, rng)
    if idx < n:
        return contenido(post, idx, W, H, vis, rng)
    return cierre(post, W, H, vis, rng)


# ───────────────────────── reel animado ─────────────────────────
def secuencia_reel(post):
    """Lista de (imagen 1080x1920, segundos). Estilo 'animación de papel': el contenido se arma por pasos."""
    n = len(post["slides"])
    total = n + (1 if post["formato"] == "Carrusel" else 0)
    prog = lambda i: (i, total)
    seq = [(pagina(post, 0, "9x16", dict(t=0.0, x=0.0, prog=prog(0))), 0.45),
           (pagina(post, 0, "9x16", dict(t=0.5, x=0.0, prog=prog(0))), 0.45),
           (pagina(post, 0, "9x16", dict(t=1.0, x=0.0, prog=prog(0))), 0.55),
           (pagina(post, 0, "9x16", dict(t=1.0, x=1.0, prog=prog(0))), 1.8)]
    for i in range(1, n):
        x = post["slides"][i]["x"]
        hold = min(4.6, max(1.8, 0.032 * len(x) + 0.7))
        base = dict(prog=prog(i))
        seq += [(pagina(post, i, "9x16", dict(base, t=0.5, x=0, ref=False, nota=False)), 0.35),
                (pagina(post, i, "9x16", dict(base, t=1.0, x=0, ref=False, nota=False)), 0.4),
                (pagina(post, i, "9x16", dict(base, t=1.0, x=0.4, ref=False, nota=False)), 0.45),
                (pagina(post, i, "9x16", dict(base, t=1.0, x=0.75, ref=False, nota=False)), 0.45),
                (pagina(post, i, "9x16", dict(base, t=1.0, x=1.0, ref=False, nota=False)), 0.5),
                (pagina(post, i, "9x16", dict(base, t=1.0, x=1.0, ref=True, nota=True)), hold)]
    if post["formato"] == "Carrusel":
        seq += [(pagina(post, n, "9x16", dict(sello=None)), 1.6),
                (pagina(post, n, "9x16", dict(sello=(1.7, 0.35))), 0.12),
                (pagina(post, n, "9x16", dict(sello=(1.2, 0.8))), 0.1),
                (pagina(post, n, "9x16", dict(sello=(1.0, 1.0))), 3.0)]
    return seq


def hacer_reel(post, destino):
    tmp = Path(tempfile.mkdtemp(prefix="reel_"))
    lista = []
    try:
        for k, (img, seg) in enumerate(secuencia_reel(post)):
            r = tmp / f"f{k:03d}.jpg"
            img.save(r, "JPEG", quality=93)
            lista.append(f"file '{r}'\nduration {seg}")
        lista.append(f"file '{r}'")
        (tmp / "lista.txt").write_text("\n".join(lista), encoding="utf-8")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(tmp / "lista.txt"),
               "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "21", "-preset", "medium",
               "-movflags", "+faststart", str(destino)]
        subprocess.run(cmd, check=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def medir(post, formatos, reel=False):
    """Renderiza en memoria (sin escribir nada) y devuelve la lista de desbordes. Lista vacía = todo cabe."""
    AVISOS.clear()
    total = len(post["slides"]) + (1 if post["formato"] == "Carrusel" else 0)
    fmts = [f for f in formatos if f != "191x1"] + (["9x16"] if reel and "9x16" not in formatos else [])
    for fmt in dict.fromkeys(fmts):
        for i in range(total):
            _CTX["pieza"] = f"{fmt} lámina {i + 1}"
            pagina(post, i, fmt)
    if "191x1" in formatos:
        _CTX["pieza"] = "191x1 portada"
        paisaje(post, random.Random(post["id"]))
    out = list(dict.fromkeys(AVISOS))
    AVISOS.clear()
    return out


# ───────────────────────── exportación ─────────────────────────
def renderizar(post, formatos, reel=True):
    carpeta = SALIDA / post["id"]
    if carpeta.exists():
        shutil.rmtree(carpeta)
    carpeta.mkdir(parents=True)
    n = len(post["slides"])
    total = n + (1 if post["formato"] == "Carrusel" else 0)
    archivos = {}
    for fmt in formatos:
        if fmt == "191x1":
            (carpeta / "191x1").mkdir()
            paisaje(post, random.Random(post["id"])).save(carpeta / "191x1" / "portada.jpg", "JPEG", quality=90, optimize=True)
            archivos[fmt] = ["portada.jpg"]
            continue
        (carpeta / fmt).mkdir()
        nombres = []
        for i in range(total):
            nom = f"{i + 1:02d}.jpg"
            pagina(post, i, fmt).save(carpeta / fmt / nom, "JPEG", quality=84, optimize=True)
            nombres.append(nom)
        archivos[fmt] = nombres
    if "4x5" in formatos and total > 1:
        pags = [pagina(post, i, "4x5") for i in range(total)]
        pags[0].save(carpeta / "linkedin.pdf", save_all=True, append_images=pags[1:], resolution=100.0)
        archivos["pdf"] = "linkedin.pdf"
    if reel:
        hacer_reel(post, carpeta / "reel.mp4")
        archivos["reel"] = "reel.mp4"
    return archivos


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--solo", default=None, help="ID o lista de IDs separados por coma")
    ap.add_argument("--sin-reel", action="store_true")
    ap.add_argument("--formatos", default="4x5,1x1,9x16,191x1")
    ap.add_argument("--archivo", default=str(RAIZ / "salida" / "contenido.json"))
    a = ap.parse_args()
    ruta = Path(a.archivo)
    posts = json.loads(ruta.read_text(encoding="utf-8"))
    solo = set(a.solo.split(",")) if a.solo else None
    for p in posts:
        if solo and p["id"] not in solo:
            continue
        p["archivos"] = renderizar(p, a.formatos.split(","), reel=not a.sin_reel)
        (SALIDA / p["id"] / "archivos.json").write_text(json.dumps(p["archivos"], ensure_ascii=False), encoding="utf-8")
        print("✓", p["id"], p["tema"], flush=True)
    if not solo:                       # con --solo no se toca contenido.json (permite correr procesos en paralelo)
        ruta.write_text(json.dumps(posts, ensure_ascii=False, indent=2), encoding="utf-8")
