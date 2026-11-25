// Arma zips y hojas .xlsx mínimas para las pruebas (deflate, con índice central), sin dependencias.
import { crearZip } from "../../src/lib/zip.js";
export { crearZip };

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
