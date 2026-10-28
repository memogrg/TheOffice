// Revisión de comprobantes que llegan en un zip (PDF + XML, como los que mandan algunos clientes) o
// sueltos: de quién a quién, por cuánto, si Hacienda los aceptó y si ya están en Odoo (registrados
// o en el buzón). Solo lee: cargarlos en Odoo es documento de FE y espera a TecnoDEM.
import { leerZip } from "../lib/archivos.js";
import { agrupar } from "../lib/comprobantes.js";

const idDe = v => (Array.isArray(v) ? v[0] : v);
const nombreDe = v => (Array.isArray(v) ? v[1] : v);
const digitos = v => String(v || "").replace(/\D/g, "");
const trozos = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export function archivosDe({ nombre = "", base64 = "" }) {
  const buf = Buffer.from(String(base64), "base64");
  if (buf.length < 4) throw new Error("El archivo está vacío.");
  const base = String(nombre).split(/[\\/]/).pop();
  if (/\.zip$/i.test(base) || buf.readUInt32LE(0) === 0x04034b50) return leerZip(buf);
  if (/\.xml$/i.test(base)) return [{ nombre: base, base, datos: buf, error: null }];
  throw new Error("Suba un .zip con los PDF y XML, o un XML suelto.");
}

export async function revisar({ corridas, archivo }) {
  let entradas;
  try { entradas = archivosDe(archivo || {}); } catch (e) { return { error: e.message }; }
  const g = agrupar(entradas);
  if (!g.documentos.length) return { error: "No se encontró ningún comprobante electrónico (XML de Hacienda) en el archivo.", ...g };

  const odoo = corridas.crearCliente({ meta: { escribe: false } });
  const cias = await odoo.leer("res.company", "search_read", [[], ["name", "vat"]], {});
  const ciaPorCedula = new Map(cias.filter(c => digitos(c.vat)).map(c => [digitos(c.vat), c]));
  const claves = g.documentos.map(d => d.clave);
  const movs = [];
  for (const t of trozos(claves, 200)) movs.push(...await odoo.leer("account.move", "search_read", [[["e_key", "in", t]], ["name", "state", "move_type", "company_id", "partner_id", "amount_total", "e_key"]], {}));
  const porClave = new Map(movs.map(m => [m.e_key, m]));
  const buzon = new Map();
  const faltan = claves.filter(k => !porClave.has(k));
  try {
    for (const t of trozos(faltan, 40)) {
      const dom = [...Array(Math.max(0, t.length - 1)).fill("|"), ...t.map(k => ["e_invoice_name", "ilike", k])];
      for (const b of await odoo.leer("bdt.invoice.email", "search_read", [dom, ["company_id", "state", "error", "e_invoice_name", "date"]], {})) {
        const k = t.find(x => String(b.e_invoice_name || "").includes(x));
        if (k && !buzon.has(k)) buzon.set(k, b);
      }
    }
  } catch { /* sin acceso al buzón en esta instancia */ }

  const documentos = g.documentos.map(d => {
    const compra = ciaPorCedula.get(digitos(d.receptor?.cedula)), venta = ciaPorCedula.get(digitos(d.emisor?.cedula));
    const cia = compra || venta || null;
    const m = porClave.get(d.clave), b = buzon.get(d.clave);
    let estado;
    if (!cia) estado = "ajeno";
    else if (m) estado = "registrado";
    else if (b) estado = "en-buzon";
    else estado = "falta";
    return {
      clave: d.clave, tipo: d.tipo, consecutivo: d.consecutivo, fecha: d.fecha, emisor: d.emisor?.nombre || null, cedulaEmisor: d.emisor?.cedula || null,
      receptor: d.receptor?.nombre || null, cedulaReceptor: d.receptor?.cedula || null, moneda: d.moneda, total: d.total, impuesto: d.impuesto,
      lado: compra ? "compra" : venta ? "venta" : null, companiaId: cia?.id ?? null, compania: cia?.name ?? null, hacienda: d.hacienda || null,
      xml: d.xml, pdf: d.pdf, estado,
      odoo: m ? { asiento: m.name || `#${m.id}`, estadoOdoo: m.state, compania: nombreDe(m.company_id), otraCompania: cia && idDe(m.company_id) !== cia.id } : null,
      buzon: b ? { estado: b.state, error: b.error ? String(b.error).slice(0, 200) : null } : null
    };
  }).sort((a, b) => ["falta", "en-buzon", "registrado", "ajeno"].indexOf(a.estado) - ["falta", "en-buzon", "registrado", "ajeno"].indexOf(b.estado) || String(a.fecha).localeCompare(String(b.fecha)));

  const cuenta = e => documentos.filter(d => d.estado === e).length;
  const totales = { documentos: documentos.length, registrados: cuenta("registrado"), enBuzon: cuenta("en-buzon"), faltan: cuenta("falta"), ajenos: cuenta("ajeno"),
    rechazadosHacienda: documentos.filter(d => d.hacienda === "rechazado").length, sinPDF: documentos.filter(d => !d.pdf).length, pdfSinXML: g.pdfSinXML.length };
  const alertas = [];
  if (totales.faltan) alertas.push({ nivel: "alto", texto: `${totales.faltan} comprobantes no están en Odoo ni en el buzón: hay que cargarlos (o reenviarlos al correo del buzón).`,
    detalle: documentos.filter(d => d.estado === "falta").slice(0, 10).map(d => `${d.compania} — ${d.emisor} ${d.consecutivo || ""} ${d.fecha || ""} ${d.moneda} ${d.total}`) });
  if (totales.enBuzon) alertas.push({ nivel: "info", texto: `${totales.enBuzon} están en el buzón sin registrar (vea Casos y Hallazgos → Diagnóstico).`,
    detalle: documentos.filter(d => d.estado === "en-buzon").slice(0, 8).map(d => `${d.compania} — ${d.emisor}: ${d.buzon.estado}${d.buzon.error ? ` (${d.buzon.error.slice(0, 80)})` : ""}`) });
  if (totales.rechazadosHacienda) alertas.push({ nivel: "alto", texto: `${totales.rechazadosHacienda} comprobantes rechazados por Hacienda: no sirven para crédito fiscal ni gasto.`,
    detalle: documentos.filter(d => d.hacienda === "rechazado").slice(0, 8).map(d => `${d.emisor} ${d.consecutivo || d.clave}`) });
  if (totales.ajenos) alertas.push({ nivel: "info", texto: `${totales.ajenos} comprobantes cuya cédula de emisor o receptor no es de ninguna compañía.`, detalle: documentos.filter(d => d.estado === "ajeno").slice(0, 6).map(d => `${d.emisor} → ${d.receptor} (${d.cedulaReceptor})`) });
  if (g.pdfSinXML.length) alertas.push({ nivel: "info", texto: `${g.pdfSinXML.length} PDF sin su XML: sin el XML no se puede registrar.`, detalle: g.pdfSinXML.slice(0, 8) });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: "Todos los comprobantes ya están registrados en Odoo.", detalle: [] });
  return { totales, documentos, pdfSinXML: g.pdfSinXML, otros: g.otros.slice(0, 50), alertas };
}
