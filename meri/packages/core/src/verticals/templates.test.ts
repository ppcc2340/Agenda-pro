import { describe, expect, it } from "vitest";
import { parseCapture } from "../capture/parse";
import { getVerticalTemplate, isVerticalId, VERTICALS, VERTICAL_TEMPLATES } from "./templates";

const ctx = { now: "2026-10-19T10:00:00.000Z", timezone: "Europe/Madrid", clients: [] };

describe("vertical templates (D-045)", () => {
  it("has three verticals with tags, matter kinds and a vocabulary; unknown ids fall back to generic", () => {
    expect([...VERTICALS]).toEqual(["legal", "consulting", "generic"]);
    for (const id of VERTICALS) {
      const tpl = VERTICAL_TEMPLATES[id];
      expect(tpl.tags.length).toBeGreaterThan(2);
      expect(tpl.matterKinds.length).toBeGreaterThan(1);
      expect(tpl.vocabulary.deadlineNouns.length).toBeGreaterThan(2);
    }
    expect(isVerticalId("legal")).toBe(true);
    expect(isVerticalId("crypto")).toBe(false);
    expect(getVerticalTemplate("nope").id).toBe("generic");
    expect(getVerticalTemplate(null).id).toBe("generic");
  });

  it("the parser uses the vocabulary: dated deadline nouns → hard deadline, deliverables → deep work", () => {
    const legal = getVerticalTemplate("legal").vocabulary;
    const dated = parseCapture("Audiencia en el juzgado el 3 de noviembre", { ...ctx, vocabulary: legal });
    expect(dated.deadlineType).toBe("hard");
    expect(dated.priority).toBe(2);
    expect(dated.dueAt).not.toBeNull();
    // Without the vocabulary (phase 2 behaviour) nothing changes.
    const plain = parseCapture("Audiencia en el juzgado el 3 de noviembre", ctx);
    expect(plain.deadlineType).toBeNull();
    expect(plain.priority).toBeNull();
    const deliverable = parseCapture("Redactar la demanda para Acme", { ...ctx, vocabulary: legal });
    expect(deliverable.kind).toBe("deep");
    expect(deliverable.estimateMinutes).toBeNull();
    // An explicit duration always wins over the vocabulary.
    const short = parseCapture("Revisar la demanda 20 min", { ...ctx, vocabulary: legal });
    expect(short.kind).toBe("shallow");
    // Undated deadline nouns do not invent a hard deadline.
    expect(parseCapture("Preparar la vista", { ...ctx, vocabulary: legal }).deadlineType).toBeNull();
  });
});
