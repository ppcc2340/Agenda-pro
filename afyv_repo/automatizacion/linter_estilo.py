"""
Linter de estilo de AFyV Legal. Hace cumplir 05_guia_de_estilo_bajadas.md.

Devuelve dos listas:
  errores        -> impiden generar la pieza (reglas inequívocas de la guía)
  advertencias   -> se muestran, pero no bloquean (criterio editorial)

No reemplaza al guardarraíl jurídico: este módulo cuida el TONO y la FORMA, no la verdad jurídica.

Uso suelto:  python automatizacion/linter_estilo.py pedido.json
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import limites as L  # noqa: E402

# Emojis y pictogramas (incluye 1️⃣ y variaciones). La viñeta «•» NO cuenta como emoji.
RE_EMOJI = re.compile(
    "[0-9#*]\U0000FE0F?\U000020E3"                       # 1️⃣ (keycap)
    "|[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF\U00002B00-\U00002BFF\U000023E9-\U000023FA\U0000231A-\U0000231B]"
)

MULETILLAS = [
    r"en el mundo actual", r"en la era (?:digital|actual)", r"hoy en d[ií]a", r"\bdescubre\b", r"sum[ée]rgete",
    r"no es solo .{1,40}, es\b", r"no es solo .{1,40} sino\b", r"en un mundo (?:cada vez|donde)",
    r"sin duda alguna", r"revoluciona", r"lleva (?:tu|su) .{1,20} al siguiente nivel", r"desbloquea",
    r"\bpotencia tu\b", r"te invitamos a conocer",
]

# La guía pide tuteo. Se marcan usted/ustedes y el imperativo formal más común en captions.
RE_USTED = re.compile(r"\busted(?:es)?\b|\bcont[áa]ctenos\b|\bescr[íi]banos\b|\bsolicite\b|\bconsulte\b", re.I)

# Estructura de caption de Instagram recomendada: empieza con un emoji de gancho.
RE_INICIA_EMOJI = re.compile(r"^\s*(?:" + RE_EMOJI.pattern + ")")


def _sin_enfasis(t: str) -> str:
    return (t or "").replace("*", "")


def _emojis(t: str) -> list:
    return RE_EMOJI.findall(t.replace("\ufe0f", ""))


# ───────────── legibilidad (Szigriszt-Pazos) ─────────────
_FUERTES = "aeoáéíóúÁÉÍÓÚ"
_DEBILES = "iuüIUÜ"


def silabas(palabra: str) -> int:
    """Aproximación de conteo de sílabas en español (diptongos, hiatos con tilde). Suficiente para un índice."""
    p = re.sub(r"[^a-záéíóúüñ]", "", palabra.lower())
    if not p:
        return 0
    grupos = re.findall(r"[aeiouáéíóúü]+", p)
    n = 0
    for g in grupos:
        n += 1
        # hiato: dos vocales fuertes seguidas, o débil tónica (í, ú) junto a otra vocal
        for a, b in zip(g, g[1:]):
            if (a in "aeoáéó" and b in "aeoáéó") or (a in "íú" and b in "aeiou") or (b in "íú" and a in "aeiou"):
                n += 1
    return max(n, 1)


def legibilidad(texto: str) -> float:
    """Índice Szigriszt-Pazos (0-100+). >65 normal, 50-65 algo difícil, <50 difícil."""
    limpio = RE_EMOJI.sub(" ", texto.replace("\ufe0f", ""))
    palabras = re.findall(r"[A-Za-záéíóúüñÁÉÍÓÚÜÑ]+", limpio)
    frases = [f for f in re.split(r"[.!?…\n]+", limpio) if re.search(r"[A-Za-záéíóúüñ]", f)]
    if not palabras or not frases:
        return 100.0
    sil = sum(silabas(w) for w in palabras)
    return 206.835 - 62.3 * (sil / len(palabras)) - len(palabras) / len(frases)


# ───────────── revisiones ─────────────
def revisar_texto(texto: str, canal: str) -> tuple:
    """canal: 'ig' | 'li' | 'slide'. Devuelve (errores, advertencias)."""
    err, adv = [], []
    t = _sin_enfasis(texto)
    bajo = t.lower()

    for pat in MULETILLAS:
        m = re.search(pat, bajo)
        if m:
            err.append(f"[{canal}] muletilla de texto automático: «{m.group(0)}»")
    if len(re.findall(r"\bclave\b", bajo)) > 1:
        err.append(f"[{canal}] «clave» repetido")
    if RE_USTED.search(t):
        err.append(f"[{canal}] la guía pide tuteo; hay trato de usted: «{RE_USTED.search(t).group(0)}»")
    if "!!" in t or "¡¡" in t:
        err.append(f"[{canal}] signos de exclamación repetidos")
    if t.count("!") > L.EXCLAMACIONES_MAX:
        adv.append(f"[{canal}] más de {L.EXCLAMACIONES_MAX} signos de exclamación")

    if canal == "li" and _emojis(t):
        err.append(f"[li] LinkedIn va sin emojis (hay {len(_emojis(t))})")

    if canal == "ig":
        for i, linea in enumerate(t.split("\n"), 1):
            n = len(_emojis(linea))
            if n > L.EMOJIS_POR_LINEA_MAX:
                err.append(f"[ig] línea {i}: {n} emojis (máx. {L.EMOJIS_POR_LINEA_MAX} por viñeta)")
        if not RE_INICIA_EMOJI.match(t):
            adv.append("[ig] el gancho debería empezar con un emoji (estructura de la guía)")
        a, b = L.IG_RECOMENDADO
        if not a <= len(t) <= b:
            adv.append(f"[ig] largo {len(t)} caracteres; la guía recomienda {a}–{b}")
        if t.count("\n\n") < 2:
            adv.append("[ig] pocos párrafos: la guía pide gancho, explicación y bloques separados")

    if canal in ("ig", "li"):
        lg = legibilidad(t)
        if lg < L.LEGIBILIDAD_MIN:
            adv.append(f"[{canal}] legibilidad Szigriszt-Pazos {lg:.0f} (<{L.LEGIBILIDAD_MIN}): frases largas o palabras técnicas")
        largas = [f for f in re.split(r"(?<=[.!?])\s+", t) if len(f.split()) > 38]
        if largas:
            adv.append(f"[{canal}] {len(largas)} frase(s) de más de 38 palabras; la guía pide frases cortas")
    return err, adv


def revisar_post(post: dict) -> tuple:
    err, adv = [], []
    for canal, clave in (("ig", "ig"), ("li", "li")):
        e, a = revisar_texto(post.get(clave, ""), canal)
        err += e
        adv += a
    for k, s in enumerate(post.get("slides", []), 1):
        for campo in ("t", "x"):
            e, a = revisar_texto(s.get(campo, ""), "slide")
            err += [f"lámina {k}: {x}" for x in e]
            adv += [f"lámina {k}: {x}" for x in a]
    return list(dict.fromkeys(err)), list(dict.fromkeys(adv))


if __name__ == "__main__":
    datos = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    malos = 0
    for p in (datos if isinstance(datos, list) else [datos]):
        e, a = revisar_post(p)
        print(f"{'✗' if e else '✓'} {p.get('tema', '?')}")
        for x in e:
            print("   ERROR :", x)
        for x in a:
            print("   aviso :", x)
        malos += bool(e)
    sys.exit(1 if malos else 0)
