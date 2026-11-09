"""Programa en Zoho los envíos de mañana y pasado mañana (solo días hábiles), con aumento gradual:
hasta el 13-nov 25/día, del 16 al 20-nov 35/día, desde el 23-nov 50/día. Ventana 9:00–17:30 (hora de Chile).
No programa más de 2 días por adelantado (Zoho despachó de golpe lo programado a ~3 días).
Uso: python programar_dia.py [--fecha AAAA-MM-DD]   (sin fecha: mañana y pasado mañana)"""
import argparse, subprocess, sys
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))
from motor import store  # noqa: E402

def cupo(d: date) -> int:
    if d <= date(2026, 11, 13): return 25
    if d <= date(2026, 11, 20): return 35
    return 50

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--fecha"); a = ap.parse_args()
    hoy = datetime.now(ZoneInfo("America/Santiago")).date()
    fechas = [date.fromisoformat(a.fecha)] if a.fecha else [hoy + timedelta(days=1), hoy + timedelta(days=2)]
    con = store.conectar(); con.execute("PRAGMA busy_timeout=60000")
    for d in fechas:
        if d.weekday() >= 5:
            print(f"{d}: fin de semana, no se programa"); continue
        camp = f"-d{d:%Y%m%d}"
        ya = con.execute("SELECT COUNT(*) FROM leads WHERE message_id LIKE ? AND message_id NOT LIKE '%-revisar>'", (f"<zoho-prog{camp}-%",)).fetchone()[0]
        n = cupo(d)
        if ya >= n:
            print(f"{d}: ya tiene {ya} programados"); continue
        print(f"{d}: programando {n - ya} (meta {n})", flush=True)
        r = subprocess.run([sys.executable, "-u", str(AQUI / "programar_masivo.py"), f"--campana={camp}", "--dias", d.isoformat(),
                            "--total", str(n), "--lote", str(n), "--desde", "09:00", "--hasta", "17:30"], capture_output=True, text=True)
        print("\n".join(l for l in r.stdout.splitlines() if not l.startswith("CONFIRMANDO"))[-1500:], r.stderr[-500:], flush=True)


if __name__ == "__main__":
    main()
