// AGENTE CONCILIACION — solo lectura.
// Toma cada correo que el buzon dio por registrado, saca la clave numerica del XML
// y verifica que exista la factura correspondiente en la contabilidad.
// Lo que no aparece es un gasto que el sistema da por bueno y no esta en los libros.

export const meta = {
  id: "conciliacion", nombre: "CONCILIACION", puesto: "Cruza con la contabilidad",
  modelo: "bdt.invoice.email", escribe: false
};

const clave = n => { const m = n && String(n).match(/\d{50}/); return m ? m[0] : null; };
const tipoDoc = c => c ? c.slice(29, 31) : null;
const TIPO = { "01":"Factura electronica","02":"Nota de debito","03":"Nota de credito",
               "04":"Tiquete electronico","08":"Factura de compra","09":"Factura de exportacion" };

async function paginar(odoo, modelo, dominio, campos, log, etiqueta){
  const out = []; const paso = 4000;
  for (let off = 0; ; off += paso){
    const lote = await odoo.leer(modelo, "search_read", [dominio, campos], { limit: paso, offset: off });
    out.push(...lote);
    if (lote.length < paso) break;
    log(`${etiqueta}: ${out.length} leidos...`);
  }
  return out;
}

export async function ejecutar({ odoo, cfg, log }){
  const t0 = Date.now();
  await odoo.conectar();

  // 1. Todas las claves que existen en la contabilidad
  const asientos = await paginar(odoo, "account.move",
    [["e_key", "!=", false]], ["e_key", "company_id", "move_type", "state"], log, "asientos");
  const enLibros = new Map();
  for (const a of asientos) if (a.e_key) enLibros.set(a.e_key, a);
  log(`${asientos.length} asientos con clave en la contabilidad`);

  // 2. Todos los correos dados por registrados
  const correos = await paginar(odoo, meta.modelo,
    [["state", "=", "done"]], ["company_id", "e_invoice_name", "name", "date"], log, "correos");
  log(`${correos.length} correos en estado done`);

  // 3. El cruce
  const huecos = [], porCia = {};
  let conClave = 0, verificados = 0;
  const vistas = new Set();
  for (const c of correos){
    const k = clave(c.e_invoice_name);
    if (!k) continue;
    conClave++;
    if (vistas.has(k)) continue;          // el mismo documento pudo llegar varias veces
    vistas.add(k);
    const cia = c.company_id ? c.company_id[1] : "(sin compania)";
    const ciaId = c.company_id ? c.company_id[0] : 0;
    porCia[cia] = porCia[cia] || { compania: cia, id: ciaId, verificables: 0, sinAsiento: 0, documentos: [] };
    porCia[cia].verificables++;
    if (enLibros.has(k)) { verificados++; continue; }
    porCia[cia].sinAsiento++;
    const h = { clave: k, tipo: TIPO[tipoDoc(k)] || tipoDoc(k), compania: cia, companiaId: ciaId,
                fecha: (c.date || "").slice(0, 10), asunto: String(c.name || "").slice(0, 90), correoId: c.id };
    huecos.push(h);
    if (porCia[cia].documentos.length < 25) porCia[cia].documentos.push(h);
  }
  log(`${vistas.size} claves unicas verificables; ${huecos.length} sin asiento en la contabilidad`);

  const lista = Object.values(porCia)
    .map(c => { c.pct = c.verificables ? Math.round((c.sinAsiento / c.verificables) * 1000) / 10 : 0; return c; })
    .filter(c => c.sinAsiento > 0)
    .sort((a, b) => b.sinAsiento - a.sinAsiento);

  const porTipo = {};
  for (const h of huecos) porTipo[h.tipo] = (porTipo[h.tipo] || 0) + 1;

  const alertas = [];
  if (huecos.length) alertas.push({
    nivel: huecos.length > 100 ? "critico" : "alto",
    texto: `${huecos.length} documentos dados por registrados no tienen factura en la contabilidad.`,
    detalle: lista.slice(0, 10).map(c => `${c.compania} — ${c.sinAsiento} de ${c.verificables} (${c.pct} %)`)
  });
  else alertas.push({ nivel: "ok", texto: "Todo correo registrado tiene su factura en los libros.", detalle: [] });

  return {
    agente: meta.nombre, corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    totales: {
      correosDone: correos.length, conClaveLegible: conClave, clavesUnicas: vistas.size,
      conAsiento: verificados, sinAsiento: huecos.length,
      pctCuadrado: vistas.size ? Math.round((verificados / vistas.size) * 1000) / 10 : 0,
      companiasAfectadas: lista.length
    },
    porTipoDocumento: Object.entries(porTipo).sort((a,b) => b[1]-a[1]).map(([t,n]) => ({ tipo: t, documentos: n })),
    companias: lista,
    huecos: huecos.slice(0, 600),
    alertas
  };
}
