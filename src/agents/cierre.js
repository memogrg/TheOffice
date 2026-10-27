// AGENTE CIERRE — solo lectura. Fase 3A (ítems 11, 12, 18 y 19 de la matriz).
// Dos revisiones de cierre de mes, en todas las compañías:
//  1. Cuentas puente (salarios, CCSS, IVA, retenciones, renta, transitorias): cuánto de su saldo es
//     más viejo que el plazo en que se tenía que liquidar. Si los salarios de enero siguen ahí en
//     febrero, no se registró el pago (o se registró contra otra cuenta).
//  2. Cuadre de IVA del mes: débito (ventas) y crédito (compras) según los documentos, el neto a
//     pagar o a favor, el IVA cargado a cuentas que no son de IVA, el que quedó en borradores, y
//     —si TecnoDEM generó el Reporte IVA del mes— la diferencia contra ese reporte.
//
// Configuración: CIERRE_MES (AAAA-MM; por omisión el último mes cerrado), CIERRE_VENTANA (6),
// CIERRE_TOLERANCIA (colones, 1000). Las cuentas puente: data/referencia/cuentas-puente.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sumarMeses } from "../lib/meses.js";
import { idDe, nombreDe, r2, rangoMes, mesesHasta, lado, sumarPorCuenta, ultimaFechaPorCompania, mesAEvaluar, leerCuentas, colones } from "../lib/contable.js";

export const meta = {
  id: "cierre", nombre: "CIERRE", puesto: "Revisa cuentas puente e IVA del mes",
  modelo: "account.move.line", escribe: false
};

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export function cargarPuentes(archivo = path.join(RAIZ, "data/referencia/cuentas-puente.json")) {
  const j = JSON.parse(fs.readFileSync(archivo, "utf8"));
  return j.puentes.map(p => ({ ...p, re: new RegExp(p.patron, "i") }));
}
export const sinTildes = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export function tipoDePuente(nombre, tipoCuenta, puentes) {
  const n = sinTildes(nombre);
  return puentes.find(p => p.tipos.includes(tipoCuenta) && p.re.test(n)) || null;
}

// Dónde puede caer el IVA de un documento sin que sea un error.
const PERMITIDAS = {
  sale: new Set(["liability_current", "asset_current"]),
  purchase: new Set(["asset_current", "liability_current", "expense", "expense_direct_cost"])   // al gasto = IVA no acreditable
};

// Arrastre de una cuenta puente en un mes: lo que queda del saldo después de descontar lo que entró
// en el plazo. pendiente = saldo del lado natural; entradas = movimiento del lado natural en el plazo.
export function arrastre({ pendiente, entradas, periodicidad, tolerancia }) {
  const tol = Math.max(tolerancia, Math.abs(entradas) * 0.005);
  if (periodicidad === 0) return { arrastre: r2(pendiente), estado: Math.abs(pendiente) > tol ? "con-saldo" : "ok" };
  const a = pendiente - entradas;
  if (pendiente < -tol) return { arrastre: r2(a), estado: "al-reves" };
  return { arrastre: r2(Math.max(0, a)), estado: a > tol ? "arrastra" : "ok" };
}

export async function ejecutar({ odoo, cfg, log }) {
  const t0 = Date.now();
  await odoo.conectar();
  const ventana = Number(cfg.CIERRE_VENTANA || 6), tolerancia = Number(cfg.CIERRE_TOLERANCIA || 1000);
  const puentes = cargarPuentes(cfg.CIERRE_PUENTES || undefined);
  const maxPlazo = Math.max(1, ...puentes.map(p => p.periodicidad));

  const ultimas = await ultimaFechaPorCompania(odoo);
  const mes = mesAEvaluar(cfg, cfg.CIERRE_MES, ultimas);
  const meses = mesesHasta(mes, ventana + maxPlazo - 1);          // lo que hace falta para medir el plazo más largo
  const serieMeses = meses.slice(-ventana);
  log(`Mes evaluado ${mes}; ventana ${serieMeses[0]} a ${mes}`);

  // 1. Qué cuentas son puente: por nombre, y las que reciben IVA de los documentos.
  const ivaG = await odoo.leer("account.move.line", "read_group",
    [[["parent_state", "=", "posted"], ["tax_line_id", "!=", false]], ["balance:sum"], ["company_id", "tax_line_id", "account_id"]], { lazy: false });
  const impuestos = new Map();
  const idsImp = [...new Set(ivaG.map(x => idDe(x.tax_line_id)).filter(Boolean))];
  if (idsImp.length) for (const t of await odoo.leer("account.tax", "search_read", [[["id", "in", idsImp]], ["name", "type_tax_use"]], { context: { active_test: false } }))
    impuestos.set(t.id, { nombre: t.name, uso: t.type_tax_use });
  // las cuentas de los tipos en que puede haber un puente (unas pocas miles en toda la instancia)
  const tipos = [...new Set(puentes.flatMap(p => p.tipos))];
  const porNombre = await odoo.leerTodo("account.account", [["account_type", "in", tipos]], ["name", "account_type"]);
  const cuentasInfo = await leerCuentas(odoo, ivaG.map(x => idDe(x.account_id)));
  for (const c of porNombre) cuentasInfo.set(c.id, { nombre: String(c.name ?? ""), tipo: c.account_type });

  const candidatas = new Map();   // "cia|cuenta" o "*|cuenta" → puente
  for (const [id, c] of cuentasInfo) {
    const p = tipoDePuente(c.nombre, c.tipo, puentes);
    if (p) candidatas.set(`*|${id}`, p);
  }
  for (const x of ivaG) {
    const cta = idDe(x.account_id), cia = idDe(x.company_id), imp = impuestos.get(idDe(x.tax_line_id)), c = cuentasInfo.get(cta);
    if (!c || !imp || candidatas.has(`*|${cta}`)) continue;
    if (/^liability/.test(c.tipo)) candidatas.set(`${cia}|${cta}`, puentes.find(p => p.id === "iva"));
    else if (c.tipo === "asset_current") candidatas.set(`${cia}|${cta}`, imp.uso === "sale" ? puentes.find(p => p.id === "iva") : puentes.find(p => p.id === "iva-credito"));
  }
  const idsCand = [...new Set([...candidatas.keys()].map(k => Number(k.split("|")[1])))];
  log(`${idsCand.length} cuentas puente candidatas`);

  // 2. Saldos: inicial antes de la ventana y movimiento de cada mes.
  const filtro = [["account_id", "in", idsCand]];
  const inicial = idsCand.length ? await sumarPorCuenta(odoo, [...filtro, ["date", "<", rangoMes(meses[0])[0]]], { campos: ["balance:sum"] }) : new Map();
  const porMes = new Map();
  for (const m of meses) {
    const [d, h] = rangoMes(m);
    porMes.set(m, idsCand.length ? await sumarPorCuenta(odoo, [...filtro, ["date", ">=", d], ["date", "<", h]]) : new Map());
  }
  // compañías sin ningún asiento en el mes evaluado: no se juzgan sus cuentas, se avisa aparte
  const [dM, hM] = rangoMes(mes);
  const actividad = await odoo.leer("account.move.line", "read_group",
    [[["parent_state", "=", "posted"], ["date", ">=", dM], ["date", "<", hM]], ["balance:sum"], ["company_id"]], { lazy: false });
  const activas = new Set(actividad.filter(x => x.__count > 0).map(x => idDe(x.company_id)));

  const llaves = new Set([...inicial.keys()]);
  for (const mp of porMes.values()) for (const k of mp.keys()) llaves.add(k);
  const cuentas = [];
  for (const k of llaves) {
    const [cia, cta] = k.split("|").map(Number);
    const p = candidatas.get(`*|${cta}`) || candidatas.get(k);
    if (!p) continue;
    const info = cuentasInfo.get(cta), s = lado(info.tipo);
    let saldo = inicial.get(k)?.balance || 0;
    const compania = inicial.get(k)?.compania || [...porMes.values()].map(mp => mp.get(k)?.compania).find(Boolean) || String(cia);
    const entradasDe = m => { const x = porMes.get(m).get(k); return x ? (s > 0 ? x.debit : x.credit) : 0; };
    const serie = [];
    for (let i = 0; i < meses.length; i++) {
      const m = meses[i];
      saldo += porMes.get(m).get(k)?.balance || 0;
      if (!serieMeses.includes(m)) continue;
      const plazo = p.periodicidad === 0 ? [] : meses.slice(Math.max(0, i - p.periodicidad + 1), i + 1);
      const entradas = plazo.reduce((t, mm) => t + entradasDe(mm), 0);
      serie.push({ mes: m, pendiente: r2(s * saldo), entradas: r2(entradas), ...arrastre({ pendiente: s * saldo, entradas, periodicidad: p.periodicidad, tolerancia }) });
    }
    const ult = serie[serie.length - 1];
    if (Math.abs(ult.pendiente) < 1 && serie.every(x => Math.abs(x.pendiente) < 1)) continue;   // cuenta muerta
    let seguidos = 0;
    for (let i = serie.length - 1; i >= 0 && serie[i].estado !== "ok"; i--) seguidos++;
    const sinRegistro = !activas.has(cia);
    cuentas.push({
      compania, companiaId: cia, cuenta: info.nombre, cuentaId: cta, tipoCuenta: info.tipo, puente: p.id, titulo: p.titulo,
      periodicidad: p.periodicidad, saldoAFavor: Boolean(p.saldoAFavor),
      saldo: ult.pendiente, entradasMes: r2(entradasDe(mes)), arrastre: ult.arrastre, mesesSeguidos: seguidos,
      estado: sinRegistro && ult.estado !== "ok" ? "sin-registro" : ult.estado, serie
    });
  }
  const pesoEstado = { "al-reves": 0, arrastra: 1, "con-saldo": 2, "sin-registro": 3, ok: 4 };
  cuentas.sort((a, b) => (pesoEstado[a.estado] - pesoEstado[b.estado]) || (Math.abs(b.arrastre) - Math.abs(a.arrastre)));

  // 2b. Asientos sugeridos (fase 3B): para lo que arrastra, el asiento que lo liquida, con la
  // contrapartida que esa misma cuenta usó en sus pagos anteriores. Solo se proponen; un contable
  // los revisa, los aprueba y recién entonces se pueden crear en Odoo.
  let asientosSugeridos = [], errorAsientos = null;
  try { asientosSugeridos = await sugerirAsientos({ odoo, cuentas, mes, cuentasInfo, log }); }
  catch (e) { errorAsientos = e.message; log(`Sin asientos sugeridos: ${e.message}`); }

  // 3. Cuadre de IVA por compañía y mes (documentos publicados).
  const ivaMeses = new Map();
  const malUbicado = new Map();
  for (const m of serieMeses) {
    const [d, h] = rangoMes(m);
    const g = await odoo.leer("account.move.line", "read_group",
      [[["parent_state", "=", "posted"], ["tax_line_id", "!=", false], ["date", ">=", d], ["date", "<", h]], ["balance:sum"], ["company_id", "tax_line_id", "account_id"]], { lazy: false });
    for (const x of g) {
      const cia = idDe(x.company_id), imp = impuestos.get(idDe(x.tax_line_id)), cta = idDe(x.account_id);
      if (!cia || !imp) continue;
      const c = cuentasInfo.get(cta) || { nombre: nombreDe(x.account_id), tipo: "?" };
      const k = `${cia}|${m}`;
      const v = ivaMeses.get(k) || { companiaId: cia, compania: nombreDe(x.company_id), mes: m, debito: 0, credito: 0, noAcreditable: 0, malUbicado: 0 };
      const bal = Number(x.balance) || 0;
      if (imp.uso === "sale") v.debito += -bal;
      else if (imp.uso === "purchase") { if (/^expense/.test(c.tipo)) v.noAcreditable += bal; else v.credito += bal; }
      if (PERMITIDAS[imp.uso] && !PERMITIDAS[imp.uso].has(c.tipo)) {
        v.malUbicado += Math.abs(bal);
        const km = `${cia}|${idDe(x.tax_line_id)}|${cta}`;
        const e = malUbicado.get(km) || { compania: nombreDe(x.company_id), companiaId: cia, impuesto: imp.nombre, uso: imp.uso === "sale" ? "ventas" : "compras",
          cuenta: c.nombre, tipoCuenta: c.tipo, lineas: 0, monto: 0, meses: [] };
        e.lineas += x.__count || 0; e.monto = r2(e.monto + bal); if (!e.meses.includes(m)) e.meses.push(m);
        malUbicado.set(km, e);
      }
      ivaMeses.set(k, v);
    }
  }
  // borradores del mes evaluado con impuesto (no entran en el IVA del mes hasta que se publiquen)
  const borr = new Map();
  try {
    const g = await odoo.leer("account.move", "read_group",
      [[["state", "=", "draft"], ["move_type", "in", ["in_invoice", "in_refund", "out_invoice", "out_refund"]], ["invoice_date", ">=", dM], ["invoice_date", "<", hM]],
        ["amount_tax:sum"], ["company_id", "move_type"]], { lazy: false });
    for (const x of g) {
      const cia = idDe(x.company_id); if (!cia) continue;
      const b = borr.get(cia) || { compras: 0, ivaCompras: 0, ventas: 0, ivaVentas: 0 };
      const signo = /refund/.test(x.move_type) ? -1 : 1;
      if (/^in_/.test(x.move_type)) { b.compras += x.__count; b.ivaCompras += signo * (Number(x.amount_tax) || 0); }
      else { b.ventas += x.__count; b.ivaVentas += signo * (Number(x.amount_tax) || 0); }
      borr.set(cia, b);
    }
  } catch (e) { log(`Sin medir borradores: ${e.message}`); }
  // Reporte IVA de TecnoDEM, si existe para el mes
  const declarado = new Map();
  try {
    const reps = await odoo.leerTodo("tecnodem_iva_reporter.vat_report", [["init_date", ">=", dM], ["init_date", "<", hM]],
      ["company_id", "init_date", "end_date", "state", "total_vat_sale", "total_vat_purchase"]);
    for (const r of reps) declarado.set(idDe(r.company_id), { debito: Number(r.total_vat_sale) || 0, credito: Number(r.total_vat_purchase) || 0, estado: r.state });
  } catch { /* módulo no instalado */ }

  const iva = [];
  const ciasIva = new Set([...ivaMeses.values()].map(v => v.companiaId));
  for (const cia of ciasIva) {
    const serie = serieMeses.map(m => {
      const v = ivaMeses.get(`${cia}|${m}`) || { debito: 0, credito: 0, noAcreditable: 0 };
      return { mes: m, debito: r2(v.debito), credito: r2(v.credito), neto: r2(v.debito - v.credito) };
    });
    const v = ivaMeses.get(`${cia}|${mes}`) || { compania: [...ivaMeses.values()].find(x => x.companiaId === cia).compania, debito: 0, credito: 0, noAcreditable: 0, malUbicado: 0 };
    const b = borr.get(cia) || null, dec = declarado.get(cia) || null;
    if (!v.debito && !v.credito && !v.noAcreditable && !b && !dec) continue;   // sin IVA en el mes evaluado
    iva.push({
      compania: v.compania || [...ivaMeses.values()].find(x => x.companiaId === cia).compania, companiaId: cia, mes,
      debito: r2(v.debito), credito: r2(v.credito), noAcreditable: r2(v.noAcreditable), neto: r2(v.debito - v.credito),
      resultado: v.debito - v.credito >= 0 ? "a pagar" : "a favor", malUbicado: r2(v.malUbicado),
      borradores: b ? { compras: b.compras, ivaCompras: r2(b.ivaCompras), ventas: b.ventas, ivaVentas: r2(b.ivaVentas) } : null,
      declarado: dec ? { ...dec, difDebito: r2(v.debito - dec.debito), difCredito: r2(v.credito - dec.credito) } : null,
      serie
    });
  }
  iva.sort((a, b) => Math.abs(b.neto) - Math.abs(a.neto));
  const mal = [...malUbicado.values()].sort((a, b) => Math.abs(b.monto) - Math.abs(a.monto));

  const sinRegistro = [...ultimas.entries()].filter(([id]) => !activas.has(id)).map(([id, u]) => ({ companiaId: id, compania: u.compania, ultima: u.ultima }))
    .sort((a, b) => String(a.ultima).localeCompare(String(b.ultima)));
  const cuenta = e => cuentas.filter(c => c.estado === e);
  const arr = cuenta("arrastra").filter(c => !c.saldoAFavor), favor = cuenta("arrastra").filter(c => c.saldoAFavor);
  const totales = {
    cuentasPuente: cuentas.length, arrastran: arr.length, saldoAFavor: favor.length, alReves: cuenta("al-reves").length,
    transitoriasConSaldo: cuenta("con-saldo").length, sinRegistro: sinRegistro.length,
    montoArrastrado: r2(arr.reduce((t, c) => t + c.arrastre, 0)),
    companiasIva: iva.length, ivaMalUbicado: mal.length, conBorradores: iva.filter(i => i.borradores && (i.borradores.ivaCompras || i.borradores.ivaVentas)).length,
    difDeclaracion: iva.filter(i => i.declarado && (Math.abs(i.declarado.difDebito) > tolerancia || Math.abs(i.declarado.difCredito) > tolerancia)).length
,
    asientosSugeridos: asientosSugeridos.length
  };

  const alertas = [];
  if (arr.length) alertas.push({ nivel: "alto",
    texto: `${arr.length} cuentas puente arrastran saldo sin liquidar al cierre de ${mes} (₡${colones(totales.montoArrastrado)}): falta registrar el pago o se registró contra otra cuenta.`,
    detalle: arr.slice(0, 10).map(c => `${c.compania} — ${c.cuenta}: ₡${colones(c.arrastre)} más viejo que ${c.periodicidad === 12 ? "un año" : "el mes"}${c.mesesSeguidos > 1 ? ` (${c.mesesSeguidos} meses seguidos)` : ""}`) });
  const rev = cuenta("al-reves");
  if (rev.length) alertas.push({ nivel: "alto", texto: `${rev.length} cuentas puente con saldo al revés: se pagó de más o se registró un pago sin su provisión.`,
    detalle: rev.slice(0, 8).map(c => `${c.compania} — ${c.cuenta}: ₡${colones(-c.saldo)} del lado contrario`) });
  if (mal.length) alertas.push({ nivel: "alto", texto: `IVA cargado a cuentas que no son de IVA en ${new Set(mal.map(m => m.compania)).size} compañías: infla ingresos, caja o activos.`,
    detalle: mal.slice(0, 8).map(m => `${m.compania} — IVA de ${m.uso} (${m.impuesto}) en «${m.cuenta}»: ${m.lineas} líneas, ₡${colones(Math.abs(m.monto))}`) });
  if (totales.difDeclaracion) alertas.push({ nivel: "alto", texto: `${totales.difDeclaracion} compañías con diferencia entre los documentos y el Reporte IVA de ${mes}.`,
    detalle: iva.filter(i => i.declarado && (Math.abs(i.declarado.difDebito) > tolerancia || Math.abs(i.declarado.difCredito) > tolerancia)).slice(0, 8)
      .map(i => `${i.compania}: débito ${colones(i.declarado.difDebito)}, crédito ${colones(i.declarado.difCredito)}`) });
  const conBorr = iva.filter(i => i.borradores && (i.borradores.ivaCompras || i.borradores.ivaVentas));
  if (conBorr.length) alertas.push({ nivel: "info", texto: `${conBorr.length} compañías tienen facturas de ${mes} en borrador: su IVA no entra en el cuadre hasta que se publiquen.`,
    detalle: conBorr.sort((a, b) => b.borradores.ivaCompras - a.borradores.ivaCompras).slice(0, 8).map(i => `${i.compania}: ${i.borradores.compras} de compra (IVA ₡${colones(i.borradores.ivaCompras)}), ${i.borradores.ventas} de venta`) });
  const tr = cuenta("con-saldo");
  if (tr.length) alertas.push({ nivel: "info", texto: `${tr.length} cuentas transitorias con saldo al cierre de ${mes}: hay partidas sin aplicar.`,
    detalle: tr.slice(0, 8).map(c => `${c.compania} — ${c.cuenta}: ₡${colones(c.saldo)}`) });
  if (favor.length) alertas.push({ nivel: "info", texto: `${favor.length} cuentas de crédito fiscal arrastran saldo: puede ser saldo a favor legítimo; confirmar contra la declaración.`,
    detalle: favor.slice(0, 6).map(c => `${c.compania} — ${c.cuenta}: ₡${colones(c.arrastre)}`) });
  if (sinRegistro.length) alertas.push({ nivel: "info", texto: `${sinRegistro.length} compañías sin ningún asiento publicado en ${mes}: su cierre no se puede revisar todavía.`,
    detalle: sinRegistro.slice(0, 10).map(s => `${s.compania} — último asiento ${s.ultima || "nunca"}`) });
  if (asientosSugeridos.length) alertas.push({ nivel: "info", texto: `${asientosSugeridos.length} asientos de liquidación propuestos en Aprobaciones → Asientos (${asientosSugeridos.filter(a => a.porDefinir).length} con el banco por elegir). Ninguno se crea en Odoo sin aprobación.`,
    detalle: asientosSugeridos.slice(0, 6).map(a => `${a.compania}: ${a.referencia}`) });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: `Cierre de ${mes}: cuentas puente liquidadas e IVA sin observaciones.`, detalle: [] });

  return {
    agente: meta.nombre, titulo: `Cierre de ${mes}: cuentas puente e IVA`, corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    mes, ventana: serieMeses, totales, cuentas: cuentas.filter(c => c.estado !== "ok").slice(0, 400), alDia: cuentas.filter(c => c.estado === "ok").length,
    iva: iva.slice(0, 200), ivaMalUbicado: mal.slice(0, 100), sinRegistro, asientosSugeridos, errorAsientos, alertas
  };
}

// --- Fase 3B: asientos sugeridos para liquidar lo que arrastra ------------------------------
const PAGABLES = new Set(["salarios", "cargas-sociales", "iva", "retenciones"]);
export const ultimoDia = mes => { const [a, m] = mes.split("-").map(Number); return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10); };

// La contrapartida usual de cada cuenta puente: el banco (cuenta y diario) contra el que se
// registraron sus pagos del último año. Devuelve Map "cia|cuenta" → { cuentaId, cuenta, diarioId, diario, veces }.
async function contrapartidasUsuales(odoo, objetivo, desde, cuentasInfo) {
  const ids = [...new Set(objetivo.map(c => c.cuentaId))], cias = [...new Set(objetivo.map(c => c.companiaId))];
  const pagos = await odoo.leerTodo("account.move.line", [["parent_state", "=", "posted"], ["account_id", "in", ids], ["company_id", "in", cias], ["debit", ">", 0], ["date", ">=", desde]],
    ["company_id", "account_id", "move_id", "journal_id"]);
  const puentesDe = new Map();
  for (const p of pagos) { const m = idDe(p.move_id); puentesDe.set(m, [...(puentesDe.get(m) || []), `${idDe(p.company_id)}|${idDe(p.account_id)}`]); }
  const moves = [...puentesDe.keys()], otras = [];
  for (let i = 0; i < moves.length; i += 500)
    otras.push(...await odoo.leerTodo("account.move.line", [["move_id", "in", moves.slice(i, i + 500)], ["credit", ">", 0]], ["move_id", "account_id", "journal_id", "credit"]));
  const faltan = [...new Set(otras.map(o => idDe(o.account_id)))].filter(id => !cuentasInfo.has(id));
  if (faltan.length) for (const [id, c] of await leerCuentas(odoo, faltan)) cuentasInfo.set(id, c);
  const conteo = new Map();
  for (const o of otras) {
    const c = cuentasInfo.get(idDe(o.account_id));
    if (c?.tipo !== "asset_cash") continue;
    for (const k of puentesDe.get(idDe(o.move_id)) || []) {
      const llave = `${idDe(o.account_id)}|${idDe(o.journal_id)}`;
      const m = conteo.get(k) || new Map();
      const x = m.get(llave) || { cuentaId: idDe(o.account_id), cuenta: c.nombre, diarioId: idDe(o.journal_id), diario: nombreDe(o.journal_id), veces: 0 };
      x.veces++; m.set(llave, x); conteo.set(k, m);
    }
  }
  return new Map([...conteo].map(([k, m]) => [k, [...m.values()].sort((a, b) => b.veces - a.veces)[0]]));
}

export async function sugerirAsientos({ odoo, cuentas, mes, cuentasInfo, log = () => {} }) {
  const objetivo = cuentas.filter(c => c.estado === "arrastra" && c.periodicidad === 1 && (PAGABLES.has(c.puente) || c.puente === "iva-credito"));
  const pagables = objetivo.filter(c => PAGABLES.has(c.puente));
  if (!pagables.length) return [];
  const cias = [...new Set(pagables.map(c => c.companiaId))];
  const fecha = ultimoDia(mes), desde = `${sumarMeses(mes, -12)}-01`;
  const diarios = await odoo.leerTodo("account.journal", [["company_id", "in", cias], ["type", "in", ["bank", "cash", "general"]]], ["name", "type", "company_id", "default_account_id"]);
  const usual = await contrapartidasUsuales(odoo, pagables, desde, cuentasInfo);
  const AVISO = `Confirme contra el estado de cuenta la fecha y el monto reales del pago: la fecha propuesta es el último día de ${mes}, y el monto es lo que quedó sin liquidar.`;
  const contrapartidaDe = (cia, cuentaId) => {
    const u = usual.get(`${cia}|${cuentaId}`);
    if (u) return { ...u, fuente: `la usó en ${u.veces} pagos anteriores` };
    const bancos = diarios.filter(d => idDe(d.company_id) === cia && d.type === "bank" && d.default_account_id);
    if (bancos.length === 1) return { cuentaId: idDe(bancos[0].default_account_id), cuenta: nombreDe(bancos[0].default_account_id), diarioId: bancos[0].id, diario: bancos[0].name, fuente: "único banco de la compañía" };
    return null;
  };
  const general = cia => diarios.find(d => idDe(d.company_id) === cia && d.type === "general") || null;
  const lineaContra = (c, monto) => c
    ? { cuentaId: c.cuentaId, cuenta: c.cuenta, descripcion: "Pago", debito: 0, credito: r2(monto), rol: "contrapartida", fuente: c.fuente }
    : { cuentaId: null, cuenta: "(banco por definir)", descripcion: "Pago", debito: 0, credito: r2(monto), rol: "contrapartida", fuente: "sin pagos anteriores: elija el banco" };

  const out = [];
  for (const cia of cias) {
    const mias = objetivo.filter(c => c.companiaId === cia), compania = mias[0].compania;
    const ivaD = mias.filter(c => c.puente === "iva"), ivaC = mias.filter(c => c.puente === "iva-credito");
    if (ivaD.length) {
      const totalD = ivaD.reduce((t, c) => t + c.arrastre, 0), totalC = ivaC.reduce((t, c) => t + c.arrastre, 0);
      let compensar = Math.min(totalD, totalC);
      const pagar = r2(totalD - compensar);
      const lineas = ivaD.map(c => ({ cuentaId: c.cuentaId, cuenta: c.cuenta, descripcion: `IVA por pagar anterior a ${mes}`, debito: r2(c.arrastre), credito: 0, rol: "puente" }));
      for (const c of ivaC) { if (compensar <= 0.005) break; const m = Math.min(c.arrastre, compensar); compensar -= m;
        lineas.push({ cuentaId: c.cuentaId, cuenta: c.cuenta, descripcion: "Compensación con crédito fiscal", debito: 0, credito: r2(m), rol: "compensacion" }); }
      const contra = pagar > 0.005 ? contrapartidaDe(cia, ivaD[0].cuentaId) : null;
      if (pagar > 0.005) lineas.push(lineaContra(contra, pagar));
      const diario = contra ? { id: contra.diarioId, nombre: contra.diario } : (g => g ? { id: g.id, nombre: g.name } : null)(general(cia));
      out.push({ clave: `cierre|${cia}|iva`, origen: "cierre", mes, companiaId: cia, compania, fecha, diarioId: diario?.id ?? null, diario: diario?.nombre ?? null,
        referencia: `Liquidación de IVA pendiente al cierre de ${mes}`,
        motivo: `IVA por pagar con ₡${colones(totalD)} más viejo que ${mes}` + (totalC ? `; se compensa con ₡${colones(totalD - pagar)} de crédito fiscal también arrastrado` : "") + (pagar > 0.005 ? `; el pago neto es ₡${colones(pagar)}.` : "."),
        aviso: AVISO, lineas, porDefinir: lineas.some(l => !l.cuentaId) });
    }
    for (const c of mias.filter(x => PAGABLES.has(x.puente) && x.puente !== "iva")) {
      const contra = contrapartidaDe(cia, c.cuentaId);
      const lineas = [{ cuentaId: c.cuentaId, cuenta: c.cuenta, descripcion: `${c.titulo} anterior a ${mes}`, debito: r2(c.arrastre), credito: 0, rol: "puente" }, lineaContra(contra, c.arrastre)];
      out.push({ clave: `cierre|${cia}|${c.cuentaId}`, origen: "cierre", mes, companiaId: cia, compania, fecha, diarioId: contra?.diarioId ?? null, diario: contra?.diario ?? null,
        referencia: `${c.titulo}: pago pendiente al cierre de ${mes}`,
        motivo: `${c.cuenta} tiene ₡${colones(c.arrastre)} más viejos que ${mes}${c.mesesSeguidos > 1 ? ` (${c.mesesSeguidos} meses seguidos)` : ""}: falta registrar el pago, o se registró contra otra cuenta (en ese caso, rechace y corrija aquel asiento).`,
        aviso: AVISO, lineas, porDefinir: !contra });
    }
  }
  log(`${out.length} asientos sugeridos (${out.filter(a => a.porDefinir).length} con el banco por definir)`);
  return out;
}
