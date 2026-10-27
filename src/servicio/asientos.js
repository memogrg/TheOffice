// Fase 3B: asientos de diario propuestos (sin comprobante electrónico, no pasan por Hacienda).
//
//   proponer  — desde el Director: cuentas por código en el plan de la compañía, valida que cuadre.
//   validar   — contra Odoo: cuentas de la compañía y vigentes, diario de la compañía, cuadre,
//               periodo fiscal abierto para la fecha.
//   aplicar   — SOLO un asiento aprobado y SOLO con PERMITIR_ESCRITURA_ASIENTOS=si: lo crea en
//               borrador; con ASIENTOS_PUBLICAR=si además lo publica; después lo relee y verifica.
//
// Es un permiso distinto de PERMITIR_ESCRITURA (que gobierna facturas con comprobante): la matriz
// B1/B2 separa los asientos sin FE porque no los bloquea la confirmación de Hacienda.
import { canon } from "../catalogo.js";

const r2 = x => Math.round((Number(x) || 0) * 100) / 100;
const idDe = v => (Array.isArray(v) ? v[0] : v);
export const escrituraAsientos = cfg => String(cfg.PERMITIR_ESCRITURA_ASIENTOS || "").toLowerCase() === "si";

// Cuadre y forma, sin Odoo.
export function revisarForma(a) {
  const errores = [];
  const lineas = a.lineas || [];
  if (lineas.length < 2) errores.push("Un asiento necesita al menos dos líneas.");
  for (const [i, l] of lineas.entries()) {
    const d = r2(l.debito), c = r2(l.credito);
    if (!l.cuentaId) errores.push(`Línea ${i + 1}: falta la cuenta${l.rol === "contrapartida" ? " (elija el banco)" : ""}.`);
    if (d < 0 || c < 0) errores.push(`Línea ${i + 1}: montos negativos.`);
    if (d && c) errores.push(`Línea ${i + 1}: tiene débito y crédito a la vez.`);
    if (!d && !c) errores.push(`Línea ${i + 1}: sin monto.`);
  }
  const deb = r2(lineas.reduce((t, l) => t + (Number(l.debito) || 0), 0)), cre = r2(lineas.reduce((t, l) => t + (Number(l.credito) || 0), 0));
  if (Math.abs(deb - cre) > 0.009) errores.push(`No cuadra: débitos ${deb} y créditos ${cre}.`);
  if (!a.diario_id && !a.diarioId) errores.push("Falta el diario.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.fecha || ""))) errores.push("Fecha inválida (AAAA-MM-DD).");
  if (a.reversa && !(String(a.reversa) > String(a.fecha))) errores.push("La fecha de reversión tiene que ser posterior a la del asiento.");
  return { errores, debitos: deb, creditos: cre };
}

export async function validar(odoo, a) {
  const { errores } = revisarForma(a);
  const CID = a.compania_id ?? a.companiaId, diarioId = a.diario_id ?? a.diarioId;
  const ctx = { context: { allowed_company_ids: [CID] } };
  const avisos = [];
  const ids = [...new Set((a.lineas || []).map(l => l.cuentaId).filter(Boolean))];
  if (ids.length) {
    const cuentas = await odoo.leer("account.account", "search_read", [[["id", "in", ids]], ["name", "company_ids", "deprecated", "account_type"]], ctx);
    for (const id of ids) {
      const c = cuentas.find(x => x.id === id);
      if (!c) { errores.push(`La cuenta ${id} no existe o no se ve desde la compañía.`); continue; }
      if (c.deprecated) errores.push(`La cuenta «${c.name}» está obsoleta.`);
      if (Array.isArray(c.company_ids) && c.company_ids.length && !c.company_ids.map(idDe).includes(CID)) errores.push(`La cuenta «${c.name}» no es de esta compañía.`);
    }
  }
  if (diarioId) {
    const [d] = await odoo.leer("account.journal", "search_read", [[["id", "=", diarioId]], ["name", "company_id", "type"]], ctx);
    if (!d) errores.push(`El diario ${diarioId} no existe.`);
    else if (idDe(d.company_id) !== CID) errores.push(`El diario «${d.name}» es de otra compañía.`);
  }
  // Periodo fiscal de TecnoDEM: si el módulo está, la fecha (y la de la reversión) tiene que caer en uno abierto.
  for (const f of [a.fecha, a.reversa].filter(Boolean)) {
    try {
      const periodos = await odoo.leer("taerp.fiscal.period", "search_read",
        [[["company_id", "=", CID], ["date_from", "<=", f], ["date_to", ">=", f]], ["name", "state"]], ctx);
      if (!periodos.length) errores.push(`No hay periodo fiscal para ${f} en la compañía: hay que crearlo antes.`);
      else if (!periodos.some(p => p.state === "open")) errores.push(`El periodo fiscal de ${f} está ${periodos[0].state === "close" ? "cerrado" : "en borrador"}.`);
    } catch { avisos.push("No se pudo revisar el periodo fiscal (módulo de TecnoDEM no disponible)."); break; }
  }
  return { ok: !errores.length, errores, avisos };
}

// Del Director: líneas con código de cuenta → ids del plan de esa compañía.
export async function proponer({ corridas, db, compania, fecha, diario = null, referencia = "", motivo = "", lineas = [], propuso }) {
  const CID = Number(compania);
  if (!CID) return { error: "Falta la compañía (compania = id)." };
  if (!Array.isArray(lineas) || lineas.length < 2) return { error: "Un asiento necesita al menos dos líneas (codigo, debito o credito)." };
  const odoo = corridas.crearCliente({ meta: { escribe: false } });
  const ctx = { context: { allowed_company_ids: [CID] } };
  const [cia] = await odoo.leer("res.company", "search_read", [[["id", "=", CID]], ["name"]]);
  if (!cia) return { error: `No existe la compañía ${CID}.` };
  const plan = await odoo.leerTodo("account.account", [["company_ids", "in", [CID]]], ["code", "name", "deprecated"], { context: ctx.context });
  const resueltas = [];
  for (const l of lineas) {
    const c = plan.find(x => !x.deprecated && x.code && canon(x.code) === canon(l.codigo));
    if (!c) return { error: `La cuenta ${l.codigo} no existe (o está obsoleta) en el plan de ${cia.name}.` };
    resueltas.push({ cuentaId: c.id, cuenta: `${c.code} ${c.name}`, descripcion: String(l.descripcion || referencia || "").slice(0, 120), debito: r2(l.debito), credito: r2(l.credito), rol: "manual" });
  }
  const diarios = await odoo.leer("account.journal", "search_read", [[["company_id", "=", CID]], ["name", "type"]], ctx);
  const d = diario ? diarios.find(x => x.id === Number(diario) || String(x.name).toLowerCase() === String(diario).toLowerCase()) : diarios.find(x => x.type === "general");
  if (!d) return { error: diario ? `No encontré el diario «${diario}» en ${cia.name}. Diarios: ${diarios.map(x => `${x.id} ${x.name}`).join(", ")}.` : `${cia.name} no tiene diario general; indique uno.` };
  const a = { origen: "director", companiaId: CID, compania: cia.name, fecha: String(fecha || "").slice(0, 10), diarioId: d.id, diario: d.name,
    referencia: String(referencia || "").slice(0, 200), motivo: String(motivo || "").slice(0, 500), lineas: resueltas };
  const forma = revisarForma(a);
  if (forma.errores.length) return { error: forma.errores.join(" ") };
  const v = await validar(odoo, a);
  const creado = db.proponerAsiento(a, propuso);
  return { asiento: { id: creado.id, compania: creado.compania, fecha: creado.fecha, diario: creado.diario, total: creado.total, lineas: creado.lineas },
    observaciones: v.errores.concat(v.avisos),
    siguiente: "Queda en Aprobaciones → Asientos. Un contable lo aprueba; crearlo en Odoo requiere PERMITIR_ESCRITURA_ASIENTOS=si." };
}

// Crea en Odoo un asiento APROBADO y lo verifica al releerlo.
export async function aplicar({ corridas, db, id, quien }) {
  const a = db.asiento(Number(id));
  if (!a) return { error: "No existe ese asiento.", codigo: 404 };
  if (a.estado !== "aprobada") return { error: `El asiento está ${a.estado}; solo se aplica uno aprobado.`, codigo: 409 };
  if (!escrituraAsientos(corridas.cfg)) return { error: "PERMITIR_ESCRITURA_ASIENTOS no es 'si': el servicio no puede crear asientos en Odoo.", codigo: 403 };
  const odoo = corridas.crearCliente({ meta: { escribe: true } });
  const v = await validar(odoo, a);
  if (!v.ok) { db.marcarAsiento(a.id, "aprobada", { resultado: { validacion: v } }); return { error: "No pasa la validación: " + v.errores.join(" "), validacion: v, codigo: 400 }; }
  const CID = a.compania_id, ctx = { context: { allowed_company_ids: [CID] } };
  const publicar = String(corridas.cfg.ASIENTOS_PUBLICAR || "").toLowerCase() === "si";
  let moveId = null;
  // Crea un asiento (las líneas, o las mismas con débito y crédito cambiados para la reversión), lo
  // publica si corresponde y lo verifica al releerlo.
  const crear = async ({ fecha, ref, invertir }) => {
    const lin = a.lineas.map(l => ({ ...l, debito: invertir ? l.credito : l.debito, credito: invertir ? l.debito : l.credito }));
    const creado = await odoo.escribir("account.move", "create", [{
      move_type: "entry", company_id: CID, journal_id: a.diario_id, date: fecha, ref,
      line_ids: lin.map(l => [0, 0, { account_id: l.cuentaId, name: l.descripcion || a.referencia || "", debit: r2(l.debito), credit: r2(l.credito),
        ...(l.partnerId ? { partner_id: l.partnerId } : {}), ...(l.monedaId ? { currency_id: l.monedaId, amount_currency: 0 } : {}) }])
    }], ctx);
    const id = Array.isArray(creado) ? creado[0] : creado;
    if (!invertir) moveId = id;
    if (publicar) await odoo.escribir("account.move", "action_post", [[id]], ctx);
    const [m] = await odoo.leer("account.move", "search_read", [[["id", "=", id]], ["name", "state", "date", "journal_id"]], ctx);
    const ls = await odoo.leer("account.move.line", "search_read", [[["move_id", "=", id]], ["account_id", "debit", "credit"]], ctx);
    const esperado = lin.map(l => `${l.cuentaId}|${r2(l.debito)}|${r2(l.credito)}`).sort().join(";");
    const leido = ls.map(l => `${idDe(l.account_id)}|${r2(l.debit)}|${r2(l.credit)}`).sort().join(";");
    const ok = Boolean(m) && esperado === leido && m.state === (publicar ? "posted" : "draft");
    return { id, nombre: m?.name || null, estado: m?.state, ok, lineasLeidas: ls.length, ...(ok ? {} : { esperado, leido }) };
  };
  try {
    const base = `${a.referencia || "Asiento propuesto"} · Oficina #${a.id}`;
    const m = await crear({ fecha: a.fecha, ref: base, invertir: false });
    const rev = a.reversa && m.ok ? await crear({ fecha: a.reversa, ref: `Reversión de ${m.nombre || m.id}: ${base}`, invertir: true }) : null;
    const ok = m.ok && (!a.reversa || Boolean(rev?.ok));
    const resultado = { ok, estadoOdoo: m.estado, publicado: publicar, lineasLeidas: m.lineasLeidas, ...(m.ok ? {} : { esperado: m.esperado, leido: m.leido }),
      ...(rev ? { reversion: { moveId: rev.id, nombre: rev.nombre, fecha: a.reversa, estado: rev.estado, ok: rev.ok } } : {}) };
    db.marcarAsiento(a.id, ok ? "aplicada" : "fallo", { moveId, moveName: m.nombre, resultado });
    db.auditar(quien, "aplicar", "asiento", a.id, { moveId, reversion: rev?.id ?? null, publicado: publicar, ok });
    return { ok, moveId, asiento: m.nombre, estadoOdoo: m.estado, publicado: publicar, reversion: rev ? rev.nombre || rev.id : null,
      mensaje: ok ? `Asiento ${m.nombre || moveId} creado${rev ? ` con su reversión ${rev.nombre || rev.id} al ${a.reversa}` : ""}${publicar ? " y publicado" : " en borrador (ASIENTOS_PUBLICAR no es 'si': publíquelo en Odoo)"}.`
        : "Se creó pero la verificación no calza: revíselo en Odoo." };
  } catch (e) {
    db.marcarAsiento(a.id, "fallo", { moveId, resultado: { error: e.message } });
    db.auditar(quien, "aplicar", "asiento", a.id, { error: e.message });
    return { error: `Odoo rechazó el asiento: ${e.message}`, codigo: 502 };
  }
}

// Diarios de banco y caja de la compañía, para elegir la contrapartida.
export async function opciones({ corridas, companiaId }) {
  const odoo = corridas.crearCliente({ meta: { escribe: false } });
  const ds = await odoo.leer("account.journal", "search_read", [[["company_id", "=", companiaId], ["type", "in", ["bank", "cash", "general"]]], ["name", "type", "default_account_id"]],
    { context: { allowed_company_ids: [companiaId] } });
  return ds.map(d => ({ id: d.id, nombre: d.name, tipo: d.type, cuentaId: idDe(d.default_account_id) || null, cuenta: Array.isArray(d.default_account_id) ? d.default_account_id[1] : null }));
}

// Código → cuenta del plan de una compañía (para completar líneas por definir).
export async function cuentasPorCodigo({ corridas, companiaId, codigos }) {
  const odoo = corridas.crearCliente({ meta: { escribe: false } });
  const plan = await odoo.leerTodo("account.account", [["company_ids", "in", [companiaId]]], ["code", "name", "deprecated"], { context: { allowed_company_ids: [companiaId] } });
  const out = new Map();
  for (const cod of codigos) { const c = plan.find(x => !x.deprecated && x.code && canon(x.code) === canon(cod)); if (c) out.set(String(cod).trim(), c); }
  return out;
}
