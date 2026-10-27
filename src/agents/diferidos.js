// AGENTE DIFERIDOS — Fase 3B (ítem 15 de la matriz: gastos diferidos).
// Los diferidos (pólizas, alquileres pagados por adelantado, licencias, mantenimientos anuales)
// se registran en la app —uno por uno o subiendo la hoja de cálculo de cada cliente— con su cuenta
// de activo, su cuenta de gasto, monto, meses e inicio. Este agente arma, por compañía, el asiento
// del mes con la cuota de cada uno (y las cuotas atrasadas que falten) y lo deja en la cola de
// asientos. No escribe: crear el asiento en Odoo pasa por Aprobaciones.
//
// Configuración: DIFERIDOS_MES (AAAA-MM; por omisión el último mes cerrado).
import { idDe, r2, ultimaFechaPorCompania, mesAEvaluar, colones } from "../lib/contable.js";
import { pendientes, avance } from "../lib/diferidos.js";
import { ultimoDia } from "./cierre.js";

export const meta = {
  id: "diferidos", nombre: "DIFERIDOS", puesto: "Amortiza los gastos diferidos",
  modelo: "account.move.line", escribe: false
};

export async function ejecutar({ odoo, cfg, log, db }) {
  const t0 = Date.now();
  if (!db) throw new Error("Los diferidos se registran en la base del servicio: corra este agente desde la app (npm run servicio).");
  await odoo.conectar();
  const ultimas = await ultimaFechaPorCompania(odoo);
  const mes = mesAEvaluar(cfg, cfg.DIFERIDOS_MES, ultimas), fecha = ultimoDia(mes);
  const lista = db.diferidos({ estado: "activo" });
  const aplicados = db.mesesAplicadosDiferidos();
  log(`${lista.length} diferidos activos; cuotas hasta ${mes}`);

  // Las cuentas siguen existiendo y vigentes en la compañía.
  const ids = [...new Set(lista.flatMap(d => [d.cuenta_activo_id, d.cuenta_gasto_id]))];
  const cuentas = ids.length ? await odoo.leer("account.account", "search_read", [[["id", "in", ids]], ["name", "deprecated"]], {}) : [];
  const vigente = new Map(cuentas.map(c => [c.id, !c.deprecated]));
  const cias = [...new Set(lista.map(d => d.compania_id))];
  const diarios = cias.length ? await odoo.leerTodo("account.journal", [["company_id", "in", cias], ["type", "=", "general"]], ["name", "company_id"]) : [];

  const filas = [], problemas = [], porCia = new Map();
  for (const d of lista) {
    const ap = aplicados.get(d.id) || new Set();
    const pend = pendientes(d, mes, ap), av = avance(d, ap);
    const fila = { id: d.id, compania: d.compania, companiaId: d.compania_id, descripcion: d.descripcion, referencia: d.referencia, monto: d.monto, meses: d.meses, inicio: d.inicio,
      cuentaActivo: d.cuenta_activo, cuentaGasto: d.cuenta_gasto, ...av, pendientes: pend.length, montoPendiente: r2(pend.reduce((t, c) => t + c.cuota, 0)),
      estado: av.registradas === av.cuotas ? "terminado" : pend.length > 1 ? "atrasado" : pend.length ? "cuota-del-mes" : d.inicio > mes ? "por-empezar" : "al-dia" };
    filas.push(fila);
    if (!pend.length) continue;
    const malas = [d.cuenta_activo_id, d.cuenta_gasto_id].filter(id => !vigente.get(id));
    if (malas.length) { problemas.push({ ...fila, motivo: "Una de sus cuentas ya no existe o está obsoleta: corrija el diferido." }); fila.estado = "cuenta-invalida"; continue; }
    const total = fila.montoPendiente, nums = pend.map(c => c.numero);
    const tramo = nums.length === 1 ? `cuota ${nums[0]}/${d.meses}` : `cuotas ${nums[0]}–${nums[nums.length - 1]}/${d.meses}`;
    const lineas = porCia.get(d.compania_id) || [];
    lineas.push({ cuentaId: d.cuenta_gasto_id, cuenta: d.cuenta_gasto, descripcion: `${d.descripcion} · ${tramo}`, debito: total, credito: 0, rol: "gasto", diferidoId: d.id, meses: pend.map(c => c.mes),
      fuente: `${colones(d.monto)} en ${d.meses} meses desde ${d.inicio}` });
    lineas.push({ cuentaId: d.cuenta_activo_id, cuenta: d.cuenta_activo, descripcion: `${d.descripcion} · ${tramo}`, debito: 0, credito: total, rol: "diferido", diferidoId: d.id, meses: pend.map(c => c.mes) });
    porCia.set(d.compania_id, lineas);
  }

  const asientosSugeridos = [];
  for (const [cia, lineas] of porCia) {
    const compania = lista.find(d => d.compania_id === cia).compania, diario = diarios.find(j => idDe(j.company_id) === cia) || null;
    const n = new Set(lineas.map(l => l.diferidoId)).size, total = r2(lineas.reduce((t, l) => t + l.debito, 0));
    asientosSugeridos.push({ clave: `diferidos|${cia}|${mes}`, origen: "diferidos", mes, companiaId: cia, compania, fecha, diarioId: diario?.id ?? null, diario: diario?.name ?? null,
      referencia: `Amortización de gastos diferidos ${mes}`,
      motivo: `${n} diferido${n === 1 ? "" : "s"} con cuota hasta ${mes}: ₡${colones(total)}${lineas.some(l => l.meses.length > 1) ? " (incluye cuotas atrasadas)" : ""}.`,
      aviso: "Cada línea dice qué cuotas cubre; al crearse en Odoo esas cuotas quedan registradas y no se vuelven a proponer.", lineas });
  }
  const cuenta = e => filas.filter(f => f.estado === e).length;
  const totales = { diferidos: filas.length, cuotaDelMes: cuenta("cuota-del-mes"), atrasados: cuenta("atrasado"), terminados: cuenta("terminado"), porEmpezar: cuenta("por-empezar"),
    cuentaInvalida: problemas.length, companias: porCia.size, montoDelMes: r2(asientosSugeridos.reduce((t, a) => t + a.lineas.reduce((s, l) => s + l.debito, 0), 0)), asientosSugeridos: asientosSugeridos.length };
  const alertas = [];
  if (asientosSugeridos.length) alertas.push({ nivel: "info", texto: `${asientosSugeridos.length} asientos de amortización de ${mes} (₡${colones(totales.montoDelMes)}) en Aprobaciones → Asientos.`,
    detalle: asientosSugeridos.slice(0, 8).map(a => `${a.compania}: ${a.motivo}`) });
  if (totales.atrasados) alertas.push({ nivel: "alto", texto: `${totales.atrasados} diferidos con cuotas atrasadas: el asiento del mes las incluye.`,
    detalle: filas.filter(f => f.estado === "atrasado").slice(0, 8).map(f => `${f.compania} — ${f.descripcion}: ${f.pendientes} cuotas, ₡${colones(f.montoPendiente)}`) });
  if (problemas.length) alertas.push({ nivel: "alto", texto: `${problemas.length} diferidos con una cuenta que ya no existe o está obsoleta: no se proponen.`, detalle: problemas.slice(0, 8).map(p => `${p.compania} — ${p.descripcion}`) });
  if (!lista.length) alertas.push({ nivel: "info", texto: "Todavía no hay diferidos registrados. Se cargan en la pestaña Diferidos (uno por uno o subiendo la hoja de cálculo).", detalle: [] });
  else if (!alertas.length) alertas.push({ nivel: "ok", texto: `Diferidos al día en ${mes}.`, detalle: [] });

  return {
    agente: meta.nombre, titulo: `Gastos diferidos de ${mes}`, corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    mes, fecha, totales, diferidos: filas, problemas, asientosSugeridos, alertas
  };
}
