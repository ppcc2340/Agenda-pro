import { describe, expect, it } from "vitest";
import { readZip } from "../../test/zip-reader";
import { collectionCsv, crc32, exportFiles, zipStore } from "./zip";

describe("export ZIP (F-16, ADR 0007)", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it("writes a ZIP any unzip can read back, byte for byte", () => {
    const files = [
      { name: "export.json", data: Buffer.from('{"a":1}') },
      { name: "tasks.csv", data: Buffer.from("x,y\r\n") },
    ];
    const read = readZip(zipStore(files, new Date("2026-10-20T08:40:00Z")));
    expect([...read.keys()]).toEqual(["export.json", "tasks.csv"]);
    expect(read.get("export.json")?.toString()).toBe('{"a":1}');
  });

  it("one CSV per collection, nested values as JSON, formula cells neutralized", () => {
    const files = exportFiles({
      format: "meri-export/1",
      tasks: [
        { id: "t1", title: "=HYPERLINK(\"http://evil\")", tags: ["a"] },
        { id: "t2", title: "Normal", extra: null },
      ],
      truncated: [],
      user: { email: "a@b.co" },
    });
    expect(files.map((f) => f.name)).toEqual(["export.json", "tasks.csv", "truncated.csv"]);
    const csv = files[1]?.data.toString("utf8") ?? "";
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"id","title","tags","extra"');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain('"[""a""]"');
    expect(collectionCsv([]).toString("utf8")).toBe("﻿\r\n");
  });
});
