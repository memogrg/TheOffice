// AGENTE DEPRECIACIÓN — Fase 3B (ítem 16 de la matriz: depreciación y control de activo fijo).
// En IASIMA no hay activos cargados en Odoo (account.asset.asset = 0) y la depreciación se registra
// a mano, a veces mensual, a veces trimestral. Los activos se registran en la app (con lo ya
// depreciado afuera hasta un mes) y este agente propone, por compañía, el asiento de depreciación
// lineal del mes (y los meses atrasados): gasto por depreciación contra depreciación acumulada.
//
// Para no duplicar: si en el mes ya hay depreciación registrada a mano en la misma cuenta de gasto
// de la compañía, no propone el asiento de esa compañía y lo avisa (hay que decidir si se sigue a
// mano o desde aquí, y marcar «depreciado hasta» en los activos).
//
// Configuración: DEPRECIACION_MES (AAAA-MM; por omisión el último mes cerrado).
import { idDe, r2, rangoMes, ultimaFechaPorCompania, mesAEvaluar, colones } from "../lib/contable.js";
import { pendientes, avance } from "../lib/diferidos.js";
import { ultimoDia } from "./cierre.js";

export const meta = {
  id: "depreciacion", nombre: "DEPRECIACIÓN", puesto: "Deprecia los activos fijos",
  modelo: "account.move.line", escribe: false
};

const sched = a => ({ monto: Number(a.costo) - Number(a.residual || 0), meses: a.vida_meses, inicio: a.inicio });

export async function ejecutar({ odoo, cfg, log, db }) {
  const t0 = Date.now();
  if (!db) throw new Error("Los activos se registran en la base del servicio: corra este agente desde la app (npm run servicio).");
  await odoo.conectar();
  const ultimas = await ultimaFechaPorCompania(odoo);
  const mes = mesAEvaluar(cfg, cfg.DEPRECIACION_MES, ultimas), fecha = ultimoDia(mes), [dM, hM] = rangoMes(mes);
  const lista = [...db.activos({ estado: "activo" }), ...db.activos({ estado: "baja" })];   // de los dados de baja, solo lo pendiente hasta el mes de la baja
  const aplicados = db.mesesAplicadosActivos();
  log(`${lista.length} activos; depreciación hasta ${mes}`);

  const ids = [...new Set(lista.flatMap(a => [a.cuenta_acumulada_id, a.cuenta_gasto_id]))];
  const cuentas = ids.length ? await odoo.leer("account.account", "search_read", [[["id", "in", ids]], ["name", "deprecated"]], {}) : [];
  const vigente = new Map(cuentas.map(c => [c.id, !c.deprecated]));
  const cias = [...new Set(lista.map(a => a.compania_id))];
  const diarios = cias.length ? await odoo.leerTodo("account.journal", [["company_id", "in", cias], ["type", "=", "general"]], ["name", "company_id"]) : [];

  // depreciación ya registrada a mano en el mes, en las cuentas de gasto de los activos registrados
  const aMano = new Map();
  const gastos = [...new Set(lista.map(a => a.cuenta_gasto_id))];
  if (gastos.length) {
    const ls = await odoo.leerTodo("account.move.line", [["parent_state", "=", "posted"], ["account_id", "in", gastos], ["date", ">=", dM], ["date", "<", hM]], ["company_id", "account_id", "move_id", "balance"]);
    const movs = [...new Set(ls.map(l => idDe(l.move_id)))];
    const refs = new Map();
    for (let i = 0; i < movs.length; i += 500)
      for (const m of await odoo.leer("account.move", "search_read", [[["id", "in", movs.slice(i, i + 500)]], ["ref", "name"]], {})) refs.set(m.id, `${m.ref || ""}`);
    for (const l of ls) {
      if (/Oficina #\d+/.test(refs.get(idDe(l.move_id)) || "")) continue;     // lo que creó la app no cuenta
      const cia = idDe(l.company_id), v = aMano.get(cia) || { monto: 0, asientos: new Set() };
      v.monto += Number(l.balance) || 0; v.asientos.add(idDe(l.move_id)); aMano.set(cia, v);
    }
  }

  const filas = [], problemas = [], porCia = new Map();
  for (const a of lista) {
    const ap = aplicados.get(a.id) || new Set();
    const pend = pendientes(sched(a), mes, ap, { hechoHasta: a.hecho_hasta, baja: a.baja_mes }), av = avance(sched(a), ap, { hechoHasta: a.hecho_hasta });
    const neto = r2(Number(a.costo) - av.amortizado);
    const fila = { id: a.id, compania: a.compania, companiaId: a.compania_id, descripcion: a.descripcion, categoria: a.categoria, costo: a.costo, residual: a.residual, vidaMeses: a.vida_meses,
      inicio: a.inicio, ...av, depreciado: av.amortizado, valorEnLibros: neto, pendientes: pend.length, montoPendiente: r2(pend.reduce((t, c) => t + c.cuota, 0)), baja: a.baja_mes,
      estado: a.estado === "baja" ? "baja" : av.registradas === av.cuotas ? "depreciado" : pend.length > 1 ? "atrasado" : pend.length ? "cuota-del-mes" : a.inicio > mes ? "por-empezar" : "al-dia" };
    filas.push(fila);
    if (!pend.length) continue;
    if (![a.cuenta_acumulada_id, a.cuenta_gasto_id].every(id => vigente.get(id))) { problemas.push({ ...fila, motivo: "Una de sus cuentas ya no existe o está obsoleta." }); fila.estado = "cuenta-invalida"; continue; }
    const total = fila.montoPendiente, nums = pend.map(c => c.numero), m = pend.map(c => c.mes);
    const tramo = nums.length === 1 ? `mes ${nums[0]}/${a.vida_meses}` : `meses ${nums[0]}–${nums[nums.length - 1]}/${a.vida_meses}`;
    const lineas = porCia.get(a.compania_id) || [];
    lineas.push({ cuentaId: a.cuenta_gasto_id, cuenta: a.cuenta_gasto, descripcion: `Depreciación ${a.descripcion} · ${tramo}`, debito: total, credito: 0, rol: "gasto", activoId: a.id, meses: m,
      fuente: `(${colones(a.costo)} − ${colones(a.residual)}) / ${a.vida_meses} meses` });
    lineas.push({ cuentaId: a.cuenta_acumulada_id, cuenta: a.cuenta_acumulada, descripcion: `Depreciación ${a.descripcion} · ${tramo}`, debito: 0, credito: total, rol: "acumulada", activoId: a.id, meses: m });
    porCia.set(a.compania_id, lineas);
  }

  const asientosSugeridos = [], duplicados = [];
  for (const [cia, lineas] of porCia) {
    const compania = lista.find(a => a.compania_id === cia).compania;
    const mano = aMano.get(cia);
    if (mano && Math.abs(mano.monto) >= 1) { duplicados.push({ compania, companiaId: cia, monto: r2(mano.monto), asientos: mano.asientos.size }); continue; }
    const diario = diarios.find(j => idDe(j.company_id) === cia) || null, n = new Set(lineas.map(l => l.activoId)).size, total = r2(lineas.reduce((t, l) => t + l.debito, 0));
    asientosSugeridos.push({ clave: `depreciacion|${cia}|${mes}`, origen: "depreciacion", mes, companiaId: cia, compania, fecha, diarioId: diario?.id ?? null, diario: diario?.name ?? null,
      referencia: `Depreciación de activos fijos ${mes}`,
      motivo: `${n} activo${n === 1 ? "" : "s"}: ₡${colones(total)}${lineas.some(l => l.meses.length > 1) ? " (incluye meses atrasados)" : ""}.`,
      aviso: "Cada línea dice qué meses cubre; al crearse en Odoo esos meses quedan registrados y no se vuelven a proponer.", lineas });
  }
  const cuenta = e => filas.filter(f => f.estado === e).length;
  const totales = { activos: filas.length, cuotaDelMes: cuenta("cuota-del-mes"), atrasados: cuenta("atrasado"), depreciados: cuenta("depreciado"), bajas: cuenta("baja"),
    cuentaInvalida: problemas.length, yaAMano: duplicados.length, costo: r2(filas.reduce((t, f) => t + Number(f.costo), 0)), valorEnLibros: r2(filas.reduce((t, f) => t + f.valorEnLibros, 0)),
    montoDelMes: r2(asientosSugeridos.reduce((t, a) => t + a.lineas.reduce((s, l) => s + l.debito, 0), 0)), asientosSugeridos: asientosSugeridos.length };
  const alertas = [];
  if (asientosSugeridos.length) alertas.push({ nivel: "info", texto: `${asientosSugeridos.length} asientos de depreciación de ${mes} (₡${colones(totales.montoDelMes)}) en Aprobaciones → Asientos.`,
    detalle: asientosSugeridos.slice(0, 8).map(a => `${a.compania}: ${a.motivo}`) });
  if (duplicados.length) alertas.push({ nivel: "alto", texto: `${duplicados.length} compañías ya tienen depreciación registrada a mano en ${mes}: no se propone para no duplicar. Decida si se sigue a mano o desde aquí, y marque «depreciado hasta» en sus activos.`,
    detalle: duplicados.slice(0, 8).map(d => `${d.compania}: ₡${colones(d.monto)} en ${d.asientos} asiento(s)`) });
  if (problemas.length) alertas.push({ nivel: "alto", texto: `${problemas.length} activos con una cuenta que ya no existe o está obsoleta.`, detalle: problemas.slice(0, 8).map(p => `${p.compania} — ${p.descripcion}`) });
  if (totales.atrasados) alertas.push({ nivel: "info", texto: `${totales.atrasados} activos con meses atrasados: el asiento los incluye.`, detalle: filas.filter(f => f.estado === "atrasado").slice(0, 6).map(f => `${f.compania} — ${f.descripcion}: ${f.pendientes} meses`) });
  if (!lista.length) alertas.push({ nivel: "info", texto: "Todavía no hay activos registrados. Se cargan en la pestaña Activos fijos (uno por uno o subiendo la hoja de cálculo).", detalle: [] });
  else if (!alertas.length) alertas.push({ nivel: "ok", texto: `Depreciación al día en ${mes}.`, detalle: [] });

  return {
    agente: meta.nombre, titulo: `Depreciación de ${mes}`, corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    mes, fecha, totales, activos: filas, problemas, duplicados, asientosSugeridos, alertas
  };
}
