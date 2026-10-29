// Declaraciones de Hacienda (TRIBU-CR), parte pura: los formularios, las tarifas de IVA, cómo se
// arma el «paquete» de una declaración a partir de lo agregado en Odoo, y el juez de reglas.
//
// Un paquete es lo que una persona (o el plugin) copia al portal: casilla por casilla, con su
// rastro (de qué impuestos y cuántos documentos sale cada cifra). Las casillas son nuestras; la
// correspondencia con las pantallas del portal vive en el plugin y se ajusta en la primera
// declaración real. Nada aquí toca Odoo ni la base.
import { sumarMeses } from "./meses.js";

export const r2 = x => Math.round((Number(x) || 0) * 100) / 100;
export const FORMULARIOS = {
  150: { nombre: "IVA (formulario 150)", periodicidad: "mensual", vence: "los primeros 15 días del mes siguiente" },
  102: { nombre: "Renta de sociedades (formulario 102)", periodicidad: "anual", vence: "15 de marzo del año siguiente (confirmar en el calendario de Hacienda)" },
  270: { nombre: "Informativa de compras sin comprobante (270)", periodicidad: "mensual desde 2027 (2026 se puede presentar junta en enero 2027)", vence: "los primeros 25 días del mes siguiente" }
};

// Tarifas de IVA de Hacienda (CodigoTarifaIVA, comprobantes 4.4). «derecho» = la venta da derecho a crédito.
export const TARIFAS = {
  "01": { id: "0cd", tasa: 0, etiqueta: "0% con derecho a crédito (art. 32)", derecho: true },
  "02": { id: "1", tasa: 1, etiqueta: "Reducida 1%", derecho: true },
  "03": { id: "2", tasa: 2, etiqueta: "Reducida 2%", derecho: true },
  "04": { id: "4", tasa: 4, etiqueta: "Reducida 4%", derecho: true },
  "05": { id: "0cd", tasa: 0, etiqueta: "Transitorio 0%", derecho: true },
  "06": { id: "t4", tasa: 4, etiqueta: "Transitorio 4%", derecho: true },
  "07": { id: "t8", tasa: 8, etiqueta: "Transitorio 8%", derecho: true },
  "08": { id: "13", tasa: 13, etiqueta: "General 13%", derecho: true },
  "09": { id: "05", tasa: 0.5, etiqueta: "Reducida 0,5%", derecho: true },
  "10": { id: "ex", tasa: 0, etiqueta: "Exenta", derecho: false },
  "11": { id: "0sd", tasa: 0, etiqueta: "0% sin derecho a crédito", derecho: false }
};
const ORDEN_TARIFAS = ["13", "4", "2", "1", "05", "t4", "t8", "0cd", "ex", "0sd"];
const POR_ID = Object.fromEntries(Object.values(TARIFAS).map(t => [t.id, t]));
const POR_TASA = { 13: "13", 4: "4", 2: "2", 1: "1", 0.5: "05", 8: "t8" };

// Un impuesto de Odoo → tarifa de Hacienda. La localización de TecnoDEM guarda el código de tarifa
// en tax_rate_code (01–11; «00» = sin código) y el tipo de impuesto en code (01 IVA, 07 IVA cálculo
// especial, 08 IVA régimen de bienes usados; 02 selectivo, 04 bebidas, 12 cemento, 99 otros: no son IVA
// y quedan fuera del 150). Sin código: por «código NN» o «tarifa NN» en el nombre, y si no, por el
// porcentaje. Devuelve null cuando no se reconoce.
const NO_IVA = { "02": "selectivo de consumo", "04": "bebidas alcohólicas", "12": "específico al cemento", "99": "otros" };
export function clasificarImpuesto({ name = "", amount = null, amount_type = "percent", type_tax_use = "", tax_rate_code = null, code = null } = {}) {
  const n = String(name || "");
  if (code && NO_IVA[code]) return { excluido: NO_IVA[code] };
  const noAcreditable = /no acreditable|sin derecho a cr[eé]dito|gasto/i.test(n) && type_tax_use === "purchase";
  let t = tax_rate_code && TARIFAS[tax_rate_code] ? TARIFAS[tax_rate_code] : null;
  const m = n.match(/(?:c[oó]d(?:igo)?\.?|tarifa)\s*(\d{1,2})\b/i);
  if (!t && m && TARIFAS[m[1].padStart(2, "0")]) t = TARIFAS[m[1].padStart(2, "0")];
  if (!t && /exent/i.test(n)) t = TARIFAS["10"];
  if (!t && /no sujet/i.test(n)) t = TARIFAS["11"];
  if (!t && amount_type === "percent" && amount != null) {
    const id = POR_TASA[Number(amount)];
    if (id) t = POR_ID[id];
    else if (Number(amount) === 0) t = TARIFAS["01"];
  }
  if (!t) return null;
  return { tarifa: t.id, tasa: t.tasa, etiqueta: t.etiqueta, derecho: t.derecho, noAcreditable, uso: type_tax_use, especial: code === "07" || code === "08" ? (code === "07" ? "cálculo especial" : "bienes usados") : null, exentoComo01: t.id === "0cd" && /exent/i.test(n) };
}

// Arma el paquete del formulario 150 de una compañía y un mes.
// agregados: [{ impuestoId, nombre, tarifa, tasa, derecho, noAcreditable, uso: sale|purchase, base, impuesto, documentos }]
// extra: { saldoAFavorAnterior, proporcion (0–100, null = no aplica), anterior: {debito, credito} del mes previo, borradores, rechazadosHacienda, comprasSinAceptar, sinClasificar: [nombres] }
// Las casillas van en colones enteros, como las pide el portal; el rastro conserva los centavos.
const entero = x => Math.round(Number(x) || 0);
export function paquete150({ compania, companiaId, periodo, agregados = [], extra = {} }) {
  const casillas = [];
  const c = (id, seccion, etiqueta, monto, rastro = [], atributos = {}) => { const m = atributos.porcentaje ? r2(monto) : entero(monto); casillas.push({ id, seccion, etiqueta, monto: m, rastro, ...atributos }); return m; };
  const de = (uso, tarifa) => agregados.filter(a => a.uso === uso && a.tarifa === tarifa);
  const suma = (xs, k) => r2(xs.reduce((t, a) => t + (Number(a[k]) || 0), 0));
  const rastro = xs => xs.map(a => ({ impuestoId: a.impuestoId, impuesto: a.nombre, base: r2(a.base), impuesto_monto: r2(a.impuesto), documentos: a.documentos || 0 }));

  // Ventas: base e IVA por tarifa
  let ventasTotal = 0, debito = 0, ventasConDerecho = 0;
  for (const t of ORDEN_TARIFAS) {
    const xs = de("sale", t); if (!xs.length && !["13", "ex", "0sd"].includes(t)) continue;
    const base = c(`v${t}`, "ventas", `Ventas ${POR_ID[t].etiqueta}`, suma(xs, "base"), rastro(xs), { tarifa: t, tasa: POR_ID[t].tasa });
    ventasTotal += base; if (POR_ID[t].derecho) ventasConDerecho += base;
    if (POR_ID[t].tasa > 0) debito += c(`d${t}`, "debito", `IVA cobrado ${POR_ID[t].etiqueta}`, suma(xs, "impuesto"), rastro(xs), { tarifa: t, tasa: POR_ID[t].tasa, base });
  }
  c("vtot", "ventas", "Total de ventas", ventasTotal, [], { total: true });
  c("dtot", "debito", "Total IVA cobrado (débito fiscal)", debito, [], { total: true });

  // Compras: base e IVA soportado por tarifa; el no acreditable aparte
  let comprasTotal = 0, soportado = 0, noAcreditable = 0;
  for (const t of ORDEN_TARIFAS) {
    const xs = de("purchase", t); if (!xs.length && t !== "13") continue;
    const base = c(`c${t}`, "compras", `Compras ${POR_ID[t].etiqueta}`, suma(xs, "base"), rastro(xs), { tarifa: t, tasa: POR_ID[t].tasa });
    comprasTotal += base;
    if (POR_ID[t].tasa > 0) {
      const acred = xs.filter(a => !a.noAcreditable), noAcred = xs.filter(a => a.noAcreditable);
      soportado += c(`s${t}`, "credito", `IVA pagado ${POR_ID[t].etiqueta}`, suma(acred, "impuesto"), rastro(acred), { tarifa: t, tasa: POR_ID[t].tasa, base: suma(acred, "base") });
      noAcreditable += suma(noAcred, "impuesto");
    }
  }
  c("ctot", "compras", "Total de compras", comprasTotal, [], { total: true });
  c("stot", "credito", "Total IVA pagado", soportado, [], { total: true });
  c("sna", "credito", "IVA no acreditable (impuestos marcados así)", noAcreditable, rastro(agregados.filter(a => a.uso === "purchase" && a.noAcreditable)));
  // Proporción (prorrata): si no viene, la del periodo = ventas con derecho / ventas totales
  const propCalculada = ventasTotal > 0 ? r2(ventasConDerecho / ventasTotal * 100) : 100;
  const proporcion = extra.proporcion == null ? propCalculada : r2(extra.proporcion);
  c("prop", "credito", "Proporción de crédito aplicable (%)", proporcion, [], { porcentaje: true, calculada: propCalculada, confirmada: extra.proporcion != null });
  const credito = c("cf", "credito", "Crédito fiscal del periodo", soportado * proporcion / 100, [], { total: true });
  const saf = c("saf", "determinacion", "Saldo a favor del periodo anterior", extra.saldoAFavorAnterior || 0, [], { fuente: extra.fuenteSaldoAnterior || null });
  const det = r2(debito - credito - saf);
  c("det", "determinacion", "Impuesto determinado (débito − crédito − saldo anterior)", det, [], { total: true });
  c("pagar", "determinacion", "Impuesto a pagar", Math.max(0, det), [], { total: true, resultado: true });
  c("favor", "determinacion", "Saldo a favor para el periodo siguiente", Math.max(0, -det), [], { total: true, resultado: true });

  const totales = { ventas: r2(ventasTotal), debito: r2(debito), compras: r2(comprasTotal), soportado: r2(soportado), noAcreditable: r2(noAcreditable), proporcion, credito, saldoAnterior: saf,
    determinado: det, pagar: Math.max(0, det), favor: Math.max(0, -det), documentosVenta: agregados.filter(a => a.uso === "sale").reduce((t, a) => t + (a.documentos || 0), 0),
    documentosCompra: agregados.filter(a => a.uso === "purchase").reduce((t, a) => t + (a.documentos || 0), 0) };
  return { impuesto: "150", formulario: FORMULARIOS[150].nombre, compania, companiaId, periodo, casillas, totales, extra: { ...extra, proporcionCalculada: propCalculada } };
}

// Renta de sociedades (102), anual, desde los saldos del año por tipo de cuenta de Odoo.
// saldos: [{ tipo (account_type), cuentaId, cuenta, monto }] con monto positivo = ingreso o gasto según su naturaleza.
// extra: { tarifa (%), pagosParciales, retenciones, noDeducibles: [{cuenta, monto}] }
export function paquete102({ compania, companiaId, periodo, saldos = [], extra = {} }) {
  const casillas = [];
  const c = (id, seccion, etiqueta, monto, rastro = [], atributos = {}) => { const m = atributos.porcentaje ? r2(monto) : entero(monto); casillas.push({ id, seccion, etiqueta, monto: m, rastro, ...atributos }); return m; };
  const de = tipos => saldos.filter(s => tipos.includes(s.tipo));
  const suma = xs => r2(xs.reduce((t, s) => t + (Number(s.monto) || 0), 0));
  const rastro = xs => xs.filter(s => Math.abs(s.monto) >= 0.005).map(s => ({ cuentaId: s.cuentaId, cuenta: s.cuenta, monto: r2(s.monto) }));
  const ingresos = c("ing", "ingresos", "Ingresos brutos", suma(de(["income"])), rastro(de(["income"])));
  const otros = c("ingo", "ingresos", "Otros ingresos", suma(de(["income_other"])), rastro(de(["income_other"])));
  const costo = c("cv", "costos", "Costo de ventas", suma(de(["expense_direct_cost"])), rastro(de(["expense_direct_cost"])));
  const gastosTodos = de(["expense", "expense_depreciation"]);
  const noDed = extra.noDeducibles || [];
  const gastos = c("gas", "gastos", "Gastos deducibles", suma(gastosTodos) - suma(noDed), rastro(gastosTodos));
  const nd = c("nd", "gastos", "Gastos no deducibles (se suman a la renta)", suma(noDed), rastro(noDed), { porValidar: true });
  const renta = c("rn", "determinacion", "Renta neta (ingresos − costo − gastos deducibles)", ingresos + otros - costo - gastos, [], { total: true });
  const tarifa = c("tar", "determinacion", "Tarifa (%)", extra.tarifa ?? 30, [], { porcentaje: true, porValidar: true, nota: "30% general; las PYMES por ingresos brutos tienen tarifas escalonadas: confirmar por compañía." });
  const imp = c("imp", "determinacion", "Impuesto sobre la renta", Math.max(0, renta) * tarifa / 100, [], { total: true });
  const pp = c("pp", "determinacion", "Pagos parciales del periodo", extra.pagosParciales || 0, [], { porValidar: true });
  const ret = c("ret", "determinacion", "Retenciones acreditables", extra.retenciones || 0, [], { porValidar: true });
  const det = r2(imp - pp - ret);
  c("pagar", "determinacion", "Impuesto a pagar", Math.max(0, det), [], { total: true, resultado: true });
  c("favor", "determinacion", "Saldo a favor", Math.max(0, -det), [], { total: true, resultado: true });
  const totales = { ingresos: r2(ingresos + otros), costo, gastos, noDeducibles: nd, renta, tarifa, impuesto: imp, pagosParciales: pp, retenciones: ret, pagar: Math.max(0, det), favor: Math.max(0, -det) };
  return { impuesto: "102", formulario: FORMULARIOS[102].nombre, compania, companiaId, periodo, casillas, totales, extra, porValidar: true };
}

// Informativa 270: compras del periodo sin comprobante electrónico, por proveedor.
// compras: [{ partnerId, proveedor, cedula, monto, documentos }]
export function paquete270({ compania, companiaId, periodo, compras = [] }) {
  const filas = compras.map(x => ({ ...x, monto: entero(x.monto) })).sort((a, b) => b.monto - a.monto);
  const total = entero(filas.reduce((t, x) => t + x.monto, 0));
  return { impuesto: "270", formulario: FORMULARIOS[270].nombre, compania, companiaId, periodo, casillas: [{ id: "tot", seccion: "compras", etiqueta: "Total de compras sin comprobante electrónico", monto: total, rastro: [], total: true, resultado: true }],
    filas, totales: { proveedores: filas.length, documentos: filas.reduce((t, x) => t + (x.documentos || 0), 0), total, sinCedula: filas.filter(x => !x.cedula).length } };
}

// --- El juez de reglas: no cambia cifras, marca. Devuelve { semaforo, observaciones } ---
const colones = x => Math.round(Number(x) || 0).toLocaleString("es-CR");
export function juezDeReglas(p) {
  const obs = [];
  const ob = (regla, nivel, texto) => obs.push({ regla, nivel, texto });
  const cas = Object.fromEntries(p.casillas.map(x => [x.id, x]));
  const x = p.extra || {};
  if (p.impuesto === "150") {
    for (const k of Object.keys(cas)) {
      const d = cas[k];
      if (!/^[ds]/.test(k) || d.total || !d.tasa) continue;
      const esperado = r2((d.base || 0) * d.tasa / 100), tol = Math.max(100, esperado * 0.01);
      if (Math.abs(d.monto - esperado) > tol) ob("cuadre", "alto", `${d.etiqueta}: ₡${colones(d.monto)} no cuadra con la base × ${d.tasa}% (≈ ₡${colones(esperado)}).`);
    }
    if ((x.sinClasificar || []).length) ob("tarifa", "critico", `${x.sinClasificar.length} impuestos con movimiento no se reconocen como tarifa de IVA: ${x.sinClasificar.slice(0, 4).join(", ")}. Hay que asignarles tarifa antes de declarar.`);
    if (x.borradores) ob("borradores", "alto", `${x.borradores} documentos del periodo siguen en borrador: no están en estas cifras.`);
    if (x.rechazadosHacienda) ob("hacienda", "critico", `${x.rechazadosHacienda} documentos del periodo rechazados por Hacienda: no deben declararse así.`);
    if (x.comprasSinAceptar) ob("aceptacion", "info", `${x.comprasSinAceptar} facturas de compra del periodo sin mensaje de aceptación en Hacienda (estado «${x.estadosSinAceptar || "-"}»): confirmar con TecnoDEM si el crédito fiscal queda respaldado.`);
    if ((x.exentasComo01 || []).length) ob("exento-01", "alto", `Ventas con impuestos llamados «exento» pero con código de tarifa 01 (0 % con derecho a crédito): ${x.exentasComo01.slice(0, 3).join(", ")}. Si son exentas de verdad (tarifa 10), cambia la proporción de crédito.`);
    if ((x.especiales || []).length) ob("especial", "info", `Impuestos de régimen especial en el periodo (${x.especiales.slice(0, 3).join(", ")}): revisar que el formulario los lleve donde corresponde.`);
    if (x.notasSinLigar) ob("notas", "info", `${x.notasSinLigar} notas de crédito del periodo sin ligar a su factura.`);
    if (cas.prop && cas.prop.monto < 100 && !cas.prop.confirmada) ob("prorrata", "alto", `La proporción de crédito salió en ${cas.prop.monto}% por las ventas sin derecho del periodo. Confirme la prorrata de la compañía antes de declarar.`);
    if (x.anterior && (x.anterior.debito || x.anterior.credito)) {
      const v = (a, b) => (a === 0 ? (b === 0 ? 0 : 1) : Math.abs(b - a) / Math.abs(a));
      if (v(x.anterior.debito, p.totales.debito) > 0.5 && Math.abs(p.totales.debito - x.anterior.debito) > 100000) ob("variacion", "alto", `El IVA cobrado cambió ${Math.round(v(x.anterior.debito, p.totales.debito) * 100)}% contra el mes anterior (₡${colones(x.anterior.debito)} → ₡${colones(p.totales.debito)}).`);
      if (v(x.anterior.credito, p.totales.soportado) > 0.5 && Math.abs(p.totales.soportado - x.anterior.credito) > 100000) ob("variacion", "alto", `El IVA pagado cambió ${Math.round(v(x.anterior.credito, p.totales.soportado) * 100)}% contra el mes anterior (₡${colones(x.anterior.credito)} → ₡${colones(p.totales.soportado)}).`);
    }
    if (!p.totales.ventas && !p.totales.compras) ob("actividad", "info", "Sin ventas ni compras en el periodo: la declaración va en cero (si la compañía sigue activa ante Hacienda, igual se presenta).");
    if (p.totales.favor > 0) ob("favor", "info", `Queda un saldo a favor de ₡${colones(p.totales.favor)} para el periodo siguiente.`);
  }
  if (p.impuesto === "102") {
    ob("validar", "alto", "Mapeo por validar con el contador: gastos no deducibles, tarifa aplicable, pagos parciales y retenciones.");
    if (p.totales.renta < 0) ob("perdida", "info", `Pérdida del periodo: ₡${colones(-p.totales.renta)}.`);
    if (x.anioSinCerrar) ob("cierre", "alto", "El año anterior no está cerrado en Odoo: los saldos pueden arrastrar resultados del año pasado.");
  }
  if (p.impuesto === "270") {
    if (p.totales.sinCedula) ob("cedula", "alto", `${p.totales.sinCedula} proveedores sin cédula: la 270 pide la identificación de cada uno.`);
    if (!p.totales.proveedores) ob("vacia", "info", "Sin compras sin comprobante en el periodo.");
  }
  return { semaforo: semaforoDe(obs), observaciones: obs };
}
export const semaforoDe = obs => (obs.some(o => o.nivel === "critico") ? "rojo" : obs.some(o => o.nivel === "alto") ? "amarillo" : "verde");

// Comparación del paquete con lo que se leyó en el portal (o con el prellenado de Hacienda).
// leido: { casillaId: monto }. Devuelve las diferencias.
export function comparar(p, leido = {}, { tolerancia = 1 } = {}) {
  const dif = [];
  for (const c of p.casillas) {
    if (!(c.id in leido)) continue;
    const v = Number(leido[c.id]);
    if (!Number.isFinite(v)) { dif.push({ casilla: c.id, etiqueta: c.etiqueta, paquete: c.monto, portal: leido[c.id], motivo: "ilegible" }); continue; }
    if (Math.abs(v - c.monto) > tolerancia) dif.push({ casilla: c.id, etiqueta: c.etiqueta, paquete: c.monto, portal: r2(v), diferencia: r2(v - c.monto) });
  }
  return dif;
}

// Periodo por omisión de cada formulario respecto de un mes de referencia (AAAA-MM).
export const periodoDe = (impuesto, mes) => (impuesto === "102" ? String(sumarMeses(mes, 0)).slice(0, 4) : mes);
export const claveDeclaracion = (companiaId, impuesto, periodo) => `${impuesto}|${companiaId}|${periodo}`;
