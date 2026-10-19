/**
 * D-045 vertical templates (P3-07): tags, matter kinds and capture vocabulary per vertical. Applying one never
 * deletes data; it only changes what Meri suggests (tags in the client form, matter kinds, parser hints).
 */
export const VERTICALS = ["legal", "consulting", "generic"] as const;
export type VerticalId = (typeof VERTICALS)[number];

export interface CaptureVocabulary {
  /** Nouns that name a hard deadline ("audiencia", "vista", "vencimiento"): a dated capture becomes a hard deadline. */
  deadlineNouns: string[];
  /** Nouns that name a deliverable ("demanda", "informe"): an undated-duration capture becomes deep work. */
  deliverableNouns: string[];
}

export interface VerticalTemplate {
  id: VerticalId;
  tags: string[];
  matterKinds: string[];
  vocabulary: CaptureVocabulary;
}

const GENERIC_VOCABULARY: CaptureVocabulary = {
  deadlineNouns: ["plazo", "vencimiento", "deadline", "fecha limite", "fecha límite", "entrega"],
  deliverableNouns: ["informe", "propuesta", "presupuesto", "entregable", "presentacion", "presentación", "report", "proposal", "deliverable"],
};

export const VERTICAL_TEMPLATES: Record<VerticalId, VerticalTemplate> = {
  legal: {
    id: "legal",
    tags: ["litigio", "mercantil", "laboral", "fiscal", "civil", "penal", "administrativo", "inmobiliario"],
    matterKinds: ["procedimiento", "contrato", "asesoramiento", "due diligence", "recurso", "arbitraje"],
    vocabulary: {
      deadlineNouns: [...GENERIC_VOCABULARY.deadlineNouns, "audiencia", "vista", "juicio", "comparecencia", "señalamiento", "senalamiento", "plazo procesal", "requerimiento", "notificacion", "notificación"],
      deliverableNouns: [...GENERIC_VOCABULARY.deliverableNouns, "demanda", "contestacion", "contestación", "recurso", "escrito", "dictamen", "contrato", "alegaciones", "querella", "burofax"],
    },
  },
  consulting: {
    id: "consulting",
    tags: ["estrategia", "operaciones", "finanzas", "tecnologia", "tecnología", "personas", "marketing"],
    matterKinds: ["proyecto", "diagnostico", "diagnóstico", "implantacion", "implantación", "formacion", "formación", "retainer"],
    vocabulary: {
      deadlineNouns: [...GENERIC_VOCABULARY.deadlineNouns, "comite", "comité", "steering", "hito", "milestone", "go-live", "cierre"],
      deliverableNouns: [...GENERIC_VOCABULARY.deliverableNouns, "diagnostico", "diagnóstico", "roadmap", "business case", "plan de accion", "plan de acción", "deck", "workshop", "taller"],
    },
  },
  generic: {
    id: "generic",
    tags: ["cliente", "interno", "admin", "ventas"],
    matterKinds: ["proyecto", "soporte", "retainer"],
    vocabulary: GENERIC_VOCABULARY,
  },
};

export const isVerticalId = (s: string): s is VerticalId => (VERTICALS as readonly string[]).includes(s);

export function getVerticalTemplate(id: string | null | undefined): VerticalTemplate {
  return id && isVerticalId(id) ? VERTICAL_TEMPLATES[id] : VERTICAL_TEMPLATES.generic;
}
