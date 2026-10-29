// AGENTE HACIENDA — solo lectura. Prepara, por compañía y periodo, el paquete de cada declaración
// de TRIBU-CR a partir de lo que hay en Odoo:
//   · 150 (IVA mensual): ventas y compras por tarifa, IVA cobrado y pagado, proporción, saldo anterior
//   · 270 (informativa): compras del mes sin comprobante electrónico, por proveedor
//   · 102 (renta anual): acumulado del año por tipo de cuenta, marcado «por validar»
// Pasa cada paquete por el juez de reglas y lo deja en la pestaña Hacienda de la app. No presenta
// nada: presentar es de una persona (con el plugin que llena el portal, si se quiere).
import { idDe, nombreDe, r2, rangoMes, ultimaFechaPorCompania, mesAEvaluar, leerCuentas } from "../lib/contable.js";
import { sumarMeses } from "../lib/meses.js";
import { clasificarImpuesto, paquete150, paquete102, paquete270, juezDeReglas, claveDeclaracion } from "../lib/hacienda.js";

export const meta = {
  id: "hacienda", nombre: "HACIENDA", puesto: "Prepara las declaraciones",
  modelo: "account.move.line", escribe: false
};
const VENTA = ["out_invoice", "out_refund"], COMPRA = ["in_invoice", "in_refund"];
const CAMPOS_ESTADO_MH = ["state_tributacion", "mh_status", "state_send_invoice", "estado_hacienda"];
const colones = x => Math.round(Number(x) || 0).toLocaleString("es-CR");

export async function ejecutar({ odoo, cfg, log, db = null }) {
  const t0 = Date.now();
  await odoo.conectar();
  const ultimas = await ultimaFechaPorCompania(odoo);
  const mes = mesAEvaluar(cfg, cfg.HACIENDA_MES, ultimas);
  const anio = mes.slice(0, 4);
  const [d, h] = rangoMes(mes), [dA, hA] = rangoMes(sumarMeses(mes, -1));
  log(`Periodo ${mes}`);
  const companias = new Map((await odoo.leer("res.company", "search_read", [[], ["name", "vat"]], {})).map(c => [c.id, c]));

  // --- Impuestos de Odoo → tarifas de Hacienda
  const impuestos = new Map();
  let camposImp = ["name", "amount", "amount_type", "type_tax_use", "company_id", "tax_rate_code", "code"];
  let listaImp;
  try { listaImp = await odoo.leerTodo("account.tax", [], camposImp, { context: { active_test: false } }); }
  catch { camposImp = camposImp.slice(0, 5); listaImp = await odoo.leerTodo("account.tax", [], camposImp, { context: { active_test: false } }); }   // sin la localización de TecnoDEM
  for (const t of listaImp) impuestos.set(t.id, { id: t.id, nombre: t.name, clase: clasificarImpuesto(t) });

  // --- Líneas del periodo: la base (líneas con impuestos) y el impuesto (líneas de impuesto)
  const tipoDoc = ["in", VENTA.concat(COMPRA)];
  const bases = await odoo.leerTodo("account.move.line", [["parent_state", "=", "posted"], ["date", ">=", d], ["date", "<", h], ["move_type", ...tipoDoc], ["tax_ids", "!=", false]],
    ["company_id", "move_id", "move_type", "tax_ids", "balance"]);
  // (move_type no es un campo almacenado en las líneas: se leen, no se agrupan)
  const impLineas = await odoo.leerTodo("account.move.line", [["parent_state", "=", "posted"], ["date", ">=", d], ["date", "<", h], ["move_type", ...tipoDoc], ["tax_line_id", "!=", false]],
    ["company_id", "tax_line_id", "move_type", "balance"]);
  log(`${bases.length} líneas con impuesto, ${impLineas.length} líneas de IVA`);
  const agregados = new Map();   // "cia|impuesto|uso" → agregado
  const ag = (cia, impId, uso) => {
    const k = `${cia}|${impId}|${uso}`;
    if (!agregados.has(k)) { const t = impuestos.get(impId); agregados.set(k, { companiaId: cia, impuestoId: impId, nombre: t?.nombre || `impuesto ${impId}`, clase: t?.clase || null, uso, base: 0, impuesto: 0, docs: new Set() }); }
    return agregados.get(k);
  };
  for (const l of bases) {
    const uso = VENTA.includes(l.move_type) ? "sale" : "purchase", signo = uso === "sale" ? -1 : 1;
    for (const impId of l.tax_ids || []) { const a = ag(idDe(l.company_id), impId, uso); a.base += signo * (Number(l.balance) || 0); a.docs.add(idDe(l.move_id)); }
  }
  for (const g of impLineas) {
    const uso = VENTA.includes(g.move_type) ? "sale" : "purchase", signo = uso === "sale" ? -1 : 1;
    ag(idDe(g.company_id), idDe(g.tax_line_id), uso).impuesto += signo * (Number(g.balance) || 0);
  }
  // mes anterior, solo totales de IVA por compañía (para la regla de variación)
  const anterior = new Map();
  for (const g of await odoo.leerTodo("account.move.line", [["parent_state", "=", "posted"], ["date", ">=", dA], ["date", "<", hA], ["move_type", ...tipoDoc], ["tax_line_id", "!=", false]], ["company_id", "move_type", "balance"])) {
    const cia = idDe(g.company_id), x = anterior.get(cia) || { debito: 0, credito: 0 };
    if (VENTA.includes(g.move_type)) x.debito += -(Number(g.balance) || 0); else x.credito += Number(g.balance) || 0;
    anterior.set(cia, x);
  }

  // --- Señales del periodo por compañía: borradores, notas sin ligar, estado en Hacienda
  const porCia = (filas, f) => { const m = new Map(); for (const x of filas) { const cia = idDe(x.company_id); m.set(cia, (m.get(cia) || 0) + f(x)); } return m; };
  const borradores = porCia(await odoo.leer("account.move", "read_group", [[["state", "=", "draft"], ["move_type", ...tipoDoc], ["date", ">=", d], ["date", "<", h]], [], ["company_id"]], { lazy: false }), x => x.__count);
  const notas = porCia(await odoo.leer("account.move", "read_group", [[["state", "=", "posted"], ["move_type", "in", ["in_refund", "out_refund"]], ["reversed_entry_id", "=", false], ["date", ">=", d], ["date", "<", h]], [], ["company_id"]], { lazy: false }), x => x.__count);
  let campoMH = null, rechazados = new Map(), sinAceptar = new Map(); const estadosVistos = new Set();
  for (const campo of CAMPOS_ESTADO_MH) {
    try {
      const g = await odoo.leer("account.move", "read_group", [[["state", "=", "posted"], ["move_type", ...tipoDoc], ["date", ">=", d], ["date", "<", h]], [], ["company_id", "move_type", campo]], { lazy: false });
      if (!g.length || g.every(x => x[campo] === undefined || x[campo] === false)) continue;
      campoMH = campo;
      for (const x of g) {
        const v = String(x[campo] || "").toLowerCase(), cia = idDe(x.company_id);
        if (/rechaz/.test(v)) rechazados.set(cia, (rechazados.get(cia) || 0) + x.__count);
        else if (x.move_type === "in_invoice" && !/acept|accept/.test(v)) { sinAceptar.set(cia, (sinAceptar.get(cia) || 0) + x.__count); estadosVistos.add(v || "-"); }
      }
      break;
    } catch { /* ese campo no existe en esta instancia */ }
  }
  log(campoMH ? `Estado en Hacienda leído de ${campoMH}` : "Sin campo de estado en Hacienda en esta instancia");

  // --- 270: compras del mes sin comprobante electrónico
  const sinClave = await odoo.leerTodo("account.move", [["state", "=", "posted"], ["move_type", "=", "in_invoice"], ["date", ">=", d], ["date", "<", h], ["e_key", "=", false]], ["company_id", "partner_id", "amount_untaxed"]);
  const idsProv = [...new Set(sinClave.map(x => idDe(x.partner_id)).filter(Boolean))];
  const proveedores = new Map();
  for (let i = 0; i < idsProv.length; i += 500) for (const p of await odoo.leer("res.partner", "search_read", [[["id", "in", idsProv.slice(i, i + 500)]], ["name", "vat"]], { context: { active_test: false } })) proveedores.set(p.id, p);

  // --- 102: acumulado del año por cuenta (resultados), por compañía
  const anual = await odoo.leer("account.move.line", "read_group",
    [[["parent_state", "=", "posted"], ["date", ">=", `${anio}-01-01`], ["date", "<", `${Number(anio) + 1}-01-01`], ["account_id.account_type", "in", ["income", "income_other", "expense", "expense_direct_cost", "expense_depreciation"]]],
    ["balance:sum"], ["company_id", "account_id"]], { lazy: false });
  const cuentas = await leerCuentas(odoo, anual.map(x => idDe(x.account_id)));

  // --- Armar los paquetes
  const ajustesDe = (cia, imp, per) => (db && db.ajustesDeclaracion ? db.ajustesDeclaracion(claveDeclaracion(cia, imp, per)) : null) || {};
  const paquetes = [], sinClasificar = new Map();
  const ciasConMovimiento = new Set([...agregados.values()].map(a => a.companiaId));
  for (const [cia, c] of companias) {
    const nombre = c.name;
    // 150
    const mios = [...agregados.values()].filter(a => a.companiaId === cia);
    const lista = [], desconocidos = [], exentasComo01 = [], especiales = [];
    for (const a of mios) {
      if (a.clase && a.clase.excluido) continue;                                   // selectivo, cemento…: no van en el 150
      if (!a.clase) { if (Math.abs(a.base) + Math.abs(a.impuesto) > 0.005) desconocidos.push(a.nombre); continue; }
      if (a.clase.exentoComo01 && a.uso === "sale" && Math.abs(a.base) > 0.005) exentasComo01.push(a.nombre);
      if (a.clase.especial && Math.abs(a.base) + Math.abs(a.impuesto) > 0.005) especiales.push(`${a.nombre} (${a.clase.especial})`);
      lista.push({ impuestoId: a.impuestoId, nombre: a.nombre, tarifa: a.clase.tarifa, tasa: a.clase.tasa, derecho: a.clase.derecho, noAcreditable: a.clase.noAcreditable, uso: a.uso, base: r2(a.base), impuesto: r2(a.impuesto), documentos: a.docs.size });
    }
    if (desconocidos.length) sinClasificar.set(cia, desconocidos);
    const aj = ajustesDe(cia, "150", mes);
    const previa = db && db.declaracionAnterior ? db.declaracionAnterior(cia, "150", mes) : null;
    const p150 = paquete150({ compania: nombre, companiaId: cia, periodo: mes, agregados: lista, extra: {
      proporcion: aj.proporcion ?? null, saldoAFavorAnterior: aj.saldoAnterior ?? previa?.favor ?? 0, fuenteSaldoAnterior: aj.saldoAnterior != null ? "indicado a mano" : previa ? `declaración ${previa.periodo} en la Oficina` : null,
      anterior: anterior.get(cia) || null, borradores: borradores.get(cia) || 0, notasSinLigar: notas.get(cia) || 0, rechazadosHacienda: rechazados.get(cia) || 0, comprasSinAceptar: sinAceptar.get(cia) || 0,
      sinClasificar: desconocidos, exentasComo01, especiales, campoEstadoHacienda: campoMH, estadosSinAceptar: [...estadosVistos].join(", ") } });
    p150.fuentes = lista;                 // para recalcular con otros ajustes sin volver a Odoo
    p150.juez = juezDeReglas(p150);
    if (ciasConMovimiento.has(cia) || previa) paquetes.push(p150);
    // 270
    const compras = new Map();
    for (const x of sinClave.filter(x => idDe(x.company_id) === cia)) {
      const pid = idDe(x.partner_id) || 0, pr = proveedores.get(pid), k = compras.get(pid) || { partnerId: pid || null, proveedor: pr?.name || nombreDe(x.partner_id) || "(sin proveedor)", cedula: pr?.vat || null, monto: 0, documentos: 0 };
      k.monto += Number(x.amount_untaxed) || 0; k.documentos++; compras.set(pid, k);
    }
    if (compras.size) { const p270 = paquete270({ compania: nombre, companiaId: cia, periodo: mes, compras: [...compras.values()] }); p270.juez = juezDeReglas(p270); paquetes.push(p270); }
    // 102 (acumulado del año; completo solo en diciembre)
    const saldos = anual.filter(x => idDe(x.company_id) === cia).map(x => { const ct = cuentas.get(idDe(x.account_id)); const bal = Number(x.balance) || 0;
      return { tipo: ct?.tipo, cuentaId: idDe(x.account_id), cuenta: ct?.nombre || String(idDe(x.account_id)), monto: /^income/.test(ct?.tipo || "") ? -bal : bal }; });
    if (saldos.length) {
      const aj2 = ajustesDe(cia, "102", anio);
      const noDed = saldos.filter(s => /^expense/.test(s.tipo || "") && /no deducible/i.test(s.cuenta)).map(s => ({ cuenta: s.cuenta, cuentaId: s.cuentaId, monto: s.monto }));
      const p102 = paquete102({ compania: nombre, companiaId: cia, periodo: anio, saldos, extra: { tarifa: aj2.tarifa ?? 30, pagosParciales: aj2.pagosParciales ?? 0, retenciones: aj2.retenciones ?? 0, noDeducibles: aj2.noDeducibles ?? noDed, hastaMes: mes, parcial: !mes.endsWith("-12") } });
      p102.fuentes = saldos; p102.juez = juezDeReglas(p102); paquetes.push(p102);
    }
  }

  const de = imp => paquetes.filter(p => p.impuesto === imp);
  const totales = { periodo: mes, companias: companias.size, declaraciones150: de("150").length, declaraciones270: de("270").length, declaraciones102: de("102").length,
    ivaAPagar: r2(de("150").reduce((t, p) => t + p.totales.pagar, 0)), saldosAFavor: r2(de("150").reduce((t, p) => t + p.totales.favor, 0)),
    rojo: paquetes.filter(p => p.juez.semaforo === "rojo").length, amarillo: paquetes.filter(p => p.juez.semaforo === "amarillo").length, verde: paquetes.filter(p => p.juez.semaforo === "verde").length,
    sinClasificar: sinClasificar.size };
  const alertas = [];
  if (de("150").length) alertas.push({ nivel: "info", texto: `${de("150").length} declaraciones de IVA de ${mes} preparadas: ₡${colones(totales.ivaAPagar)} a pagar en total; ${totales.verde} en verde, ${totales.amarillo} en amarillo, ${totales.rojo} en rojo. Están en la pestaña Hacienda.`,
    detalle: de("150").filter(p => p.totales.pagar > 0).sort((a, b) => b.totales.pagar - a.totales.pagar).slice(0, 8).map(p => `${p.compania}: ₡${colones(p.totales.pagar)} (${p.juez.semaforo})`) });
  if (sinClasificar.size) alertas.push({ nivel: "alto", texto: `${sinClasificar.size} compañías usan impuestos que no se reconocen como tarifa de IVA: hay que revisarlos antes de declarar.`, detalle: [...sinClasificar.entries()].slice(0, 8).map(([cia, xs]) => `${companias.get(cia)?.name}: ${xs.slice(0, 3).join(", ")}`) });
  const rojos = paquetes.filter(p => p.juez.semaforo === "rojo");
  if (rojos.length) alertas.push({ nivel: "alto", texto: `${rojos.length} declaraciones en rojo: el juez de reglas las frena.`, detalle: rojos.slice(0, 8).map(p => `${p.compania} ${p.formulario}: ${p.juez.observaciones.find(o => o.nivel === "critico")?.texto || ""}`) });
  if (!campoMH) alertas.push({ nivel: "info", texto: "Esta instancia no expone el estado de aceptación en Hacienda por documento: el juez no puede revisar rechazos ni compras sin aceptar.", detalle: [] });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: `Sin movimiento en ${mes}.`, detalle: [] });

  return {
    agente: meta.nombre, titulo: `Declaraciones de ${mes}`, corrida: new Date().toISOString(), segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    mes, totales, paquetes, resumen: paquetes.map(p => ({ impuesto: p.impuesto, compania: p.compania, companiaId: p.companiaId, periodo: p.periodo, semaforo: p.juez.semaforo, pagar: p.totales.pagar ?? null, favor: p.totales.favor ?? null })), alertas
  };
}
