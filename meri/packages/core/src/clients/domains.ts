/**
 * D-040: which e-mail domains deserve a "create this client?" proposal. Pure rules over counts the job
 * computes: freemail, the user's own domain, mail exclusions and domains already on any client never qualify.
 */

/** Consumer mail providers: a domain shared by strangers is never a client. */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.es",
  "hotmail.com",
  "hotmail.es",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.es",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "aol.com",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "zoho.com",
  "fastmail.com",
  "yandex.com",
  "telefonica.net",
  "movistar.es",
  "orange.es",
  "vodafone.es",
]);

export const MIN_DOMAIN_SIGHTINGS = 3;

export interface DomainSighting {
  domain: string;
  /** Contacts without a client whose address belongs to the domain. */
  contacts: number;
  /** Indexed threads without a client with a participant of the domain. */
  threads: number;
}

export interface SuggestDomainsInput {
  sightings: DomainSighting[];
  /** The user's own addresses (their domain is never a client). */
  me: string[];
  /** `mail_exclusions` values: senders (address) and domains. */
  excluded: string[];
  /** Domains of every client, active, archived or deleted. */
  clientDomains: string[];
  minSightings?: number;
}

export interface DomainSuggestion extends DomainSighting {
  /** Capitalised second-level label ("acme" → "Acme") as the proposed client name. */
  suggestedName: string;
}

const domainOf = (s: string) => {
  const at = s.lastIndexOf("@");
  return (at >= 0 ? s.slice(at + 1) : s).trim().toLowerCase();
};

const isUnder = (domain: string, parent: string) => domain === parent || domain.endsWith(`.${parent}`);

export function suggestedClientName(domain: string): string {
  const label = domain.split(".")[0] ?? domain;
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : domain;
}

export function suggestClientDomains(input: SuggestDomainsInput): DomainSuggestion[] {
  const min = input.minSightings ?? MIN_DOMAIN_SIGHTINGS;
  const own = new Set(input.me.map(domainOf).filter(Boolean));
  const excluded = new Set(input.excluded.map(domainOf).filter(Boolean));
  const taken = input.clientDomains.map((d) => d.toLowerCase());
  const out: DomainSuggestion[] = [];
  for (const s of input.sightings) {
    const domain = s.domain.trim().toLowerCase();
    if (!domain || !domain.includes(".")) continue;
    if (s.contacts + s.threads < min) continue;
    if (FREEMAIL_DOMAINS.has(domain) || own.has(domain) || excluded.has(domain)) continue;
    if (taken.some((t) => isUnder(domain, t))) continue;
    out.push({ domain, contacts: s.contacts, threads: s.threads, suggestedName: suggestedClientName(domain) });
  }
  return out.sort((a, b) => b.contacts + b.threads - (a.contacts + a.threads) || a.domain.localeCompare(b.domain));
}
