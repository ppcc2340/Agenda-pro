"""
Límites de contenido en UN solo lugar. Antes estaban repartidos entre las instrucciones,
la guía de estilo y producir.py, y no coincidían.

DUROS  -> si se superan, la pieza NO se genera.
BLANDOS -> el linter de estilo los informa como advertencia (la guía de estilo los recomienda).
"""

# Duros (técnicos o de diseño: si se pasan, el texto no cabe o la plataforma lo corta)
TITULO_MAX = 70          # caracteres, sin los *asteriscos* de énfasis
TEXTO_MAX = 220          # caracteres por lámina
MAX_SLIDES = 8
IG_MAX_DURO = 2200       # límite real de Instagram
LI_MIN, LI_MAX = 250, 3000

# Blandos (guía de estilo, 05_guia_de_estilo_bajadas.md)
IG_RECOMENDADO = (700, 1500)
LEGIBILIDAD_MIN = 50     # Szigriszt-Pazos; bajo 50 = "algo difícil"
EMOJIS_POR_LINEA_MAX = 1
EXCLAMACIONES_MAX = 2

# Vigencia de las fichas (también está en base_juridica.json -> dias_maximos_sin_reverificar)
DIAS_AVISO_PREVIO = 10   # `afyv estado` avisa cuando faltan menos de N días para que venzan
