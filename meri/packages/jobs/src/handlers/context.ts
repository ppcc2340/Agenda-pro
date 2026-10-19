import type { Logger } from "@meri/config";
import type { Db } from "@meri/db";
import type { KeyProvider } from "@meri/config/crypto";
import type { Integrations } from "@meri/integrations";

/** Dependencies every handler receives (explicit injection, docs/12 §1). */
export interface HandlerDeps {
  db: Db;
  integrations: Integrations;
  keys: KeyProvider;
  logger: Logger;
  now: () => Date;
}
