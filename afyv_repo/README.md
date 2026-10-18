# AFyV Legal · motor de contenido

Genera publicaciones para Instagram y LinkedIn con el diseño de afyvlegal.com, con un guardarraíl que impide
afirmar derecho que no esté respaldado por fichas verificadas contra el texto oficial.

## Instalar
    python -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    # Tipografías libres (Google Fonts) en assets/: Lora-Variable.ttf, Lora-Italic-Variable.ttf,
    # Poppins-Regular.ttf, Poppins-Medium.ttf. Opcional: assets/logo.png (fondo transparente).
    python afyv.py test

## Uso diario
    python afyv.py estado                        # ¿alguna ficha por vencer?
    python afyv.py vigencia                      # reverifica contra LeyChile (necesita red)
    python afyv.py validar pedidos/ejemplo_juridico.json
    python afyv.py generar pedidos/ejemplo_juridico.json --formatos 4x5
Las piezas quedan en `salida/pedidos/<ID>/` (imágenes, `linkedin.pdf`, `textos.md` con la tabla de verificación jurídica).

## Qué se valida antes de generar (todo debe pasar)
1. Estructura y largos (`limites.py`)
2. Guardarraíl jurídico/publicitario (`guardarrail.py`)
3. Estilo (`linter_estilo.py`): muletillas, tuteo, emojis, LinkedIn sin emojis, legibilidad (avisos)
4. Maquetación: que el texto quepa en cada formato pedido (`render_v2.medir`)

## Agregar una ley nueva
1. Descarga el PDF/TXT vigente desde leychile.cl.
2. Redacta `fichas_nuevas.json` (citas literales de máx. 15 palabras).
3. `python afyv.py fichas fichas_nuevas.json ley.pdf --norma "Ley 18.101" --numero 18.101`
   Solo se aceptan las fichas cuyas citas existan palabra por palabra en la ley.
4. Commit de `base_juridica.json`.

## Ojo con
- **Vigencia:** las fichas vencen a los 45 días. `afyv estado` avisa con 10 días de anticipación.
- **`verificar_vigencia.py` no está probado contra la BCN real** (se escribió sin acceso a red); sus tests usan un
  XML simulado. Revisa la primera ejecución a mano.
- El sistema comprueba **textos y citas**, no el criterio jurídico: la revisión final es del abogado que firma.
- Revisa la publicidad contra el Código de Ética del Colegio de Abogados.
