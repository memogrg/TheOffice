// Lectura de archivos subidos a la app, sin dependencias: zip, hoja de Excel (.xlsx) y texto
// separado (CSV/TXT). Lo usan los extractos bancarios y la revisión de comprobantes (zip de PDF+XML).
//
// Todo es puro (Buffer → datos) y con límites, porque los archivos vienen de afuera.
import { inflateRawSync } from "node:zlib";

export const LIMITES = { entradas: 3000, descomprimido: 120 * 1024 * 1024 };

// --- zip (sin zip64; métodos 0 = guardado y 8 = deflate) -------------------------------------
export function leerZip(buf, { limites = LIMITES } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("No es un archivo zip.");
  let fin = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  if (fin < 0) throw new Error("No es un archivo zip (o está incompleto).");
  const n = buf.readUInt16LE(fin + 10), inicio = buf.readUInt32LE(fin + 16);
  if (n === 0xffff || inicio === 0xffffffff) throw new Error("Zip demasiado grande (zip64): divídalo en varios.");
  if (n > limites.entradas) throw new Error(`El zip tiene ${n} archivos; el máximo es ${limites.entradas}.`);
  const out = [];
  let p = inicio, total = 0;
  for (let k = 0; k < n; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("El índice del zip está dañado.");
    const flags = buf.readUInt16LE(p + 8), metodo = buf.readUInt16LE(p + 10);
    const comprimido = buf.readUInt32LE(p + 20), tamano = buf.readUInt32LE(p + 24);
    const ln = buf.readUInt16LE(p + 28), le = buf.readUInt16LE(p + 30), lc = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const nombre = buf.subarray(p + 46, p + 46 + ln).toString(flags & 0x800 ? "utf8" : "latin1");
    p += 46 + ln + le + lc;
    if (nombre.endsWith("/") || /(^|\/)(__MACOSX|\.DS_Store)/.test(nombre)) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`«${nombre}» está dañado dentro del zip.`);
    const desde = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const crudo = buf.subarray(desde, desde + comprimido);
    total += tamano;
    if (total > limites.descomprimido) throw new Error("El zip descomprimido es demasiado grande: divídalo en varios.");
    let datos = null, error = null;
    try {
      if (metodo === 0) datos = Buffer.from(crudo);
      else if (metodo === 8) datos = inflateRawSync(crudo, { maxOutputLength: Math.max(tamano, 1) });
      else error = `método de compresión ${metodo} no soportado`;
    } catch (e) { error = e.message; }
    if (flags & 0x1) { datos = null; error = "está protegido con contraseña"; }
    out.push({ nombre, base: nombre.split("/").pop(), tamano, datos, error });
  }
  return out;
}

// --- XML mínimo -------------------------------------------------------------------------------
export const desescapar = s => String(s ?? "").replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const t = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e.toLowerCase()];
  if (t) return t;
  const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
});

// --- Excel .xlsx: la primera hoja como filas (números como number, el resto como texto) -------
const columna = ref => { const m = /^([A-Z]+)/.exec(ref || ""); if (!m) return null; let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
export function leerXLSX(buf) {
  const ent = new Map(leerZip(buf).map(e => [e.nombre.replace(/^\//, ""), e]));
  const texto = k => { const e = ent.get(k); return e && e.datos ? e.datos.toString("utf8") : null; };
  if (!ent.has("xl/workbook.xml")) throw new Error("No es una hoja de Excel .xlsx (si es .xls antiguo, guárdela como .xlsx o .csv).");
  const compartidos = [];
  const ss = texto("xl/sharedStrings.xml");
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const sinFonetica = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
    compartidos.push(desescapar([...sinFonetica.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join("")));
  }
  // primera hoja según el libro; si no se puede resolver, la primera que haya
  let ruta = null;
  const libro = texto("xl/workbook.xml"), rels = texto("xl/_rels/workbook.xml.rels");
  const rid = libro && /<sheet\b[^>]*\br:id="([^"]+)"/.exec(libro)?.[1];
  if (rid && rels) {
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(x => x[0]).find(x => x.includes(`Id="${rid}"`));
    const destino = rel && /Target="([^"]+)"/.exec(rel)?.[1];
    if (destino) ruta = destino.startsWith("/") ? destino.slice(1) : `xl/${destino.replace(/^\.\//, "")}`;
  }
  if (!ruta || !ent.has(ruta)) ruta = [...ent.keys()].filter(k => /^xl\/worksheets\/sheet\d*\.xml$/.test(k)).sort()[0];
  const hoja = ruta && texto(ruta);
  if (!hoja) throw new Error("La hoja de Excel no tiene datos legibles.");
  const filas = [];
  for (const f of hoja.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(/\br="(\d+)"/.exec(f[1])?.[1]) || filas.length + 1;
    const fila = [];
    for (const c of (f[2] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const at = c[1], cuerpo = c[2] || "";
      const col = columna(/\br="([A-Z]+)\d+"/.exec(at)?.[1]) ?? fila.length;
      const tipo = /\bt="(\w+)"/.exec(at)?.[1] || "n";
      const v = /<v>([\s\S]*?)<\/v>/.exec(cuerpo)?.[1];
      let valor = "";
      if (tipo === "s") valor = compartidos[Number(v)] ?? "";
      else if (tipo === "inlineStr") valor = desescapar([...cuerpo.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(""));
      else if (tipo === "str" || tipo === "e") valor = desescapar(v ?? "");
      else if (tipo === "b") valor = v === "1" ? "VERDADERO" : "FALSO";
      else valor = v == null || v === "" ? "" : Number(v);
      fila[col] = valor;
    }
    filas[r - 1] = Array.from(fila, x => x ?? "");
  }
  return Array.from(filas, x => x ?? []);
}

// --- Texto separado (CSV, TXT): detecta codificación y separador ------------------------------
export function decodificar(buf) {
  const u = buf.toString("utf8");
  return (u.includes("�") ? buf.toString("latin1") : u).replace(/^﻿/, "");
}
export function leerSeparado(texto) {
  const lineas = String(texto || "").split(/\r?\n/);
  const muestra = lineas.filter(l => l.trim()).slice(0, 60);
  let sep = ",", mejor = -1;
  for (const c of [";", "\t", ",", "|"]) {
    const cuentas = muestra.map(l => partir(l, c).length).filter(n => n > 1);
    if (!cuentas.length) continue;
    const moda = [...cuentas.reduce((m, n) => m.set(n, (m.get(n) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0];
    const puntaje = moda[1] * Math.min(moda[0], 12);
    if (puntaje > mejor) { mejor = puntaje; sep = c; }
  }
  return lineas.map(l => (l.trim() ? partir(l, sep) : []));
}
function partir(l, sep) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === sep && !q) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// Un archivo subido ({nombre, base64}) → filas, según la extensión o el contenido.
export function filasDeArchivo({ nombre = "", base64 = "" }) {
  const buf = Buffer.from(String(base64), "base64");
  if (buf.length < 4) throw new Error("El archivo está vacío.");
  const ext = String(nombre).toLowerCase().split(".").pop();
  if (ext === "xls" && buf.readUInt32LE(0) === 0xe011cfd0) throw new Error("Es un .xls antiguo: ábralo en Excel y guárdelo como .xlsx o .csv.");
  if (ext === "xlsx" || (buf.readUInt32LE(0) === 0x04034b50 && ext !== "zip")) return { formato: "xlsx", filas: leerXLSX(buf) };
  return { formato: ext === "txt" ? "txt" : "csv", filas: leerSeparado(decodificar(buf)) };
}
