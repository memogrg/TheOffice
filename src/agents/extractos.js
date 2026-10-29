// AGENTE EXTRACTOS — lee Odoo, no escribe. Fase 3C (ítems 1, 7–10 y 13 de la matriz).
//
// Toma las líneas de los extractos bancarios que se subieron en la app y las empareja con los
// apuntes de la cuenta de cada banco en Odoo (mismo monto, ±7 días; la referencia desempata).
// Lo que no está en libros se clasifica:
//   · cargos bancarios (comisiones, timbres, IVA del banco…)  → asiento propuesto: gasto contra banco
//   · intereses ganados                                       → asiento propuesto: banco contra ingreso
//   · transferencias entre dos cuentas de la misma compañía   → asiento propuesto: banco contra banco
//   · cobros y pagos                                          → facturas abiertas con ese saldo (sugerencia)
// Y por cada banco: saldo del extracto contra saldo en libros, y lo que explica la diferencia.
//
// Los asientos van a Aprobaciones → Asientos (origen «extractos»), como los de Cierre o Diferidos.
// Cobros y pagos no se proponen como asiento: registrarlos es un pago contra la factura, y eso
// espera a la confirmación de TecnoDEM (puede emitir un recibo electrónico de pago).
import { createHash } from "node:crypto";
import { idDe, nombreDe, r2, ultimaFechaPorCompania, mesAEvaluar, rangoMes } from "../lib/contable.js";
import { sumarMeses } from "../lib/meses.js";
import { clasificarTexto, esTextoCargo, esTextoInteres, normal } from "../lib/extractos.js";

export const meta = {
  id: "extractos", nombre: "EXTRACTOS", puesto: "Empareja los extractos con los libros",
  modelo: "account.move.line", escribe: false
};
const DIAS = 7;
const dias = (a, b) => Math.round(Math.abs(new Date(a + "T00:00:00Z") - new Date(b + "T00:00:00Z")) / 86400000);
const sumarDias = (f, n) => new Date(new Date(f + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);
const colones = x => Number(x).toLocaleString("es-CR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const corto = ids => createHash("sha1").update(ids.slice().sort((a, b) => a - b).join(",")).digest("hex").slice(0, 8);
const palabras = t => new Set(normal(t).split(" ").filter(w => w.length > 3 && !/^\d+$/.test(w)));
const parecido = (a, b) => { const x = palabras(a), y = palabras(b); let n = 0; for (const w of x) if (y.has(w)) n++; return n; };

// El módulo de conciliación de TecnoDEM ya guarda los movimientos del banco que el contador subió
// (taerp.bank.line, uno por conciliación): se traen solos, sin pedir el CSV otra vez. Idempotente:
// una fila de extracto por conciliación y las líneas por huella. Débito = entrada, crédito = salida.
async function traerDeTecnoDEM({ odoo, db, cfg, log }) {
  if (String(cfg.EXTRACTOS_TECNODEM || "").toLowerCase() === "no") return null;
  const meses = Math.max(1, Number(cfg.EXTRACTOS_MESES) || 3);
  let recs;
  try {
    const mes = mesAEvaluar(cfg, cfg.EXTRACTOS_MES, await ultimaFechaPorCompania(odoo));
    const desde = rangoMes(sumarMeses(mes, 1 - meses))[0];
    recs = await odoo.leerTodo("taerp.bank.reconciliation", [["end_date", ">=", desde]], ["name", "state", "end_date", "account_id", "company_id", "currency_id", "bank_balance", "name_file"]);
  } catch (e) { log(`Sin módulo de conciliación de TecnoDEM (${e.message}): solo los extractos subidos a mano`); return null; }
  if (!recs.length) return { conciliaciones: 0, nuevas: 0 };
  const diarios = await odoo.leerTodo("account.journal", [["type", "=", "bank"]], ["name", "company_id", "default_account_id", "currency_id"]);
  const porCuenta = new Map(diarios.filter(d => idDe(d.default_account_id)).map(d => [`${idDe(d.company_id)}|${idDe(d.default_account_id)}`, d]));
  let nuevas = 0, sinDiario = 0, extractosNuevos = 0;
  const ids = recs.map(r => r.id);
  const lineas = [];
  for (let i = 0; i < ids.length; i += 200) lineas.push(...await odoo.leerTodo("taerp.bank.line", [["bank_reconcil_id", "in", ids.slice(i, i + 200)]], ["bank_reconcil_id", "name", "description", "date", "debit", "credit", "reconciliation"]));
  const porRec = new Map();
  for (const l of lineas) { const k = idDe(l.bank_reconcil_id); porRec.set(k, [...(porRec.get(k) || []), l]); }
  for (const r of recs) {
    const d = porCuenta.get(`${idDe(r.company_id)}|${idDe(r.account_id)}`);
    if (!d) { sinDiario++; continue; }
    const vistas = new Map();
    const movimientos = (porRec.get(r.id) || []).filter(l => l.date && /^\d{4}-\d{2}-\d{2}/.test(String(l.date))).map(l => {
      const monto = r2((Number(l.debit) || 0) - (Number(l.credit) || 0)), descripcion = String(l.description || l.name || "").replace(/\s+/g, " ").slice(0, 300), referencia = String(l.name || "").slice(0, 80);
      const base = `${String(l.date).slice(0, 10)}|${monto.toFixed(2)}|${normal(descripcion)}|${normal(referencia)}`;
      const n = (vistas.get(base) || 0) + 1; vistas.set(base, n);
      return { fecha: String(l.date).slice(0, 10), descripcion, referencia, monto, saldo: null, huella: createHash("sha1").update(`${base}|${n}`).digest("hex").slice(0, 20), externo: { tecnodem: l.id, conciliada: Boolean(l.reconciliation), conciliacion: r.name } };
    }).filter(m => m.monto !== 0).sort((a, b) => a.fecha.localeCompare(b.fecha));
    if (!movimientos.length) continue;
    const referencia = `tecnodem:${r.id}`;
    const existente = db.extractoPorReferencia(referencia);
    if (existente) { nuevas += db.agregarLineasExtracto(existente.id, movimientos, { hasta: r.end_date, saldoFinal: r.bank_balance ?? null }).nuevos; continue; }
    const x = db.registrarExtracto({ companiaId: idDe(r.company_id), compania: nombreDe(r.company_id), diarioId: d.id, diario: d.name, cuentaId: idDe(d.default_account_id), moneda: nombreDe(r.currency_id) || nombreDe(d.currency_id) || null,
      archivo: r.name_file || r.name, formato: "tecnodem", desde: movimientos[0].fecha, hasta: r.end_date, saldoInicial: null, saldoFinal: r.bank_balance ?? null, cuadra: null, referencia }, movimientos, "agente:extractos");
    nuevas += x.nuevos; extractosNuevos++;
  }
  log(`TecnoDEM: ${recs.length} conciliaciones desde hace ${meses} meses, ${extractosNuevos} extractos nuevos, ${nuevas} movimientos nuevos${sinDiario ? `, ${sinDiario} conciliaciones de cuentas que no son de un diario de banco` : ""}`);
  return { conciliaciones: recs.length, extractosNuevos, nuevas, sinDiario };
}

export async function ejecutar({ odoo, cfg, log, db }) {
  const t0 = Date.now();
  const vacio = (texto) => ({ agente: meta.nombre, titulo: "Extractos bancarios", corrida: new Date().toISOString(), segundos: 0, llamadasOdoo: 0,
    totales: { lineas: 0 }, bancos: [], cobros: [], pagos: [], transito: [], asientosSugeridos: [], cambios: [], alertas: [{ nivel: "info", texto, detalle: [] }] });
  if (!db) return vacio("El emparejamiento de extractos corre desde el servicio (necesita la base de la app).");
  await odoo.conectar();
  const tecnodem = await traerDeTecnoDEM({ odoo, db, cfg, log });
  const lineas = db.lineasExtracto({ estados: ["pendiente", "en-libros", "propuesta", "registrada"], limite: 50000 });
  if (!lineas.length) return vacio("Todavía no hay extractos: ni en el módulo de conciliación de TecnoDEM ni subidos en la pestaña Extractos (CSV, TXT o Excel del banco).");

  const idsDiario = [...new Set(lineas.map(l => l.diario_id))];
  const diarios = await odoo.leer("account.journal", "search_read", [[["id", "in", idsDiario]], ["name", "company_id", "default_account_id", "currency_id"]], {});
  const idsCia = [...new Set(diarios.map(d => idDe(d.company_id)))];
  const cias = await odoo.leer("res.company", "search_read", [[["id", "in", idsCia]], ["name", "currency_id"]], {});
  const extractos = db.extractos({ estado: "activo" });
  const estadoAsiento = db.estadoAsientosPorClave("extractos");
  log(`${lineas.length} líneas de extracto en ${diarios.length} cuentas de banco`);

  // --- 1. Emparejar con los apuntes de la cuenta del banco
  const porDiario = new Map();
  for (const d of diarios) {
    const cia = cias.find(c => c.id === idDe(d.company_id));
    const enMoneda = Boolean(idDe(d.currency_id)) && idDe(d.currency_id) !== idDe(cia?.currency_id);
    const mias = lineas.filter(l => l.diario_id === d.id);
    const desde = mias[0].fecha, hasta = mias[mias.length - 1].fecha;
    const cuentaId = idDe(d.default_account_id);
    const apuntes = cuentaId ? await odoo.leerTodo("account.move.line", [["account_id", "=", cuentaId], ["date", ">=", sumarDias(desde, -DIAS - 3)], ["date", "<=", sumarDias(hasta, DIAS + 3)],
      ["parent_state", "in", ["posted", "draft"]]], ["date", "name", "ref", "balance", "amount_currency", "move_id", "partner_id", "parent_state"]) : [];
    const valor = a => r2(enMoneda ? a.amount_currency : a.balance);
    const pares = [];
    for (const l of mias) for (const a of apuntes) {
      if (Math.abs(valor(a) - l.monto) > 0.005) continue;
      const dd = dias(l.fecha, a.date);
      if (dd > DIAS) continue;
      const ref = l.referencia && `${a.name || ""} ${a.ref || ""} ${nombreDe(a.move_id) || ""}`.includes(l.referencia) ? 1 : 0;
      pares.push({ l, a, dd, puntos: ref * 10 + parecido(l.descripcion, `${a.name || ""} ${a.ref || ""} ${nombreDe(a.partner_id) || ""}`) });
    }
    pares.sort((x, y) => (y.puntos - x.puntos) || (x.dd - y.dd) || (x.a.id - y.a.id));
    const usadosL = new Map(), usadosA = new Set();
    for (const p of pares) if (!usadosL.has(p.l.id) && !usadosA.has(p.a.id)) { usadosL.set(p.l.id, p); usadosA.add(p.a.id); }
    // registrado en libros dentro del periodo del extracto y que el banco no muestra (partidas en tránsito)
    const transito = apuntes.filter(a => !usadosA.has(a.id) && a.date >= desde && a.date <= hasta && a.parent_state === "posted")
      .map(a => ({ fecha: a.date, asiento: nombreDe(a.move_id), detalle: a.name || a.ref || "", tercero: nombreDe(a.partner_id) || null, monto: valor(a) }));
    porDiario.set(d.id, { d, cia, enMoneda, cuentaId, mias, usadosL, transito, desde, hasta });
  }

  // --- 2. Cuentas aprendidas por compañía: gasto de cargos bancarios e ingreso por intereses
  const aprendidas = new Map();
  for (const ciaId of idsCia) {
    const deCia = diarios.filter(d => idDe(d.company_id) === ciaId).map(d => d.id);
    const desdeHist = sumarDias(lineas.reduce((m, l) => (l.fecha < m ? l.fecha : m), lineas[0].fecha), -400);   // el último año, más o menos
    let gastos = [], ingresos = [];
    try {
      gastos = await odoo.leerTodo("account.move.line", [["journal_id", "in", deCia], ["parent_state", "=", "posted"], ["date", ">=", desdeHist], ["account_id.account_type", "=", "expense"]], ["account_id", "name"]);
      ingresos = await odoo.leerTodo("account.move.line", [["journal_id", "in", deCia], ["parent_state", "=", "posted"], ["date", ">=", desdeHist], ["account_id.account_type", "in", ["income", "income_other"]]], ["account_id", "name"]);
    } catch (e) { log(`No se pudo aprender las cuentas de ${ciaId}: ${e.message}`); }
    const masUsada = (xs, prueba) => {
      const c = new Map();
      for (const x of xs) if (prueba(x.name || "")) { const k = idDe(x.account_id); c.set(k, { id: k, nombre: nombreDe(x.account_id), n: (c.get(k)?.n || 0) + 1 }); }
      return [...c.values()].sort((a, b) => b.n - a.n)[0] || null;
    };
    aprendidas.set(ciaId, { gasto: masUsada(gastos, esTextoCargo), ingreso: masUsada(ingresos, esTextoInteres) });
  }

  // --- 3. Lo que no está en libros: transferencias propias, cargos, intereses, cobros y pagos
  const cambios = [], asientosSugeridos = [], sueltas = [];
  for (const x of porDiario.values()) for (const l of x.mias) {
    const p = x.usadosL.get(l.id);
    if (p) { cambios.push({ id: l.id, estado: "en-libros", tipo: l.monto > 0 ? "entrada" : "salida", emparejado: { asiento: nombreDe(p.a.move_id), fecha: p.a.date, dias: p.dd, borrador: p.a.parent_state === "draft" } }); continue; }
    // ya en un asiento aprobado o creado: se respeta
    const prev = l.asiento_clave && estadoAsiento.get(l.asiento_clave);
    if (prev && ["aprobada", "aplicada", "fallo"].includes(prev.estado)) {
      cambios.push({ id: l.id, estado: prev.estado === "aplicada" ? "registrada" : "propuesta", tipo: l.tipo, emparejado: { ...(l.emparejado || {}), asiento: prev.asiento || null }, asientoClave: l.asiento_clave });
      continue;
    }
    sueltas.push({ l, x, tipo: clasificarTexto(l.descripcion, l.monto) });
  }

  // transferencias: salida en un banco y entrada por el mismo monto en otro de la misma compañía
  const usadas = new Set();
  const salidas = sueltas.filter(s => s.l.monto < 0 && !s.x.enMoneda), entradas = sueltas.filter(s => s.l.monto > 0 && !s.x.enMoneda);
  for (const s of salidas) {
    const e = entradas.filter(e => !usadas.has(e.l.id) && e.x.d.id !== s.x.d.id && idDe(e.x.d.company_id) === idDe(s.x.d.company_id) && Math.abs(e.l.monto + s.l.monto) < 0.005
      && dias(e.l.fecha, s.l.fecha) <= 3 && (s.tipo === "transferencia" || e.tipo === "transferencia" || e.l.fecha === s.l.fecha))
      .sort((a, b) => dias(a.l.fecha, s.l.fecha) - dias(b.l.fecha, s.l.fecha))[0];
    if (!e || usadas.has(s.l.id)) continue;
    usadas.add(s.l.id); usadas.add(e.l.id);
    const monto = Math.abs(s.l.monto), clave = `extracto|transferencia|${s.l.id}|${e.l.id}`;
    const cia = idDe(s.x.d.company_id);
    asientosSugeridos.push({ clave, origen: "extractos", mes: s.l.fecha.slice(0, 7), companiaId: cia, compania: nombreDe(s.x.d.company_id), fecha: s.l.fecha,
      diarioId: s.x.d.id, diario: s.x.d.name, referencia: `Transferencia entre cuentas propias ${s.l.fecha}`,
      motivo: `Sale de ${s.x.d.name} y entra en ${e.x.d.name} (${e.l.fecha}) por ₡${colones(monto)}; no está registrada en ninguna de las dos.`,
      lineas: [
        { cuentaId: e.x.cuentaId, cuenta: nombreDe(e.x.d.default_account_id), descripcion: `Transferencia desde ${s.x.d.name}: ${e.l.descripcion}`.slice(0, 200), debito: monto, credito: 0, rol: "banco-destino", extractoLineas: [e.l.id] },
        { cuentaId: s.x.cuentaId, cuenta: nombreDe(s.x.d.default_account_id), descripcion: `Transferencia a ${e.x.d.name}: ${s.l.descripcion}`.slice(0, 200), debito: 0, credito: monto, rol: "banco-origen", extractoLineas: [s.l.id] }] });
    for (const [a, b] of [[s, e], [e, s]]) cambios.push({ id: a.l.id, estado: estadoAsiento.get(clave)?.estado === "rechazada" ? "pendiente" : "propuesta", tipo: "transferencia",
      emparejado: { otraCuenta: b.x.d.name, otraLinea: b.l.id, fecha: b.l.fecha }, asientoClave: clave });
  }

  // cargos e intereses: un asiento por banco y mes
  const grupos = new Map();
  for (const s of sueltas) {
    if (usadas.has(s.l.id) || s.x.enMoneda || !["cargo", "interes"].includes(s.tipo)) continue;
    const k = `${s.tipo}|${s.x.d.id}|${s.l.fecha.slice(0, 7)}`;
    grupos.set(k, [...(grupos.get(k) || []), s]);
  }
  for (const [k, g] of grupos) {
    const [tipo, , mes] = k.split("|"), x = g[0].x, ciaId = idDe(x.d.company_id), ap = aprendidas.get(ciaId) || {};
    const ids = g.map(s => s.l.id), total = r2(g.reduce((t, s) => t + Math.abs(s.l.monto), 0));
    const clave = `extracto|${tipo === "cargo" ? "cargos" : "intereses"}|${x.d.id}|${mes}|${corto(ids)}`;
    const cuenta = tipo === "cargo" ? ap.gasto : ap.ingreso;
    const contra = { cuentaId: cuenta?.id ?? null, cuenta: cuenta ? cuenta.nombre : `(por definir: ${tipo === "cargo" ? "gasto bancario" : "ingreso por intereses"})`,
      descripcion: `${tipo === "cargo" ? "Cargos bancarios" : "Intereses"} ${x.d.name} ${mes} (${g.length})`, rol: tipo === "cargo" ? "contrapartida-gasto" : "contrapartida-ingreso",
      fuente: cuenta ? `la más usada para ${tipo === "cargo" ? "cargos" : "intereses"} en este banco (${cuenta.n} veces)` : null, extractoLineas: ids };
    const banco = { cuentaId: x.cuentaId, cuenta: nombreDe(x.d.default_account_id), descripcion: contra.descripcion, rol: "banco", extractoLineas: ids };
    const fecha = g.map(s => s.l.fecha).sort().pop();
    asientosSugeridos.push({ clave, origen: "extractos", mes, companiaId: ciaId, compania: nombreDe(x.d.company_id), fecha, diarioId: x.d.id, diario: x.d.name,
      referencia: `${tipo === "cargo" ? "Cargos bancarios" : "Intereses ganados"} ${x.d.name} ${mes}`,
      motivo: `${g.length === 1 ? "1 movimiento del extracto que no está" : `${g.length} movimientos del extracto que no están`} en libros, por ₡${colones(total)}: ${g.slice(0, 4).map(s => `${s.l.fecha} ${s.l.descripcion} ₡${colones(Math.abs(s.l.monto))}`).join(" · ")}${g.length > 4 ? " …" : ""}`,
      aviso: cuenta ? null : `Falta la cuenta de ${tipo === "cargo" ? "gasto" : "ingreso"}: escriba su código en la línea antes de aprobar.`,
      lineas: tipo === "cargo" ? [{ ...contra, debito: total, credito: 0 }, { ...banco, debito: 0, credito: total }] : [{ ...banco, debito: total, credito: 0 }, { ...contra, debito: 0, credito: total }] });
    for (const s of g) { usadas.add(s.l.id); cambios.push({ id: s.l.id, estado: estadoAsiento.get(clave)?.estado === "rechazada" ? "pendiente" : "propuesta", tipo, asientoClave: clave, emparejado: null }); }
  }

  // cobros y pagos: facturas abiertas de la compañía con ese saldo exacto
  const resto = sueltas.filter(s => !usadas.has(s.l.id));
  let abiertas = [];
  if (resto.length) {
    abiertas = await odoo.leerTodo("account.move", [["company_id", "in", idsCia], ["move_type", "in", ["out_invoice", "in_invoice"]], ["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]]],
      ["name", "partner_id", "amount_residual", "amount_residual_signed", "currency_id", "invoice_date_due", "move_type", "company_id"]);
  }
  const cobros = [], pagos = [];
  for (const s of resto) {
    const tipoDoc = s.l.monto > 0 ? "out_invoice" : "in_invoice", monto = Math.abs(s.l.monto), ciaId = idDe(s.x.d.company_id);
    const moneda = s.x.enMoneda ? idDe(s.x.d.currency_id) : idDe(s.x.cia?.currency_id);
    const cand = abiertas.filter(f => idDe(f.company_id) === ciaId && f.move_type === tipoDoc && idDe(f.currency_id) === moneda && Math.abs(Number(f.amount_residual) - monto) < 0.005)
      .map(f => ({ factura: f.name, tercero: nombreDe(f.partner_id), vence: f.invoice_date_due || null, puntos: parecido(s.l.descripcion, nombreDe(f.partner_id)) }))
      .sort((a, b) => b.puntos - a.puntos).slice(0, 3);
    const tipo = cand.length ? (s.l.monto > 0 ? "cobro" : "pago") : s.tipo;
    cambios.push({ id: s.l.id, estado: "pendiente", tipo, emparejado: cand.length ? { candidatos: cand.map(({ puntos, ...c }) => c) } : null });
    const fila = { compania: nombreDe(s.x.d.company_id), companiaId: ciaId, banco: s.x.d.name, fecha: s.l.fecha, descripcion: s.l.descripcion, monto: s.l.monto, candidatos: cand.map(({ puntos, ...c }) => c) };
    if (s.l.monto > 0) cobros.push(fila); else pagos.push(fila);
  }

  // --- 4. Por banco: cuántas líneas en cada estado y el saldo del extracto contra libros
  const estadoDe = new Map(cambios.map(c => [c.id, c]));
  const bancos = [];
  for (const x of porDiario.values()) {
    const ls = x.mias.map(l => ({ ...l, ...estadoDe.get(l.id) }));
    const cuenta = e => ls.filter(l => l.estado === e).length;
    const ult = extractos.filter(e => e.diario_id === x.d.id && e.saldo_final != null).sort((a, b) => String(b.hasta).localeCompare(String(a.hasta)) || b.id - a.id)[0];
    let saldoLibros = null;
    if (ult && x.cuentaId) {
      const g = await odoo.leer("account.move.line", "read_group", [[["account_id", "=", x.cuentaId], ["parent_state", "=", "posted"], ["date", "<=", ult.hasta]], ["balance:sum", "amount_currency:sum"], ["account_id"]], { lazy: false });
      saldoLibros = g.length ? r2(x.enMoneda ? g[0].amount_currency : g[0].balance) : 0;
    }
    const sinLibros = r2(ls.filter(l => l.estado !== "en-libros" && l.estado !== "registrada" && (!ult || l.fecha <= ult.hasta)).reduce((t, l) => t + l.monto, 0));
    const enTransito = r2(x.transito.filter(a => !ult || a.fecha <= ult.hasta).reduce((t, a) => t + a.monto, 0));
    const diferencia = ult && saldoLibros != null ? r2(ult.saldo_final - saldoLibros) : null;
    bancos.push({ compania: nombreDe(x.d.company_id), companiaId: idDe(x.d.company_id), diarioId: x.d.id, banco: x.d.name, moneda: x.enMoneda ? nombreDe(x.d.currency_id) : nombreDe(x.cia?.currency_id),
      desde: x.desde, hasta: x.hasta, lineas: ls.length, enLibros: cuenta("en-libros"), propuestas: cuenta("propuesta"), registradas: cuenta("registrada"), pendientes: cuenta("pendiente"),
      saldoExtracto: ult ? ult.saldo_final : null, alDia: ult ? ult.hasta : null, saldoLibros, diferencia, sinLibros, enTransito,
      sinExplicar: diferencia == null ? null : r2(diferencia - sinLibros + enTransito), transito: x.transito.slice(0, 50) });
  }
  bancos.sort((a, b) => a.compania.localeCompare(b.compania) || a.banco.localeCompare(b.banco));

  const totales = { bancos: bancos.length, lineas: lineas.length, enLibros: bancos.reduce((t, b) => t + b.enLibros, 0), propuestas: cambios.filter(c => c.estado === "propuesta").length,
    registradas: bancos.reduce((t, b) => t + b.registradas, 0), pendientes: bancos.reduce((t, b) => t + b.pendientes, 0), cobrosConFactura: cobros.filter(c => c.candidatos.length).length,
    pagosConFactura: pagos.filter(p => p.candidatos.length).length, enTransito: bancos.reduce((t, b) => t + b.transito.length, 0), asientosSugeridos: asientosSugeridos.length };
  const alertas = [];
  if (tecnodem && tecnodem.conciliaciones) alertas.push({ nivel: "info", texto: `Del módulo de conciliación de TecnoDEM: ${tecnodem.conciliaciones} conciliaciones recientes, ${tecnodem.nuevas} movimientos nuevos en esta corrida.`, detalle: tecnodem.sinDiario ? [`${tecnodem.sinDiario} conciliaciones son de cuentas que no corresponden a un diario de banco: no se trajeron.`] : [] });
  if (asientosSugeridos.length) alertas.push({ nivel: "info", texto: `${asientosSugeridos.length} asientos propuestos desde los extractos (cargos bancarios, intereses y transferencias propias) en Aprobaciones → Asientos.`,
    detalle: asientosSugeridos.slice(0, 8).map(a => `${a.compania}: ${a.referencia}`) });
  const sinCuenta = asientosSugeridos.filter(a => a.aviso);
  if (sinCuenta.length) alertas.push({ nivel: "alto", texto: `${sinCuenta.length} de esos asientos no tienen la cuenta de gasto o ingreso: no hay historial en ese banco. Escriba el código antes de aprobar.`, detalle: sinCuenta.slice(0, 6).map(a => `${a.compania}: ${a.referencia}`) });
  const conFactura = [...cobros, ...pagos].filter(c => c.candidatos.length);
  if (conFactura.length) alertas.push({ nivel: "info", texto: `${conFactura.length} cobros o pagos del banco coinciden con el saldo de una factura abierta: falta registrar el pago en Odoo.`,
    detalle: conFactura.slice(0, 8).map(c => `${c.compania} — ${c.fecha} ₡${colones(Math.abs(c.monto))}: ${c.candidatos[0].factura} (${c.candidatos[0].tercero})`) });
  const sinId = [...cobros, ...pagos].filter(c => !c.candidatos.length);
  if (sinId.length) alertas.push({ nivel: "alto", texto: `${sinId.length} movimientos del banco sin registrar y sin factura que calce: hay que identificarlos.`,
    detalle: sinId.slice(0, 8).map(c => `${c.compania} — ${c.banco} ${c.fecha}: ${c.descripcion} ₡${colones(c.monto)}`) });
  const descuadres = bancos.filter(b => b.sinExplicar != null && Math.abs(b.sinExplicar) > 0.01);
  if (descuadres.length) alertas.push({ nivel: "alto", texto: `${descuadres.length} bancos con una diferencia entre el extracto y los libros que no explican los movimientos pendientes: puede faltar un extracto anterior o haber un error en libros.`,
    detalle: descuadres.slice(0, 8).map(b => `${b.compania} — ${b.banco} al ${b.alDia}: extracto ₡${colones(b.saldoExtracto)}, libros ₡${colones(b.saldoLibros)}, sin explicar ₡${colones(b.sinExplicar)}`) });
  if (totales.enTransito) alertas.push({ nivel: "info", texto: `${totales.enTransito} apuntes en libros que el banco no muestra (cheques o depósitos en tránsito, o registros de más).`,
    detalle: bancos.filter(b => b.transito.length).slice(0, 6).map(b => `${b.compania} — ${b.banco}: ${b.transito.length} por ₡${colones(b.enTransito)}`) });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: "Todo lo del extracto está en libros y los saldos cuadran.", detalle: [] });

  return {
    agente: meta.nombre, titulo: "Extractos bancarios contra libros", corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    totales: { ...totales, tecnodem: tecnodem ? tecnodem.nuevas : null }, bancos, cobros: cobros.slice(0, 300), pagos: pagos.slice(0, 300), asientosSugeridos, cambios, alertas
  };
}
