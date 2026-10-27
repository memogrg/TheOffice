// AGENTE DOCUMENTOS — solo lectura. Fase 3A (ítems 3, 4 y 5 de la matriz).
//   1. Notas de crédito (de compra y de venta) que no están ligadas a la factura que corrigen.
//      La referencia viene en el XML (reference_number): la clave de 50 dígitos de la factura
//      original o su consecutivo de 20. Si la factura está en los libros, propone el vínculo;
//      si no, avisa que falta registrarla.
//   2. Huecos en los consecutivos de venta: por compañía, sucursal, terminal y tipo de documento,
//      los números que faltan entre el primero y el último emitido (ventas importadas de otros
//      sistemas que no llegaron).
// No liga nada ni crea nada: el vínculo es una propuesta que decide una persona.
import { esClave, consecutivoDoc, cedulaEmisor, TIPO_DOC } from "../lib/clave.js";

export const meta = {
  id: "documentos", nombre: "DOCUMENTOS", puesto: "Notas de crédito y consecutivos",
  modelo: "account.move", escribe: false
};

const ORIGINAL = { in_refund: "in_invoice", out_refund: "out_invoice" };
const MOTIVO = { "01": "anula el documento", "02": "corrige texto", "03": "corrige monto", "04": "referencia a otro documento", "05": "sustituye un comprobante provisional", "99": "otros" };

// Rangos compactos de números faltantes: [5,6,7,10] → ["5–7", "10"]
export function rangos(nums) {
  const out = []; let i = 0;
  while (i < nums.length) { let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++; out.push(i === j ? `${nums[i]}` : `${nums[i]}–${nums[j]}`); i = j + 1; }
  return out;
}

// Huecos de una serie de números enteros (ya sin repetidos). Una serie con huecos gigantes (más
// de maxHueco seguidos) casi siempre es una serie que empezó en otro sistema: se informa aparte.
export function huecos(numeros, { maxHueco = 500 } = {}) {
  const s = [...new Set(numeros)].sort((a, b) => a - b);
  const faltan = [], saltos = [];
  for (let i = 1; i < s.length; i++) {
    const d = s[i] - s[i - 1] - 1;
    if (d <= 0) continue;
    if (d > maxHueco) { saltos.push({ desde: s[i - 1], hasta: s[i], faltan: d }); continue; }
    for (let n = s[i - 1] + 1; n < s[i]; n++) faltan.push(n);
  }
  return { primero: s[0] ?? null, ultimo: s[s.length - 1] ?? null, emitidos: s.length, faltan, saltos };
}

export async function ejecutar({ odoo, cfg, log }) {
  const t0 = Date.now();
  await odoo.conectar();

  // --- 1. Notas de crédito sin ligar
  const ncs = await odoo.leerTodo("account.move", [["move_type", "in", ["in_refund", "out_refund"]], ["state", "in", ["draft", "posted"]], ["reversed_entry_id", "=", false]],
    ["name", "company_id", "partner_id", "move_type", "state", "invoice_date", "amount_total", "reference_number", "reference_code", "reference_reason", "e_key"]);
  const originales = await odoo.leerTodo("account.move", [["move_type", "in", ["in_invoice", "out_invoice"]], ["e_key", "!=", false]],
    ["name", "company_id", "partner_id", "move_type", "state", "invoice_date", "amount_total", "e_key"]);
  log(`${ncs.length} notas de crédito sin ligar; ${originales.length} facturas con clave para buscarles el original`);
  const porClave = new Map(), porConsecutivo = new Map();
  for (const o of originales) {
    porClave.set(o.e_key, o);
    const c = consecutivoDoc(o.e_key);
    if (c) porConsecutivo.set(`${o.company_id?.[0]}|${o.move_type}|${cedulaEmisor(o.e_key)}|${c}`, o);
  }
  const notas = ncs.map(n => {
    const ref = String(n.reference_number || "").replace(/\D/g, "");
    const tipoOriginal = ORIGINAL[n.move_type];
    let original = null, por = null;
    if (esClave(ref)) { const o = porClave.get(ref); if (o && o.company_id?.[0] === n.company_id?.[0] && o.move_type === tipoOriginal) { original = o; por = "clave"; } }
    else if (/^\d{20}$/.test(ref)) {
      // solo el consecutivo: se busca entre los documentos del mismo emisor (la cédula de la clave de la nota)
      const o = porConsecutivo.get(`${n.company_id?.[0]}|${tipoOriginal}|${cedulaEmisor(n.e_key)}|${ref}`);
      if (o) { original = o; por = "consecutivo"; }
    }
    const estado = original ? "ligable" : ref ? "original-no-esta" : "sin-referencia";
    const r = { id: n.id, nota: n.name || null, tipo: n.move_type === "in_refund" ? "compra" : "venta", compania: n.company_id?.[1] || "", companiaId: n.company_id?.[0] || null,
      contraparte: n.partner_id?.[1] || null, fecha: n.invoice_date || null, monto: n.amount_total, estadoNota: n.state,
      referencia: ref || null, motivo: MOTIVO[n.reference_code] || n.reference_code || null, razon: String(n.reference_reason || "").slice(0, 120), estado };
    if (original) Object.assign(r, { originalId: original.id, original: original.name || original.e_key, originalMonto: original.amount_total, encontradaPor: por,
      montoMayor: Number(n.amount_total) > Number(original.amount_total) + 0.01 });
    return r;
  });

  // --- 2. Consecutivos de venta
  const ventas = await odoo.leerTodo("account.move", [["move_type", "in", ["out_invoice", "out_refund"]], ["e_key", "!=", false]], ["company_id", "e_key", "state"]);
  const series = new Map();
  for (const v of ventas) {
    const c = consecutivoDoc(v.e_key);
    if (!c) continue;
    const k = `${v.company_id?.[0]}|${c.slice(0, 3)}|${c.slice(3, 8)}|${c.slice(8, 10)}`;
    const s = series.get(k) || { compania: v.company_id?.[1] || "", companiaId: v.company_id?.[0] || null, sucursal: c.slice(0, 3), terminal: c.slice(3, 8), tipo: c.slice(8, 10), numeros: [] };
    s.numeros.push(Number(c.slice(10)));
    series.set(k, s);
  }
  const consecutivos = [...series.values()].map(s => {
    const h = huecos(s.numeros);
    return { compania: s.compania, companiaId: s.companiaId, sucursal: s.sucursal, terminal: s.terminal, tipo: TIPO_DOC[s.tipo] || s.tipo,
      primero: h.primero, ultimo: h.ultimo, emitidos: h.emitidos, faltantes: h.faltan.length, rangos: rangos(h.faltan).slice(0, 15), saltos: h.saltos };
  }).filter(s => s.faltantes || s.saltos.length).sort((a, b) => b.faltantes - a.faltantes);

  // --- totales y alertas
  const cuenta = (t, e) => notas.filter(n => n.tipo === t && n.estado === e).length;
  const totales = {
    notasSinLigar: notas.length, ligables: notas.filter(n => n.estado === "ligable").length,
    originalNoEsta: notas.filter(n => n.estado === "original-no-esta").length, sinReferencia: notas.filter(n => n.estado === "sin-referencia").length,
    compra: notas.filter(n => n.tipo === "compra").length, venta: notas.filter(n => n.tipo === "venta").length,
    seriesConHuecos: consecutivos.length, consecutivosFaltantes: consecutivos.reduce((s, c) => s + c.faltantes, 0)
  };
  const alertas = [];
  if (totales.ligables) alertas.push({ nivel: "alto", texto: `${totales.ligables} notas de crédito tienen su factura original en los libros pero no están ligadas: el vínculo está propuesto.`,
    detalle: notas.filter(n => n.estado === "ligable").slice(0, 8).map(n => `${n.compania} — NC ${n.nota || n.id} → ${n.original} (por ${n.encontradaPor})${n.montoMayor ? " ⚠ la nota supera a la factura" : ""}`) });
  if (totales.originalNoEsta) alertas.push({ nivel: "alto", texto: `${totales.originalNoEsta} notas de crédito corrigen una factura que no está registrada (compra ${cuenta("compra", "original-no-esta")}, venta ${cuenta("venta", "original-no-esta")}).`,
    detalle: notas.filter(n => n.estado === "original-no-esta").slice(0, 8).map(n => `${n.compania} — NC ${n.nota || n.id} de ${n.contraparte || "?"}: referencia ${String(n.referencia).slice(-20)}`) });
  if (consecutivos.length) alertas.push({ nivel: "alto", texto: `${totales.consecutivosFaltantes} consecutivos de venta faltan en ${consecutivos.length} series: ventas emitidas que no llegaron a Odoo, o números anulados sin registrar.`,
    detalle: consecutivos.slice(0, 8).map(c => `${c.compania} — ${c.tipo} ${c.sucursal}-${c.terminal}: faltan ${c.faltantes} (${c.rangos.slice(0, 3).join(", ")})`) });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: "Notas de crédito ligadas y consecutivos de venta completos.", detalle: [] });

  return {
    agente: meta.nombre, titulo: "Notas de crédito y consecutivos de venta", corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    totales, notas: notas.slice(0, 400), consecutivos: consecutivos.slice(0, 200), alertas
  };
}
