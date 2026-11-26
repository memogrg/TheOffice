// AGENTE CONTROLES — solo lectura. Los controles que la firma aplica en cada cierre (B3) y que no
// hacían los otros agentes:
//   · Candados del periodo: cada compañía debe tener la fecha de bloqueo puesta al entregar un mes.
//   · Arrastre retroactivo: asientos de un mes ya entregado creados o modificados después de la
//     entrega (por create_date / write_date). Es el retrabajo número uno de la firma.
//   · Salarios por pagar en cero al cierre.
//   · Cobros y pagos sin contacto (cuentas por cobrar o pagar sin tercero).
//   · Variación de ±15 % por cuenta de resultados contra el promedio móvil de 18 meses (sin diciembre).
// No escribe nada: los candados se ponen en Odoo; lo demás se corrige en su pestaña.
//
// Configuración: CONTROLES_MES (AAAA-MM), CONTROLES_DIA_ENTREGA (20: día del mes siguiente a partir
// del cual un asiento del mes anterior cuenta como tardío, salvo que la Oficina tenga la fecha real
// del cierre), CONTROLES_MESES (3: meses hacia atrás que se revisan), CONTROLES_VARIACION (15, %),
// CONTROLES_MINIMO (100000: diferencia mínima en colones para avisar una variación).
import { idDe, nombreDe, r2, rangoMes, ultimaFechaPorCompania, mesAEvaluar, sumarPorCuenta, leerCuentas, colones } from "../lib/contable.js";
import { sumarMeses } from "../lib/meses.js";

export const meta = {
  id: "controles", nombre: "CONTROLES", puesto: "Controles de cierre de la firma",
  modelo: "account.move", escribe: false
};
const RESULTADOS = ["income", "income_other", "expense", "expense_direct_cost", "expense_depreciation"];
const finDe = mes => { const [, h] = rangoMes(mes); return sumarDias(h, -1); };
const sumarDias = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fecha = x => (x ? String(x).slice(0, 10) : null);

export async function ejecutar({ odoo, cfg, log, db = null }) {
  const t0 = Date.now();
  await odoo.conectar();
  const ultimas = await ultimaFechaPorCompania(odoo);
  const mes = mesAEvaluar(cfg, cfg.CONTROLES_MES, ultimas);
  const dia = Math.min(28, Math.max(1, Number(cfg.CONTROLES_DIA_ENTREGA || 20)));
  const atras = Math.max(1, Number(cfg.CONTROLES_MESES || 3));
  const umbralPct = Number(cfg.CONTROLES_VARIACION || 15), minimo = Number(cfg.CONTROLES_MINIMO || 100000);
  const [dM, hM] = rangoMes(mes);
  log(`Controles de cierre de ${mes}`);

  // --- Compañías y candados
  let camposCia = ["name", "fiscalyear_lock_date", "hard_lock_date", "tax_lock_date"], cias;
  try { cias = await odoo.leer("res.company", "search_read", [[], camposCia], {}); }
  catch { camposCia = ["name"]; cias = await odoo.leer("res.company", "search_read", [[], camposCia], {}); }
  const nombreCia = new Map(cias.map(c => [c.id, c.name]));
  const esperado = finDe(sumarMeses(mes, -1));          // el mes anterior al evaluado ya debería estar entregado y bloqueado
  const candados = cias.map(c => {
    const duro = fecha(c.hard_lock_date), fiscal = fecha(c.fiscalyear_lock_date), iva = fecha(c.tax_lock_date);
    const candado = [duro, fiscal].filter(Boolean).sort().pop() || null;
    const estado = !candado ? "sin-candado" : candado < esperado ? "atrasado" : "al-dia";
    return { companiaId: c.id, compania: c.name, candado, duro, fiscal, iva, esperado, estado, alCerrar: finDe(mes) };
  });

  // --- Arrastre retroactivo: asientos de meses anteriores tocados después de la entrega
  const cerrados = new Map();                            // "cia|mes" → fecha real del cierre en la Oficina
  if (db && db.cierresMes) for (let i = 1; i <= atras; i++) { const m = sumarMeses(mes, -i); for (const c of db.cierresMes(m)) if (c.estado === "cerrado" && c.cerrado_en) cerrados.set(`${c.compania_id}|${m}`, new Date(c.cerrado_en).toISOString().slice(0, 19).replace("T", " ")); }
  const retro = new Map();                               // "cia|mes" → grupo
  for (let i = 1; i <= atras; i++) {
    const m = sumarMeses(mes, -i), [d, h] = rangoMes(m);
    const corteGenerico = `${sumarMeses(m, 1)}-${String(dia).padStart(2, "0")} 23:59:59`;
    let movs;
    try {
      movs = await odoo.leerTodo("account.move", [["state", "=", "posted"], ["date", ">=", d], ["date", "<", h], ["write_date", ">", corteGenerico.slice(0, 10)]],
        ["name", "date", "create_date", "write_date", "company_id", "journal_id", "amount_total", "move_type", "write_uid"]);
    } catch (e) { log(`Sin leer asientos tardíos de ${m}: ${e.message}`); continue; }
    for (const x of movs) {
      const cia = idDe(x.company_id);
      const corte = cerrados.get(`${cia}|${m}`) || corteGenerico;
      const creado = String(x.create_date || ""), modificado = String(x.write_date || "");
      if (!(modificado > corte)) continue;
      const k = `${cia}|${m}`;
      const g = retro.get(k) || { companiaId: cia, compania: nombreCia.get(cia) || nombreDe(x.company_id), mes: m, corte: corte.slice(0, 16).replace("T", " "), corteReal: cerrados.has(k), asientos: 0, creadosTarde: 0, modificadosTarde: 0, monto: 0, ultimaModificacion: null, ejemplos: [] };
      g.asientos++; g.monto += Math.abs(Number(x.amount_total) || 0);
      if (creado > corte) g.creadosTarde++; else g.modificadosTarde++;
      if (!g.ultimaModificacion || modificado > g.ultimaModificacion) g.ultimaModificacion = modificado;
      if (g.ejemplos.length < 5) g.ejemplos.push({ asiento: x.name, fecha: x.date, creado: creado.slice(0, 10), modificado: modificado.slice(0, 16).replace("T", " "), por: nombreDe(x.write_uid) || null, diario: nombreDe(x.journal_id) || null, monto: r2(x.amount_total) });
      retro.set(k, g);
    }
  }
  const retroactivos = [...retro.values()].map(g => ({ ...g, monto: r2(g.monto), ultimaModificacion: g.ultimaModificacion?.slice(0, 16).replace("T", " ") || null })).sort((a, b) => b.asientos - a.asientos);

  // --- Salarios por pagar en cero al cierre
  const saldos = await sumarPorCuenta(odoo, [["date", "<", hM]], { campos: ["balance:sum"] });
  const cuentas = await leerCuentas(odoo, [...saldos.values()].map(x => x.cuentaId));
  const salarios = [];
  for (const f of saldos.values()) {
    const c = cuentas.get(f.cuentaId); if (!c || !/^liability/.test(c.tipo || "")) continue;
    if (!/(salario|sueldo|planilla)/i.test(c.nombre) || !/(por pagar|x pagar|pagar|pendiente|acumulad)/i.test(c.nombre)) continue;
    if (Math.abs(f.balance) > 1) salarios.push({ companiaId: f.companiaId, compania: f.compania, cuenta: c.nombre, cuentaId: f.cuentaId, saldo: r2(-f.balance) });
  }
  salarios.sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo));

  // --- Cobros y pagos sin contacto en el mes
  let sinContacto = [];
  try {
    const g = await odoo.leer("account.move.line", "read_group", [[["parent_state", "=", "posted"], ["date", ">=", dM], ["date", "<", hM], ["partner_id", "=", false], ["account_id.account_type", "in", ["asset_receivable", "liability_payable"]]], ["balance:sum"], ["company_id"]], { lazy: false });
    sinContacto = g.filter(x => idDe(x.company_id)).map(x => ({ companiaId: idDe(x.company_id), compania: nombreCia.get(idDe(x.company_id)) || nombreDe(x.company_id), lineas: x.__count || 0, monto: r2(x.balance) })).sort((a, b) => b.lineas - a.lineas);
  } catch (e) { log(`Sin medir líneas sin contacto: ${e.message}`); }

  // --- Variación ±15 % por cuenta de resultados contra el promedio de los 18 meses anteriores (sin diciembre)
  const historia = new Map();                            // "cia|cuenta" → { nombre, meses: Map(mes → monto) }
  const mesesHist = []; for (let i = 18; i >= 0; i--) mesesHist.push(sumarMeses(mes, -i));
  for (const m of mesesHist) {
    const [d, h] = rangoMes(m);
    const porCuenta = await sumarPorCuenta(odoo, [["date", ">=", d], ["date", "<", h], ["account_id.account_type", "in", RESULTADOS]], { campos: ["balance:sum"] });
    for (const f of porCuenta.values()) {
      const k = `${f.companiaId}|${f.cuentaId}`;
      const x = historia.get(k) || { companiaId: f.companiaId, compania: f.compania, cuentaId: f.cuentaId, meses: new Map() };
      x.meses.set(m, Math.abs(Number(f.balance) || 0)); historia.set(k, x);
    }
  }
  const cuentasRes = await leerCuentas(odoo, [...historia.values()].map(x => x.cuentaId));
  const variaciones = [];
  for (const x of historia.values()) {
    const actual = x.meses.get(mes) || 0;
    const previos = mesesHist.filter(m => m !== mes && !m.endsWith("-12")).map(m => x.meses.get(m) || 0);
    const conDato = previos.filter(v => v > 0);
    if (conDato.length < 6) continue;                    // sin historial suficiente no hay promedio que valga
    const promedio = previos.reduce((t, v) => t + v, 0) / previos.length;
    if (promedio <= 0) continue;
    const diferencia = actual - promedio, pct = Math.round((diferencia / promedio) * 100);
    if (Math.abs(pct) < umbralPct || Math.abs(diferencia) < minimo) continue;
    const c = cuentasRes.get(x.cuentaId);
    variaciones.push({ companiaId: x.companiaId, compania: x.compania, cuentaId: x.cuentaId, cuenta: c?.nombre || String(x.cuentaId), tipo: c?.tipo || null, mes, actual: r2(actual), promedio: r2(promedio), diferencia: r2(diferencia), variacionPct: pct, mesesConDato: conDato.length });
  }
  variaciones.sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));

  const sinCandado = candados.filter(c => c.estado === "sin-candado"), atrasados = candados.filter(c => c.estado === "atrasado");
  const totales = { mes, companias: cias.length, sinCandado: sinCandado.length, candadosAtrasados: atrasados.length, candadosAlDia: candados.length - sinCandado.length - atrasados.length,
    retroactivos: retroactivos.reduce((t, g) => t + g.asientos, 0), companiasConRetroactivos: new Set(retroactivos.map(g => g.companiaId)).size,
    salariosConSaldo: salarios.length, sinContacto: sinContacto.reduce((t, x) => t + x.lineas, 0), variaciones: variaciones.length, diaEntrega: dia, mesesRevisados: atras };

  const alertas = [];
  if (retroactivos.length) alertas.push({ nivel: "alto", texto: `${totales.retroactivos} asientos de meses ya entregados fueron creados o modificados después de la entrega (${totales.companiasConRetroactivos} compañías, últimos ${atras} meses). Cada uno obliga a rehacer los estados de ese mes y los siguientes.`,
    detalle: retroactivos.slice(0, 8).map(g => `${g.compania} ${g.mes}: ${g.asientos} (${g.creadosTarde} creados tarde, ${g.modificadosTarde} modificados), último el ${g.ultimaModificacion}`) });
  if (sinCandado.length || atrasados.length) alertas.push({ nivel: "alto", texto: `${sinCandado.length} compañías sin fecha de bloqueo y ${atrasados.length} con el candado atrasado (debería estar al ${esperado}). Sin candado, cualquier asiento puede caer en un mes ya entregado.`,
    detalle: [...sinCandado.slice(0, 5).map(c => `${c.compania}: sin candado`), ...atrasados.slice(0, 5).map(c => `${c.compania}: candado al ${c.candado}`)] });
  if (salarios.length) alertas.push({ nivel: "alto", texto: `${salarios.length} cuentas de salarios por pagar con saldo al cierre de ${mes}: la firma las cierra en cero cada mes.`,
    detalle: salarios.slice(0, 8).map(s => `${s.compania} — ${s.cuenta}: ₡${colones(s.saldo)}`) });
  if (variaciones.length) alertas.push({ nivel: "alto", texto: `${variaciones.length} cuentas de resultados se movieron más de ${umbralPct} % contra su promedio de 18 meses en ${mes} (recurrentes omitidos, gastos duplicados o montos anormales).`,
    detalle: variaciones.slice(0, 8).map(v => `${v.compania} — ${v.cuenta}: ₡${colones(v.actual)} contra ₡${colones(v.promedio)} (${v.variacionPct > 0 ? "+" : ""}${v.variacionPct} %)`) });
  if (sinContacto.length) alertas.push({ nivel: "info", texto: `${totales.sinContacto} apuntes de cuentas por cobrar o pagar sin contacto en ${mes}: no se pueden conciliar con su factura.`,
    detalle: sinContacto.slice(0, 8).map(x => `${x.compania}: ${x.lineas} apuntes (₡${colones(x.monto)})`) });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: `Controles de cierre de ${mes} sin observaciones en ${cias.length} compañías.`, detalle: [] });

  return {
    agente: meta.nombre, titulo: `Controles de cierre de ${mes}`, corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    mes, totales, candados, retroactivos, salarios, sinContacto, variaciones, alertas
  };
}
