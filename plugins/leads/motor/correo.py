"""Preparación y envío de correos.

Dos modos (config.yaml → correo.modo):
  gmail → este programa prepara la cola; Claude envía cada correo con su conector de Gmail
          y luego llama a `marcar-enviado`.
  smtp  → este programa envía directamente con EMAIL_USER / EMAIL_PASS.
"""
import json
import smtplib
import time
from email.message import EmailMessage
from email.utils import make_msgid

from . import plantillas, store
from .config import env
from .ia import parrafo_personalizado


def componer(lead, cfg: dict, plantilla: str | None = None) -> dict:
    nombre_pl = plantillas.elegir(lead, cfg, plantilla)
    asunto, cuerpo = plantillas.renderizar(nombre_pl, lead, cfg)
    if cfg["correo"].get("personalizar_con_ia"):
        extra = parrafo_personalizado(dict(lead), cfg["negocio"])
        if extra:
            saludo, _, resto = cuerpo.partition("\n")
            cuerpo = f"{saludo}\n\n{extra}\n{resto}"
    return {"id": lead["id"], "para": lead["email"], "nombre": lead["nombre"],
            "asunto": asunto, "cuerpo": cuerpo, "plantilla": nombre_pl}


def cupo_hoy(con, cfg: dict) -> int:
    hoy = store.ahora()[:10]
    enviados_hoy = con.execute(
        "SELECT COUNT(*) FROM leads WHERE enviado_el LIKE ?", (hoy + "%",)).fetchone()[0]
    return max(0, cfg["correo"].get("max_por_dia", 40) - enviados_hoy)


def pendientes(con, cfg: dict, limite: int | None = None) -> list:
    filas = [l for l in store.listar(con, "nuevo") if l["email"]]
    cupo = cupo_hoy(con, cfg)
    if limite is not None:
        cupo = min(cupo, limite)
    return filas[:cupo]


def imprimir_correo(c: dict) -> None:
    print(f"Lead #{c['id']} · {c['nombre']}\nPara: {c['para']}\nPlantilla: {c['plantilla']}"
          f"\nAsunto: {c['asunto']}\n\n{c['cuerpo']}")


def cola(con, cfg: dict, plantilla: str | None, limite: int | None, como_json: bool) -> list[dict]:
    """Modo gmail: lista los correos listos para que Claude los envíe."""
    correos = [componer(l, cfg, plantilla) for l in pendientes(con, cfg, limite)]
    if como_json:
        print(json.dumps(correos, ensure_ascii=False, indent=2))
    else:
        print(f"Correos en cola: {len(correos)} (cupo hoy: {cupo_hoy(con, cfg)})\n")
        for c in correos:
            print("─" * 70)
            imprimir_correo(c)
    return correos


def marcar_enviado(con, cfg: dict, id_: int, message_id: str | None, plantilla: str | None) -> None:
    lead = store.por_id(con, id_)
    if lead is None:
        raise SystemExit(f"No existe el lead #{id_}")
    store.actualizar(con, id_, estado="enviado", enviado_el=store.ahora(),
                     message_id=message_id or f"<gmail-{id_}>",
                     plantilla=plantillas.elegir(lead, cfg, plantilla))
    print(f"✔ #{id_} {lead['nombre']} marcado como enviado")


def enviar_smtp(con, cfg: dict, confirmar: bool, plantilla: str | None, limite: int | None) -> int:
    """Modo smtp. Sin confirmar solo muestra la vista previa del primer correo."""
    lista = pendientes(con, cfg, limite)
    print(f"Pendientes con correo: {len(lista)} (cupo hoy: {cupo_hoy(con, cfg)})")
    if not lista:
        return 0
    if not confirmar:
        print("\n── Vista previa (primer lead) ──")
        imprimir_correo(componer(lista[0], cfg, plantilla))
        print("\nNada enviado. Repite con --confirmar para enviar de verdad.")
        return 0

    usuario, clave = env("EMAIL_USER"), env("EMAIL_PASS")
    if not usuario or not clave:
        raise SystemExit("Modo smtp: falta EMAIL_USER / EMAIL_PASS en .env "
                         "(o cambia correo.modo a 'gmail' en config.yaml)")
    enviados = 0
    with smtplib.SMTP(env("SMTP_HOST", "smtp.gmail.com"), int(env("SMTP_PORT", "587"))) as smtp:
        smtp.starttls()
        smtp.login(usuario, clave)
        for lead in lista:
            c = componer(lead, cfg, plantilla)
            msg = EmailMessage()
            msg["From"] = f"{cfg['negocio'].get('remitente', '')} <{usuario}>"
            msg["To"] = c["para"]
            msg["Subject"] = c["asunto"]
            msg["Message-ID"] = make_msgid(domain=usuario.split("@")[-1])
            msg.set_content(c["cuerpo"])
            try:
                smtp.send_message(msg)
                store.actualizar(con, lead["id"], estado="enviado", message_id=msg["Message-ID"],
                                 enviado_el=store.ahora(), plantilla=c["plantilla"])
                enviados += 1
                print(f"  ✔ {lead['nombre']} <{c['para']}>")
            except smtplib.SMTPException as e:
                print(f"  ✘ {lead['nombre']} <{c['para']}>: {e}")
                store.actualizar(con, lead["id"], estado="rebote", respuesta=str(e)[:200])
            if lead is not lista[-1]:
                time.sleep(cfg["correo"].get("segundos_entre_envios", 45))
    return enviados
