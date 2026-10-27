// AGENTE ESTADOS — solo lectura. Fase 3A (objetivo 3 de la matriz: estados financieros).
// Arma, para cada compañía y el mes evaluado, el balance de situación y el estado de resultados
// (del mes, acumulado del año y los últimos meses) a partir de los asientos publicados, agrupando
// por el tipo de cuenta de Odoo. No usa los asistentes de TecnoDEM (crearían registros); los
// totales deben coincidir con ellos. Además revisa lo que haría que esos estados no sirvan:
// cajas o bancos en negativo, proveedores o clientes del lado contrario, años anteriores sin
// cerrar, borradores del mes y compañías sin asientos.
//
// Configuración: ESTADOS_MES (AAAA-MM; por omisión el último mes cerrado), ESTADOS_VENTANA (6).
import { idDe, r2, rangoMes, mesesHasta, sumarPorCuenta, ultimaFechaPorCompania, mesAEvaluar, leerCuentas, colones } from "../lib/contable.js";

export const meta = {
  id: "estados", nombre: "ESTADOS", puesto: "Arma balance y resultados",
  modelo: "account.move.line", escribe: false
};

// Rubros del balance y del estado de resultados según account_type (Odoo 18).
export const RUBRO = {
  asset_cash: ["activo", "corriente", "Efectivo y bancos"],
  asset_receivable: ["activo", "corriente", "Cuentas por cobrar"],
  asset_current: ["activo", "corriente", "Otros activos corrientes"],
  asset_prepayments: ["activo", "corriente", "Gastos pagados por adelantado"],
  asset_non_current: ["activo", "no corriente", "Otros activos no corrientes"],
  asset_fixed: ["activo", "no corriente", "Propiedad, planta y equipo"],
  liability_payable: ["pasivo", "corriente", "Cuentas por pagar"],
  liability_credit_card: ["pasivo", "corriente", "Tarjetas de crédito"],
  liability_current: ["pasivo", "corriente", "Otros pasivos corrientes"],
  liability_non_current: ["pasivo", "no corriente", "Pasivos no corrientes"],
  equity: ["patrimonio", "", "Capital y reservas"],
  equity_unaffected: ["patrimonio", "", "Utilidades no distribuidas"],
  income: ["resultados", "ingresos", "Ingresos"],
  income_other: ["resultados", "otrosIngresos", "Otros ingresos"],
  expense_direct_cost: ["resultados", "costo", "Costo de ventas"],
  expense: ["resultados", "gastos", "Gastos"],
  expense_depreciation: ["resultados", "depreciacion", "Depreciación"]
};
const esResultado = t => RUBRO[t]?.[0] === "resultados";

// Estado de resultados a partir de saldos por cuenta (balance de Odoo: deudor +, acreedor −).
export function resultados(filas, cuentas) {
  const r = { ingresos: 0, otrosIngresos: 0, costo: 0, gastos: 0, depreciacion: 0 };
  for (const f of filas) {
    const t = cuentas.get(f.cuentaId)?.tipo; if (!esResultado(t)) continue;
    const k = RUBRO[t][1];
    r[k] += /^income/.test(t) ? -f.balance : f.balance;
  }
  for (const k of Object.keys(r)) r[k] = r2(r[k]);
  r.utilidadBruta = r2(r.ingresos - r.costo);
  r.utilidad = r2(r.ingresos + r.otrosIngresos - r.costo - r.gastos - r.depreciacion);
  return r;
}

export async function ejecutar({ odoo, cfg, log }) {
  const t0 = Date.now();
  await odoo.conectar();
  const ventana = Number(cfg.ESTADOS_VENTANA || 6);
  const ultimas = await ultimaFechaPorCompania(odoo);
  const mes = mesAEvaluar(cfg, cfg.ESTADOS_MES, ultimas);
  const [dM, hM] = rangoMes(mes), anio = mes.slice(0, 4), inicioAnio = `${anio}-01-01`;
  const meses = mesesHasta(mes, ventana);
  log(`Estados al cierre de ${mes}`);

  const acumulado = await sumarPorCuenta(odoo, [["date", "<", hM]], { campos: ["balance:sum"] });
  const delAnio = await sumarPorCuenta(odoo, [["date", ">=", inicioAnio], ["date", "<", hM]], { campos: ["balance:sum"] });
  const porMes = new Map();
  for (const m of meses) { const [d, h] = rangoMes(m); porMes.set(m, await sumarPorCuenta(odoo, [["date", ">=", d], ["date", "<", h]], { campos: ["balance:sum"] })); }
  const cuentas = await leerCuentas(odoo, [...acumulado.values()].map(x => x.cuentaId));

  let borradores = new Map();
  try {
    const g = await odoo.leer("account.move", "read_group", [[["state", "=", "draft"], ["date", ">=", dM], ["date", "<", hM]], ["amount_total:sum"], ["company_id"]], { lazy: false });
    borradores = new Map(g.filter(x => idDe(x.company_id)).map(x => [idDe(x.company_id), x.__count]));
  } catch (e) { log(`Sin medir borradores: ${e.message}`); }

  const agrupar = mapa => { const m = new Map(); for (const f of mapa.values()) m.set(f.companiaId, [...(m.get(f.companiaId) || []), f]); return m; };
  const acum = agrupar(acumulado), anual = agrupar(delAnio), mensuales = new Map([...porMes].map(([m, v]) => [m, agrupar(v)]));

  const companias = [], negativos = [], ladoContrario = [], anioSinCerrar = [], descuadres = [];
  for (const [cia, filas] of acum) {
    const compania = filas[0].compania;
    // Balance de situación: saldos acumulados hasta el fin del mes.
    const lineas = new Map();   // rubro → { seccion, grupo, rubro, monto, cuentas[] }
    let resultadoTotal = 0;
    for (const f of filas) {
      const c = cuentas.get(f.cuentaId); if (!c) continue;
      if (esResultado(c.tipo)) { resultadoTotal += -f.balance; continue; }
      const def = RUBRO[c.tipo]; if (!def) continue;     // off_balance y tipos desconocidos
      const [seccion, grupo, rubro] = def, signo = seccion === "activo" ? 1 : -1;
      const l = lineas.get(rubro) || { seccion, grupo, rubro, monto: 0, cuentas: [] };
      l.monto += signo * f.balance;
      if (Math.abs(f.balance) >= 1) l.cuentas.push({ cuenta: c.nombre, cuentaId: f.cuentaId, monto: r2(signo * f.balance) });
      lineas.set(rubro, l);
      if (c.tipo === "asset_cash" && f.balance < -1000) negativos.push({ compania, companiaId: cia, cuenta: c.nombre, saldo: r2(f.balance) });
    }
    const totalDe = (s, g) => r2([...lineas.values()].filter(l => l.seccion === s && (g == null || l.grupo === g)).reduce((t, l) => t + l.monto, 0));
    const rAnio = resultados(anual.get(cia) || [], cuentas);
    const anteriores = r2(resultadoTotal - rAnio.utilidad);    // utilidades de años anteriores que siguen en cuentas de resultados
    const balance = {
      activoCorriente: totalDe("activo", "corriente"), activoNoCorriente: totalDe("activo", "no corriente"), activo: totalDe("activo"),
      pasivoCorriente: totalDe("pasivo", "corriente"), pasivoNoCorriente: totalDe("pasivo", "no corriente"), pasivo: totalDe("pasivo"),
      patrimonio: totalDe("patrimonio"), resultadosAnteriores: anteriores, resultadoDelAnio: rAnio.utilidad
    };
    balance.pasivoYPatrimonio = r2(balance.pasivo + balance.patrimonio + anteriores + rAnio.utilidad);
    balance.diferencia = r2(balance.activo - balance.pasivoYPatrimonio);
    balance.razonCorriente = balance.pasivoCorriente ? Math.round((balance.activoCorriente / balance.pasivoCorriente) * 100) / 100 : null;
    if (Math.abs(balance.diferencia) > 1) descuadres.push({ compania, companiaId: cia, diferencia: balance.diferencia });
    const cxp = lineas.get("Cuentas por pagar")?.monto || 0, cxc = lineas.get("Cuentas por cobrar")?.monto || 0;
    if (cxp < -1000) ladoContrario.push({ compania, companiaId: cia, rubro: "Cuentas por pagar", monto: r2(cxp) });
    if (cxc < -1000) ladoContrario.push({ compania, companiaId: cia, rubro: "Cuentas por cobrar", monto: r2(cxc) });
    if (Math.abs(anteriores) > 1 && Number(anio) > 0) anioSinCerrar.push({ compania, companiaId: cia, monto: anteriores });

    const serie = meses.map(m => ({ mes: m, ...resultados(mensuales.get(m).get(cia) || [], cuentas) }));
    const detalleResultados = (anual.get(cia) || []).filter(f => esResultado(cuentas.get(f.cuentaId)?.tipo) && Math.abs(f.balance) >= 1)
      .map(f => { const c = cuentas.get(f.cuentaId); return { rubro: RUBRO[c.tipo][2], cuenta: c.nombre, monto: r2(/^income/.test(c.tipo) ? -f.balance : f.balance) }; })
      .sort((a, b) => a.rubro.localeCompare(b.rubro) || Math.abs(b.monto) - Math.abs(a.monto));
    companias.push({
      compania, companiaId: cia, mes, ultimaFecha: ultimas.get(cia)?.ultima || null,
      sinMovimientoEnElMes: !serie[serie.length - 1] || !(mensuales.get(mes).get(cia) || []).length,
      borradores: borradores.get(cia) || 0,
      balance, rubros: [...lineas.values()].map(l => ({ ...l, monto: r2(l.monto), cuentas: l.cuentas.sort((a, b) => Math.abs(b.monto) - Math.abs(a.monto)) })),
      resultadosMes: serie[serie.length - 1], resultadosAnio: rAnio, serie, detalleResultados
    });
  }
  companias.sort((a, b) => a.compania.localeCompare(b.compania));
  const sinMov = companias.filter(c => c.sinMovimientoEnElMes);
  const conBorr = companias.filter(c => c.borradores > 0).sort((a, b) => b.borradores - a.borradores);
  const totales = {
    companias: companias.length, sinMovimiento: sinMov.length, conBorradores: conBorr.length,
    cajasNegativas: negativos.length, ladoContrario: ladoContrario.length, anioSinCerrar: anioSinCerrar.length, descuadres: descuadres.length,
    conPerdidaEnElAnio: companias.filter(c => c.resultadosAnio.utilidad < 0).length
  };

  const alertas = [];
  if (descuadres.length) alertas.push({ nivel: "alto", texto: `${descuadres.length} compañías cuyo balance no cuadra (activo ≠ pasivo + patrimonio + resultados).`,
    detalle: descuadres.slice(0, 8).map(d => `${d.compania}: diferencia ₡${colones(d.diferencia)}`) });
  if (negativos.length) alertas.push({ nivel: "alto", texto: `${negativos.length} cuentas de caja o banco con saldo negativo al cierre de ${mes}: faltan depósitos, sobran pagos o hay un pago registrado al banco equivocado.`,
    detalle: negativos.sort((a, b) => a.saldo - b.saldo).slice(0, 10).map(n => `${n.compania} — ${n.cuenta}: ₡${colones(n.saldo)}`) });
  if (ladoContrario.length) alertas.push({ nivel: "alto", texto: `${ladoContrario.length} saldos de proveedores o clientes del lado contrario (pagos sin su factura, o anticipos sin aplicar).`,
    detalle: ladoContrario.slice(0, 8).map(l => `${l.compania} — ${l.rubro}: ₡${colones(l.monto)}`) });
  if (conBorr.length) alertas.push({ nivel: "info", texto: `${conBorr.length} compañías con documentos de ${mes} en borrador: no están en estos estados.`,
    detalle: conBorr.slice(0, 8).map(c => `${c.compania}: ${c.borradores} en borrador`) });
  if (anioSinCerrar.length) alertas.push({ nivel: "info", texto: `${anioSinCerrar.length} compañías con resultados de años anteriores sin trasladar al patrimonio (cierre anual pendiente).`,
    detalle: anioSinCerrar.slice(0, 8).map(a => `${a.compania}: ₡${colones(a.monto)}`) });
  if (sinMov.length) alertas.push({ nivel: "info", texto: `${sinMov.length} compañías sin asientos en ${mes}: sus estados del mes quedan vacíos.`,
    detalle: sinMov.slice(0, 10).map(c => `${c.compania} — último asiento ${c.ultimaFecha || "nunca"}`) });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: `Estados de ${mes} listos para ${companias.length} compañías, sin observaciones.`, detalle: [] });

  return {
    agente: meta.nombre, titulo: `Estados financieros al cierre de ${mes}`, corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    mes, ventana: meses, totales, companias, cajasNegativas: negativos, ladoContrario, anioSinCerrar, descuadres, alertas
  };
}
