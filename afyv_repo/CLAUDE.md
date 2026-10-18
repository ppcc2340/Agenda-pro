# AFyV Legal · motor de contenido (instrucciones para Claude Code)

Generador de publicaciones (carruseles, imágenes, reels, captions) para un estudio jurídico chileno.
El contenido jurídico es publicidad de abogados: **un error aquí es un riesgo ético y reputacional**. Trabaja con cuidado.

## Comandos
    python afyv.py test                      # suite completa; debe quedar en verde antes de cualquier commit
    python afyv.py validar pedidos/X.json    # guardarraíl + estilo + maquetación, sin generar imágenes
    python afyv.py generar pedidos/X.json --formatos 4x5
    python afyv.py estado                    # vencimiento de fichas
    python afyv.py vigencia                  # contrasta fichas con LeyChile (requiere red)

## Reglas que NO se negocian
1. **Nunca debilites el guardarraíl ni los tests** para que algo pase. Si una pieza se rechaza, se corrige la pieza.
   Un cambio en `guardarrail.py` que haga pasar un caso que antes fallaba requiere un test nuevo y aviso explícito al usuario.
2. **No inventes derecho.** Toda afirmación jurídica sale de una ficha en `base_juridica.json` cuyas citas existen
   palabra por palabra en el texto oficial (`agregar_fichas.py` lo comprueba). Tu memoria no es fuente jurídica.
3. **No edites a mano `fecha_verificacion` ni `estado` en las fichas.** Solo los scripts de verificación los cambian.
4. **Produce solo lo que se pide.** No agregues comandos ni lógica que armen calendarios, series o publicaciones extra.
5. **No publiques automáticamente en redes.** El último filtro es el abogado que firma.
6. Los precios salen únicamente de `fuente_de_verdad.json`, siempre «sin IVA».
7. Los textos del estudio van en español de Chile, tuteo (ver `05_guia_de_estilo_bajadas.md`).

## Mapa
- `automatizacion/limites.py`   límites de largo (única fuente; no los repitas en otros archivos)
- `automatizacion/guardarrail.py`  reglas jurídicas y publicitarias (deterministas)
- `automatizacion/linter_estilo.py`  guía de estilo: muletillas, tuteo, emojis, legibilidad
- `automatizacion/verificar_citas.py` / `agregar_fichas.py` / `verificar_vigencia.py`  base jurídica
- `automatizacion/render_v2.py`  diseño (Pillow); `medir()` detecta texto que no cabe
- `automatizacion/producir.py`  orquesta: estructura → guardarraíl → estilo → desborde → render
- `tests/`  cada test trabaja sobre una copia temporal de los datos

## Pendientes conocidos (ver README)
- `verificar_vigencia.py` nunca se ha ejecutado contra la BCN real (se desarrolló sin red). Primera tarea con red:
  correrlo, inspeccionar la estructura real del XML y ajustar `texto_desde_xml()` si hace falta.
- Falta el flujo de aprobación (borrador → revisado → aprobado) y el «juez» IA opcional.
