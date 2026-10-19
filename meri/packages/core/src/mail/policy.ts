/**
 * Policy layer against prompt injection (docs/05 §6.4): nothing coming from a message may look like an
 * instruction, a recipient change or a system marker. Applied to every extracted field, whatever the model said.
 */
const INJECTION_PATTERNS = [
  /ignor(a|e|ar|es)\s+(todas?\s+)?(las?\s+)?(instrucciones|indicaciones|reglas)/i,
  /ignore\s+(all\s+|the\s+)?(previous|prior|above|earlier)?\s*(instructions|rules|prompts?)/i,
  /disregard\s+(all\s+|the\s+)?(previous|prior|above)?\s*instructions/i,
  /reenv[ií][ae]\s+(este|el)\s+(correo|mensaje|mail)/i,
  /forward\s+(this|the)\s+(e-?mail|message)/i,
  /\b(system|assistant|user)\s*:/i,
  /\[\s*(system|instruction|assistant)\s*\]/i,
  /<\/?\s*(system|instruction|assistant|tool|commitment|thread|message)\b/i,
  /you are (now )?(an?|the) (assistant|ai|model)/i,
  /(env[ií]a|send)\s+(to|a)\s+[^\s@]+@[^\s@]+\.[^\s@]+/i,
  /(contraseñ|password|api key|token de acceso|access token)/i,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/** Recipients of drafts come from the thread, never from text: validate an address against the allowed set. */
export function isAllowedRecipient(address: string, allowed: readonly string[]): boolean {
  const a = address.trim().toLowerCase();
  return allowed.some((x) => x.trim().toLowerCase() === a);
}
