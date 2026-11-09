"""Programa de una vez varios días hábiles con el aumento gradual de programar_dia.py.
Uso: python programar_rango.py DESDE HASTA [--parte K --de N]   (fechas AAAA-MM-DD)"""
import argparse, subprocess, sys
from datetime import date, timedelta
from pathlib import Path
AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
from programar_dia import cupo  # noqa: E402

ap = argparse.ArgumentParser(); ap.add_argument("desde"); ap.add_argument("hasta")
ap.add_argument("--parte", type=int, default=0); ap.add_argument("--de", type=int, default=1)
a = ap.parse_args()
d, fin = date.fromisoformat(a.desde), date.fromisoformat(a.hasta)
while d <= fin:
    if d.weekday() < 5:
        n = cupo(d)
        r = subprocess.run([sys.executable, "-u", str(AQUI / "programar_masivo.py"), f"--campana=-d{d:%Y%m%d}", "--dias", d.isoformat(),
                            "--total", str(n), "--lote", str(n), "--desde", "09:00", "--hasta", "17:30",
                            "--parte", str(a.parte), "--de", str(a.de)], capture_output=True, text=True)
        resumen = [l for l in r.stdout.splitlines() if l.startswith(("LOTE_TERMINADO", "SIN_", "CAMPAÑA", "DEMASIADOS", "✘"))]
        print(d, " | ".join(resumen) or r.stdout[-300:], r.stderr[-300:], flush=True)
        if any(l.startswith(("SIN_SESION", "DEMASIADOS")) for l in resumen):
            break
    d += timedelta(days=1)
print("RANGO_TERMINADO", flush=True)
