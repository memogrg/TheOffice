// AGENTE CAMBIARIO — solo lectura. Fase 3B (ítem 17 de la matriz: diferencial cambiario).
// Al cierre de cada mes revalúa, por compañía, lo que está en moneda extranjera con el tipo de
// cambio de Odoo a esa fecha (el que carga tecnodem_api_exchange_rate) y propone el asiento:
//   · cuentas con moneda propia (bancos en dólares): saldo en moneda × tipo de cambio − saldo en colones
//   · clientes y proveedores: documentos abiertos en moneda extranjera, por tercero
// El diferencial va a las cuentas de ganancia y pérdida cambiaria de la compañía, en su diario de
// diferencias de cambio, y se revierte solo el día 1 del mes siguiente (así el mes siguiente se
// revalúa desde los saldos originales). Lo que tiene dólares en una cuenta sin moneda propia se
// informa: no se puede revaluar bien hasta configurarla.
//
// Configuración: CAMBIARIO_MES (AAAA-MM; por omisión el último mes cerrado), CAMBIARIO_MINIMO
// (colones por línea por debajo de los cuales no se ajusta; 100).
// Límite conocido: los abiertos de clientes y proveedores son los de HOY con fecha hasta fin de mes;
// corrido a inicio del mes siguiente es exacto, para meses viejos descuenta pagos posteriores.
import { sumarMeses } from "../lib/meses.js";
import { idDe, nombreDe, r2, rangoMes, ultimaFechaPorCompania, mesAEvaluar, colones } from "../lib/contable.js";
import { ultimoDia } from "./cierre.js";

export const meta = {
  id: "cambiario", nombre: "CAMBIARIO", puesto: "Revalúa los saldos en dólares",
  modelo: "account.move.line", escribe: false
};

export async function ejecutar({ odoo, cfg, log }) {
  const t0 = Date.now();
  await odoo.conectar();
  const minimo = Number(cfg.CAMBIARIO_MINIMO || 100);
  const ultimas = await ultimaFechaPorCompania(odoo);
  const mes = mesAEvaluar(cfg, cfg.CAMBIARIO_MES, ultimas);
  const [, hM] = rangoMes(mes), fecha = ultimoDia(mes), reversa = `${sumarMeses(mes, 1)}-01`;
  log(`Revaluación al ${fecha}`);

  const companias = await odoo.leer("res.company", "search_read", [[], ["name", "currency_id", "income_currency_exchange_account_id", "expense_currency_exchange_account_id", "currency_exchange_journal_id"]], {});
  const monedas = await odoo.leer("res.currency", "search_read", [[], ["name"]], {});
  const nombreMoneda = id => monedas.find(m => m.id === id)?.name || String(id);
  // Tipo de cambio a fin de mes: la tasa de Odoo es «moneda por unidad de moneda de la compañía»;
  // colones por dólar = 1 / tasa. Se toma la última con fecha ≤ fin de mes (global o de la compañía).
  const tasas = await odoo.leerTodo("res.currency.rate", [["name", "<=", fecha]], ["currency_id", "company_id", "name", "rate"]);
  const tasaDe = (monedaId, ciaId) => tasas.filter(t => idDe(t.currency_id) === monedaId && (!t.company_id || idDe(t.company_id) === ciaId))
    .sort((a, b) => String(b.name).localeCompare(String(a.name)) || (b.company_id ? 1 : 0) - (a.company_id ? 1 : 0))[0] || null;

  // Cuentas con moneda propia (bancos en dólares) y cuentas de clientes y proveedores.
  const conMoneda = await odoo.leerTodo("account.account", [["currency_id", "!=", false]], ["name", "currency_id", "account_type"]);
  const cxcxp = await odoo.leerTodo("account.account", [["account_type", "in", ["asset_receivable", "liability_payable"]], ["currency_id", "=", false]], ["name", "account_type"]);
  const info = new Map([...conMoneda, ...cxcxp].map(c => [c.id, { nombre: String(c.name), tipo: c.account_type, monedaId: idDe(c.currency_id) || null }]));

  const items = [];      // { ciaId, cuentaId, partnerId, partner, monedaId, enMoneda, libros }
  if (conMoneda.length) {
    const g = await odoo.leer("account.move.line", "read_group", [[["parent_state", "=", "posted"], ["account_id", "in", conMoneda.map(c => c.id)], ["date", "<", hM]],
      ["amount_currency:sum", "balance:sum"], ["company_id", "account_id"]], { lazy: false });
    for (const x of g) items.push({ ciaId: idDe(x.company_id), compania: nombreDe(x.company_id), cuentaId: idDe(x.account_id), partnerId: null, partner: null,
      monedaId: info.get(idDe(x.account_id))?.monedaId, enMoneda: Number(x.amount_currency) || 0, libros: Number(x.balance) || 0, forzarMoneda: true });
  }
  if (cxcxp.length) {
    const g = await odoo.leer("account.move.line", "read_group", [[["parent_state", "=", "posted"], ["account_id", "in", cxcxp.map(c => c.id)], ["date", "<", hM],
      ["reconciled", "=", false], ["amount_residual_currency", "!=", 0]], ["amount_residual_currency:sum", "amount_residual:sum"], ["company_id", "account_id", "partner_id", "currency_id"]], { lazy: false });
    for (const x of g) items.push({ ciaId: idDe(x.company_id), compania: nombreDe(x.company_id), cuentaId: idDe(x.account_id), partnerId: idDe(x.partner_id) || null, partner: nombreDe(x.partner_id) || null,
      monedaId: idDe(x.currency_id), enMoneda: Number(x.amount_residual_currency) || 0, libros: Number(x.amount_residual) || 0, forzarMoneda: false });
  }

  // Lo que no se puede revaluar: dólares en cuentas sin moneda propia que no son clientes ni proveedores.
  let sinMoneda = [];
  try {
    const otras = await odoo.leerTodo("account.account", [["currency_id", "=", false], ["account_type", "in", ["asset_cash", "asset_current", "liability_current", "liability_credit_card", "liability_non_current", "asset_non_current"]]], ["name", "account_type"]);
    if (otras.length) {
      const g = await odoo.leer("account.move.line", "read_group", [[["parent_state", "=", "posted"], ["account_id", "in", otras.map(c => c.id)], ["date", "<", hM]],
        ["amount_currency:sum", "balance:sum"], ["company_id", "account_id", "currency_id"]], { lazy: false });
      const nombre = new Map(otras.map(c => [c.id, c.name]));
      sinMoneda = g.filter(x => Math.abs(Number(x.amount_currency) || 0) >= 1 && companias.find(c => c.id === idDe(x.company_id))?.currency_id?.[0] !== idDe(x.currency_id))
        .map(x => ({ compania: nombreDe(x.company_id), companiaId: idDe(x.company_id), cuenta: nombre.get(idDe(x.account_id)), moneda: nombreDe(x.currency_id), enMoneda: r2(x.amount_currency), libros: r2(x.balance) }))
        .sort((a, b) => Math.abs(b.libros) - Math.abs(a.libros));
    }
  } catch (e) { log(`Sin revisar cuentas sin moneda: ${e.message}`); }

  const resultado = [], asientosSugeridos = [];
  for (const cia of companias) {
    const mias = items.filter(i => i.ciaId === cia.id && i.monedaId && i.monedaId !== idDe(cia.currency_id));
    if (!mias.length) continue;
    const lineas = [], porMoneda = {};
    let sinTasa = false;
    for (const i of mias) {
      const t = tasaDe(i.monedaId, cia.id);
      if (!t || !t.rate) { sinTasa = true; continue; }
      const tc = 1 / t.rate, revaluado = r2(i.enMoneda * tc), dif = r2(revaluado - i.libros);
      const mon = nombreMoneda(i.monedaId);
      porMoneda[mon] = { tipoCambio: Math.round(tc * 100) / 100, fechaTasa: t.name };
      if (Math.abs(dif) < minimo) continue;
      const c = info.get(i.cuentaId);
      lineas.push({ cuentaId: i.cuentaId, cuenta: c?.nombre || String(i.cuentaId), partnerId: i.partnerId, descripcion: `Diferencial ${mon} ${mes}${i.partner ? ` · ${i.partner}` : ""}`,
        debito: dif > 0 ? dif : 0, credito: dif < 0 ? -dif : 0, rol: "revaluacion", ...(i.forzarMoneda ? { monedaId: i.monedaId } : {}),
        fuente: `${mon} ${colones(i.enMoneda)} × ${porMoneda[mon].tipoCambio} = ${colones(revaluado)}; en libros ${colones(i.libros)}` });
    }
    const ganancia = r2(lineas.reduce((t, l) => t + l.debito, 0)), perdida = r2(lineas.reduce((t, l) => t + l.credito, 0));
    const ctaG = cia.income_currency_exchange_account_id, ctaP = cia.expense_currency_exchange_account_id, diario = cia.currency_exchange_journal_id;
    const fila = { compania: cia.name, companiaId: cia.id, mes, monedas: porMoneda, partidas: mias.length, ajustes: lineas.length, ganancia, perdida, neto: r2(ganancia - perdida),
      sinTasa, sinConfiguracion: !ctaG || !ctaP || !diario };
    resultado.push(fila);
    if (!lineas.length) continue;
    // contrapartidas: ganancia (crédito) por los aumentos, pérdida (débito) por las disminuciones
    if (ganancia) lineas.push(ctaG ? { cuentaId: idDe(ctaG), cuenta: nombreDe(ctaG), descripcion: `Ganancia cambiaria ${mes}`, debito: 0, credito: ganancia, rol: "contrapartida", fuente: "cuenta de ganancia cambiaria de la compañía" }
      : { cuentaId: null, cuenta: "(ganancia cambiaria por definir)", descripcion: `Ganancia cambiaria ${mes}`, debito: 0, credito: ganancia, rol: "contrapartida", fuente: "la compañía no tiene cuenta de ganancia cambiaria configurada" });
    if (perdida) lineas.push(ctaP ? { cuentaId: idDe(ctaP), cuenta: nombreDe(ctaP), descripcion: `Pérdida cambiaria ${mes}`, debito: perdida, credito: 0, rol: "contrapartida-perdida", fuente: "cuenta de pérdida cambiaria de la compañía" }
      : { cuentaId: null, cuenta: "(pérdida cambiaria por definir)", descripcion: `Pérdida cambiaria ${mes}`, debito: perdida, credito: 0, rol: "contrapartida-perdida", fuente: "la compañía no tiene cuenta de pérdida cambiaria configurada" });
    asientosSugeridos.push({ clave: `cambiario|${cia.id}|${mes}`, origen: "cambiario", mes, companiaId: cia.id, compania: cia.name, fecha, reversa,
      diarioId: idDe(diario) || null, diario: nombreDe(diario) || null,
      referencia: `Diferencial cambiario no realizado al ${fecha}`,
      motivo: `Revaluación de ${lineas.length - (ganancia ? 1 : 0) - (perdida ? 1 : 0)} saldos en moneda extranjera (${Object.entries(porMoneda).map(([m, v]) => `${m} a ${v.tipoCambio}`).join(", ")}): ganancia ₡${colones(ganancia)}, pérdida ₡${colones(perdida)}. Se revierte el ${reversa}.`,
      aviso: "El tipo de cambio es el que tiene Odoo a fin de mes; confírmelo con el de referencia del BCCR que usa la compañía.", lineas });
  }
  resultado.sort((a, b) => Math.abs(b.neto) - Math.abs(a.neto));

  const totales = {
    companias: resultado.length, conAjuste: asientosSugeridos.length, ganancia: r2(resultado.reduce((t, r) => t + r.ganancia, 0)), perdida: r2(resultado.reduce((t, r) => t + r.perdida, 0)),
    sinConfiguracion: resultado.filter(r => r.sinConfiguracion && r.ajustes).length, sinTasa: resultado.filter(r => r.sinTasa).length, cuentasSinMoneda: sinMoneda.length,
    asientosSugeridos: asientosSugeridos.length
  };
  const alertas = [];
  if (asientosSugeridos.length) alertas.push({ nivel: "info",
    texto: `${asientosSugeridos.length} asientos de diferencial cambiario al ${fecha} propuestos en Aprobaciones → Asientos (ganancia ₡${colones(totales.ganancia)}, pérdida ₡${colones(totales.perdida)}); cada uno se revierte el ${reversa}.`,
    detalle: resultado.filter(r => r.ajustes).slice(0, 8).map(r => `${r.compania}: neto ₡${colones(r.neto)} (${r.ajustes} saldos)`) });
  const sc = resultado.filter(r => r.sinConfiguracion && r.ajustes);
  if (sc.length) alertas.push({ nivel: "alto", texto: `${sc.length} compañías con saldos en dólares sin cuentas o diario de diferencial cambiario configurados: el asiento queda con la contrapartida por definir.`,
    detalle: sc.slice(0, 8).map(r => r.compania) });
  if (totales.sinTasa) alertas.push({ nivel: "alto", texto: `${totales.sinTasa} compañías sin tipo de cambio en Odoo para ${fecha}: revisar la carga de tasas.`, detalle: resultado.filter(r => r.sinTasa).slice(0, 8).map(r => r.compania) });
  if (sinMoneda.length) alertas.push({ nivel: "info", texto: `${sinMoneda.length} cuentas con saldos en moneda extranjera pero sin moneda propia configurada: no se revalúan. Si son de dólares (préstamos, anticipos, tarjetas), configure su moneda.`,
    detalle: sinMoneda.slice(0, 8).map(s => `${s.compania} — ${s.cuenta}: ${s.moneda} ${colones(s.enMoneda)}`) });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: `Sin saldos en moneda extranjera que revaluar al ${fecha}.`, detalle: [] });

  return {
    agente: meta.nombre, titulo: `Diferencial cambiario al ${fecha}`, corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    mes, fecha, reversa, totales, companias: resultado, sinMoneda: sinMoneda.slice(0, 200), asientosSugeridos, alertas
  };
}
