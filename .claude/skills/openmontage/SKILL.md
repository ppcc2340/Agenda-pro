---
name: openmontage
description: Producción de vídeo con IA (OpenMontage). Úsalo cuando el usuario quiera crear, editar o analizar un vídeo — explainer, reel, short, documental, tráiler, anuncio, vídeo con narración o subtítulos, "hazme un vídeo como este" — o pregunte por OpenMontage.
---

# OpenMontage — dentro de este repositorio

OpenMontage está instalado como submódulo de git en `OpenMontage/`
(origen: https://github.com/OpenMontageInc/OpenMontage, licencia AGPLv3).

## 1. Prepararlo (solo si hace falta)

Comprueba desde la raíz del repo; si todo existe, salta al paso 2:

```bash
test -f OpenMontage/AGENT_GUIDE.md && test -x OpenMontage/.venv/bin/python && test -d OpenMontage/remotion-composer/node_modules && echo LISTO
```

Si no está listo (máquina nueva de Claude Code web), instálalo:

```bash
git submodule update --init --depth 1 OpenMontage
cd OpenMontage
# En Claude Code web la descarga directa de PyPI se cuelga; forzamos el proxy para PyPI.
NP=$(printf '%s' "$NO_PROXY" | tr ',' '\n' | grep -vxE 'pypi.org|files.pythonhosted.org' | paste -sd,)
NO_PROXY="$NP" no_proxy="$NP" make setup PYTHON_VERSION=3.11
# Voz offline en español (Piper, gratis):
.venv/bin/python -m piper.download_voices --download-dir ~/.piper/models es_ES-davefx-medium
```

Requisitos ya presentes en Claude Code web: Python 3.11, FFmpeg, Node 22.

## 2. Usarlo

1. Trabaja **dentro de `OpenMontage/`** y con el entorno activado: `source .venv/bin/activate`
   (así se detectan herramientas locales como `piper`).
2. **Lee `OpenMontage/AGENT_GUIDE.md` antes de hacer nada** y sigue sus reglas al pie de la letra
   (onboarding, pipelines, preflight, aprobaciones). Todo vídeo pasa por un pipeline de `pipeline_defs/`.
3. Las claves de APIs de pago (fal.ai, ElevenLabs, OpenAI, Google…) van en `OpenMontage/.env`
   (copia de `.env.example`). **Nunca** las subas a git. Sin claves funciona igual con herramientas
   gratuitas: Remotion, HyperFrames, Piper, metraje de stock gratuito.
4. Prueba rápida sin claves: `make demo-list` y `.venv/bin/python render_demo.py world-in-numbers`
   (deja el MP4 en `projects/demos/renders/`).

## 3. Guardar resultados

La máquina de Claude Code web es temporal. Los vídeos se generan en `OpenMontage/projects/`
(ignorado por git y dentro del submódulo): entrégalos al usuario con la herramienta de enviar
archivos o súbelos donde pida (p. ej. Google Drive). No hagas commits dentro de `OpenMontage/`.
