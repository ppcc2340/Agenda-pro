#!/bin/bash
# Programa la campaña completa en lotes, esperando nuevos leads cuando no hay. Uso:
#   ZOHO_WEB_DIR=~/.zoho-web2 bash campana.sh PARTE DE [opciones extra de programar_masivo.py]
P=$1; N=$2; shift 2
cd "$(dirname "$0")"
while true; do
  out=$(python3 -u programar_masivo.py --lote 40 --parte "$P" --de "$N" "$@" 2>&1 | tee /dev/stderr)
  case "$out" in
    *CAMPAÑA_COMPLETA*) echo "PARTE $P: CAMPAÑA_COMPLETA"; exit 0 ;;
    *SIN_SESION*) echo "PARTE $P: SIN_SESION"; exit 3 ;;
    *DEMASIADOS_FALLOS*) echo "PARTE $P: DEMASIADOS_FALLOS"; exit 4 ;;
    *SIN_CANDIDATOS*) sleep 180 ;;
  esac
done
