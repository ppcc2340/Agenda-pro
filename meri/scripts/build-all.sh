#!/usr/bin/env bash
# Construye las fases del MVP en secuencia, cada una con contexto limpio, y se detiene si una falla.
# Uso: scripts/build-all.sh [fase_inicial] [fase_final]     (por defecto 0 a 5)
# Requiere Claude Code (comando `claude`). Revisa `claude --help` por si tu versión cambió los flags.
set -euo pipefail
FROM="${1:-0}"; TO="${2:-5}"
for N in $(seq "$FROM" "$TO"); do
  echo "=============== FASE $N ==============="
  claude -p "Sigue prompts/build-phase.md con PHASE=$N. Trabaja de forma autónoma hasta cerrar la fase." \
    --permission-mode acceptEdits \
    --allowedTools "Bash(pnpm:*)" "Bash(git add:*)" "Bash(git commit:*)" "Bash(git status:*)" "Bash(git diff:*)" "Bash(docker compose:*)" "Bash(node:*)" "Bash(npx:*)" "Edit" "Write" "Read" "Glob" "Grep" "Task" \
    --max-turns 400
  echo "--- Verificando fase $N ---"
  pnpm install --silent
  pnpm verify
  grep -q "Fase $N.*cerrada\|| $N |.*cerrada" STATE.md || { echo "STATE.md no marca la fase $N como cerrada. Revisa a mano."; exit 1; }
  git status --porcelain | grep -q . && { echo "Hay cambios sin commit tras la fase $N."; exit 1; } || true
done
pnpm status
echo "Listo. Revisa STATE.md y los bloqueos pendientes con: pnpm blockers"
