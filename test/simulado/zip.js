// Arma zips y hojas .xlsx mínimas para las pruebas (deflate, con índice central), sin dependencias.
import { deflateRawSync } from "node:zlib";

const crc = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return b => { let c = -1; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }; })();

export function crearZip(archivos) {
  const locales = [], centrales = []; let off = 0;
  for (const [nombre, contenido] of Object.entries(archivos)) {
    const datos = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido, "utf8");
    const comp = deflateRawSync(datos), n = Buffer.from(nombre, "utf8");
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x800, 6); l.writeUInt16LE(8, 8);
    l.writeUInt32LE(crc(datos), 14); l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(datos.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc(datos), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(datos.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    locales.push(l, n, comp); centrales.push(c, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrales), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(archivos).length, 8); e.writeUInt16LE(Object.keys(archivos).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locales, cd, e]);
}

// filas: arreglos de texto o número. Los textos van como cadenas compartidas, como lo hace Excel.
export function crearXLSX(filas) {
  const compartidas = [];
  const idx = s => { let i = compartidas.indexOf(s); if (i < 0) { compartidas.push(s); i = compartidas.length - 1; } return i; };
  const col = i => { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const hoja = filas.map((f, r) => `<row r="${r + 1}">${f.map((v, c) => v === "" || v == null ? "" : typeof v === "number"
    ? `<c r="${col(c)}${r + 1}"><v>${v}</v></c>` : `<c r="${col(c)}${r + 1}" t="s"><v>${idx(String(v))}</v></c>`).join("")}</row>`).join("");
  return crearZip({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Movimientos" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst>${compartidas.map(s => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${hoja}</sheetData></worksheet>`
  });
}
