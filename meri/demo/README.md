# Demos de Meri

Dos mockups interactivos, autocontenidos, con datos de ejemplo. No tocan ningún servicio ni guardan nada.

| Archivo | Para qué |
|---|---|
| `desktop.html` | Aplicación en ordenador |
| `mobile.html` | Aplicación en móvil (en pantallas anchas se muestra dentro de un teléfono) |

Ábrelos con doble clic. Las tipografías se cargan de Google Fonts; sin conexión usan las del sistema.

## Qué probar
- **Hoy:** pulsa un bloque de la línea del día para ver por qué está ahí. «Ver cómo reorganizar» abre el diff; acéptalo y luego deshazlo desde el aviso o desde Actividad.
- **Captura:** `Ctrl K` en escritorio o el botón `+` en móvil. Escribe «Informe para Acme el jueves, 2 h» y mira lo que entiende.
- **Entrada:** confirma, edita o descarta propuestas. Lo confirmado pasa a Compromisos.
- **Compromisos:** «Preparar seguimiento» crea un borrador (nunca envía).
- **Tiempo:** aprueba lo sugerido y exporta el CSV.
- **Clientes:** «Generar briefing» muestra cada punto con su fuente.
- **Centro de control:** autonomía, conexiones, créditos y actividad.

## Qué son y qué no
Son la **referencia visual y de textos** para `apps/web` (ver `docs/11-design-system.md`). No son código de producción: el estado vive en memoria y los datos son ficticios.

## Regenerar
El código fuente está en `src/` y `build.py` lo une en los dos HTML:
```bash
python3 demo/src/build.py
```
