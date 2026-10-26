/**
 * Generador de PDF mínimo y sin dependencias: páginas A4, Helvetica/Helvetica-Bold (fuentes estándar del PDF,
 * codificación WinAnsi para tildes, ñ y €), texto, líneas y rectángulos. Suficiente para presupuestos y
 * documentos de negocio; para maquetación compleja se usaría un motor de plantillas (DOCX → PDF).
 */
const W = 595.28, H = 841.89;
// anchos AFM de Helvetica (32..126) en milésimas de em; el resto se aproxima
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVB = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const CP1252: Record<string, number> = { "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99 };
const fold = (s: string) => s.normalize("NFC");
function bytes(s: string): number[] { return Array.from(fold(s)).map((ch) => { const c = ch.codePointAt(0)!; if (CP1252[ch]) return CP1252[ch]!; return c < 256 ? c : 63; }); }
function esc(s: string): string { return bytes(s).map((b) => (b === 40 || b === 41 || b === 92 ? `\\${String.fromCharCode(b)}` : b < 32 || b > 126 ? `\\${b.toString(8).padStart(3, "0")}` : String.fromCharCode(b))).join(""); }
export function textWidth(s: string, size: number, bold = false): number {
  const t = bold ? HELVB : HELV;
  return bytes(s).reduce((w, b) => w + (b >= 32 && b <= 126 ? t[b - 32]! : b === 0x80 ? 556 : 556), 0) * size / 1000;
}
const rgb = (hex: string) => { const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i); return m ? [m[1], m[2], m[3]].map((x) => (parseInt(x!, 16) / 255).toFixed(3)).join(" ") : "0 0 0"; };

export class PdfDoc {
  private pages: string[][] = [];
  private cur: string[] = [];
  readonly width = W; readonly height = H;
  constructor() { this.addPage(); }
  addPage() { this.cur = []; this.pages.push(this.cur); return this; }
  text(x: number, y: number, s: string, o: { size?: number; bold?: boolean; color?: string; align?: "left" | "right" | "center" } = {}) {
    const size = o.size ?? 10; const w = textWidth(s, size, o.bold);
    const xx = o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x;
    this.cur.push(`BT /${o.bold ? "F2" : "F1"} ${size} Tf ${rgb(o.color ?? "#323338")} rg ${xx.toFixed(2)} ${(H - y).toFixed(2)} Td (${esc(s)}) Tj ET`);
    return w;
  }
  /** Parte un texto en líneas que caben en `maxW`. */
  wrap(s: string, maxW: number, size: number, bold = false): string[] {
    const out: string[] = [];
    for (const para of String(s).split(/\n/)) {
      let line = "";
      for (const word of para.split(/\s+/)) { const tryL = line ? `${line} ${word}` : word; if (textWidth(tryL, size, bold) > maxW && line) { out.push(line); line = word; } else line = tryL; }
      out.push(line);
    }
    return out;
  }
  line(x1: number, y1: number, x2: number, y2: number, color = "#d0d4e4", width = 0.6) { this.cur.push(`${rgb(color)} RG ${width} w ${x1.toFixed(2)} ${(H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(H - y2).toFixed(2)} l S`); return this; }
  rect(x: number, y: number, w: number, h: number, fill: string) { this.cur.push(`${rgb(fill)} rg ${x.toFixed(2)} ${(H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); return this; }
  get pageCount() { return this.pages.length; }
  render(meta: { title?: string; author?: string; created?: string } = {}): Buffer {
    const objs: string[] = [];
    const add = (s: string) => { objs.push(s); return objs.length; };
    const catalog = add(""); const pagesObj = add("");
    const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const kids: number[] = [];
    for (const p of this.pages) {
      const content = p.join("\n");
      const c = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    const info = add(`<< /Producer (CRM) /Title (${esc(meta.title ?? "")}) /Author (${esc(meta.author ?? "")}) /CreationDate (D:${new Date(meta.created ?? Date.now()).toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z) >>`);
    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"; const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  }
}
