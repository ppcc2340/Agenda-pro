/**
 * clients.scan (D-040): once a day per workspace, domains seen ≥ 3 times among unassigned contacts/threads
 * become ONE `client_link` proposal each ("¿Crear el cliente acme.com?"). Nothing is created without the
 * user confirming it in Entrada; a dismissed domain is never proposed again (hash kept in any status).
 */
import { suggestClientDomains } from "@meri/core";
import {
  createProposalIfAbsent,
  getPreferences,
  listAllClientDomains,
  listIntegrationAccounts,
  listMailExclusions,
  listUnlinkedDomainSightings,
  proposalHashExists,
  withWorkspace,
  type WorkspaceId,
} from "@meri/db";
import type { HandlerDeps } from "./context";

export interface ClientsScanResult {
  status: "done" | "skipped";
  candidates: number;
  proposals: number;
}

/** Payload of a `client_link` proposal. */
export interface ClientLinkPayload {
  domain: string;
  suggestedName: string;
  contacts: number;
  threads: number;
}

export const clientLinkDedupeHash = (domain: string) => `client_link:${domain.toLowerCase()}`;

export async function scanClients(deps: HandlerDeps, workspaceId: WorkspaceId): Promise<ClientsScanResult> {
  const now = deps.now();
  return withWorkspace(deps.db, workspaceId, async (tx) => {
    const prefs = await getPreferences(tx, workspaceId);
    if (!prefs) return { status: "skipped", candidates: 0, proposals: 0 };
    const [sightings, accounts, exclusions, clientDomains] = await Promise.all([
      listUnlinkedDomainSightings(tx, workspaceId),
      listIntegrationAccounts(tx, workspaceId),
      listMailExclusions(tx, workspaceId),
      listAllClientDomains(tx, workspaceId),
    ]);
    const candidates = suggestClientDomains({
      sightings,
      me: accounts.map((a) => a.email).filter((e): e is string => Boolean(e)),
      excluded: exclusions.filter((e) => e.kind !== "label").map((e) => e.value),
      clientDomains,
    });
    let proposals = 0;
    for (const c of candidates) {
      const hash = clientLinkDedupeHash(c.domain);
      if (await proposalHashExists(tx, workspaceId, hash)) continue;
      const payload: ClientLinkPayload = {
        domain: c.domain,
        suggestedName: c.suggestedName,
        contacts: c.contacts,
        threads: c.threads,
      };
      const created = await createProposalIfAbsent(
        tx,
        workspaceId,
        {
          kind: "client_link",
          confidence: null,
          explanation: "domain_seen",
          dedupeHash: hash,
          sourceRef: null,
          payload: { ...payload },
        },
        now,
      );
      if (created) proposals++;
    }
    deps.logger.info({ workspaceId, candidates: candidates.length, proposals }, "clients scanned");
    return { status: "done", candidates: candidates.length, proposals };
  });
}
