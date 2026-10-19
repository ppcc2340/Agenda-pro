import { describe, expect, it } from "vitest";
import { csvCell, hoursOf, timeEntriesCsv, CSV_BOM } from "./csv";

describe("time CSV (D-046)", () => {
  it("quotes every field, escapes quotes and neutralises formulas and newlines", () => {
    expect(csvCell("Acme")).toBe('"Acme"');
    expect(csvCell('Dijo "ok"')).toBe('"Dijo ""ok"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("\"'=HYPERLINK(1)\"");
    expect(csvCell("+34 600")).toBe("\"'+34 600\"");
    expect(csvCell("-1")).toBe("\"'-1\"");
    expect(csvCell("@cmd")).toBe("\"'@cmd\"");
    expect(csvCell("\tx")).toBe("\"'\tx\"");
    expect(csvCell("línea 1\nlínea 2")).toBe('"línea 1 línea 2"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(66)).toBe('"66"');
  });

  it("writes BOM, documented header, CRLF rows and hours with a decimal point", () => {
    const csv = timeEntriesCsv([
      {
        day: "2026-10-19",
        clientName: "Acme",
        projectName: "",
        description: "Reunión",
        minutes: 66,
        sourceType: "calendar_event",
        status: "approved",
        approvedAt: "2026-10-19T10:00:00.000Z",
      },
    ]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const [header, row] = csv.slice(1).split("\r\n");
    expect(header).toBe('"fecha","cliente","asunto","descripcion","minutos","horas","origen","estado","aprobada_el"');
    expect(row).toBe('"2026-10-19","Acme","","Reunión","66","1.10","calendar_event","approved","2026-10-19T10:00:00.000Z"');
    expect(hoursOf(45)).toBe("0.75");
  });
});
