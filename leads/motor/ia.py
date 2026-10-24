"""Opcional: Claude redacta un primer párrafo personalizado para cada lead."""
from .config import env


def parrafo_personalizado(lead: dict, negocio: dict) -> str | None:
    if not env("ANTHROPIC_API_KEY"):
        return None
    import anthropic

    cliente = anthropic.Anthropic()
    datos = ", ".join(f"{k}: {v}" for k, v in lead.items()
                      if k in ("nombre", "rubro", "ciudad", "web", "direccion", "instagram") and v)
    try:
        resp = cliente.messages.create(
            model="claude-opus-5-5",
            max_tokens=300,
            system=("Escribes correos comerciales breves en español, tono cercano y profesional. "
                    "Devuelve solo un párrafo de 2 frases, sin saludo ni despedida."),
            messages=[{"role": "user", "content":
                       f"Negocio que ofrece el servicio: {negocio.get('nombre')} — "
                       f"{negocio.get('servicio')}.\nLead: {datos}.\n"
                       "Escribe un párrafo de apertura que mencione algo concreto del lead y "
                       "conecte con el servicio ofrecido."}],
        )
    except anthropic.APIError:
        return None
    if resp.stop_reason == "refusal":
        return None
    return "".join(b.text for b in resp.content if b.type == "text").strip() or None
