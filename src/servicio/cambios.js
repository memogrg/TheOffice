// Cambios masivos al plan de cuentas (objetivo 5 de la matriz B1/B2): una instrucción que se
// aplica en N compañías a la vez. Flujo NIVELES: previsualizar → aprobar → ejecutar → verificar.
//
//   renombrar   — la cuenta con ese código pasa a llamarse <nuevo nombre>
//   recodificar — la cuenta con ese código pasa a <nuevo código> (si ese código está libre)
//   crear       — crea <código> <nombre> (tipo de Odoo) donde no exista
//   obsoleta    — marca la cuenta como obsoleta (no recibe asientos nuevos); avisa si se usa
//
// En IASIMA cada compañía tiene su propio plan (ninguna cuenta compartida) y un mismo código puede
// significar otra cosa en otro cliente: la previsualización muestra el nombre actual en cada
// compañía y, si se dio el nombre esperado, deja fuera las que no calzan. No toca asientos ni
// comprobantes. Escribir requiere PERMITIR_ESCRITURA_CUENTAS=si (permiso propio).
import { canon, norm } from "../catalogo.js";

export const TIPOS = ["renombrar", "recodificar", "crear", "obsoleta"];
export const TIPOS_CUENTA = ["asset_receivable", "asset_cash", "asset_current", "asset_non_current", "asset_prepayments", "asset_fixed", "liability_payable",
  "liability_credit_card", "liability_current", "liability_non_current", "equity", "equity_unaffected", "income", "income_other", "expense",
  "expense_depreciation", "expense_direct_cost", "off_balance"];
export const escrituraCuentas = cfg => String(cfg.PERMITIR_ESCRITURA_CUENTAS || "").toLowerCase() === "si";
const idDe = v => (Array.isArray(v) ? v[0] : v);
const calza = (actual, esperado) => !esperado || norm(actual).includes(norm(esperado));

// Revisa la instrucción sin Odoo.
export function revisarInstruccion(x) {
  const e = [];
  if (!TIPOS.includes(x.tipo)) e.push(`Tipo inválido: use ${TIPOS.join(", ")}.`);
  if (!x.codigo) e.push("Falta el código de la cuenta.");
  if (x.tipo === "renombrar" && !String(x.nuevoNombre || "").trim()) e.push("Falta el nombre nuevo.");
  if (x.tipo === "recodificar" && !String(x.nuevoCodigo || "").trim()) e.push("Falta el código nuevo.");
  if (x.tipo === "recodificar" && canon(x.nuevoCodigo) === canon(x.codigo)) e.push("El código nuevo es el mismo.");
  if (x.tipo === "crear" && !String(x.nuevoNombre || "").trim()) e.push("Falta el nombre de la cuenta a crear.");
  if (x.tipo === "crear" && !TIPOS_CUENTA.includes(x.tipoCuenta)) e.push(`Falta el tipo de cuenta de Odoo (${TIPOS_CUENTA.join(", ")}).`);
  if (!String(x.motivo || "").trim()) e.push("Falta el motivo.");
  return e;
}

// Previsualización: para cada compañía del alcance, qué pasaría. Solo lee.
export async function previsualizar(odoo, x, { companias, log = () => {} }) {
  const items = [];
  const cods = { orig: canon(x.codigo), nuevo: x.nuevoCodigo ? canon(x.nuevoCodigo) : null };
  const desde = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  for (const cia of companias) {
    const ctx = { context: { allowed_company_ids: [cia.id] } };
    let plan;
    try { plan = await odoo.leerTodo("account.account", [["company_ids", "in", [cia.id]]], ["code", "name", "account_type", "deprecated"], ctx); }
    catch (e) { items.push({ companiaId: cia.id, compania: cia.name, estado: "error", motivo: e.message }); continue; }
    const base = { companiaId: cia.id, compania: cia.name, incluido: true };
    const actual = plan.find(c => canon(c.code) === cods.orig);
    if (x.tipo === "crear") {
      if (actual) { items.push({ ...base, cuentaId: actual.id, actual: { codigo: actual.code, nombre: actual.name, tipo: actual.account_type }, estado: "ya-existe", motivo: "Ya hay una cuenta con ese código.", incluido: false }); continue; }
      // el padre (código sin el último nivel) indica que el plan de esa compañía tiene esa rama
      const partes = String(x.codigo).split("."), padre = partes.length > 2 ? canon(partes.slice(0, -1).join(".")) : null;
      const tienePadre = !padre || plan.some(c => canon(c.code) === padre);
      items.push({ ...base, cuentaId: null, actual: null, nuevo: { codigo: x.codigo, nombre: x.nuevoNombre, tipo: x.tipoCuenta },
        estado: tienePadre ? "listo" : "revisar", motivo: tienePadre ? null : `El plan de esta compañía no tiene la cuenta madre ${padre}: revise que ese código tenga sentido aquí.` });
      continue;
    }
    if (!actual) { items.push({ ...base, cuentaId: null, actual: null, estado: "no-existe", motivo: "No tiene una cuenta con ese código.", incluido: false }); continue; }
    const ahora = { codigo: actual.code, nombre: actual.name, tipo: actual.account_type, obsoleta: Boolean(actual.deprecated) };
    if (!calza(actual.name, x.nombreActual)) {
      items.push({ ...base, cuentaId: actual.id, actual: ahora, estado: "otro-significado", motivo: `Aquí ${actual.code} es «${actual.name}», no «${x.nombreActual}».`, incluido: false }); continue;
    }
    const it = { ...base, cuentaId: actual.id, actual: ahora, estado: "listo", motivo: null };
    if (x.tipo === "renombrar") {
      it.nuevo = { ...ahora, nombre: x.nuevoNombre };
      if (String(actual.name).trim() === String(x.nuevoNombre).trim()) Object.assign(it, { estado: "sin-cambio", motivo: "Ya se llama así.", incluido: false });
    } else if (x.tipo === "recodificar") {
      it.nuevo = { ...ahora, codigo: x.nuevoCodigo };
      const choca = plan.find(c => canon(c.code) === cods.nuevo);
      if (choca) Object.assign(it, { estado: "conflicto", motivo: `El código ${x.nuevoCodigo} ya es «${choca.name}» en esta compañía.`, incluido: false });
    } else if (x.tipo === "obsoleta") {
      it.nuevo = { ...ahora, obsoleta: true };
      if (actual.deprecated) Object.assign(it, { estado: "sin-cambio", motivo: "Ya está obsoleta.", incluido: false });
      else {
        try {
          const n = await odoo.leer("account.move.line", "search_count", [[["account_id", "=", actual.id], ["date", ">=", desde]]], ctx);
          if (n) Object.assign(it, { estado: "revisar", motivo: `Tuvo ${n} líneas en los últimos 90 días: al marcarla obsoleta, lo que siga llegando a esta cuenta va a fallar.` });
        } catch { /* informativo */ }
      }
    }
    items.push(it);
  }
  // nombres distintos para el mismo código entre compañías (sin nombre esperado): se marcan para revisar
  if (!x.nombreActual && x.tipo !== "crear") {
    const conteo = new Map();
    for (const i of items.filter(i => i.actual)) conteo.set(norm(i.actual.nombre), (conteo.get(norm(i.actual.nombre)) || 0) + 1);
    const mayoria = [...conteo].sort((a, b) => b[1] - a[1])[0]?.[0];
    for (const i of items) if (i.actual && i.estado === "listo" && conteo.size > 1 && norm(i.actual.nombre) !== mayoria)
      Object.assign(i, { estado: "revisar", motivo: `Aquí se llama «${i.actual.nombre}», distinto de la mayoría: confirme que es la misma cuenta.` });
  }
  log(`${items.length} compañías revisadas`);
  return items;
}

export function resumen(items) {
  const r = {};
  for (const i of items) r[i.estado] = (r[i.estado] || 0) + 1;
  r.incluidos = items.filter(i => i.incluido).length;
  return r;
}

// Proponer: desde la app o desde el Director.
export async function proponer({ corridas, db, instruccion, propuso }) {
  const x = { ...instruccion, codigo: String(instruccion.codigo || "").trim(), nuevoCodigo: instruccion.nuevoCodigo ? String(instruccion.nuevoCodigo).trim() : null,
    nuevoNombre: instruccion.nuevoNombre ? String(instruccion.nuevoNombre).trim() : null, nombreActual: instruccion.nombreActual ? String(instruccion.nombreActual).trim() : null };
  const errores = revisarInstruccion(x);
  if (errores.length) return { error: errores.join(" ") };
  const odoo = corridas.crearCliente({ meta: { escribe: false } });
  let companias = await odoo.leer("res.company", "search_read", [[], ["name"]], {});
  if (Array.isArray(x.companias) && x.companias.length) companias = companias.filter(c => x.companias.map(Number).includes(c.id));
  if (Array.isArray(x.excluir) && x.excluir.length) companias = companias.filter(c => !x.excluir.map(Number).includes(c.id));
  if (!companias.length) return { error: "Ninguna compañía en el alcance." };
  const items = await previsualizar(odoo, x, { companias });
  const cambio = db.proponerCambio({ tipo: x.tipo, instruccion: { codigo: x.codigo, nombreActual: x.nombreActual, nuevoCodigo: x.nuevoCodigo, nuevoNombre: x.nuevoNombre,
    tipoCuenta: x.tipoCuenta || null, companias: x.companias || null, excluir: x.excluir || null }, motivo: String(x.motivo).slice(0, 500), items }, propuso);
  return { cambio: { id: cambio.id, tipo: cambio.tipo, resumen: resumen(items) },
    revisar: items.filter(i => ["revisar", "conflicto", "otro-significado"].includes(i.estado)).slice(0, 15).map(i => `${i.compania}: ${i.motivo}`),
    siguiente: "Queda en Aprobaciones → Cambios al plan de cuentas. Revise compañía por compañía, excluya las que no correspondan y apruebe; ejecutarlo en Odoo requiere PERMITIR_ESCRITURA_CUENTAS=si." };
}

// Ejecuta un cambio APROBADO: solo los ítems incluidos; relee y verifica cada uno.
export async function aplicar({ corridas, db, id, quien }) {
  const c = db.cambio(Number(id));
  if (!c) return { error: "No existe ese cambio.", codigo: 404 };
  if (c.estado !== "aprobada") return { error: `El cambio está ${c.estado}; solo se ejecuta uno aprobado.`, codigo: 409 };
  if (!escrituraCuentas(corridas.cfg)) return { error: "PERMITIR_ESCRITURA_CUENTAS no es 'si': el servicio no puede cambiar el plan de cuentas.", codigo: 403 };
  const odoo = corridas.crearCliente({ meta: { escribe: true } });
  const x = { ...c.instruccion, tipo: c.tipo };
  const items = c.items.map(i => ({ ...i }));
  let ok = 0, fallos = 0, omitidos = 0;
  for (const it of items) {
    if (!it.incluido || !["listo", "revisar"].includes(it.estado)) continue;
    const ctx = { context: { allowed_company_ids: [it.companiaId], lang: "es_ES" } };
    try {
      // revalidar justo antes de escribir: el plan pudo cambiar desde la previsualización
      const [ahora] = await previsualizar(odoo, x, { companias: [{ id: it.companiaId, name: it.compania }] });
      if (!["listo", "revisar"].includes(ahora.estado)) { Object.assign(it, { estado: "omitido", motivo: `Cambió desde la previsualización: ${ahora.motivo || ahora.estado}` }); omitidos++; continue; }
      let cuentaId = it.cuentaId;
      if (c.tipo === "renombrar") await odoo.escribir("account.account", "write", [[cuentaId], { name: x.nuevoNombre }], ctx);
      if (c.tipo === "recodificar") await odoo.escribir("account.account", "write", [[cuentaId], { code: x.nuevoCodigo }], ctx);
      if (c.tipo === "obsoleta") await odoo.escribir("account.account", "write", [[cuentaId], { deprecated: true }], ctx);
      if (c.tipo === "crear") {
        const r = await odoo.escribir("account.account", "create", [{ code: x.codigo, name: x.nuevoNombre, account_type: x.tipoCuenta, company_ids: [[6, 0, [it.companiaId]]] }], ctx);
        cuentaId = Array.isArray(r) ? r[0] : r;
      }
      const [leida] = await odoo.leer("account.account", "search_read", [[["id", "=", cuentaId]], ["code", "name", "deprecated"]], ctx);
      const bien = leida && (c.tipo === "renombrar" ? leida.name === x.nuevoNombre
        : c.tipo === "recodificar" ? canon(leida.code) === canon(x.nuevoCodigo)
        : c.tipo === "obsoleta" ? leida.deprecated === true
        : canon(leida.code) === canon(x.codigo) && leida.name === x.nuevoNombre);
      Object.assign(it, { cuentaId, estado: bien ? "aplicado" : "fallo", motivo: bien ? null : `Releído: ${leida ? `${leida.code} ${leida.name}` : "no aparece"}`, despues: leida ? { codigo: leida.code, nombre: leida.name, obsoleta: Boolean(leida.deprecated) } : null });
      bien ? ok++ : fallos++;
    } catch (e) { Object.assign(it, { estado: "fallo", motivo: e.message }); fallos++; }
  }
  const estado = ok && !fallos && !omitidos ? "aplicada" : ok ? "parcial" : "fallo";
  db.marcarCambio(c.id, estado, items);
  db.auditar(quien, "aplicar", "cambio", c.id, { tipo: c.tipo, aplicados: ok, fallos });
  return { ok: estado === "aplicada", aplicados: ok, fallos, omitidos, estado, mensaje: `${ok} compañías cambiadas${fallos ? `, ${fallos} con fallo` : ""}${omitidos ? `, ${omitidos} omitidas porque su plan cambió` : ""}.` };
}
