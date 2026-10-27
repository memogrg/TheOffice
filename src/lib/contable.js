// Ayudas de solo lectura para los agentes de cierre y estados financieros: sumas por compañía y
// cuenta con read_group (un mes por llamada, sin depender de cómo Odoo nombra los grupos de fecha),
// el mes a evaluar y la naturaleza de cada tipo de cuenta de Odoo 18.
import { mesDe, sumarMeses, hoyLocal } from "./meses.js";

export const idDe = v => (Array.isArray(v) ? v[0] : v);
export const nombreDe = v => (Array.isArray(v) ? v[1] : v);
export const r2 = x => Math.round((Number(x) || 0) * 100) / 100;

// [desde, hasta) de un mes AAAA-MM
export const rangoMes = mes => [`${mes}-01`, `${sumarMeses(mes, 1)}-01`];
export const mesesHasta = (mes, n) => Array.from({ length: n }, (_, i) => sumarMeses(mes, i - n + 1));

// Lado natural del saldo: +1 deudor (activos y gastos), −1 acreedor (pasivos, patrimonio, ingresos).
export const lado = tipo => (/^(asset|expense)/.test(String(tipo)) ? 1 : -1);

// Suma por compañía × cuenta. Devuelve Map "cia|cuenta" → { companiaId, compania, cuentaId, debit, credit, balance, lineas }.
export async function sumarPorCuenta(odoo, dominio, { campos = ["debit:sum", "credit:sum", "balance:sum"] } = {}) {
  const g = await odoo.leer("account.move.line", "read_group",
    [[["parent_state", "=", "posted"], ...dominio], campos, ["company_id", "account_id"]], { lazy: false });
  const out = new Map();
  for (const x of g) {
    const cia = idDe(x.company_id), cta = idDe(x.account_id);
    if (!cia || !cta) continue;
    out.set(`${cia}|${cta}`, { companiaId: cia, compania: nombreDe(x.company_id), cuentaId: cta,
      debit: Number(x.debit) || 0, credit: Number(x.credit) || 0, balance: Number(x.balance) || 0, lineas: x.__count || 0 });
  }
  return out;
}

// Última fecha contable por compañía (asientos publicados, sin pasar de hoy).
export async function ultimaFechaPorCompania(odoo, hoy = hoyLocal()) {
  const g = await odoo.leer("account.move.line", "read_group",
    [[["parent_state", "=", "posted"], ["date", "<=", hoy]], ["date:max"], ["company_id"]], { lazy: false });
  const out = new Map();
  for (const x of g) if (idDe(x.company_id)) out.set(idDe(x.company_id), { compania: nombreDe(x.company_id), ultima: x.date || null, lineas: x.__count || 0 });
  return out;
}

// Mes a evaluar: el que se pida (AAAA-MM), o el último cerrado respecto de hoy. Con
// ALERTA_REFERENCIA=ultimo-correo (base congelada), el anterior al mes en que la compañía típica
// dejó de registrar (mediana de las últimas fechas): unos pocos asientos con fecha adelantada no
// mueven la referencia.
export function mesAEvaluar(cfg, pedido, ultimas) {
  if (pedido) return pedido;
  const hoy = hoyLocal();
  if (cfg.ALERTA_REFERENCIA === "ultimo-correo") {
    const fechas = [...ultimas.values()].map(u => u.ultima).filter(Boolean).sort();
    if (fechas.length) return sumarMeses(mesDe(fechas[Math.floor((fechas.length - 1) / 2)]), -1);
  }
  return sumarMeses(mesDe(hoy), -1);
}

// Lee nombre y tipo de las cuentas indicadas (en lotes).
export async function leerCuentas(odoo, ids) {
  const out = new Map(), lista = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < lista.length; i += 1000) {
    const lote = await odoo.leer("account.account", "search_read", [[["id", "in", lista.slice(i, i + 1000)]], ["name", "account_type"]], {});
    for (const c of lote) out.set(c.id, { nombre: typeof c.name === "string" ? c.name : String(c.name ?? ""), tipo: c.account_type });
  }
  return out;
}

export const colones = x => Math.round(Number(x) || 0).toLocaleString("es-CR");
