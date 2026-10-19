"""Genera demo/desktop.html y demo/mobile.html autocontenidos a partir de src/."""
import pathlib
src = pathlib.Path(__file__).parent
out = src.parent
rd = lambda n: (src / n).read_text(encoding="utf-8")
FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@500;600;700&family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">'

def page(title, css, body, js):
    return f'''<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{title}</title>
{FONTS}
<style>
{rd("shared.css")}
{css}
</style>
</head>
<body>
{body}
<script>
{rd("shared.js")}
{js}
</script>
</body>
</html>
'''

desktop_body = '''<div class="app" id="app"></div>
<div class="ov" id="pal" hidden><div class="pal" role="dialog" aria-modal="true" aria-label="Capturar o buscar">
  <input id="pal-in" placeholder="Captura algo o busca: Informe para Acme el jueves, 2 h" autocomplete="off" aria-label="Capturar o buscar">
  <div id="pal-body"></div><div class="tip">Enter elige. Esc cierra. Meri entiende fechas, clientes y duraciones.</div></div></div>
<div class="ov" id="modal" hidden></div>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>'''
(out / "desktop.html").write_text(page("Meri: demo de escritorio", rd("desktop.css"), desktop_body, rd("desktop.js")), encoding="utf-8")

if (src / "mobile.js").exists():
    mobile_body = '''<div class="stage"><div class="phone" id="phone">
  <div class="sbar" aria-hidden="true"><span class="num">10:40</span><span>Demo</span></div>
  <div class="screen" id="screen"></div>
  <button class="fab" id="fab" data-act="sheet-capture" aria-label="Capturar">+</button>
  <nav class="tabbar" id="tabbar" aria-label="Áreas"></nav>
  <div class="sheet-wrap" id="sheet" hidden></div>
  <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
</div></div>'''
    (out / "mobile.html").write_text(page("Meri: demo móvil", rd("mobile.css"), mobile_body, rd("mobile.js")), encoding="utf-8")
print("ok")
