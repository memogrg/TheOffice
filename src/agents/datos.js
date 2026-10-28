// AGENTE CALIDAD DE DATOS — solo lectura. Revisa los contactos (res.partner) de todas las
// compañías y encuentra lo que después rompe otras cosas:
//   · duplicados por cédula en la misma compañía (el buzón falla con «supplier exists more than once»)
//   · posibles duplicados por nombre (mismo nombre normalizado, cédulas distintas o sin cédula)
//   · cédulas con formato inválido para su tipo (física 9, jurídica 10, DIMEX 11–12, NITE 10)
//   · proveedores y clientes con documentos y sin cédula
//   · clientes facturados sin correo (no reciben la factura electrónica ni el recordatorio de cobro)
//   · correos con formato inválido, y terceros archivados que tienen documentos
// No corrige: dice qué contacto conservar (el que tiene más documentos) y qué revisar.
import { idDe, nombreDe } from "../lib/contable.js";

export const meta = {
  id: "datos", nombre: "CALIDAD DE DATOS", puesto: "Revisa los contactos",
  modelo: "res.partner", escribe: false
};

export const soloDigitos = v => String(v || "").replace(/\D/g, "");
const LARGOS = { "01": [9], "02": [10], "03": [11, 12], "04": [10] };
const TIPOS = { "01": "física", "02": "jurídica", "03": "DIMEX", "04": "NITE", "05": "extranjero", "06": "otro" };
export function cedulaInvalida(vat, tipo) {
  const v = String(vat || "").trim();
  if (!v) return null;
  const d = soloDigitos(v);
  if (LARGOS[tipo] && !LARGOS[tipo].includes(d.length)) return `${TIPOS[tipo]} con ${d.length} dígitos (debe tener ${LARGOS[tipo].join(" u ")})`;
  if (LARGOS[tipo] && d !== v) return `tiene caracteres que no son dígitos («${v}»)`;
  return null;
}
const SUFIJOS = /\b(SOCIEDAD ANONIMA|S\s*A|SRL|S\s*R\s*L|LTDA|LIMITADA|SOCIEDAD DE RESPONSABILIDAD LIMITADA|CORPORACION|CORP|INC|EIRL)\b/g;
export const nombreNormal = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(SUFIJOS, " ").replace(/\s+/g, " ").trim();
export const correoValido = e => /^[^@\s;,]+@[^@\s;,]+\.[a-z]{2,}$/i.test(String(e || "").trim());

export async function ejecutar({ odoo, cfg, log }) {
  const t0 = Date.now();
  await odoo.conectar();
  const contactos = await odoo.leerTodo("res.partner", [["active", "=", true], ["parent_id", "=", false]], ["name", "vat", "type_vat", "email", "company_id"]);
  let archivados = [];
  try { archivados = await odoo.leerTodo("res.partner", [["active", "=", false], ["parent_id", "=", false]], ["name", "vat", "company_id"]); } catch { /* sin permiso */ }
  log(`${contactos.length} contactos activos, ${archivados.length} archivados`);

  // documentos por tercero: ventas y compras publicadas
  const g = await odoo.leer("account.move", "read_group", [[["state", "=", "posted"], ["move_type", "in", ["out_invoice", "out_refund", "in_invoice", "in_refund"]]], ["partner_id"], ["partner_id", "move_type"]], { lazy: false });
  const docs = new Map();
  for (const x of g) {
    const p = idDe(x.partner_id); if (!p) continue;
    const d = docs.get(p) || { ventas: 0, compras: 0 };
    if (/^out_/.test(x.move_type)) d.ventas += x.__count; else d.compras += x.__count;
    docs.set(p, d);
  }
  const usoDe = id => docs.get(id) || { ventas: 0, compras: 0 };
  const ficha = c => ({ id: c.id, nombre: c.name, cedula: c.vat || null, correo: c.email || null, ...usoDe(c.id) });
  const ciaDe = c => ({ companiaId: idDe(c.company_id) || null, compania: nombreDe(c.company_id) || "(compartido)" });

  const porCedula = new Map(), porNombre = new Map();
  for (const c of contactos) {
    const cia = idDe(c.company_id) || 0;
    const d = soloDigitos(c.vat);
    if (d.length >= 6) { const k = `${cia}|${d}`; porCedula.set(k, [...(porCedula.get(k) || []), c]); }
    const n = nombreNormal(c.name);
    if (n.length >= 4) { const k = `${cia}|${n}`; porNombre.set(k, [...(porNombre.get(k) || []), c]); }
  }
  const total = c => usoDe(c.id).ventas + usoDe(c.id).compras;
  const conservar = grupo => [...grupo].sort((a, b) => total(b) - total(a) || a.id - b.id)[0];
  const duplicados = [...porCedula.values()].filter(x => x.length > 1).map(x => ({ ...ciaDe(x[0]), cedula: soloDigitos(x[0].vat), contactos: x.map(ficha), conservar: conservar(x).id, documentos: x.reduce((t, c) => t + total(c), 0) }))
    .sort((a, b) => b.documentos - a.documentos);
  const enDuplicados = new Set(duplicados.flatMap(d => d.contactos.map(c => c.id)));
  const parecidos = [...porNombre.values()].filter(x => x.length > 1 && new Set(x.map(c => soloDigitos(c.vat))).size > 1 && !x.every(c => enDuplicados.has(c.id)))
    .map(x => ({ ...ciaDe(x[0]), nombre: x[0].name, contactos: x.map(ficha), documentos: x.reduce((t, c) => t + total(c), 0) })).sort((a, b) => b.documentos - a.documentos);

  const cedulas = [], sinCedula = [], sinCorreo = [], correosMalos = [];
  for (const c of contactos) {
    const u = usoDe(c.id), base = { ...ciaDe(c), ...ficha(c) };
    const mala = cedulaInvalida(c.vat, c.type_vat);
    if (mala) cedulas.push({ ...base, tipo: TIPOS[c.type_vat] || c.type_vat || "?", motivo: mala });
    if (!c.vat && (u.ventas || u.compras)) sinCedula.push({ ...base, rol: u.compras && u.ventas ? "cliente y proveedor" : u.compras ? "proveedor" : "cliente" });
    if (u.ventas && !c.email) sinCorreo.push(base);
    if (c.email && String(c.email).split(/[;,]/).some(e => !correoValido(e))) correosMalos.push(base);
  }
  const archivadosConDocs = archivados.filter(a => total(a)).map(a => ({ ...ciaDe(a), ...ficha(a) }));
  const ordenar = xs => xs.sort((a, b) => (b.ventas + b.compras) - (a.ventas + a.compras));
  [cedulas, sinCedula, sinCorreo, correosMalos].forEach(ordenar);

  const totales = { contactos: contactos.length, gruposDuplicados: duplicados.length, contactosDuplicados: duplicados.reduce((t, d) => t + d.contactos.length, 0),
    posiblesDuplicados: parecidos.length, cedulasInvalidas: cedulas.length, sinCedulaConDocumentos: sinCedula.length, clientesSinCorreo: sinCorreo.length,
    correosInvalidos: correosMalos.length, archivadosConDocumentos: archivadosConDocs.length };
  const alertas = [];
  if (duplicados.length) alertas.push({ nivel: "alto", texto: `${duplicados.length} cédulas repetidas en la misma compañía (${totales.contactosDuplicados} contactos): el buzón no registra facturas de esos proveedores («supplier exists more than once»). Fusionar en Odoo (Contactos → seleccionar → Acción → Fusionar), conservando el que tiene más documentos.`,
    detalle: duplicados.slice(0, 8).map(d => `${d.compania} — ${d.cedula}: ${d.contactos.map(c => `${c.nombre} (#${c.id}, ${c.ventas + c.compras} doc.)`).join(" / ")}`) });
  if (sinCedula.length) alertas.push({ nivel: "alto", texto: `${sinCedula.length} terceros con documentos y sin cédula.`, detalle: sinCedula.slice(0, 8).map(s => `${s.compania} — ${s.nombre} (${s.rol}, ${s.ventas + s.compras} doc.)`) });
  if (cedulas.length) alertas.push({ nivel: "alto", texto: `${cedulas.length} cédulas con formato inválido para su tipo.`, detalle: cedulas.slice(0, 8).map(c => `${c.compania} — ${c.nombre}: ${c.motivo}`) });
  if (sinCorreo.length) alertas.push({ nivel: "info", texto: `${sinCorreo.length} clientes facturados sin correo: no les llega la factura electrónica ni el recordatorio de cobro.`, detalle: sinCorreo.slice(0, 8).map(s => `${s.compania} — ${s.nombre} (${s.ventas} facturas)`) });
  if (parecidos.length) alertas.push({ nivel: "info", texto: `${parecidos.length} grupos de contactos con el mismo nombre y cédula distinta o vacía: revisar si son el mismo.`, detalle: parecidos.slice(0, 6).map(p => `${p.compania} — ${p.nombre}: ${p.contactos.map(c => c.cedula || "sin cédula").join(" / ")}`) });
  if (correosMalos.length) alertas.push({ nivel: "info", texto: `${correosMalos.length} correos con formato inválido.`, detalle: correosMalos.slice(0, 6).map(c => `${c.compania} — ${c.nombre}: «${c.correo}»`) });
  if (archivadosConDocs.length) alertas.push({ nivel: "info", texto: `${archivadosConDocs.length} terceros archivados que tienen documentos.`, detalle: archivadosConDocs.slice(0, 6).map(a => `${a.compania} — ${a.nombre}`) });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: "Contactos sin observaciones.", detalle: [] });

  return {
    agente: meta.nombre, titulo: "Calidad de datos de contactos", corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    totales, duplicados: duplicados.slice(0, 300), parecidos: parecidos.slice(0, 200), cedulas: cedulas.slice(0, 300), sinCedula: sinCedula.slice(0, 300),
    sinCorreo: sinCorreo.slice(0, 400), correosMalos: correosMalos.slice(0, 200), archivados: archivadosConDocs.slice(0, 100), alertas
  };
}
