// Registro de gastos diferidos desde la app o el Director: valida la compañía y las cuentas (por
// código, en el plan de esa compañía) y guarda. Importa también la hoja de cálculo de un cliente
// guardada como CSV. No escribe en Odoo.
import { leerCSV, leerMes, leerMonto, calendario } from "../lib/diferidos.js";
import { cuentasPorCodigo } from "./asientos.js";

const CAMPOS = {
  compania: ["compania", "empresa", "cliente", "compania_id"],
  descripcion: ["descripcion", "detalle", "concepto", "nombre"],
  cuentaActivo: ["cuenta_activo", "cuenta_diferido", "activo", "cuenta_del_activo", "cuenta_balance"],
  cuentaGasto: ["cuenta_gasto", "gasto", "cuenta_del_gasto", "cuenta_resultados"],
  monto: ["monto", "monto_total", "total", "valor"],
  meses: ["meses", "plazo", "cuotas", "plazo_meses"],
  inicio: ["inicio", "mes_inicio", "fecha_inicio", "desde", "primer_mes"],
  referencia: ["referencia", "factura", "documento", "contrato", "poliza"]
};
const campo = (fila, k) => { for (const n of CAMPOS[k]) if (fila[n] != null && String(fila[n]).trim() !== "") return String(fila[n]).trim(); return null; };

async function companias(corridas) {
  const odoo = corridas.crearCliente({ meta: { escribe: false } });
  return odoo.leer("res.company", "search_read", [[], ["name"]], {});
}
const resolverCia = (lista, v) => {
  if (v == null) return null;
  if (/^\d+$/.test(String(v))) return lista.find(c => c.id === Number(v)) || null;
  const n = String(v).toLowerCase();
  return lista.find(c => c.name.toLowerCase() === n) || (lista.filter(c => c.name.toLowerCase().includes(n)).length === 1 ? lista.find(c => c.name.toLowerCase().includes(n)) : null);
};

// Valida un diferido (sin guardarlo). d: { compania (id o nombre), descripcion, cuentaActivo, cuentaGasto (códigos), monto, meses, inicio, referencia }
async function preparar({ corridas, d, lista, plan = new Map() }) {
  const errores = [];
  const cia = resolverCia(lista, d.compania);
  if (!cia) errores.push(`Compañía «${d.compania ?? ""}» no encontrada (o el nombre coincide con varias).`);
  if (!String(d.descripcion || "").trim()) errores.push("Falta la descripción.");
  const monto = typeof d.monto === "number" ? d.monto : leerMonto(d.monto);
  if (!(monto > 0)) errores.push("El monto tiene que ser mayor que cero.");
  const meses = Number(d.meses);
  if (!Number.isInteger(meses) || meses < 1 || meses > 600) errores.push("Meses: un entero entre 1 y 600.");
  const inicio = leerMes(d.inicio);
  if (!inicio) errores.push("Inicio: mes de la primera cuota (AAAA-MM o MM/AAAA).");
  if (!d.cuentaActivo || !d.cuentaGasto) errores.push("Faltan las cuentas (código del activo diferido y del gasto).");
  let activo = null, gasto = null;
  if (cia && d.cuentaActivo && d.cuentaGasto) {
    const m = await cuentasPorCodigo({ corridas, companiaId: cia.id, codigos: [d.cuentaActivo, d.cuentaGasto], cache: plan });
    activo = m.get(String(d.cuentaActivo).trim()); gasto = m.get(String(d.cuentaGasto).trim());
    if (!activo) errores.push(`La cuenta ${d.cuentaActivo} no existe (o está obsoleta) en ${cia.name}.`);
    if (!gasto) errores.push(`La cuenta ${d.cuentaGasto} no existe (o está obsoleta) en ${cia.name}.`);
  }
  if (errores.length) return { errores };
  return { diferido: { companiaId: cia.id, compania: cia.name, descripcion: String(d.descripcion).trim().slice(0, 200), cuentaActivoId: activo.id, cuentaActivo: `${activo.code} ${activo.name}`,
    cuentaGastoId: gasto.id, cuentaGasto: `${gasto.code} ${gasto.name}`, monto: Math.round(monto * 100) / 100, meses, inicio, referencia: d.referencia ? String(d.referencia).slice(0, 120) : null } };
}

export async function registrar({ corridas, db, d, quien }) {
  const lista = await companias(corridas);
  const r = await preparar({ corridas, d, lista });
  if (r.errores) return { error: r.errores.join(" ") };
  const x = db.registrarDiferido(r.diferido, quien);
  const cal = calendario(x);
  return { diferido: x, cuota: cal[0].cuota, fin: cal[cal.length - 1].mes,
    siguiente: "Queda registrado. El agente Diferidos propone cada mes el asiento con la cuota (y las atrasadas) en Aprobaciones → Asientos." };
}

// Importa un CSV (encabezados flexibles). Con probar=true solo valida y devuelve lo que haría.
export async function importar({ corridas, db, texto, quien, probar = false, companiaPorDefecto = null }) {
  const filas = leerCSV(texto);
  if (!filas.length) return { error: "El archivo no tiene filas (¿tiene la fila de encabezados?)." };
  const lista = await companias(corridas);
  const plan = new Map(), ok = [], errores = [];
  for (const f of filas) {
    const d = { compania: campo(f, "compania") ?? companiaPorDefecto, descripcion: campo(f, "descripcion"), cuentaActivo: campo(f, "cuentaActivo"), cuentaGasto: campo(f, "cuentaGasto"),
      monto: campo(f, "monto"), meses: campo(f, "meses"), inicio: campo(f, "inicio"), referencia: campo(f, "referencia") };
    const r = await preparar({ corridas, d, lista, plan });
    if (r.errores) errores.push({ fila: f._fila, errores: r.errores, datos: d });
    else ok.push({ fila: f._fila, ...r.diferido });
  }
  const creados = probar ? [] : ok.map(d => db.registrarDiferido(d, quien).id);
  return { filas: filas.length, validos: ok.length, creados: creados.length, errores, vista: ok.slice(0, 200) };
}
