"""Lee la bandeja por IMAP y cruza las respuestas con los leads enviados."""
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


def revisar(con, dias: int = 30) -> int:
    usuario, clave = env("EMAIL_USER"), env("EMAIL_PASS")
    if not usuario or not clave:
        raise SystemExit("Falta EMAIL_USER / EMAIL_PASS en .env")

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
        if any(x in remitente or x in asunto.lower() for x in _REBOTE):
            estado = "rebote"
        elif _BAJA.search(cuerpo[:300]) or _BAJA.search(asunto):
            estado = "baja"
        else:
            estado = "respondio"
        store.actualizar(con, lead["id"], estado=estado, respondio_el=store.ahora(),
                         respuesta=f"[{asunto}] {_recorte(cuerpo)}")
        nuevas += 1
        print(f"  {'✔' if estado == 'respondio' else '·'} {lead['nombre']} → {estado}")
    imap.logout()
    return nuevas
