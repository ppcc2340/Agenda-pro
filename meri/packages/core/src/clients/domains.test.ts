import { describe, expect, it } from "vitest";
import { suggestClientDomains, suggestedClientName } from "./domains";

describe("suggestClientDomains (D-040)", () => {
  const base = { me: ["yo@mifirma.es"], excluded: [], clientDomains: [] };

  it("proposes a domain seen at least three times and never freemail, own or excluded domains", () => {
    const out = suggestClientDomains({
      ...base,
      excluded: ["newsletter@spam.io", "spam.io"],
      sightings: [
        { domain: "acme.com", contacts: 2, threads: 1 },
        { domain: "gmail.com", contacts: 10, threads: 20 },
        { domain: "mifirma.es", contacts: 4, threads: 0 },
        { domain: "spam.io", contacts: 5, threads: 5 },
        { domain: "tiny.es", contacts: 1, threads: 1 },
        { domain: "localhost", contacts: 9, threads: 9 },
      ],
    });
    expect(out.map((s) => s.domain)).toEqual(["acme.com"]);
    expect(out[0]?.suggestedName).toBe("Acme");
  });

  it("skips domains already on any client, including subdomains, and sorts by sightings", () => {
    const out = suggestClientDomains({
      ...base,
      clientDomains: ["Globex.com"],
      sightings: [
        { domain: "mail.globex.com", contacts: 3, threads: 3 },
        { domain: "initech.com", contacts: 3, threads: 0 },
        { domain: "umbrella.org", contacts: 2, threads: 4 },
      ],
    });
    expect(out.map((s) => s.domain)).toEqual(["umbrella.org", "initech.com"]);
  });

  it("builds a readable name from the second-level label", () => {
    expect(suggestedClientName("despacho-garcia.es")).toBe("Despacho-garcia");
    expect(suggestedClientName("x")).toBe("X");
  });
});
