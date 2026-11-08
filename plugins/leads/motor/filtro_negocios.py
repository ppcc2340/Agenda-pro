"""Descarta negocios que no son pymes objetivo: cadenas grandes (nacionales o internacionales, con
respaldo legal propio) y lugares públicos o del Estado."""
import re

# Marcas/cadenas grandes (se buscan en el nombre y en el dominio del correo/web)
CADENAS = [
    # marcas que necesitan palabra completa (ver PALABRAS)
    # gimnasios
    "bigg ", "ymca",
    "smart fit", "smartfit", "sportlife", "pacific fitness", "pacificfitness", "energy fitness", "o2 fit", "o2fit",
    "bodytech", "anytime fitness", "curves", "gold's gym", "golds gym", "mindfit",
    # cafeterías y comida
    "starbucks", "juan valdez", "dunkin", "tavelli", "café haití", "cafe haiti", "café haiti", "cafehaiti",
    "café caribe", "cafe caribe", "the coffee", "doggis", "domino's", "dominos", "pizza hut", "papa john", "telepizza",
    "kfc", "burger king", "mcdonald", "subway", "wendy's", "tarragona", "juan maestro", "china wok", "niu sushi",
    "tanta", "ruby tuesday", "chili's", "applebee", "hooters", "johnny rockets", "hard rock", "fogo de chão",
    "big john", "savory", "bravissimo", "freddo", "amorino", "krispy kreme", "cinnabon", "pollo stop", "tip y tap",
    "emporio la rosa", "cassis", "panera rosa", "sushi hoy", "ben & frank", "houm", "toctoc", "vecchiola",
    "bitumix", "sonacol", "ovco", "ovco.cl", "inspira.cl", "cámara chilena", "camara chilena", "galería portales",
    "galeria portales", "patio outlet", "plaza reñaca", "boulevard plaza", "óptica comunal", "optica comunal",
    "centro deportivo comunitario", "aurusjoyeria", "joyería aurus", "joyeria aurus", "castaño.cl", "panadería castaño",
    "entel.cl", "puma.com", "chilemat.cl", "fuente alemana", "melt pizza", "little caesars", "sushi blues", "mamut", "gatsby",
    "dominó", "lomitón", "uncle fletch", "la burguesía", "barbazul", "liguria", "la mar ", "osaka",
    # hoteles
    "accor", "marriott", "hilton", "sheraton", "hyatt", "holiday inn", "ibis", "novotel", "radisson", "atton",
    "best western", "wyndham", "the singular", "w santiago", "ritz", "mandarin oriental", "enjoy", "dreams", "nh hotel",
    # retail, malls y tiendas por departamento
    "mallplaza", "parque arauco", "arauco ", "costanera center", "casacostanera", "mall marina",
    "outlet vivo", "vivo outlet", "mallsyoutletsvivo", "falabella", "ripley", "paris.cl",
    "la polar", "hites", "tricot", "johnson", "h&m", "zara", "adidas", "nike", "the north face",
    "thenorthface", "columbia", "lippi", "doite", "levi", "tommy hilfiger", "guess", "hush puppies",
    "bata ", "skechers", "forus", "rockford", "kayser", "family shop", "fashion's park", "fashions park", "isadora",
    "swarovski", "pandora", "michael kors", "sybilla", "basement", "americanino", "foster", "ellus",
    "rip curl", "billabong", "quiksilver", "volcom", "crocs", "vans ", "converse", "under armour", "new balance",
    "reebok", "asics", "decathlon", "sparta", "lider", "jumbo", "unimarc", "tottus", "santa isabel", "acuenta",
    "ok market", "oxxo", "cruz verde", "salcobrand", "ahumada", "dr. simi", "dr simi", "knop", "sodimac", "easy ",
    "construmart", "imperial", "mts ", "homecenter", "sherwin", "copec", "shell", "petrobras", "aramco",
    "movistar", "claro ", "wom ", "vtr", "gtd", "mundo pacífico", "hendrix", "maicao", "preunic",
    "cannon", "casaideas", "casa ideas", "la fete", "bauducco",
    # bancos, seguros y salud privada grande
    "banco", "bci", "santander", "scotiabank", "itaú", "itau", "coopeuch", "caja los andes", "la araucana", "afp ",
    "isapre", "consalud", "colmena", "cruz blanca", "banmédica", "banmedica", "nueva masvida", "clínica alemana",
    "clinica alemana", "clínica las condes", "clinica las condes", "clínica santa maría", "clinica santa maria",
    "dávila", "davila", "redsalud", "red salud", "integramédica", "integramedica", "megasalud", "achs", "mutual de seguridad",
    "bupa", "uc christus", "ucchristus", "vidaintegra", "unosalud", "uno salud", "medicenter",
    # ópticas, mascotas, flores y otras cadenas
    "gmo", "zeiss", "colorama", "place vendome", "rotter & krauss", "rotter y krauss", "rotterkrauss", "schilling", "econópticas", "econopticas", "opticas lux", "ópticas lux",
    "superzoo", "razas pet", "razaspet", "club de perros y gatos", "clubdeperrosygatos", "pet happy", "pethappy",
    "animal store", "puntomascotas", "punto mascotas", "floresadomicilio", "flores a domicilio", "orocash",
    # inmobiliarias y constructoras grandes, franquicias inmobiliarias
    "century 21", "century21", "c21", "re/max", "remax", "engel & völkers", "engelvoelkers", "engel&völkers",
    "keller williams", "coldwell", "socovesa", "almagro", "imagina.cl", "inmobiliaria imagina",
    "echeverría izquierdo", "echeverria izquierdo", "salfa", "besalco", "moller", "sigro", "ingevec", "aconcagua",
    "simonetti", "enaco", "ralei", "pocuro", "brotec", "property partners", "ppartnersgroup", "sento",
    "paz corp", "pazcorp", "inmobiliaria paz", "eurocorp", "armas ", "icafal", "tecsa", "inarco",
    # educación grande
    "universidad", "duoc", "inacap", "santo tomás", "santo tomas", "aiep", "ipchile", "british council", "berlitz",
    "wall street english", "instituto chileno norteamericano", "norteamericano", "inlingua", "tronwell", "ef education",
    # transporte y autos
    "starken", "chilexpress", "turbus", "pullman", "latam", "jetsmart", "derco",
    "kaufmann", "bruno fritsch", "gildemeister", "kia ", "toyota", "nissan", "chevrolet", "hyundai", "peugeot",
    "volkswagen", "mercedes", "bmw", "ford ", "suzuki", "mazda", "honda", "midas",
]
# Lugares públicos, del Estado o instituciones sin fines de lucro
# Marcas cortas que solo cuentan como palabra completa en el nombre
PALABRAS = re.compile(r"\b(entel|puma|mango|corona|patagonia|aurus|castaño)\b", re.I)
# Centros comerciales (el negocio ES el mall, no una tienda dentro de él)
MALLS = re.compile(r"^(mall\b|midmall|h mall|easton outlet mall|vivo outlet|mall paseo|mallplaza|portal |"
                   r"fashion's park|patio outlet|plaza reñaca|galería portales|boulevard plaza)", re.I)
PUBLICOS = re.compile(
    r"(municipal|municipalidad|gobierno|ministerio|seremi|servicio de salud|sernatur|injuv|instituto nacional|"
    r"\bind\b|corporaci[oó]n|fundaci[oó]n|junta de vecinos|carabineros|bomberos|ej[eé]rcito|armada|\bfach\b|"
    r"cesfam|consultorio|hospital(?!\s*(cl[ií]nico\s*)?veterinari)|uach\.cl|unab\.cl|uta\.cl|liceo|colegio|jard[ií]n infantil|sala cuna|biblioteca|museo|"
    r"parque |estadio|polideportivo|club deportivo|club de golf|club h[ií]pico|country club|stade |"
    r"^club (alem[aá]n|providencia|vitacura|de golf|de campo|de regatas|ecuestre|militar|naval|social)|\bclub vitacura\b|escuela (b[aá]sica|bernardo|municipal|particular|rep[uú]blica|d-|e-|f-|\d)|"
    r"\.gob\.cl|\bslep|\bdaem\b|\boirs\b|imantof|iglesia|parroquia|centro cultural|teatro municipal|"
    r"registro civil|correos de chile|bancoestado|metro de santiago|codelco|enap\b|junaeb|fonasa)", re.I)


def motivo_negocio(nombre: str, email: str = "", web: str = "") -> str | None:
    n = f" {(nombre or '').lower()} "
    d = f" {(email or '').lower()} {(web or '').lower()} "
    for marca in CADENAS:
        if marca in n or (len(marca) > 4 and marca.replace(" ", "") in d.replace(" ", "")):
            return f"cadena grande ({marca.strip()})"
    if MALLS.search((nombre or "").strip()):
        return "centro comercial"
    if PALABRAS.search(nombre or "") and re.search(r"[\s@./](entel|puma|mango|corona|patagonia|aurus|castaño)\.(cl|com)\b", d):
        return "cadena grande (marca)"
    if PUBLICOS.search(nombre or "") or PUBLICOS.search(email or ""):
        return "lugar público o del Estado"
    return None
