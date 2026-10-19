/**
 * Policy layer against prompt injection (docs/05 §6.4): nothing coming from a message may look like an
 * instruction, a recipient change or a system marker. Applied to every extracted field, whatever the model said.
 */
const INJECTION_PATTERNS = [
  /ignor(a|e|ar|es)\s+(todas?\s+)?(las?\s+|tus\s+|sus\s+|mis\s+|estas\s+|esas\s+)?(instrucciones|indicaciones|reglas)/i,
  /ignore\s+(all\s+|the\s+)?(previous|prior|above|earlier)?\s*(instructions|rules|prompts?)/i,
  /disregard\s+(all\s+|the\s+)?(previous|prior|above)?\s*instructions/i,
  /reenv[ií][ae]\s+(este|el)\s+(correo|mensaje|mail)/i,
  /forward\s+(this|the)\s+(e-?mail|message)/i,
  /\b(system|assistant|user)\s*:/i,
  /\[\s*(system|instructions?|instrucci[oó]n(es)?|assistant|asistente|sistema)\s*\]/i,
  /<\/?\s*(system|instruction|assistant|tool|commitment|thread|message)\b/i,
  /you are (now )?(an?|the) (assistant|ai|model)/i,
  /(env[ií]a|send)\s+(to|a)\s+[^\s@]+@[^\s@]+\.[^\s@]+/i,
  /(contraseñ|password|api key|token de acceso|access token)/i,
  /\b(eres|you are)\s+(now\s+|ahora\s+)?(un|una|an?|the|el)?\s*(asistente|assistant|modelo|model|ia|ai|llm)\b/i,
  /\b(cambia|cambie|cambiar|change|set|update)\s+(el|the|la)?\s*(destinatario|recipient|counterparty|contraparte)\b/i,
  /\b(nota|note)\s+(para|to|for)\s+(el|the)\s+(modelo|model|asistente|assistant)\b/i,
  /\b(devuelve|return|include|incluye|añade|anade|agrega|add)\s+(tambi[eé]n\s+|also\s+)?(el|the|un|a)?\s*(campo|field|enlace|link)\b/i,
  /\b(olvida|olvide|forget)\s+(todas?\s+|every\s+|all\s+)?(las\s+|los\s+|the\s+)?(reglas?|rules?|instrucciones|instructions?)\b/i,
  /\b(cc|bcc|copia a|con copia a)\s+[^\s@]+@[^\s@]+/i,
  /\b(a partir de ahora|from now on)\b/i,
  /\b(modo|mode)\s*(administrador|admin)\b|\badmin mode\b/i,
  /\[\s*(fin|end)\s+(del|of)\s+(correo|e-?mail|message)\s*\]/i,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/** Recipients of drafts come from the thread, never from text: validate an address against the allowed set. */
export function isAllowedRecipient(address: string, allowed: readonly string[]): boolean {
  const a = address.trim().toLowerCase();
  return allowed.some((x) => x.trim().toLowerCase() === a);
}
