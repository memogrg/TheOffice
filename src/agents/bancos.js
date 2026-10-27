// AGENTE BANCOS — solo lectura. Fase 3A (monitor de la conciliación bancaria, ítem 13 de la matriz).
// IASIMA no importa extractos a Odoo: la conciliación se hace con el módulo de TecnoDEM
// (taerp.bank.reconciliation). Este agente no concilia: mira, por cada cuenta de banco de cada
// compañía, hasta qué mes está conciliada, qué quedó en borrador, qué partidas siguen pendientes
// y qué cuentas con movimiento nunca se han conciliado.
import { mesDe, sumarMeses, mesesEntre, hoyLocal } from "../lib/meses.js";

export const meta = {
  id: "bancos", nombre: "BANCOS", puesto: "Vigila las conciliaciones bancarias",
  modelo: "taerp.bank.reconciliation", escribe: false
};

export async function ejecutar({ odoo, cfg, log }) {
  const t0 = Date.now();
  await odoo.conectar();
  const diarios = await odoo.leerTodo("account.journal", [["type", "=", "bank"]], ["name", "company_id", "default_account_id"]);
  const concs = await odoo.leerTodo(meta.modelo, [], ["company_id", "account_id", "name", "state", "end_date", "book_balance", "initial_balance"]);
  let pendientes = [];
  try { pendientes = await odoo.leerTodo("taerp.bank.reconciliation.unline", [], ["bank_reconcil_id", "date", "debit", "credit", "name"]); }
  catch { log("Sin detalle de partidas pendientes en esta instancia"); }
  log(`${diarios.length} cuentas de banco, ${concs.length} conciliaciones, ${pendientes.length} partidas sin conciliar`);

  // ¿Qué cuentas tienen movimiento? Las que no, no se reportan como «nunca conciliadas».
  const cuentas = [...new Set(diarios.map(d => d.default_account_id?.[0]).filter(Boolean))];
  const movimiento = new Map();
  let medido = false;
  try {
    const g = await odoo.leer("account.move.line", "read_group", [[["account_id", "in", cuentas], ["parent_state", "=", "posted"]], ["date:max"], ["account_id"]], { lazy: false });
    for (const x of g) movimiento.set(Array.isArray(x.account_id) ? x.account_id[0] : x.account_id, { lineas: x.__count, ultima: x.date || null });
    medido = true;
  } catch (e) { log(`No se pudo medir el movimiento por cuenta: ${e.message}`); }

  const hoy = hoyLocal();
  // Hasta qué mes debería estar conciliada cada cuenta: el mes anterior a hoy; en una base congelada
  // (ALERTA_REFERENCIA=ultimo-correo), el último mes que alguien concilió.
  const fechas = concs.map(c => c.end_date).filter(f => f && f <= hoy);
  const maxima = fechas.length ? fechas.reduce((a, b) => (a > b ? a : b)) : null;
  const esperado = cfg.ALERTA_REFERENCIA === "ultimo-correo" && maxima ? mesDe(maxima) : sumarMeses(mesDe(hoy), -1);

  const pendPorConc = new Map();
  for (const p of pendientes) { const id = p.bank_reconcil_id?.[0]; if (id) pendPorConc.set(id, [...(pendPorConc.get(id) || []), p]); }

  const filas = [];
  for (const d of diarios) {
    const cuentaId = d.default_account_id?.[0];
    const mias = concs.filter(c => c.account_id?.[0] === cuentaId).sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)));
    const hechas = mias.filter(c => c.state === "done" && c.end_date <= hoy);
    const borradores = mias.filter(c => c.state !== "done");
    const futuras = mias.filter(c => c.end_date > hoy);
    const ultima = hechas[hechas.length - 1] || null;
    const mov = movimiento.get(cuentaId);
    const conMovimiento = medido ? Boolean(mov && mov.lineas > 0) : true;   // si no se pudo medir, se asume que sí
    const atraso = ultima ? Math.max(0, mesesEntre(mesDe(ultima.end_date), esperado)) : null;
    let estado;
    if (!mias.length) estado = conMovimiento ? "nunca-conciliada" : "sin-movimiento";
    else if (!ultima) estado = "solo-borradores";
    else if (atraso === 0) estado = "al-dia";
    else estado = "atrasada";
    const pend = ultima ? (pendPorConc.get(ultima.id) || []) : [];
    filas.push({
      compania: d.company_id?.[1] || "(sin compañía)", companiaId: d.company_id?.[0] || null, diario: d.name, cuenta: d.default_account_id?.[1] || null, cuentaId,
      estado, ultimaConciliada: ultima ? mesDe(ultima.end_date) : null, mesesAtraso: atraso,
      borradores: borradores.map(b => ({ nombre: b.name, hasta: b.end_date })), fechasFuturas: futuras.map(f => ({ nombre: f.name, hasta: f.end_date })),
      partidasPendientes: pend.length, montoPendiente: Math.round(pend.reduce((s, p) => s + (Number(p.debit) || 0) - (Number(p.credit) || 0), 0) * 100) / 100,
      saldoLibros: ultima ? ultima.book_balance : null, ultimoMovimiento: mov?.ultima || null
    });
  }
  const orden = { atrasada: 0, "solo-borradores": 1, "nunca-conciliada": 2, "al-dia": 3, "sin-movimiento": 4 };
  filas.sort((a, b) => (orden[a.estado] - orden[b.estado]) || ((b.mesesAtraso || 0) - (a.mesesAtraso || 0)) || a.compania.localeCompare(b.compania));
  const cuenta = e => filas.filter(f => f.estado === e).length;
  const totales = {
    cuentas: filas.length, alDia: cuenta("al-dia"), atrasadas: cuenta("atrasada"), soloBorradores: cuenta("solo-borradores"),
    nuncaConciliadas: cuenta("nunca-conciliada"), sinMovimiento: cuenta("sin-movimiento"),
    borradores: filas.reduce((s, f) => s + f.borradores.length, 0), partidasPendientes: filas.reduce((s, f) => s + f.partidasPendientes, 0),
    fechasFuturas: filas.reduce((s, f) => s + f.fechasFuturas.length, 0)
  };

  const alertas = [];
  const atr = filas.filter(f => f.estado === "atrasada");
  if (atr.length) alertas.push({ nivel: "alto", texto: `${atr.length} cuentas de banco con la conciliación atrasada (se esperaba hasta ${esperado}).`,
    detalle: atr.slice(0, 10).map(f => `${f.compania} — ${f.diario}: conciliada hasta ${f.ultimaConciliada} (${f.mesesAtraso} meses)`) });
  const borr = filas.filter(f => f.borradores.length);
  if (borr.length) alertas.push({ nivel: "alto", texto: `${totales.borradores} conciliaciones en borrador en ${borr.length} cuentas: empezadas y sin cerrar.`,
    detalle: borr.slice(0, 10).map(f => `${f.compania} — ${f.borradores.map(b => b.nombre).slice(0, 2).join(", ")}`) });
  const nunca = filas.filter(f => f.estado === "nunca-conciliada");
  if (nunca.length) alertas.push({ nivel: "alto", texto: `${nunca.length} cuentas de banco con movimiento que nunca se han conciliado.`,
    detalle: nunca.slice(0, 10).map(f => `${f.compania} — ${f.diario}`) });
  if (totales.fechasFuturas) alertas.push({ nivel: "info", texto: `${totales.fechasFuturas} conciliaciones con fecha final en el futuro: probablemente un error de digitación.`,
    detalle: filas.filter(f => f.fechasFuturas.length).slice(0, 6).map(f => `${f.compania} — ${f.fechasFuturas.map(x => `${x.nombre} (${x.hasta})`).join(", ")}`) });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: "Todas las cuentas de banco están conciliadas al día.", detalle: [] });

  return {
    agente: meta.nombre, titulo: "Conciliaciones bancarias", corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    esperadoHasta: esperado, totales, cuentas: filas.slice(0, 400), alertas
  };
}
