"""Descarta correos que no son del negocio: textos de relleno de formularios, direcciones técnicas
(hosting, plantillas, plataformas), correos de colegios o municipios, y direcciones mal formadas."""
import re

DOMINIOS_RELLENO = {
    "email.com", "correo.com", "ejemplo.com", "domain.com", "mail.com", "dominio.com", "correo.cl",
    "mysite.com", "tuemail.cl", "ejemplo.cl", "yourdomain.com", "your-domain.com", "newsletter.com",
    "training.com", "example.com", "empresa.com", "company.com", "email.cl", "domicilio.com",
    "sitio.com", "tusitio.com", "tudominio.com", "tudominio.cl", "test.com", "north.com",
}
DOMINIOS_TECNICOS = (
    "getjusto.com", "cpanel.net", "automattic.com", "anthropic.com", "quadlayers.com", "pethemes.com",
    "benzahosting.cl", "businessalert.info", "bookforce.io", "luckystarcasino.com", "tastoria.com",
    "group.calendar.google.com", "medicenter.com", "posicionamiento.cl", "fetichemarketing.cl",
    "pro-code.cl", "gurusoluciones.com", "aimind.cl", "turespuesta.cl", "sentry.io", "wixpress.com",
    "godaddy.com", "hostgator.com", "wordpress.com", "squarespace.com", "shopify.com", "jumpseller.com",
)
# Siempre relleno, sea cual sea el dominio
LOCAL_RELLENO = re.compile(
    r"^(ejemplo|example|tucorreo|tuemail|tunombre|micorreo|your-email|yourname|youremail|johndoe|"
    r"escribetuemail|nombre|usuario|prueba|test|demo|xxx|abc)$")
# Relleno solo si además el dominio es gratuito o de relleno (en su propio dominio pueden ser reales)
LOCAL_GENERICO = re.compile(r"^(tu|su|mi|correo|email|e-mail|mail|name|user|your)$")
LOCAL_TECNICO = re.compile(r"^(privacypolicyupdates|copyright|hostmaster|postmaster|webmaster|noreply|no-reply|"
                           r"mailer-daemon|abuse)$")
GRATUITOS = {"gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "live.com", "icloud.com", "hotmail.cl",
             "yahoo.es", "outlook.es", "msn.com", "live.cl", "yahoo.cl", "hotmail.es", "me.com"}
INSTITUCIONES = re.compile(r"(\.gob\.cl$|\.mineduc\.cl$|^estudiantes\.|^alumnos\.|slep|imantof|municipalidad|"
                           r"\.edu$|\.edu\.cl$)")
FORMA = re.compile(r"^[a-z0-9._%+\-]+@[a-z0-9\-]+(\.[a-z0-9\-]+)*\.[a-z]{2,24}$")
TLD_FALSOS = {"chile", "restobar", "clcontacto", "contacto", "jpg", "png", "webp", "gif", "svg", "js", "css"}


def motivo_descarte(email: str) -> str | None:
    """Devuelve por qué se descarta el correo, o None si parece del negocio."""
    e = (email or "").strip().lower()
    if not FORMA.match(e):
        return "mal formado"
    local, dominio = e.split("@", 1)
    if dominio.rsplit(".", 1)[-1] in TLD_FALSOS or len(local) == 1 or local.startswith("u002f"):
        return "mal formado"
    if local.startswith("+") or len(local) > 64 or LOCAL_TECNICO.match(local):
        return "dirección técnica"
    if dominio in DOMINIOS_RELLENO or LOCAL_RELLENO.match(local):
        return "texto de relleno de un formulario"
    if LOCAL_GENERICO.match(local) and (dominio in GRATUITOS or dominio in DOMINIOS_RELLENO):
        return "texto de relleno de un formulario"
    if any(dominio == d or dominio.endswith("." + d) for d in DOMINIOS_TECNICOS):
        return "correo de una plataforma o proveedor web"
    if INSTITUCIONES.search(dominio):
        return "institución, no pyme"
    return None
