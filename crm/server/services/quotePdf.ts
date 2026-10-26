/** PDF del presupuesto: membrete, cliente, líneas con descuento e IVA, totales, condiciones y huella SHA-256. */
import type { Ctx } from "../context.js";
import type { Row } from "../db.js";
import { PdfDoc } from "../lib/pdf.js";
import { sha256 } from "../lib/util.js";

interface Line { name: string; description?: string | null; quantity: number; unit_price: number; discount: number; tax_rate: number }
const money = (n: number, cur: string) => new Intl.NumberFormat("es-ES", { style: "currency", currency: cur || "EUR" }).format(Number(n) || 0);
const num = (n: number) => new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(Number(n) || 0);
const dmy = (iso: unknown) => { const s = String(iso ?? "").slice(0, 10); const [y, m, d] = s.split("-"); return d ? `${d}/${m}/${y}` : ""; };

export function quotePdf(ctx: Ctx, q: Row): { pdf: Buffer; sha256: string; filename: string } {
  const cur = String(q.currency ?? ctx.settings.currency ?? "EUR");
  const brand = /^#[0-9a-f]{6}$/i.test(ctx.settings.brand_color) ? ctx.settings.brand_color : "#0E6B74";
  const doc = new PdfDoc();
  const M = 48, R = doc.width - M;
  let y = 0;
  const header = () => {
    doc.rect(0, 0, doc.width, 8, brand);
    doc.text(M, 52, ctx.settings.company_name || "Mi empresa", { size: 18, bold: true, color: brand });
    doc.text(R, 46, `PRESUPUESTO ${q.number}`, { size: 13, bold: true, align: "right" });
    doc.text(R, 62, `Versión ${q.version} · ${dmy(q.date)}${q.valid_until ? ` · válido hasta ${dmy(q.valid_until)}` : ""}`, { size: 9, color: "#676879", align: "right" });
    y = 96;
  };
  const cols = [{ k: "c", x: M, w: 230, t: "Concepto" }, { k: "q", x: M + 300, t: "Cant." }, { k: "p", x: M + 375, t: "Precio" }, { k: "d", x: M + 415, t: "Dto." }, { k: "i", x: M + 450, t: "IVA" }, { k: "a", x: R, t: "Importe" }];
  const tableHead = () => { doc.rect(M, y - 12, R - M, 18, "#f0f2f8"); for (const c of cols) doc.text(c.x + (c.k === "c" ? 6 : 0), y, c.t, { size: 9, bold: true, align: c.k === "c" ? "left" : "right" }); y += 16; };
  const ensure = (h: number) => { if (y + h > doc.height - 90) { doc.addPage(); header(); tableHead(); } };

  header();
  doc.text(M, y, "Para", { size: 8, bold: true, color: "#676879" });
  doc.text(M, y + 14, String(q.company_name ?? "—"), { size: 11, bold: true });
  doc.text(M, y + 28, String(q.deal_name ?? ""), { size: 9, color: "#676879" });
  if (q.created_by_name) { doc.text(R, y, "Preparado por", { size: 8, bold: true, color: "#676879", align: "right" }); doc.text(R, y + 14, String(q.created_by_name), { size: 10, align: "right" }); }
  y += 56;
  tableHead();
  const lines = (Array.isArray(q.lines) ? q.lines : []) as Line[];
  const gd = Number(q.discount) || 0;
  for (const l of lines) {
    const net = l.quantity * l.unit_price * (1 - (l.discount || 0) / 100) * (1 - gd / 100);
    const nameLines = doc.wrap(l.name, 225, 10, true);
    const descLines = l.description ? doc.wrap(l.description, 225, 8.5) : [];
    ensure(14 * nameLines.length + 11 * descLines.length + 8);
    const top = y;
    nameLines.forEach((t, i) => doc.text(M + 6, top + i * 13, t, { size: 10, bold: true }));
    descLines.forEach((t, i) => doc.text(M + 6, top + nameLines.length * 13 + i * 11, t, { size: 8.5, color: "#676879" }));
    doc.text(cols[1]!.x, top, num(l.quantity), { size: 10, align: "right" });
    doc.text(cols[2]!.x, top, money(l.unit_price, cur), { size: 10, align: "right" });
    doc.text(cols[3]!.x, top, l.discount ? `${num(l.discount)} %` : "—", { size: 10, align: "right" });
    doc.text(cols[4]!.x, top, `${num(l.tax_rate)} %`, { size: 10, align: "right" });
    doc.text(R, top, money(net, cur), { size: 10, align: "right" });
    y = top + nameLines.length * 13 + descLines.length * 11 + 6;
    doc.line(M, y - 2, R, y - 2);
    y += 10;
  }
  ensure(90);
  y += 6;
  const tot = (label: string, value: string, bold = false) => { doc.text(R - 120, y, label, { size: bold ? 11 : 10, bold, align: "right" }); doc.text(R, y, value, { size: bold ? 12 : 10, bold, align: "right" }); y += bold ? 20 : 15; };
  if (gd) tot(`Descuento global`, `${num(gd)} %`);
  tot("Base imponible", money(Number(q.subtotal), cur));
  tot("IVA", money(Number(q.tax), cur));
  doc.rect(R - 230, y - 13, 230, 22, "#f0f2f8");
  y += 3; tot("TOTAL", money(Number(q.total), cur), true);
  if (q.notes) {
    y += 10; ensure(40);
    doc.text(M, y, "Condiciones y notas", { size: 9, bold: true, color: "#676879" }); y += 14;
    for (const t of doc.wrap(String(q.notes), R - M, 9)) { ensure(12); doc.text(M, y, t, { size: 9 }); y += 12; }
  }
  // pie con la huella del contenido (permite comprobar que el documento aceptado es este)
  const body = JSON.stringify({ n: q.number, v: q.version, l: lines, s: q.subtotal, t: q.tax, T: q.total, d: q.discount, notes: q.notes ?? null });
  const fingerprint = sha256(body);
  doc.text(M, doc.height - 40, `Huella SHA-256 del contenido: ${fingerprint}`, { size: 7, color: "#9699a6" });
  doc.text(R, doc.height - 40, ctx.settings.company_name || "", { size: 7, color: "#9699a6", align: "right" });
  const pdf = doc.render({ title: `Presupuesto ${q.number} v${q.version}`, author: ctx.settings.company_name, created: String(q.created_at ?? q.date) });
  return { pdf, sha256: fingerprint, filename: `presupuesto-${q.number}-v${q.version}.pdf` };
}
