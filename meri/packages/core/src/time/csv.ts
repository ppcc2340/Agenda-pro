/**
 * D-046 CSV export: UTF-8 with BOM, comma separator, every field quoted, cells that a spreadsheet would run as a
 * formula (= + - @ and leading tab/CR) prefixed with an apostrophe. Descriptions come from calendar titles and
 * mail subjects, which are untrusted.
 */
export const CSV_BOM = "﻿";
export const TIME_CSV_COLUMNS = [
  "fecha",
  "cliente",
  "asunto",
  "descripcion",
  "minutos",
  "horas",
  "origen",
  "estado",
  "aprobada_el",
] as const;

export interface TimeCsvRow {
  day: string;
  clientName: string;
  projectName: string;
  description: string;
  minutes: number;
  sourceType: string;
  status: string;
  approvedAt: string | null;
}

export function csvCell(value: string | number | null): string {
  let s = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
}

/** Hours with two decimals and a decimal point (locale-neutral; the column `minutos` is the exact value). */
export const hoursOf = (minutes: number) => (Math.round((minutes / 60) * 100) / 100).toFixed(2);

export function timeEntriesCsv(rows: TimeCsvRow[]): string {
  const lines = [TIME_CSV_COLUMNS.map((c) => csvCell(c)).join(",")];
  for (const r of rows)
    lines.push(
      [
        csvCell(r.day),
        csvCell(r.clientName),
        csvCell(r.projectName),
        csvCell(r.description),
        csvCell(r.minutes),
        csvCell(hoursOf(r.minutes)),
        csvCell(r.sourceType),
        csvCell(r.status),
        csvCell(r.approvedAt),
      ].join(","),
    );
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}
