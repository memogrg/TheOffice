// Registro de activos fijos (ítem 16) desde la app, el Director o la hoja del cliente en CSV.
// Valida compañía y cuentas por código en el plan de cada una. No escribe en Odoo: la
// depreciación de cada mes la propone el agente Depreciación en la cola de asientos.
import { leerCSV, leerMes, leerMonto, calendario } from "../lib/diferidos.js";
import { cuentasPorCodigo } from "./asientos.js";
import { companias, resolverCia } from "./diferidos.js";

const CAMPOS = {
  compania: ["compania", "empresa", "cliente", "compania_id"],
  descripcion: ["descripcion", "detalle", "activo", "bien", "nombre"],
  categoria: ["categoria", "tipo", "clase", "grupo"],
  cuentaActivo: ["cuenta_activo", "cuenta_costo", "cuenta_del_activo"],
  cuentaAcumulada: ["cuenta_depreciacion_acumulada", "cuenta_acumulada", "depreciacion_acumulada", "cuenta_depreciacion"],
  cuentaGasto: ["cuenta_gasto", "cuenta_gasto_depreciacion", "gasto_depreciacion", "gasto"],
  costo: ["costo", "valor", "monto", "costo_adquisicion", "valor_original"],
  residual: ["residual", "valor_residual", "valor_de_rescate", "rescate"],
  vidaMeses: ["vida_meses", "meses", "vida_util_meses"],
  vidaAnios: ["vida_anios", "vida_anos", "anios", "anos", "vida_util", "vida_util_anios", "vida_util_anos"],
  inicio: ["inicio", "mes_inicio", "fecha_inicio", "fecha_adquisicion", "desde"],
  hechoHasta: ["depreciado_hasta", "hecho_hasta", "depreciacion_registrada_hasta"],
  referencia: ["referencia", "factura", "documento", "placa", "serie"]
};
const campo = (fila, k) => { for (const n of CAMPOS[k]) if (fila[n] != null && String(fila[n]).trim() !== "") return String(fila[n]).trim(); return null; };
const num = v => (typeof v === "number" ? v : leerMonto(v));

async function preparar({ corridas, d, lista, plan = new Map() }) {
  const errores = [];
  const cia = resolverCia(lista, d.compania);
  if (!cia) errores.push(`Compañía «${d.compania ?? ""}» no encontrada (o el nombre coincide con varias).`);
  if (!String(d.descripcion || "").trim()) errores.push("Falta la descripción.");
  const costo = num(d.costo), residual = d.residual == null || d.residual === "" ? 0 : num(d.residual);
  if (!(costo > 0)) errores.push("El costo tiene que ser mayor que cero.");
  if (!(residual >= 0) || residual >= costo) errores.push("El valor residual tiene que ser cero o menor que el costo.");
  const vida = d.vidaMeses ? Number(d.vidaMeses) : d.vidaAnios ? Math.round(num(d.vidaAnios) * 12) : NaN;
  if (!Number.isInteger(vida) || vida < 1 || vida > 1200) errores.push("Vida útil: en meses (1 a 1200) o en años.");
  const inicio = leerMes(d.inicio);
  if (!inicio) errores.push("Inicio: mes en que empieza a depreciarse (AAAA-MM o MM/AAAA).");
  const hechoHasta = d.hechoHasta ? leerMes(d.hechoHasta) : null;
  if (d.hechoHasta && !hechoHasta) errores.push("«Depreciado hasta» no es un mes válido.");
  if (!d.cuentaAcumulada || !d.cuentaGasto) errores.push("Faltan las cuentas de depreciación acumulada y de gasto (por código).");
  const cuentas = {};
  if (cia && d.cuentaAcumulada && d.cuentaGasto) {
    const cods = [d.cuentaAcumulada, d.cuentaGasto, d.cuentaActivo].filter(Boolean);
    const m = await cuentasPorCodigo({ corridas, companiaId: cia.id, codigos: cods, cache: plan });
    for (const [k, cod] of [["acumulada", d.cuentaAcumulada], ["gasto", d.cuentaGasto], ["activo", d.cuentaActivo]]) {
      if (!cod) continue;
      cuentas[k] = m.get(String(cod).trim());
      if (!cuentas[k]) errores.push(`La cuenta ${cod} no existe (o está obsoleta) en ${cia.name}.`);
    }
  }
  if (errores.length) return { errores };
  const txt = c => (c ? `${c.code} ${c.name}` : null);
  return { activo: { companiaId: cia.id, compania: cia.name, descripcion: String(d.descripcion).trim().slice(0, 200), categoria: d.categoria ? String(d.categoria).slice(0, 80) : null,
    cuentaActivoId: cuentas.activo?.id ?? null, cuentaActivo: txt(cuentas.activo), cuentaAcumuladaId: cuentas.acumulada.id, cuentaAcumulada: txt(cuentas.acumulada),
    cuentaGastoId: cuentas.gasto.id, cuentaGasto: txt(cuentas.gasto), costo: Math.round(costo * 100) / 100, residual: Math.round(residual * 100) / 100, vidaMeses: vida, inicio, hechoHasta,
    referencia: d.referencia ? String(d.referencia).slice(0, 120) : null } };
}
// el calendario de un activo: (costo − residual) en vida_meses cuotas desde inicio
export const cal = a => calendario({ monto: Number(a.costo) - Number(a.residual || 0), meses: a.vida_meses ?? a.vidaMeses, inicio: a.inicio });

export async function registrar({ corridas, db, d, quien }) {
  const r = await preparar({ corridas, d, lista: await companias(corridas) });
  if (r.errores) return { error: r.errores.join(" ") };
  const x = db.registrarActivo(r.activo, quien);
  const c = cal(x);
  return { activo: x, cuota: c[0].cuota, fin: c[c.length - 1].mes,
    siguiente: "Queda registrado. El agente Depreciación propone cada mes el asiento en Aprobaciones → Asientos." };
}

export async function importar({ corridas, db, texto, quien, probar = false, companiaPorDefecto = null }) {
  const filas = leerCSV(texto);
  if (!filas.length) return { error: "El archivo no tiene filas (¿tiene la fila de encabezados?)." };
  const lista = await companias(corridas);
  const plan = new Map(), ok = [], errores = [];
  for (const f of filas) {
    const d = Object.fromEntries(Object.keys(CAMPOS).map(k => [k, campo(f, k)]));
    d.compania = d.compania ?? companiaPorDefecto;
    const r = await preparar({ corridas, d, lista, plan });
    if (r.errores) errores.push({ fila: f._fila, errores: r.errores, datos: d });
    else ok.push({ fila: f._fila, ...r.activo });
  }
  const creados = probar ? [] : ok.map(a => db.registrarActivo(a, quien).id);
  return { filas: filas.length, validos: ok.length, creados: creados.length, errores, vista: ok.slice(0, 200) };
}
