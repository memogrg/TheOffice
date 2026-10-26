// Proponer una regla contable (paso 0 de la guía): desde el chat del Director o desde una consulta
// del contador. Nunca escribe en Odoo: deja la regla en reglas_propuestas, que un contable aprueba.
// Valida la cuenta en el plan de esa compañía y estima cuántas líneas tocaría hoy.
import { canon, norm } from "../catalogo.js";
import { Clasificador } from "../clasificador.js";

export async function proponerRegla({ corridas, db, compania, codigo, proveedorId = null, articulos = [], naturaleza = null, motivo = "", factura = null, propuso }) {
  if (!db?.proponerRegla) return { error: "Esta instalación no guarda reglas propuestas." };
  const CID = Number(compania);
  const arts = (articulos || []).map(s => String(s).trim()).filter(Boolean);
  if (!CID) return { error: "Falta la compañía (compania = id)." };
  if (!codigo) return { error: "Falta el código de la cuenta destino." };
  if (!proveedorId && !arts.length && !naturaleza) return { error: "Indique el alcance: proveedor_id (todo lo de ese proveedor), articulos (descripciones de línea) o naturaleza (tipo de gasto)." };
  const clas = new Clasificador({});
  if (naturaleza && !clas.porCategoria.has(naturaleza)) return { error: `No existe la naturaleza «${naturaleza}». Opciones: ${[...clas.porCategoria.keys()].join(", ")}.` };
  const odoo = corridas.crearCliente({ meta: { escribe: false } });
  const ctx = { context: { allowed_company_ids: [CID] } };
  const [cia] = await odoo.leer("res.company", "search_read", [[["id", "=", CID]], ["name"]]);
  if (!cia) return { error: `No existe la compañía ${CID}.` };
  const plan = await odoo.leerTodo("account.account", [["company_ids", "in", [CID]]], ["code", "name", "deprecated"], { context: ctx.context });
  const destino = plan.find(c => !c.deprecated && canon(c.code) === canon(codigo));
  if (!destino) {
    const cerca = plan.filter(c => c.code && canon(c.code).startsWith(canon(codigo).split(".").slice(0, 3).join("."))).slice(0, 8).map(c => `${c.code} ${c.name}`);
    return { error: `La cuenta ${codigo} no existe (o está obsoleta) en el plan de ${cia.name}.`, parecidas: cerca };
  }
  // Nunca un comodín como destino (guía, principio 4)
  if (["5.04.99", "5.04.999", "7.01.01", "7.01.001", "7.01"].map(canon).includes(canon(destino.code)))
    return { error: `${destino.code} ${destino.name} es un comodín: la guía no permite usarlo como destino de una regla.` };
  let proveedor = null;
  if (proveedorId) {
    const [p] = await odoo.leer("res.partner", "search_read", [[["id", "=", Number(proveedorId)]], ["name", "vat"]]);
    if (!p) return { error: `No existe el proveedor ${proveedorId}.` };
    proveedor = p;
  }
  // alcance de hoy: líneas de facturas de proveedor de esa compañía que cambiarían
  const dom = [["move_id.move_type", "in", ["in_invoice", "in_refund"]], ["company_id", "=", CID], ["display_type", "in", ["product", "other"]],
    ["parent_state", "in", ["draft", "posted"]], ["account_id", "!=", destino.id]];
  if (proveedor) dom.push(["partner_id", "=", proveedor.id]);
  let lineas = null;
  if (!naturaleza) try {
    const filas = await odoo.leerTodo("account.move.line", dom, ["name", "move_id"], { context: ctx.context });
    lineas = proveedor ? filas.length : filas.filter(l => arts.some(a => norm(a) === norm(l.name))).length;
  } catch { /* el estimado es informativo */ }
  let ejemplo = null;
  if (factura) { const [f] = await odoo.leer("account.move", "search_read", [[["id", "=", Number(factura)]], ["name"]], ctx); ejemplo = f ? `${f.name} (id ${f.id})` : null; }
  const alcances = naturaleza ? [{ naturaleza }] : proveedor ? [{ proveedorId: proveedor.id, proveedor: proveedor.name }] : arts.map(a => ({ articulo: a }));
  const creadas = alcances
    .map(alc => db.proponerRegla({ companiaId: CID, compania: cia.name, ...alc, codigo: destino.code, cuenta: destino.name, cuentaId: destino.id,
      motivo: String(motivo || "").slice(0, 500), ejemplo, lineas, propuso }));
  return { propuestas: creadas.map(r => ({ id: r.id, alcance: r.naturaleza ? `todo gasto de tipo «${clas.porCategoria.get(r.naturaleza)?.naturaleza || r.naturaleza}»` : r.proveedor ? `todo lo de ${r.proveedor}` : `artículo «${r.articulo}»`, compania: r.compania, cuenta: `${r.codigo} ${r.cuenta}` })),
    lineasAfectadasHoy: lineas,
    siguiente: "Queda en la pestaña Aprobaciones → Reglas. Al aprobarla, Cuentas revisa de nuevo la compañía y cada línea afectada aparece como propuesta para aprobar; aplicar en Odoo sigue bloqueado hasta que se permita la escritura." };
}
