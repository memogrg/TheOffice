// Subida de extractos bancarios (fase 3C): vista previa e importación. Lee Odoo (los diarios de
// banco) y escribe solo en la base de la app. El emparejamiento con los libros lo hace el agente
// Extractos, que corre solo después de importar.
import { filasDeArchivo } from "../lib/archivos.js";
import { interpretar, CAMPOS } from "../lib/extractos.js";

const idDe = v => (Array.isArray(v) ? v[0] : v);
const nombreDe = v => (Array.isArray(v) ? v[1] : v);
export const MAX_MOVIMIENTOS = 20000;

// Diarios de banco de todas las compañías, para elegir a cuál pertenece el extracto.
export async function diarios({ corridas }) {
  const odoo = corridas.crearCliente({ meta: { escribe: false } });
  const [ds, cias] = await Promise.all([
    odoo.leer("account.journal", "search_read", [[["type", "=", "bank"]], ["name", "company_id", "default_account_id", "currency_id", "bank_acc_number"]], {}),
    odoo.leer("res.company", "search_read", [[], ["name", "currency_id"]], {})
  ]);
  return ds.map(d => {
    const cia = cias.find(c => c.id === idDe(d.company_id));
    return { id: d.id, nombre: d.name, companiaId: idDe(d.company_id), compania: nombreDe(d.company_id), cuentaId: idDe(d.default_account_id) || null,
      cuenta: nombreDe(d.default_account_id) || null, numero: d.bank_acc_number || null, moneda: nombreDe(d.currency_id) || nombreDe(cia?.currency_id) || null };
  }).sort((a, b) => String(a.compania).localeCompare(String(b.compania)) || a.nombre.localeCompare(b.nombre));
}

function opcionesDe(c) {
  const mapa = {};
  for (const k of CAMPOS) if (c.mapa && c.mapa[k] != null && c.mapa[k] !== "") mapa[k] = Number(c.mapa[k]);
  return { mapa: Object.keys(mapa).length ? mapa : null, filaEncabezados: c.filaEncabezados == null || c.filaEncabezados === "" ? null : Number(c.filaEncabezados),
    formatoFecha: ["dmy", "mdy"].includes(c.formatoFecha) ? c.formatoFecha : null, invertir: c.invertir === true ? true : null };
}

async function preparar({ corridas, db, cuerpo }) {
  const diarioId = Number(cuerpo.diarioId);
  if (!diarioId) return { error: "Elija la cuenta de banco (diario) del extracto." };
  if (!cuerpo.archivo || !cuerpo.archivo.base64) return { error: "Falta el archivo." };
  const d = (await diarios({ corridas })).find(x => x.id === diarioId);
  if (!d) return { error: "Ese diario no existe o no es de banco." };
  let leido;
  try { leido = filasDeArchivo(cuerpo.archivo); } catch (e) { return { error: e.message }; }
  const r = interpretar(leido.filas, opcionesDe(cuerpo));
  if (r.error) return { error: r.error, diario: d, formato: leido.formato, encabezados: r.encabezados, mapa: r.mapa, muestra: leido.filas.slice(0, 15) };
  if (!r.movimientos.length) return { error: "No se encontró ningún movimiento con fecha y monto.", diario: d, formato: leido.formato, encabezados: r.encabezados, mapa: r.mapa, muestra: leido.filas.slice(0, 15) };
  if (r.movimientos.length > MAX_MOVIMIENTOS) return { error: `El archivo tiene ${r.movimientos.length} movimientos; el máximo es ${MAX_MOVIMIENTOS}. Divídalo por mes.` };
  const ya = db.huellasExtracto(d.id);
  const repetidos = r.movimientos.filter(m => ya.has(m.huella)).length;
  const hoy = new Date().toISOString().slice(0, 10);
  if (r.hasta > hoy) r.avisos.push(`Hay movimientos con fecha futura (${r.hasta}): revise el formato de fecha (día/mes o mes/día).`);
  if (repetidos === r.movimientos.length) r.avisos.push("Todos los movimientos ya se habían importado antes para esta cuenta.");
  else if (repetidos) r.avisos.push(`${repetidos} movimientos ya se habían importado (extractos que se traslapan): no se duplican.`);
  return { diario: d, formato: leido.formato, ...r, repetidos, nuevos: r.movimientos.length - repetidos };
}

export async function vistaPrevia({ corridas, db, cuerpo }) {
  const r = await preparar({ corridas, db, cuerpo });
  if (r.error) return r;
  const { movimientos, ...resto } = r;
  return { ...resto, total: movimientos.length, movimientos: movimientos.slice(0, 40), ultimos: movimientos.length > 40 ? movimientos.slice(-5) : [] };
}

export async function importar({ corridas, db, cuerpo, quien }) {
  const r = await preparar({ corridas, db, cuerpo });
  if (r.error) return r;
  const d = r.diario;
  const x = db.registrarExtracto({ companiaId: d.companiaId, compania: d.compania, diarioId: d.id, diario: d.nombre, cuentaId: d.cuentaId, moneda: d.moneda,
    archivo: String(cuerpo.archivo.nombre || "").slice(0, 200), formato: r.formato, desde: r.desde, hasta: r.hasta,
    saldoInicial: r.saldoInicial, saldoFinal: r.saldoFinal, cuadra: r.cuadra }, r.movimientos, quien);
  return { extracto: db.extracto(x.id), nuevos: x.nuevos, repetidos: x.repetidos, avisos: r.avisos };
}
