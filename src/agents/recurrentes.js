// AGENTE RECURRENTES — solo lectura. Fase 3A (ítem 14 de la matriz).
// Por compañía y proveedor, encuentra lo que llega TODOS los meses (luz, agua, teléfono, alquiler,
// honorarios, suscripciones…) y avisa: (a) si en el último mes cerrado faltó la factura, y
// (b) si el monto se salió mucho de lo normal. En IASIMA las facturas entran por el buzón: una que
// falta casi siempre es una que hay que reclamar (Victor), no un asiento que inventar.
//
// Configuración: RECURRENTES_VENTANA (meses que se miran hacia atrás, 6), RECURRENTES_MINIMO
// (en cuántos de esos meses tiene que aparecer, 5), RECURRENTES_DESVIO (% de desvío, 50),
// RECURRENTES_MES (el mes a evaluar, AAAA-MM; por omisión el último mes cerrado).
import { mesDe, sumarMeses, hoyLocal, mediana } from "../lib/meses.js";
import { Clasificador } from "../clasificador.js";

export const meta = {
  id: "recurrentes", nombre: "RECURRENTES", puesto: "Vigila los servicios de cada mes",
  modelo: "account.move", escribe: false
};

const SERVICIOS = new Set(["electricidad", "agua", "telecomunicaciones"]);

export async function ejecutar({ odoo, cfg, log }) {
  const t0 = Date.now();
  await odoo.conectar();
  const ventana = Number(cfg.RECURRENTES_VENTANA || 6), minimo = Number(cfg.RECURRENTES_MINIMO || Math.max(2, ventana - 1));
  const umbral = Number(cfg.RECURRENTES_DESVIO || 50) / 100;
  const campos = ["company_id", "partner_id", "invoice_date", "amount_total", "state", "currency_id"];
  const dominio = [["move_type", "=", "in_invoice"], ["state", "in", ["draft", "posted"]], ["invoice_date", "!=", false]];
  let facturas;
  try { facturas = await odoo.leerTodo("account.move", dominio, [...campos, "economic_activity_purchase_id"]); }
  catch { facturas = await odoo.leerTodo("account.move", dominio, campos); }
  log(`${facturas.length} facturas de proveedor con fecha`);

  // Mes a evaluar: el último cerrado respecto de hoy, o del documento más reciente si la base está
  // congelada (ALERTA_REFERENCIA=ultimo-correo).
  const ultimo = facturas.reduce((m, f) => (f.invoice_date > m ? f.invoice_date : m), "");
  const referencia = cfg.ALERTA_REFERENCIA === "ultimo-correo" && ultimo ? ultimo : hoyLocal();
  const mes = cfg.RECURRENTES_MES || sumarMeses(mesDe(referencia), -1);
  const meses = Array.from({ length: ventana }, (_, i) => sumarMeses(mes, i - ventana));   // los N anteriores
  log(`Mes evaluado ${mes}; se miran ${meses[0]} a ${meses[meses.length - 1]}`);

  const clas = new Clasificador({});
  const grupos = new Map();
  for (const f of facturas) {
    if (!f.partner_id || !f.company_id) continue;
    const m = mesDe(f.invoice_date);
    if (m !== mes && !meses.includes(m)) continue;
    const k = `${f.company_id[0]}|${f.partner_id[0]}`;
    const g = grupos.get(k) || { companiaId: f.company_id[0], compania: f.company_id[1], proveedorId: f.partner_id[0], proveedor: f.partner_id[1],
      actividad: null, porMes: new Map() };
    if (Array.isArray(f.economic_activity_purchase_id)) g.actividad = f.economic_activity_purchase_id[1];
    g.porMes.set(m, (g.porMes.get(m) || 0) + (Number(f.amount_total) || 0));
    grupos.set(k, g);
  }

  const recurrentes = [], faltantes = [], desvios = [];
  for (const g of grupos.values()) {
    const presentes = meses.filter(m => g.porMes.has(m));
    // recurrente: en casi todos los meses de la ventana y en los dos últimos (no algo que ya se dejó de comprar)
    if (presentes.length < minimo || !g.porMes.has(meses[meses.length - 1]) || !g.porMes.has(meses[meses.length - 2])) continue;
    const tipo = clas.tipoDeProveedor(g.actividad);
    const tipico = mediana(presentes.map(m => g.porMes.get(m)));
    const r = { compania: g.compania, companiaId: g.companiaId, proveedor: g.proveedor, proveedorId: g.proveedorId,
      tipo: tipo?.id || null, servicioPublico: SERVICIOS.has(tipo?.id), mesesConFactura: presentes.length,
      montoTipico: Math.round(tipico * 100) / 100, ultimoMes: [...meses].reverse().find(m => g.porMes.has(m)) };
    recurrentes.push(r);
    if (!g.porMes.has(mes)) { faltantes.push(r); continue; }
    const monto = g.porMes.get(mes);
    const dif = monto - tipico;
    if (tipico > 0 && Math.abs(dif) / tipico > umbral && Math.abs(dif) >= 5000)
      desvios.push({ ...r, monto: Math.round(monto * 100) / 100, desvioPct: Math.round((dif / tipico) * 100) });
  }
  const orden = (a, b) => (b.servicioPublico - a.servicioPublico) || a.compania.localeCompare(b.compania);
  faltantes.sort(orden); desvios.sort((a, b) => Math.abs(b.desvioPct) - Math.abs(a.desvioPct));
  const ciasAfectadas = new Set(faltantes.map(f => f.compania));

  const alertas = [];
  if (faltantes.length) alertas.push({ nivel: "alto",
    texto: `${faltantes.length} servicios recurrentes sin factura en ${mes} (${ciasAfectadas.size} compañías). Hay que reclamarlas al proveedor o confirmar que se dieron de baja.`,
    detalle: faltantes.slice(0, 10).map(f => `${f.compania} — ${f.proveedor}${f.servicioPublico ? " (servicio público)" : ""}: ~${Math.round(f.montoTipico).toLocaleString("es-CR")} por mes, última en ${f.ultimoMes}`) });
  if (desvios.length) alertas.push({ nivel: "alto",
    texto: `${desvios.length} servicios recurrentes con un monto fuera de lo normal en ${mes}.`,
    detalle: desvios.slice(0, 10).map(d => `${d.compania} — ${d.proveedor}: ${Math.round(d.monto).toLocaleString("es-CR")} contra ~${Math.round(d.montoTipico).toLocaleString("es-CR")} (${d.desvioPct > 0 ? "+" : ""}${d.desvioPct} %)`) });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: `Todos los servicios recurrentes llegaron en ${mes} con montos normales.`, detalle: [] });

  return {
    agente: meta.nombre, titulo: `Servicios recurrentes de ${mes}`, corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    mes, ventana: meses, totales: { recurrentes: recurrentes.length, faltantes: faltantes.length, desvios: desvios.length, companias: ciasAfectadas.size },
    faltantes: faltantes.slice(0, 300), desvios: desvios.slice(0, 200), recurrentes: recurrentes.slice(0, 800), alertas
  };
}
