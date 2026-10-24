"""Respuestas de los leads.

  modo gmail → `para_revisar` lista qué buscar en Gmail; Claude busca con su conector y
               llama a `registrar` con lo que encuentre.
  modo smtp  → `revisar` lee la bandeja por IMAP y cruza las respuestas automáticamente.
"""
import json
import email
import imaplib
import re
from datetime import datetime, timedelta
from email.header import decode_header, make_header
from email.utils import parseaddr

from . import store
from .config import env

_BAJA = re.compile(r"\b(baja|unsubscribe|no me interesa|no enviar|eliminar)\b", re.I)
_REBOTE = ("mailer-daemon", "postmaster", "undeliverable", "delivery status")


def _texto(msg) -> str:
    if msg.is_multipart():
        for parte in msg.walk():
            if parte.get_content_type() == "text/plain":
                return parte.get_payload(decode=True).decode(
                    parte.get_content_charset() or "utf-8", errors="replace")
        return ""
    return msg.get_payload(decode=True).decode(msg.get_content_charset() or "utf-8", errors="replace")


def _recorte(texto: str, n: int = 400) -> str:
    lineas = [l for l in texto.splitlines() if l.strip() and not l.lstrip().startswith(">")]
    return " ".join(lineas)[:n]


def clasificar(asunto: str, cuerpo: str, remitente: str = "") -> str:
    if any(x in remitente.lower() or x in asunto.lower() for x in _REBOTE):
        return "rebote"
    if _BAJA.search(cuerpo[:300]) or _BAJA.search(asunto):
        return "baja"
    return "respondio"


def para_revisar(con, como_json: bool) -> list[dict]:
    """Modo gmail: leads enviados sin respuesta registrada, con la búsqueda sugerida para Gmail."""
    filas = store.listar(con, "enviado")
    salida = []
    for l in filas:
        fecha = (l["enviado_el"] or "")[:10].replace("-", "/")
        salida.append({"id": l["id"], "nombre": l["nombre"], "email": l["email"],
                       "enviado_el": l["enviado_el"],
                       "busqueda_gmail": f"from:{l['email']} after:{fecha}"})
    if como_json:
        print(json.dumps(salida, ensure_ascii=False, indent=2))
    else:
        print(f"Leads enviados sin respuesta registrada: {len(salida)}\n")
        for s in salida:
            print(f"  #{s['id']:<4} {s['nombre'][:40]:40} {s['busqueda_gmail']}")
    return salida


def registrar(con, id_: int, texto: str, asunto: str = "", estado: str | None = None) -> str:
    """Modo gmail: Claude registra la respuesta que encontró. Detecta BAJA/rebote si no se indica."""
    lead = store.por_id(con, id_)
    if lead is None:
        raise SystemExit(f"No existe el lead #{id_}")
    estado = estado or clasificar(asunto, texto)
    store.actualizar(con, id_, estado=estado, respondio_el=store.ahora(),
                     respuesta=f"[{asunto}] {_recorte(texto)}" if asunto else _recorte(texto))
    print(f"{'✔' if estado == 'respondio' else '·'} #{id_} {lead['nombre']} → {estado}")
    return estado


def revisar(con, dias: int = 30) -> int:
    usuario, clave = env("EMAIL_USER"), env("EMAIL_PASS")
    if not usuario or not clave:
        raise SystemExit("Modo smtp: falta EMAIL_USER / EMAIL_PASS en .env "
                         "(o cambia correo.modo a 'gmail' en config.yaml)")

    enviados = {l["email"].lower(): l for l in store.listar(con) if l["email"] and l["message_id"]}
    por_msgid = {l["message_id"]: l for l in enviados.values()}
    if not enviados:
        print("Aún no hay correos enviados que cruzar.")
        return 0

    desde = (datetime.now() - timedelta(days=dias)).strftime("%d-%b-%Y")
    imap = imaplib.IMAP4_SSL(env("IMAP_HOST", "imap.gmail.com"))
    imap.login(usuario, clave)
    imap.select("INBOX")
    _, datos = imap.search(None, f'(SINCE "{desde}")')
    nuevas = 0
    for num in datos[0].split():
        _, partes = imap.fetch(num, "(RFC822)")
        msg = email.message_from_bytes(partes[0][1])
        remitente = parseaddr(msg.get("From", ""))[1].lower()
        refs = f"{msg.get('In-Reply-To', '')} {msg.get('References', '')}"
        lead = next((por_msgid[m] for m in por_msgid if m and m in refs), None) \
            or enviados.get(remitente)
        if lead is None or lead["estado"] in ("respondio", "baja"):
            continue
        cuerpo = _texto(msg)
        asunto = str(make_header(decode_header(msg.get("Subject", ""))))
        estado = clasificar(asunto, cuerpo, remitente)
        store.actualizar(con, lead["id"], estado=estado, respondio_el=store.ahora(),
                         respuesta=f"[{asunto}] {_recorte(cuerpo)}")
        nuevas += 1
        print(f"  {'✔' if estado == 'respondio' else '·'} {lead['nombre']} → {estado}")
    imap.logout()
    return nuevas
