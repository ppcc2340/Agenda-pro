# Agenda-pro

## Plugins de Claude Code

| Plugin | Qué hace | Instalar |
|---|---|---|
| [`leads`](plugins/leads/) | Motor de leads: busca clientes en Google, Maps e Instagram, les escribe desde tu Gmail vía Claude y exporta a Excel quién respondió. Manual: [`plugins/leads/MANUAL.pdf`](plugins/leads/MANUAL.pdf) | **Claude Code local:** `/plugin install leads --marketplace ppcc2340/Agenda-pro` (o el zip). **Claude Code web / sin plugins:** abre este repo y ya está — la skill `.claude/skills/leads` lo carga sola; los datos quedan en `leads-datos/`. |

## OpenMontage (vídeo con IA)

[`OpenMontage/`](OpenMontage/) es un submódulo de git con [OpenMontage](https://github.com/OpenMontageInc/OpenMontage) ([openmontage.video](https://www.openmontage.video/), licencia AGPLv3): un sistema de producción de vídeo que maneja Claude (guion, voz, imágenes, edición y render).

- **Uso:** pídele a Claude un vídeo ("hazme un reel de 30 s sobre…"). La skill `.claude/skills/openmontage` lo prepara si hace falta y sigue `OpenMontage/AGENT_GUIDE.md`.
- **Instalar a mano:** `git submodule update --init --depth 1 OpenMontage && cd OpenMontage && make setup`
- **Claves de APIs de pago** (opcionales): en `OpenMontage/.env`, nunca en git. Sin claves funciona con herramientas gratuitas (Remotion, HyperFrames, voz Piper).
