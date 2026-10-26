/** Claves de objeto: los nativos del CRM y los objetos personalizados (o_<slug>) que crea cada empresa. */
export const CORE_BOARD_OBJECTS = ["contact", "company", "deal", "ticket", "contract"] as const;
export const isCustomObjectKey = (k: unknown): k is string => typeof k === "string" && /^o_[a-z0-9_]{2,40}$/.test(k);
/** Objetos que tienen tablero, columnas personalizadas y celdas. */
export const isBoardObject = (k: unknown): k is string => (CORE_BOARD_OBJECTS as readonly string[]).includes(String(k)) || isCustomObjectKey(k);
