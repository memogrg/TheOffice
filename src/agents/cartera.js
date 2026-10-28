// AGENTE CARTERA — solo lectura. Ítems 9 y 10 de la matriz (cobros y pagos).
// Antigüedad de cuentas por cobrar y por pagar por compañía a una fecha de corte (facturas y notas
// de crédito publicadas con saldo), clientes con más vencido, pagos a proveedores que vencen en los
// próximos días, notas de crédito sin aplicar; y redacta un recordatorio de cobro por cliente con
// facturas vencidas (en nombre de la compañía, respuesta a su correo). Los recordatorios quedan en
// la pestaña Correos como borradores: nada sale sin aprobación.
//
// Configuración: CARTERA_CORTE (AAAA-MM-DD; por omisión hoy, o la fecha típica de la base congelada),
// CARTERA_DIAS_RECORDATORIO (días de vencida para recordar, 1), CARTERA_MINIMO (monto mínimo
// vencido por cliente para recordar, 1000), CARTERA_PROXIMOS (días para «pagos por venir», 15).
import { hoyLocal } from "../lib/meses.js";
import { idDe, nombreDe, r2, ultimaFechaPorCompania, colones } from "../lib/contable.js";

export const meta = {
  id: "cartera", nombre: "CARTERA", puesto: "Antigüedad de cobros y pagos",
  modelo: "account.move", escribe: false
};

export const TRAMOS = [
  { id: "por-vencer", titulo: "Por vencer", hasta: 0 }, { id: "1-30", titulo: "1–30", hasta: 30 }, { id: "31-60", titulo: "31–60", hasta: 60 },
  { id: "61-90", titulo: "61–90", hasta: 90 }, { id: "91-180", titulo: "91–180", hasta: 180 }, { id: "mas-180", titulo: "Más de 180", hasta: Infinity }
];
const dias = (a, b) => Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 864e5);
export const tramoDe = vencidos => TRAMOS.find(t => vencidos <= t.hasta).id;
const esc = s => String(s ?? "").replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

export function fechaDeCorte(cfg, ultimas) {
  if (cfg.CARTERA_CORTE) return cfg.CARTERA_CORTE;
  if (cfg.ALERTA_REFERENCIA === "ultimo-correo") {
    const fs = [...ultimas.values()].map(u => u.ultima).filter(Boolean).sort();
    if (fs.length) return fs[Math.floor((fs.length - 1) / 2)];
  }
  return hoyLocal();
}

export function recordatorioHTML({ compania, cliente, corte, docs, total, monedaTotal, mixto = false }) {
  const filas = docs.map(d => `<tr><td style="padding:6px 8px;border-bottom:1px solid #E1E8E5">${esc(d.numero)}</td><td style="padding:6px 8px;border-bottom:1px solid #E1E8E5">${esc(d.fecha)}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #E1E8E5">${esc(d.vence)}</td><td style="padding:6px 8px;border-bottom:1px solid #E1E8E5;text-align:right">${d.diasVencida}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #E1E8E5;text-align:right">${esc(d.moneda)} ${colones(d.saldoMoneda)}</td></tr>`).join("");
  return `<div style="font-family:Helvetica,Arial,sans-serif;color:#0E1614;max-width:640px">
<p style="font-size:14.5px;line-height:1.6">Estimados señores de <b>${esc(cliente)}</b>:</p>
<p style="font-size:14.5px;line-height:1.6">Les escribimos de parte de <b>${esc(compania)}</b> para recordarles que, al ${esc(corte)}, las siguientes facturas aparecen vencidas en nuestros registros:</p>
<table style="border-collapse:collapse;font-size:13.5px;width:100%"><thead><tr style="text-align:left;color:#6B7C77;font-size:11px;text-transform:uppercase">
<th style="padding:6px 8px">Factura</th><th style="padding:6px 8px">Fecha</th><th style="padding:6px 8px">Vence</th><th style="padding:6px 8px;text-align:right">Días vencida</th><th style="padding:6px 8px;text-align:right">Saldo</th></tr></thead>
<tbody>${filas}</tbody></table>
<p style="font-size:14.5px;line-height:1.6">Saldo vencido: <b>${esc(monedaTotal)} ${colones(total)}</b>${mixto ? " (equivalente en colones de facturas en varias monedas)" : ""}.</p>
<p style="font-size:14.5px;line-height:1.6">Si ya realizaron el pago, por favor respondan este correo con el comprobante para aplicarlo; si hay alguna diferencia, con gusto la revisamos.</p>
<p style="font-size:14.5px;line-height:1.6">Saludos cordiales,<br>${esc(compania)}</p></div>`;
}

export async function ejecutar({ odoo, cfg, log }) {
  const t0 = Date.now();
  await odoo.conectar();
  const ultimas = await ultimaFechaPorCompania(odoo);
  const corte = fechaDeCorte(cfg, ultimas);
  const diasRec = Number(cfg.CARTERA_DIAS_RECORDATORIO || 1), minimo = Number(cfg.CARTERA_MINIMO || 1000), proximos = Number(cfg.CARTERA_PROXIMOS || 15);
  const docs = await odoo.leerTodo("account.move", [["state", "=", "posted"], ["move_type", "in", ["out_invoice", "out_refund", "in_invoice", "in_refund"]],
    ["payment_state", "in", ["not_paid", "partial"]], ["invoice_date", "<=", corte]],
    ["company_id", "partner_id", "name", "move_type", "invoice_date", "invoice_date_due", "amount_residual_signed", "amount_residual", "currency_id"]);
  log(`${docs.length} documentos con saldo al ${corte}`);
  const companias = await odoo.leer("res.company", "search_read", [[], ["name", "email", "currency_id"]], {});
  const ciaDe = new Map(companias.map(c => [c.id, c]));

  const porCia = new Map(), clientes = new Map(), pagos = [], notas = [];
  for (const d of docs) {
    const cia = idDe(d.company_id); if (!cia) continue;
    const venta = /^out_/.test(d.move_type), nota = /refund$/.test(d.move_type);
    const saldo = r2(Math.abs(Number(d.amount_residual_signed) || 0)) * (nota ? -1 : 1);      // en colones, la nota resta
    const vence = d.invoice_date_due || d.invoice_date, vencidos = dias(corte, vence), tramo = tramoDe(vencidos);
    const c = porCia.get(cia) || { companiaId: cia, compania: nombreDe(d.company_id), cobrar: Object.fromEntries(TRAMOS.map(t => [t.id, 0])), pagar: Object.fromEntries(TRAMOS.map(t => [t.id, 0])),
      totalCobrar: 0, totalPagar: 0, vencidoCobrar: 0, vencidoPagar: 0, documentos: 0 };
    const lado = venta ? "cobrar" : "pagar";
    c[lado][tramo] = r2(c[lado][tramo] + saldo);
    c[venta ? "totalCobrar" : "totalPagar"] = r2(c[venta ? "totalCobrar" : "totalPagar"] + saldo);
    if (vencidos > 0 && !nota) c[venta ? "vencidoCobrar" : "vencidoPagar"] = r2(c[venta ? "vencidoCobrar" : "vencidoPagar"] + saldo);
    c.documentos++;
    porCia.set(cia, c);
    if (nota) { notas.push({ compania: c.compania, companiaId: cia, tipo: venta ? "cliente" : "proveedor", tercero: nombreDe(d.partner_id) || "(sin tercero)", numero: d.name, fecha: d.invoice_date, saldo: r2(-saldo) }); continue; }
    if (venta && vencidos >= diasRec && d.partner_id) {
      const k = `${cia}|${idDe(d.partner_id)}`;
      const cl = clientes.get(k) || { companiaId: cia, compania: c.compania, partnerId: idDe(d.partner_id), cliente: nombreDe(d.partner_id), vencido: 0, docs: [], maxDias: 0 };
      cl.vencido = r2(cl.vencido + saldo); cl.maxDias = Math.max(cl.maxDias, vencidos);
      cl.docs.push({ numero: d.name, fecha: d.invoice_date, vence, diasVencida: vencidos, saldo, saldoMoneda: r2(Math.abs(Number(d.amount_residual) || 0)), moneda: nombreDe(d.currency_id) || "CRC" });
      clientes.set(k, cl);
    }
    if (!venta && vencidos > -proximos && vencidos <= 0)
      pagos.push({ compania: c.compania, companiaId: cia, proveedor: nombreDe(d.partner_id) || "(sin tercero)", numero: d.name, vence, enDias: -vencidos, saldo });
  }

  // correos de los clientes con vencidas
  const ids = [...new Set([...clientes.values()].map(c => c.partnerId))];
  const correos = new Map();
  for (let i = 0; i < ids.length; i += 500)
    for (const p of await odoo.leer("res.partner", "search_read", [[["id", "in", ids.slice(i, i + 500)]], ["email"]], {})) if (p.email) correos.set(p.id, String(p.email).split(/[;,]/)[0].trim());
  const morosos = [...clientes.values()].filter(c => c.vencido >= minimo).sort((a, b) => b.vencido - a.vencido);
  const recordatorios = [], sinCorreo = [];
  for (const c of morosos) {
    const para = correos.get(c.partnerId);
    if (!para) { sinCorreo.push({ compania: c.compania, companiaId: c.companiaId, cliente: c.cliente, vencido: c.vencido, documentos: c.docs.length }); continue; }
    const cia = ciaDe.get(c.companiaId), monedas = [...new Set(c.docs.map(d => d.moneda))];
    const unaMoneda = monedas.length === 1 ? monedas[0] : "CRC";
    const total = monedas.length === 1 ? r2(c.docs.reduce((t, d) => t + d.saldoMoneda, 0)) : c.vencido;
    recordatorios.push({ companiaId: c.companiaId, compania: c.compania, partnerId: c.partnerId, cliente: c.cliente, para, responderA: cia?.email || null,
      asunto: `${c.compania} · facturas vencidas al ${corte}`, documentos: c.docs.length, vencido: c.vencido, maxDias: c.maxDias,
      html: recordatorioHTML({ compania: c.compania, cliente: c.cliente, corte, docs: c.docs.sort((a, b) => b.diasVencida - a.diasVencida), total, monedaTotal: unaMoneda, mixto: monedas.length > 1 }) });
  }

  const filas = [...porCia.values()].sort((a, b) => b.vencidoCobrar - a.vencidoCobrar);
  const suma = k => r2(filas.reduce((t, f) => t + f[k], 0));
  const totales = { companias: filas.length, porCobrar: suma("totalCobrar"), vencidoCobrar: suma("vencidoCobrar"), porPagar: suma("totalPagar"), vencidoPagar: suma("vencidoPagar"),
    clientesMorosos: morosos.length, recordatorios: recordatorios.length, sinCorreo: sinCorreo.length, pagosProximos: pagos.length, notasSinAplicar: notas.length };
  const alertas = [];
  if (morosos.length) alertas.push({ nivel: "alto", texto: `${morosos.length} clientes con facturas vencidas al ${corte} (₡${colones(totales.vencidoCobrar)}): ${recordatorios.length} recordatorios redactados en Correos para aprobar${sinCorreo.length ? `, ${sinCorreo.length} sin correo en Odoo` : ""}.`,
    detalle: morosos.slice(0, 8).map(c => `${c.compania} — ${c.cliente}: ₡${colones(c.vencido)}, ${c.docs.length} facturas, hasta ${c.maxDias} días`) });
  const mas90 = filas.filter(f => f.cobrar["91-180"] + f.cobrar["mas-180"] > 0);
  if (mas90.length) alertas.push({ nivel: "alto", texto: `${mas90.length} compañías con cuentas por cobrar de más de 90 días: revisar si se cobran o se estiman incobrables.`,
    detalle: mas90.slice(0, 8).map(f => `${f.compania}: ₡${colones(f.cobrar["91-180"] + f.cobrar["mas-180"])}`) });
  if (pagos.length) alertas.push({ nivel: "info", texto: `${pagos.length} facturas de proveedor vencen en los próximos ${proximos} días (₡${colones(pagos.reduce((t, p) => t + p.saldo, 0))}).`,
    detalle: pagos.sort((a, b) => a.enDias - b.enDias).slice(0, 8).map(p => `${p.compania} — ${p.proveedor} ${p.numero}: vence ${p.vence}, ₡${colones(p.saldo)}`) });
  if (notas.length) alertas.push({ nivel: "info", texto: `${notas.length} notas de crédito con saldo sin aplicar a una factura.`, detalle: notas.slice(0, 6).map(n => `${n.compania} — ${n.tercero} ${n.numero}: ₡${colones(n.saldo)}`) });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: `Sin vencidos al ${corte}.`, detalle: [] });

  return {
    agente: meta.nombre, titulo: `Antigüedad de cobros y pagos al ${corte}`, corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    corte, tramos: TRAMOS.map(({ id, titulo }) => ({ id, titulo })), totales, companias: filas, morosos: morosos.slice(0, 300).map(({ docs, ...c }) => ({ ...c, documentos: docs.length })),
    sinCorreo: sinCorreo.slice(0, 200), pagosProximos: pagos.slice(0, 300), notas: notas.slice(0, 200), recordatorios, alertas
  };
}
