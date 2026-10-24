"""Almacén SQLite de leads. Una tabla, sin dependencias externas."""
import sqlite3
from datetime import datetime

from .config import RAIZ

DB = RAIZ / "leads.db"

ESTADOS = ("nuevo", "sin_correo", "enviado", "respondio", "baja", "rebote")

_SQL = """
CREATE TABLE IF NOT EXISTS leads (
  id          INTEGER PRIMARY KEY,
  nombre      TEXT,
  rubro       TEXT,
  ciudad      TEXT,
  fuente      TEXT,
  web         TEXT,
  email       TEXT,
  telefono    TEXT,
  direccion   TEXT,
  instagram   TEXT,
  url_origen  TEXT,
  estado      TEXT DEFAULT 'nuevo',
  message_id  TEXT,
  plantilla   TEXT,
  enviado_el  TEXT,
  respondio_el TEXT,
  respuesta   TEXT,
  creado_el   TEXT,
  UNIQUE(nombre, ciudad)
);
CREATE INDEX IF NOT EXISTS idx_email ON leads(email);
"""


def conectar() -> sqlite3.Connection:
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.executescript(_SQL)
    columnas = {f["name"] for f in con.execute("PRAGMA table_info(leads)")}
    if "plantilla" not in columnas:  # bases creadas con versiones anteriores
        con.execute("ALTER TABLE leads ADD COLUMN plantilla TEXT")
    return con


def por_id(con: sqlite3.Connection, id_: int) -> sqlite3.Row | None:
    return con.execute("SELECT * FROM leads WHERE id=?", (id_,)).fetchone()


def ahora() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def guardar(con: sqlite3.Connection, lead: dict) -> bool:
    """Inserta o completa un lead. Devuelve True si era nuevo."""
    nombre = (lead.get("nombre") or "").strip()
    if not nombre:
        return False
    fila = con.execute(
        "SELECT * FROM leads WHERE lower(nombre)=lower(?) AND ciudad=?",
        (nombre, lead.get("ciudad", "")),
    ).fetchone()
    if fila is None:
        estado = "nuevo" if lead.get("email") else "sin_correo"
        con.execute(
            """INSERT INTO leads (nombre,rubro,ciudad,fuente,web,email,telefono,direccion,
               instagram,url_origen,estado,plantilla,creado_el) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (nombre, lead.get("rubro"), lead.get("ciudad"), lead.get("fuente"),
             lead.get("web"), lead.get("email"), lead.get("telefono"), lead.get("direccion"),
             lead.get("instagram"), lead.get("url_origen"), estado, lead.get("plantilla"), ahora()),
        )
        con.commit()
        return True
    # Ya existe: rellena campos vacíos con lo nuevo (no pisa lo que ya había).
    cambios = {}
    for campo in ("web", "email", "telefono", "direccion", "instagram"):
        if not fila[campo] and lead.get(campo):
            cambios[campo] = lead[campo]
    if cambios:
        if "email" in cambios and fila["estado"] == "sin_correo":
            cambios["estado"] = "nuevo"
        sets = ", ".join(f"{k}=?" for k in cambios)
        con.execute(f"UPDATE leads SET {sets} WHERE id=?", (*cambios.values(), fila["id"]))
        con.commit()
    return False


def listar(con: sqlite3.Connection, estado: str | None = None) -> list[sqlite3.Row]:
    if estado:
        return con.execute("SELECT * FROM leads WHERE estado=? ORDER BY id", (estado,)).fetchall()
    return con.execute("SELECT * FROM leads ORDER BY id").fetchall()


def actualizar(con: sqlite3.Connection, id_: int, **campos) -> None:
    sets = ", ".join(f"{k}=?" for k in campos)
    con.execute(f"UPDATE leads SET {sets} WHERE id=?", (*campos.values(), id_))
    con.commit()


def resumen(con: sqlite3.Connection) -> dict:
    filas = con.execute("SELECT estado, COUNT(*) n FROM leads GROUP BY estado").fetchall()
    r = {e: 0 for e in ESTADOS}
    r.update({f["estado"]: f["n"] for f in filas})
    r["total"] = sum(r[e] for e in ESTADOS)
    return r
