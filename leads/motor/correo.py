"""Envío de correos por SMTP con límite diario, pausa entre envíos y registro en la base."""
import smtplib
import time
from email.message import EmailMessage
from email.utils import make_msgid

from . import store
from .config import env
from .ia import parrafo_personalizado


def _plantilla(texto: str, lead, cfg: dict) -> str:
    neg = cfg["negocio"]
    return texto.format(
        nombre=lead["nombre"], rubro=lead["rubro"] or "", ciudad=lead["ciudad"] or "",
        remitente=neg.get("remitente", ""), negocio=neg.get("nombre", ""),
        servicio=neg.get("servicio", ""), telefono=neg.get("telefono", ""), web=neg.get("web", ""),
    )


def previsualizar(lead, cfg: dict) -> tuple[str, str]:
    c = cfg["correo"]
    asunto = _plantilla(c["asunto"], lead, cfg)
    cuerpo = _plantilla(c["cuerpo"], lead, cfg)
    if c.get("personalizar_con_ia"):
        extra = parrafo_personalizado(dict(lead), cfg["negocio"])
        if extra:
            lineas = cuerpo.split("\n", 1)
            cuerpo = f"{lineas[0]}\n\n{extra}\n{lineas[1] if len(lineas) > 1 else ''}"
    return asunto, cuerpo


def enviar_pendientes(con, cfg: dict, confirmar: bool, limite: int | None = None) -> int:
    """Envía a los leads en estado 'nuevo' con correo. Sin --confirmar solo muestra."""
    c = cfg["correo"]
    pendientes = [l for l in store.listar(con, "nuevo") if l["email"]]
    hoy = store.ahora()[:10]
    enviados_hoy = con.execute(
        "SELECT COUNT(*) FROM leads WHERE enviado_el LIKE ?", (hoy + "%",)).fetchone()[0]
    cupo = max(0, c.get("max_por_dia", 40) - enviados_hoy)
    if limite is not None:
        cupo = min(cupo, limite)
    pendientes = pendientes[:cupo]

    print(f"Pendientes con correo: {len(pendientes)} (cupo hoy: {cupo})")
    if not pendientes:
        return 0

    if not confirmar:
        asunto, cuerpo = previsualizar(pendientes[0], cfg)
        print("\n── Vista previa (primer lead) ──")
        print(f"Para: {pendientes[0]['email']}\nAsunto: {asunto}\n\n{cuerpo}")
        print("\nNada enviado. Repite con --confirmar para enviar de verdad.")
        return 0

    usuario, clave = env("EMAIL_USER"), env("EMAIL_PASS")
    if not usuario or not clave:
        raise SystemExit("Falta EMAIL_USER / EMAIL_PASS en .env")

    enviados = 0
    with smtplib.SMTP(env("SMTP_HOST", "smtp.gmail.com"), int(env("SMTP_PORT", "587"))) as smtp:
        smtp.starttls()
        smtp.login(usuario, clave)
        for lead in pendientes:
            asunto, cuerpo = previsualizar(lead, cfg)
            msg = EmailMessage()
            msg["From"] = f"{cfg['negocio'].get('remitente', '')} <{usuario}>"
            msg["To"] = lead["email"]
            msg["Subject"] = asunto
            msg["Message-ID"] = make_msgid(domain=usuario.split("@")[-1])
            msg.set_content(cuerpo)
            try:
                smtp.send_message(msg)
                store.actualizar(con, lead["id"], estado="enviado",
                                 message_id=msg["Message-ID"], enviado_el=store.ahora())
                enviados += 1
                print(f"  ✔ {lead['nombre']} <{lead['email']}>")
            except smtplib.SMTPException as e:
                print(f"  ✘ {lead['nombre']} <{lead['email']}>: {e}")
                store.actualizar(con, lead["id"], estado="rebote", respuesta=str(e)[:200])
            if lead is not pendientes[-1]:
                time.sleep(c.get("segundos_entre_envios", 45))
    return enviados
