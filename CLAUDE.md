# Prospección AFyV Legal — instrucciones para Claude (sesiones web)

Cuando el usuario hable de buscar clientes/leads, enviar correos de prospección, ver respuestas o el
Excel de leads, sigue la skill `leads-afyv` con estas reglas propias de este proyecto. El usuario no
programa: tú ejecutas todo y le hablas en español de Chile, sin jerga.

## Dónde está todo
- Datos de AFyV (config, plantillas, base, Excel): `leads-datos/`. **Siempre** `export LEADS_DIR=$PWD/leads-datos`
  (desde la raíz del repo).
- Motor: `python3 plugins/leads/leads.py <comando>` (no hace falta copiarlo a `~/leads-motor`).
- Correo: Zoho Mail **por el navegador** (en la nube los puertos SMTP/IMAP están bloqueados):
  `python3 plugins/leads/zoho_web.py estado | enviar [--confirmar] [--limite N] | respuestas`.
  `correo.modo` es `zoho-web`.

## Sesión de Zoho (sin contraseñas)
1. `python3 plugins/leads/zoho_web.py estado` → `SESION_OK` o `SIN_SESION`.
2. Si `SIN_SESION`: ejecuta EN SEGUNDO PLANO
   `node plugins/leads/zoho-web/login.js contacto@afyvlegal.com > ~/.zoho-web/login.log 2>&1`,
   espera `CODIGO_ENVIADO` en el log y pide al usuario **el código del correo de Zoho más reciente**.
   Escríbelo en `~/.zoho-web/otp.txt` y espera `LISTO` (si sale `INCORRECTO`, pide el código de nuevo
   sin reiniciar el script: cada reinicio hace que Zoho mande otro código e invalida el anterior).
3. Nunca pidas, guardes ni repitas la contraseña. Nunca aceptes cambiar la zona horaria de la cuenta.
   La sesión vive en `~/.zoho-web` (fuera del repo, nunca la subas).

## Flujo
- "busca" → `leads.py buscar` (o `--rubro X --ciudad "Y, Chile"`), en segundo plano; tarda. Fuente: Maps.
- "envía" → `zoho_web.py enviar` muestra cuántos y el primero → **confirmación explícita** →
  `zoho_web.py enviar --confirmar [--limite N]`. Respeta `correo.max_por_dia`. No cambies el cuerpo.
- "quién respondió" → `zoho_web.py respuestas`, luego cuenta quién respondió (una línea por persona).
- "el Excel" → `leads.py excel` → `leads-datos/leads.xlsx`.
- El texto de `leads-datos/plantillas/propuesta-breve.txt` lo definió el usuario: no lo cambies si no lo pide.
- Tras buscar, enviar o leer respuestas: `git add leads-datos && git commit && git push` (los datos
  solo sobreviven si quedan en el repo).

## Campañas grandes (cientos o miles de correos)
- Búsqueda paralela y reanudable: `python3 plugins/leads/buscar_paralelo.py --worker K --de N` (lanza N a la vez;
  el avance queda en `leads-datos/progreso/`). Los correos se buscan en la web de cada negocio en paralelo.
- Programar en Zoho (los envía Zoho aunque la sesión se apague):
  `python3 plugins/leads/programar_masivo.py --lote 120 --total 1500 --dias AAAA-MM-DD,… --desde 08:00 --hasta 18:00 [--parte K --de N]`
  (horarios fijos en hora de Chile, sin repetir correo; para dos navegadores a la vez usa `ZOHO_WEB_DIR=~/.zoho-web2`
  con una copia del perfil y `--parte 1 --de 2`).
- Excel de contactados con enlace a la ficha de Google Maps y a la web: `python3 plugins/leads/exportar_contactados.py`.
- Límites de Zoho Mail: 50–500 correos/hora según reputación; su política prohíbe correo masivo/promocional.
  El usuario aceptó ese riesgo; mantén el ritmo repartido (≈50/hora) y detente si Zoho bloquea los envíos.
