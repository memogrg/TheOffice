// Extractos bancarios (base de la fase 3C, ítem 1 de la matriz): de las filas de un archivo de
// cualquier banco a movimientos {fecha, descripcion, referencia, monto, saldo}.
//
// No hay un formato por banco escrito a mano: se busca la fila de encabezados, se reconocen las
// columnas por su nombre (fecha, descripción, débito/crédito o monto, saldo…) y, si el extracto trae
// saldo, se comprueba que cada movimiento cuadre con el anterior. Lo que no se reconoce se puede
// indicar a mano (mapa de columnas) desde la app. Puro: sin Odoo, sin base.
import { createHash } from "node:crypto";
import { leerMonto as montoCR } from "./diferidos.js";

export const CAMPOS = ["fecha", "descripcion", "referencia", "debito", "credito", "monto", "tipo", "saldo"];
// Por campo, patrones del más al menos específico (sobre el encabezado sin tildes, en minúscula).
const PATRONES = {
  fecha: [/^(fecha|fecha (de )?(movimiento|transaccion|operacion|registro)|date|dia)$/, /^fecha (contable|aplicacion|efectiva)$/, /^fecha/, /fecha|date/],
  debito: [/^(debito|debitos|debe|cargo|cargos|retiro|retiros|egreso|egresos|salida|salidas|debit|debits|withdrawal)$/, /(^| )(debito|debitos|cargos?|retiros?|egresos?|debit)( |$)/],
  credito: [/^(credito|creditos|haber|abono|abonos|deposito|depositos|ingreso|ingresos|entrada|entradas|credit|credits|deposit)$/, /(^| )(credito|creditos|abonos?|depositos?|ingresos?|credit)( |$)/],
  monto: [/^(monto|importe|valor|amount|monto (de la )?transaccion|monto movimiento)$/, /(^| )(monto|importe|amount)( |$)/],
  tipo: [/^(tipo|tipo (de )?movimiento|d c|db cr|dc|naturaleza|signo|cr db)$/],
  saldo: [/^(saldo|balance|saldo (disponible|contable|final|actual))$/, /(^| )(saldo|balance)( |$)/],
  referencia: [/^(referencia|ref|documento|comprobante|num(ero)?( de)? (documento|referencia|comprobante)|no (documento|referencia|comprobante)|n documento|reference)$/, /referencia|documento|comprobante|reference/],
  descripcion: [/^(descripcion|concepto|detalle|glosa|description|descripcion (del )?movimiento|transaccion|motivo|narrativa)$/, /descripcion|concepto|detalle|glosa|transaccion|motivo|description/]
};
const ORDEN = ["fecha", "debito", "credito", "monto", "saldo", "tipo", "referencia", "descripcion"];
export const normal = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Columnas de una fila de encabezados → {campo: índice}.
export function reconocerColumnas(encabezados) {
  const h = encabezados.map(normal), usados = new Set(), mapa = {};
  for (const campo of ORDEN) {
    let mejor = null;
    PATRONES[campo].forEach((re, prioridad) => h.forEach((t, i) => {
      if (!t || usados.has(i) || !re.test(t)) return;
      if (!mejor || prioridad < mejor.prioridad) mejor = { i, prioridad };
    }));
    if (mejor) { mapa[campo] = mejor.i; usados.add(mejor.i); }
  }
  return mapa;
}
const sirve = m => m.fecha != null && (m.monto != null || m.debito != null || m.credito != null);

// Fechas: dd/mm/aaaa (lo normal en Costa Rica), aaaa-mm-dd, dd-mmm-aaaa, dd/mm/aa, número de serie de Excel.
const MESES = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, set: 9, sep: 9, oct: 10, nov: 11, dic: 12, dec: 12 };
const dosDigitos = n => String(n).padStart(2, "0");
function partesFecha(v) {
  if (typeof v === "number") {
    if (v < 20000 || v > 80000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return { iso: d.toISOString().slice(0, 10) };
  }
  const s = String(v ?? "").trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return { iso: `${m[1]}-${dosDigitos(m[2])}-${dosDigitos(m[3])}` };
  if ((m = s.match(/^(\d{1,2})[-/. ]([a-z]{3})[a-z]*\.?[-/. ](\d{2,4})/)) && MESES[m[2]]) return { a: Number(m[1]), b: MESES[m[2]], anio: m[3], mesEnLetras: true };
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:\D|$)/))) return { a: Number(m[1]), b: Number(m[2]), anio: m[3] };
  if ((m = s.match(/^(\d{2})(\d{2})(\d{4})$/))) return { a: Number(m[1]), b: Number(m[2]), anio: m[3] };
  return null;
}
function fechaISO(p, formato) {
  if (!p) return null;
  if (p.iso) return valida(p.iso);
  const anio = p.anio.length === 2 ? `20${p.anio}` : p.anio;
  const [dia, mes] = p.mesEnLetras || formato !== "mdy" ? [p.a, p.b] : [p.b, p.a];
  return valida(`${anio}-${dosDigitos(mes)}-${dosDigitos(dia)}`);
}
function valida(iso) {
  const d = new Date(iso + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}
// dmy o mdy según los datos: si algún primer número pasa de 12 es día; si algún segundo, es mes/día.
export function detectarFormatoFecha(valores) {
  let dmy = 0, mdy = 0;
  for (const v of valores) { const p = partesFecha(v); if (!p || p.iso || p.mesEnLetras) continue; if (p.a > 12) dmy++; if (p.b > 12) mdy++; }
  return mdy > dmy ? "mdy" : "dmy";
}

// Montos: 1.250.000,50 · 1,250,000.50 · (1.000,00) · 1.000,00- · -₡1 000 · número de Excel.
export function leerMonto(v) {
  if (typeof v === "number") return v;
  let s = String(v ?? "").trim();
  if (!s) return null;
  let negativo = false;
  if (/^\(.*\)$/.test(s)) { negativo = true; s = s.slice(1, -1); }
  if (/-\s*$/.test(s)) { negativo = true; s = s.replace(/-\s*$/, ""); }
  if (/^\s*[-−]/.test(s) || /^[^\d]*-/.test(s)) { negativo = !negativo; s = s.replace(/[-−]/, ""); }
  const n = montoCR(s.replace(/[A-Za-z]/g, ""));
  if (!Number.isFinite(n)) return null;
  return negativo ? -Math.abs(n) : n;
}
const r2 = x => Math.round(x * 100) / 100;
const esCargo = t => /^(d|db|deb|debito|cargo|retiro|egreso|salida|-)$/.test(normal(t));
const esAbono = t => /^(c|cr|cred|credito|abono|deposito|ingreso|entrada|\+)$/.test(normal(t));

// Filas → movimientos. opciones: { mapa: {campo: índice}, filaEncabezados, formatoFecha: dmy|mdy, invertir }
export function interpretar(filas, { mapa = null, filaEncabezados = null, formatoFecha = null, invertir = null } = {}) {
  const avisos = [];
  let cab = filaEncabezados;
  if (cab == null) {
    for (let i = 0; i < Math.min(filas.length, 40); i++) if (sirve(reconocerColumnas(filas[i] || []))) { cab = i; break; }
  }
  const encabezados = cab != null ? (filas[cab] || []).map(x => String(x ?? "")) : [];
  const m = { ...(cab != null ? reconocerColumnas(encabezados) : {}), ...(mapa || {}) };
  for (const k of Object.keys(m)) if (m[k] == null || m[k] === "" || Number(m[k]) < 0) delete m[k]; else m[k] = Number(m[k]);
  if (!sirve(m)) return { error: "No se encontró la fila de encabezados con la fecha y el monto (o débito y crédito). Indique las columnas a mano.", encabezados, mapa: m, filaEncabezados: cab, movimientos: [] };

  const datos = filas.slice((cab ?? -1) + 1).map((f, k) => ({ f: f || [], fila: (cab ?? -1) + k + 2 }));
  const formato = formatoFecha || detectarFormatoFecha(datos.map(d => d.f[m.fecha]));
  const movimientos = [], errores = [];
  let saldoAnterior = null;
  for (const { f, fila } of datos) {
    const celda = k => (m[k] != null ? f[m[k]] : undefined);
    const texto = k => String(celda(k) ?? "").trim();
    if (!f.some(x => String(x ?? "").trim() !== "")) continue;
    const fecha = fechaISO(partesFecha(celda("fecha")), formato);
    let monto = null;
    if (m.monto != null) {
      const v = leerMonto(celda("monto"));
      if (v != null) monto = m.tipo != null ? (esCargo(texto("tipo")) ? -Math.abs(v) : esAbono(texto("tipo")) ? Math.abs(v) : v) : v;
    } else {
      const d = leerMonto(celda("debito")), c = leerMonto(celda("credito"));
      if (d != null || c != null) monto = Math.abs(c || 0) - Math.abs(d || 0);
    }
    const saldo = m.saldo != null ? leerMonto(celda("saldo")) : null;
    const descripcion = texto("descripcion"), referencia = texto("referencia");
    if (!fecha) {
      // continuación de la descripción de la fila anterior, o una fila de saldo/total
      if (monto == null && descripcion && movimientos.length && !/saldo|total/i.test(descripcion)) movimientos[movimientos.length - 1].descripcion += " " + descripcion;
      else if (/saldo (inicial|anterior)/i.test(f.join(" ")) && saldo != null) saldoAnterior = saldo;
      else if (monto != null && !/saldo|total/i.test(f.join(" "))) errores.push({ fila, motivo: `Fecha ilegible («${String(celda("fecha") ?? "")}»).` });
      continue;
    }
    if (/^saldo (inicial|anterior)/i.test(descripcion) && !monto) { if (saldo != null) saldoAnterior = saldo; continue; }
    if (monto == null) { errores.push({ fila, motivo: "Sin monto legible." }); continue; }
    if (monto === 0) continue;
    movimientos.push({ fila, fecha, descripcion: descripcion.replace(/\s+/g, " ").slice(0, 300), referencia: referencia.slice(0, 80), monto: r2(monto), saldo: saldo == null ? null : r2(saldo) });
  }

  // Orden cronológico (algunos bancos dan el más reciente primero).
  const desc = movimientos.length > 1 && movimientos[0].fecha > movimientos[movimientos.length - 1].fecha;
  if (desc) movimientos.reverse();
  // Cuadre con la columna de saldo: saldo anterior + monto = saldo. Si cuadra solo con los signos al
  // revés, el banco da los cargos en positivo: se invierten (con aviso).
  const cuadre = revisarSaldos(movimientos, saldoAnterior);
  if (invertir === true || (invertir == null && cuadre && cuadre.malos > 0)) {
    const otra = revisarSaldos(movimientos.map(x => ({ ...x, monto: -x.monto })), saldoAnterior);
    if (invertir === true || (otra && otra.malos === 0 && cuadre.malos > 0)) {
      for (const x of movimientos) x.monto = -x.monto;
      if (invertir !== true) avisos.push("Los signos venían al revés (cargos en positivo): se invirtieron para que cuadre el saldo.");
      Object.assign(cuadre || {}, otra);
    }
  }
  const final = cuadre || null;
  if (final && final.malos) avisos.push(`${final.malos} movimientos no cuadran con la columna de saldo (filas ${final.filas.slice(0, 8).join(", ")}): puede faltar una fila o venir un monto mal leído.`);
  if (errores.length) avisos.push(`${errores.length} filas no se pudieron leer.`);

  // Huella para no importar dos veces el mismo movimiento (al subir extractos que se traslapan).
  const vistas = new Map();
  for (const x of movimientos) {
    const base = `${x.fecha}|${x.monto.toFixed(2)}|${normal(x.descripcion)}|${normal(x.referencia)}`;
    const n = (vistas.get(base) || 0) + 1; vistas.set(base, n);
    x.huella = createHash("sha1").update(`${base}|${n}`).digest("hex").slice(0, 20);
  }
  const fechas = movimientos.map(x => x.fecha);
  return {
    encabezados, filaEncabezados: cab, mapa: m, formatoFecha: formato, ordenInverso: desc, movimientos, errores: errores.slice(0, 100), avisos,
    desde: fechas[0] || null, hasta: fechas[fechas.length - 1] || null,
    entradas: r2(movimientos.filter(x => x.monto > 0).reduce((t, x) => t + x.monto, 0)), salidas: r2(movimientos.filter(x => x.monto < 0).reduce((t, x) => t - x.monto, 0)),
    saldoInicial: final ? final.saldoInicial : null, saldoFinal: final ? final.saldoFinal : null, cuadra: final ? final.malos === 0 : null
  };
}

function revisarSaldos(movs, saldoAnterior) {
  const con = movs.filter(x => x.saldo != null);
  if (con.length < 2 && saldoAnterior == null) return null;
  let malos = 0; const filas = [];
  let previo = saldoAnterior;
  for (const x of movs) {
    if (x.saldo == null) { previo = previo == null ? null : r2(previo + x.monto); continue; }
    if (previo != null && Math.abs(r2(previo + x.monto) - x.saldo) > 0.011) { malos++; filas.push(x.fila); }
    previo = x.saldo;
  }
  const primero = movs.find(x => x.saldo != null);
  const saldoInicial = saldoAnterior != null ? saldoAnterior : primero ? r2(primero.saldo - primero.monto) : null;
  const ultimo = [...movs].reverse().find(x => x.saldo != null);
  return { malos, filas, saldoInicial, saldoFinal: ultimo ? ultimo.saldo : null };
}

// Clasificación de un movimiento por su descripción (lo que el emparejamiento no encuentre en libros).
const RE_CARGO = /comision|cargo (por|de|admin|mensual|servicio)|manejo de cuenta|mantenimiento de cuenta|membresia|anualidad|timbre|impuesto|\biva\b|retencion|penalidad|cobro admin|servicio bancario|sobregiro|chequera|costo (de )?(transferencia|sinpe)|\bcom\b|cargo automatico/;
const RE_INTERES = /interes(es)?( ganados?| sobre saldo| acreditados?| a favor)?|rendimiento/;
const RE_TRANSF = /transf|traspaso|\btef\b|sinpe|\bach\b|entre cuentas|cuenta propia|mismo titular/;
export const esTextoCargo = t => RE_CARGO.test(normal(t));
export const esTextoInteres = t => RE_INTERES.test(normal(t));
export function clasificarTexto(descripcion, monto) {
  const t = normal(descripcion);
  if (monto < 0 && RE_CARGO.test(t)) return "cargo";
  if (monto > 0 && RE_INTERES.test(t)) return "interes";
  if (RE_TRANSF.test(t)) return "transferencia";
  return monto > 0 ? "entrada" : "salida";
}
