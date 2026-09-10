// MARTA — RECEPCIÓN. Lectura y notificación. Solo lectura: no escribe nada en Odoo.
//
// Entra a Contabilidad > Proveedores > Correo de facturas (bdt.invoice.email) de TODAS
// las compañías a la vez y hace tres cosas:
//
//   1. Cuenta el desenlace de cada correo y enlista todos los estados.
//   2. Verifica los tiquetes leyendo el tipo de documento en las posiciones 30-31
//      de la clave numérica de 50 dígitos.
//   3. Enlista quiénes son los receptores y consolida por receptor lo que hay que
//      reclamar. Arma dos paquetes y se los entrega a VICTOR (COMUNICACIÓN):
//
//        · Paquete EXTERNO  — tiquetes y rechazados. Victor le escribe al receptor
//          para que le pida al establecimiento la factura real.
//        · Paquete INTERNO  — duplicidad, error, en cola y error de identificación.
//          Victor le escribe al humano dentro de la compañía, con lujo de detalle.
//
//      Marta solo consolida y despliega. No manda un solo correo: eso es de Victor.
//
// No hace: no abre facturas, no toca cuentas contables, no compara contra los libros.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const meta = {
  id: "recepcion",
  nombre: "Marta",
  rol: "RECEPCIÓN",
  puesto: "Lectura y notificación",
  modelo: "bdt.invoice.email",
  escribe: false,
  entregaA: "comunicacion"
};

const ESTADOS = {
  done:       "Registrada como factura de compra",
  isticket:   "Tiquete electrónico (no cuenta en la contabilidad)",
  error:      "Falló el procesamiento",
  rejected:   "Rechazada, nunca se intentó procesar",
  vatiderror: "Error de identificación: cédula del emisor o receptor inválida o ausente",
  duplicate:  "Duplicidad: la clave ya estaba registrada",
  process:    "En cola, pendiente de procesar"
};

// Qué se reclama y a quién.
const RECLAMO_EXTERNO = ["isticket", "rejected"];                  // -> al establecimiento, vía el receptor
const RECLAMO_INTERNO = ["duplicate", "error", "process", "vatiderror"]; // -> al humano de la compañía

const MOTIVO = {
  isticket:   "Le giraron un tiquete electrónico en vez de factura. El tiquete no es deducible: hay que pedir la factura electrónica al establecimiento.",
  rejected:   "El documento fue rechazado y nunca se intentó registrar. Hay que pedirle al establecimiento que reemita la factura correctamente.",
  duplicate:  "La clave ya estaba registrada. Verificar si es un reenvío legítimo o una doble emisión del proveedor.",
  error:      "El procesamiento falló por una condición de la instancia (periodo fiscal, catálogo, formato).",
  process:    "Quedó en cola y nunca terminó de procesarse.",
  vatiderror: "La cédula del emisor o del receptor viene inválida o ausente en el XML."
};

// La clave numérica de 50 dígitos:
// país(3) + fecha(6) + cédula emisor(12) + consecutivo(20) + situación(1) + seguridad(8)
// Dentro del consecutivo, el tipo de documento vive en las posiciones 30-31.
const TIPO_DOC = {
  "01": "Factura electrónica", "02": "Nota de débito", "03": "Nota de crédito",
  "04": "Tiquete electrónico", "08": "Factura de compra", "09": "Factura de exportación"
};
// La clave puede venir en el nombre del archivo o, si no, en el asunto del correo.
function clave(...textos) {
  for (const t of textos) {
    const m = String(t || "").replace(/[^0-9]/g, " ").match(/\d{50}/);
    if (m) return m[0];
  }
  return null;
}
const tipoDeClave    = k => (k ? k.slice(29, 31) : null);
const cedulaEmisor   = k => (k ? k.slice(9, 21).replace(/^0+/, "") : null);
const consecutivoDoc = k => (k ? k.slice(21, 41) : null);
function fechaDeClave(k) {
  if (!k) return null;
  const d = k.slice(3, 5), m = k.slice(5, 7), a = k.slice(7, 9);
  return `20${a}-${m}-${d}`;
}

// to_mail viene sucio: '"alea@x.com" <alea@x.com>' o dos direcciones separadas por coma.
function receptores(toMail) {
  return String(toMail || "")
    .split(/[,;]/)
    .map(s => {
      const m = s.match(/<([^>]+)>/);
      return (m ? m[1] : s).replace(/["'<>\s]/g, "").toLowerCase();
    })
    .filter(s => s.includes("@"));
}

// Cuando la clave no se puede leer, el remitente es la mejor pista de quién emitió.
// '"Colina Hermanos" <facturas@colina.com>' -> nombre "Colina Hermanos", dominio colina.com
function remitenteVisible(fromMail) {
  const s = String(fromMail || "");
  const nom = s.match(/^\s*"?([^"<]+?)"?\s*</);
  const dir = (s.match(/<([^>]+)>/) || [null, s]) [1].trim().toLowerCase();
  const dom = dir.includes("@") ? dir.split("@")[1] : null;
  const nombre = nom ? nom[1].trim() : null;
  return { nombre, direccion: dir, dominio: dom };
}
// El buzón de Hacienda no es el emisor: es el acuse del Ministerio, y su correo no dice
// quién emitió. Igual pasa con los remitentes automáticos de las casas de facturación.
const DOMINIO_HACIENDA = /hacienda\.go\.cr$/i;
const REMITENTE_AUTOMATICO = /^(no-?reply|noreply|facturaci[oó]n|facturas?|documento|comprobante|notificaci|info|soporte|admin)/i;

const horas = (desde, hasta) => (hasta - desde) / 36e5;

export async function ejecutar({ odoo, cfg, log, raiz }) {
  const t0 = Date.now();
  await odoo.conectar();
  log("Conectado a Odoo como uid " + odoo.uid);

  // 1. Compañías de la instancia
  const companias = await odoo.leer("res.company", "search_read", [[], ["name"]], { order: "name" });
  const nombre = Object.fromEntries(companias.map(c => [c.id, c.name]));
  log(`${companias.length} compañías en la instancia`);

  // 2. Conteo por compañía y estado, de un solo viaje
  const grupos = await odoo.leer(meta.modelo, "read_group",
    [[], ["id"], ["company_id", "state"]], { lazy: false });

  // 3. Última ingesta por compañía
  const ultimos = await odoo.leer(meta.modelo, "read_group",
    [[], ["date:max"], ["company_id"]], { lazy: false });
  const ultimaPorCia = Object.fromEntries(
    ultimos.filter(g => g.company_id).map(g => [g.company_id[0], g.date || null]));

  // 4. Foto por compañía
  const porCia = {};
  const porEstado = {};
  for (const g of grupos) {
    if (!g.company_id) continue;
    const id = g.company_id[0], st = g.state || "(nulo)", n = g.__count;
    porEstado[st] = (porEstado[st] || 0) + n;
    const c = porCia[id] || (porCia[id] = {
      id, nombre: nombre[id] || g.company_id[1], total: 0,
      registradas: 0, tiquetes: 0, sinRegistrar: 0, estados: {}
    });
    c.total += n; c.estados[st] = (c.estados[st] || 0) + n;
    if (st === "done") c.registradas += n;
    else if (st === "isticket") c.tiquetes += n;
    else c.sinRegistrar += n;
  }

  const ahora = new Date();
  const lista = Object.values(porCia).map(c => {
    const u = ultimaPorCia[c.id];
    c.ultimaIngesta = u || null;
    c.horasSinIngesta = u ? Math.round(horas(new Date(u.replace(" ", "T") + "Z"), ahora)) : null;
    c.pctOk = c.total ? Math.round((c.registradas / c.total) * 1000) / 10 : 0;
    return c;
  }).sort((a, b) => a.pctOk - b.pctOk);

  const total        = lista.reduce((s, c) => s + c.total, 0);
  const registradas  = lista.reduce((s, c) => s + c.registradas, 0);
  const tiquetes     = lista.reduce((s, c) => s + c.tiquetes, 0);
  const sinRegistrar = total - registradas - tiquetes;
  log(`${total} correos: ${registradas} registrados, ${tiquetes} tiquetes, ${sinRegistrar} sin registrar`);

  // 5. TODO lo que no quedó registrado, con receptor, para consolidar.
  const pendientes = await odoo.leer(meta.modelo, "search_read",
    [[["state", "!=", "done"]],
     ["company_id", "to_mail", "from_mail", "name", "e_invoice_name", "state", "error", "date"]],
    { limit: 5000, order: "date desc" });
  log(`${pendientes.length} correos sin registrar traídos con su receptor`);

  // 6. Nombre del establecimiento: la cédula del emisor sale de la clave.
  const cedulas = [...new Set(pendientes.map(f => cedulaEmisor(clave(f.e_invoice_name, f.name))).filter(Boolean))];
  const socios = cedulas.length
    ? await odoo.leer("res.partner", "search_read", [[["vat", "in", cedulas]], ["vat", "name"]], { limit: 6000 })
    : [];
  const establecimiento = {};
  for (const p of socios) if (!establecimiento[p.vat]) establecimiento[p.vat] = p.name;
  log(`${cedulas.length} emisores distintos; ${Object.keys(establecimiento).length} identificados por cédula`);

  // 7. Normalizar cada correo pendiente a un "caso" reclamable.
  const casos = pendientes.map(f => {
    const k = clave(f.e_invoice_name, f.name);
    const ced = cedulaEmisor(k);
    return {
      id: f.id,
      compania: f.company_id ? f.company_id[1] : "(sin compañía)",
      companiaId: f.company_id ? f.company_id[0] : null,
      receptores: receptores(f.to_mail),
      remitente: f.from_mail || "",
      asunto: f.name || "",
      archivo: f.e_invoice_name || "",
      estado: f.state,
      error: f.error || "",
      fecha: (f.date || "").slice(0, 10),
      clave: k,
      fechaDocumento: fechaDeClave(k),
      consecutivo: consecutivoDoc(k),
      tipo: TIPO_DOC[tipoDeClave(k)] || null,
      cedulaEmisor: ced,
      establecimiento: (ced && establecimiento[ced]) || null,
      identificadoPor: (ced && establecimiento[ced]) ? "clave" : null
    };
  });

  // Dominios que en estos datos son RECEPTORES, no emisores: si el correo viene de uno de
  // ellos es un reenvío interno, no el establecimiento.
  const dominiosReceptores = new Set(
    casos.flatMap(c => c.receptores).map(r => r.split("@")[1]).filter(Boolean));

  // Direcciones que en estos datos son RECEPTORES: si el correo viene de una de ellas,
  // es un reenvío del propio cliente y no dice nada del establecimiento.
  const dirReceptores = new Set(casos.flatMap(c => c.receptores));

  for (const c of casos) {
    if (c.establecimiento) continue;
    // Sin clave legible, el remitente es la única pista. Se toma, pero se dice que es una
    // pista: bien puede ser quien reenvió el correo y no quien emitió el documento.
    const rv = remitenteVisible(c.remitente);
    const inutil = !rv.direccion || dirReceptores.has(rv.direccion)
      || DOMINIO_HACIENDA.test(rv.dominio || "");
    if (!inutil && rv.nombre && !REMITENTE_AUTOMATICO.test(rv.nombre)) {
      c.establecimiento = rv.nombre;
      c.identificadoPor = "remitente (puede ser quien reenvió, no quien emitió)";
    } else if (!inutil && rv.dominio && !dominiosReceptores.has(rv.dominio)) {
      c.establecimiento = rv.dominio;
      c.identificadoPor = "dominio del remitente";
    } else {
      c.identificadoPor = "sin identificar";
      c.reenviadoPor = rv.nombre || rv.direccion || null;
    }
  }

  // 8. Enlistar receptores y consolidar por receptor.
  const porReceptor = {};
  const sinReceptor = [];
  for (const c of casos) {
    if (!c.receptores.length) { sinReceptor.push(c); continue; }
    for (const r of c.receptores) {
      const b = porReceptor[r] || (porReceptor[r] = {
        receptor: r, companias: {}, estados: {}, externos: [], internos: [], total: 0
      });
      b.total++;
      b.estados[c.estado] = (b.estados[c.estado] || 0) + 1;
      b.companias[c.compania] = (b.companias[c.compania] || 0) + 1;
      if (RECLAMO_EXTERNO.includes(c.estado)) b.externos.push(c);
      else if (RECLAMO_INTERNO.includes(c.estado)) b.internos.push(c);
    }
  }

  // Un establecimiento que giró 30 tiquetes es una sola conversación, no 30.
  // El mismo documento entra al buzón varias veces (reenvíos, adjunto y original).
  // Se reclama una vez, diciendo cuántas veces llegó.
  function unificarDocumentos(items) {
    const g = new Map();
    for (const c of items) {
      const llave = c.clave || `${c.estado}|${c.archivo}|${c.asunto}`;
      const y = g.get(llave);
      if (y) { y.veces++; if ((c.fecha || "") > (y.fecha || "")) y.fecha = c.fecha; continue; }
      g.set(llave, { ...c, veces: 1 });
    }
    return [...g.values()];
  }

  function agruparPorEstablecimiento(items) {
    const g = {};
    for (const c of unificarDocumentos(items)) {
      const llave = c.establecimiento || c.cedulaEmisor
        || (c.reenviadoPor ? `(sin identificar · reenviado por ${c.reenviadoPor})` : "(emisor sin identificar)");
      const e = g[llave] || (g[llave] = {
        establecimiento: c.establecimiento || null, cedula: c.cedulaEmisor || null,
        identificadoPor: c.identificadoPor, remitente: c.remitente, reenviadoPor: c.reenviadoPor || null,
        documentos: [], estados: {}
      });
      e.estados[c.estado] = (e.estados[c.estado] || 0) + c.veces;
      e.documentos.push({
        fecha: c.fechaDocumento || c.fecha, consecutivo: c.consecutivo,
        clave: c.clave, tipo: c.tipo, estado: c.estado, asunto: c.asunto, correoId: c.id, veces: c.veces
      });
    }
    return Object.values(g).sort((a, b) => b.documentos.length - a.documentos.length);
  }

  // El texto del error se repite casi igual centenares de veces; lo que importa es la causa.
  function causasDominantes(items) {
    const g = {};
    for (const c of items) {
      const raw = (c.error || ESTADOS[c.estado] || c.estado).trim();
      // se quitan fechas y números para que "periodo fiscal 2025-11-01" y "…2025-12-01" sean la misma causa
      const llave = raw.replace(/\d{4}-\d{2}-\d{2}/g, "«fecha»").replace(/\d{6,}/g, "«número»").slice(0, 160);
      const e = g[llave] || (g[llave] = { causa: llave, correos: 0, ejemplo: raw });
      e.correos++;
    }
    return Object.values(g).sort((a, b) => b.correos - a.correos).slice(0, 8);
  }

  const listaReceptores = Object.values(porReceptor)
    .map(b => ({
      receptor: b.receptor,
      total: b.total,
      companias: Object.entries(b.companias).sort((x, y) => y[1] - x[1]).map(([n, k]) => ({ compania: n, correos: k })),
      estados: b.estados,
      porReclamarAfuera: b.externos.length,
      porRevisarAdentro: b.internos.length
    }))
    .sort((a, b) => b.total - a.total);

  // 9. Los dos paquetes para Victor.
  const paqueteExterno = Object.values(porReceptor)
    .filter(b => b.externos.length)
    .map(b => ({
      receptor: b.receptor,
      companias: [...new Set(b.externos.map(c => c.compania))],
      tiquetes: unificarDocumentos(b.externos.filter(c => c.estado === "isticket")).length,
      rechazados: unificarDocumentos(b.externos.filter(c => c.estado === "rejected")).length,
      correosTiquete: b.externos.filter(c => c.estado === "isticket").length,
      correosRechazo: b.externos.filter(c => c.estado === "rejected").length,
      total: b.externos.length,
      documentosUnicos: unificarDocumentos(b.externos).length,
      establecimientos: agruparPorEstablecimiento(b.externos)
    }))
    .sort((a, b) => b.total - a.total);

  const paqueteInterno = Object.values(porReceptor)
    .filter(b => b.internos.length)
    .map(b => ({
      receptor: b.receptor,
      companias: [...new Set(b.internos.map(c => c.compania))],
      total: b.internos.length,
      documentosUnicos: unificarDocumentos(b.internos).length,
      causas: causasDominantes(b.internos),
      porEstado: ["duplicate", "error", "process", "vatiderror"].map(st => ({
        estado: st, descripcion: ESTADOS[st], motivo: MOTIVO[st],
        correos: b.internos.filter(c => c.estado === st).length,
        detalle: unificarDocumentos(b.internos.filter(c => c.estado === st)).map(c => ({
          correoId: c.id, compania: c.compania, fecha: c.fecha,
          fechaDocumento: c.fechaDocumento, establecimiento: c.establecimiento,
          cedulaEmisor: c.cedulaEmisor, consecutivo: c.consecutivo, clave: c.clave,
          tipo: c.tipo, asunto: c.asunto, remitente: c.remitente, archivo: c.archivo,
          error: c.error, veces: c.veces
        }))
      })).filter(x => x.correos > 0)
    }))
    .sort((a, b) => b.total - a.total);

  // La bandeja que Victor recoge. Marta la deja escrita; no manda nada.
  const bandeja = {
    de: meta.nombre, para: "Victor", corrida: ahora.toISOString(),
    externo: { motivo: MOTIVO, destinatario: "receptor de la factura", receptores: paqueteExterno },
    interno: { motivo: MOTIVO, destinatario: "humano dentro de la compañía", receptores: paqueteInterno }
  };
  if (raiz) {
    mkdirSync(join(raiz, "data"), { recursive: true });
    writeFileSync(join(raiz, "data", "bandeja-victor.json"), JSON.stringify(bandeja, null, 2));
    log(`Bandeja entregada a Victor: ${paqueteExterno.length} receptores por reclamar afuera, ` +
        `${paqueteInterno.length} por revisar adentro`);
  }

  // 10. Control cruzado de tiquetes contra la clave.
  const filasTiquete = casos.filter(c => c.estado === "isticket");
  let conClave = 0, tipo04 = 0;
  const inconsistentes = [];
  for (const c of filasTiquete) {
    const t = tipoDeClave(c.clave);
    if (!t) continue;
    conClave++;
    if (t === "04") tipo04++;
    else inconsistentes.push({ id: c.id, compania: c.compania, tipo: t, esperado: "04" });
  }
  const filasDone = await odoo.leer(meta.modelo, "search_read",
    [[["state", "=", "done"]], ["company_id", "e_invoice_name"]], { limit: 12000 });
  const coladosComoFactura = filasDone
    .filter(f => tipoDeClave(clave(f.e_invoice_name)) === "04")
    .map(f => ({ id: f.id, compania: f.company_id ? f.company_id[1] : "—" }));
  log(`Tiquetes: ${filasTiquete.length}; con clave legible ${conClave}, de tipo 04 ${tipo04}; ` +
      `colados como factura ${coladosComoFactura.length}`);

  // 11. Alertas
  const umbralH   = Number(cfg.ALERTA_HORAS_SIN_INGESTA || 24);
  const umbralPct = Number(cfg.ALERTA_PCT_MINIMO || 90);
  const caidos = lista.filter(c => c.horasSinIngesta === null || c.horasSinIngesta > umbralH);
  const bajos  = lista.filter(c => c.total >= 20 && c.pctOk < umbralPct);
  const alertas = [];
  // Ojo: un correo dirigido a dos receptores genera dos avisos, pero es un solo documento.
  const docsExterno  = casos.filter(c => RECLAMO_EXTERNO.includes(c.estado)).length;
  const docsInterno  = casos.filter(c => RECLAMO_INTERNO.includes(c.estado)).length;
  const unicosExterno = unificarDocumentos(casos.filter(c => RECLAMO_EXTERNO.includes(c.estado))).length;
  const unicosInterno = unificarDocumentos(casos.filter(c => RECLAMO_INTERNO.includes(c.estado))).length;
  const totalExterno = paqueteExterno.reduce((s, r) => s + r.total, 0);
  const totalInterno = paqueteInterno.reduce((s, r) => s + r.total, 0);
  if (totalExterno) alertas.push({
    nivel: "alto",
    texto: `${unicosExterno} documentos distintos (${docsExterno} correos) hay que reclamarle al establecimiento: ${totalExterno} avisos a ${paqueteExterno.length} receptores. Paquete entregado a Victor.`,
    detalle: paqueteExterno.slice(0, 10).map(r =>
      `${r.receptor} — ${r.tiquetes} tiquetes y ${r.rechazados} rechazados, de ${r.establecimientos.length} establecimientos`)
  });
  if (totalInterno) alertas.push({
    nivel: "alto",
    texto: `${unicosInterno} documentos distintos (${docsInterno} correos) necesitan que alguien de adentro los revise: ${totalInterno} avisos a ${paqueteInterno.length} receptores. Paquete entregado a Victor.`,
    detalle: paqueteInterno.slice(0, 10).map(r =>
      `${r.receptor} — ${r.porEstado.map(e => `${e.correos} ${e.estado}`).join(", ")}`)
  });
  if (caidos.length) alertas.push({
    nivel: "critico",
    texto: `${caidos.length} de ${lista.length} buzones sin un correo nuevo en más de ${umbralH} h.`,
    detalle: caidos.slice(0, 10).map(c => `${c.nombre} — ${c.horasSinIngesta === null ? "nunca" : c.horasSinIngesta + " h"}`)
  });
  if (bajos.length) alertas.push({
    nivel: "alto",
    texto: `${bajos.length} compañías por debajo del ${umbralPct} % de registro.`,
    detalle: bajos.slice(0, 10).map(c => `${c.nombre} — ${c.pctOk} % (${c.sinRegistrar} sin registrar de ${c.total})`)
  });
  if (inconsistentes.length || coladosComoFactura.length) alertas.push({
    nivel: "alto",
    texto: `Clasificación de tiquetes inconsistente: ${inconsistentes.length} mal marcados, ${coladosComoFactura.length} colados como factura.`,
    detalle: [...inconsistentes, ...coladosComoFactura].slice(0, 10).map(x => `id ${x.id} — ${x.compania}`)
  });
  if (sinReceptor.length) alertas.push({
    nivel: "alto",
    texto: `${sinReceptor.length} correos sin registrar no traen receptor legible: nadie a quién avisarle.`,
    detalle: sinReceptor.slice(0, 10).map(c => `id ${c.id} — ${c.compania} — ${c.asunto.slice(0, 60)}`)
  });
  if (!alertas.length) alertas.push({ nivel: "ok", texto: "Sin novedades. Todos los buzones al día.", detalle: [] });

  return {
    agente: meta.nombre,
    rol: meta.rol,
    titulo: "Buzón de facturas: desenlace, tiquetes y qué reclamar",
    corrida: ahora.toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10,
    llamadasOdoo: odoo.llamadas,
    totales: {
      total, registradas, tiquetes, sinRegistrar,
      pctOk: total ? Math.round((registradas / total) * 1000) / 10 : 0,
      companias: lista.length,
      receptores: listaReceptores.length,
      porReclamarAfuera: docsExterno,
      documentosAfuera: unicosExterno,
      porRevisarAdentro: docsInterno,
      documentosAdentro: unicosInterno,
      avisosAfuera: totalExterno,
      avisosAdentro: totalInterno
    },
    porEstado: Object.entries(porEstado).sort((a, b) => b[1] - a[1])
      .map(([st, n]) => ({ estado: st, descripcion: ESTADOS[st] || "—", correos: n })),
    verificacionTiquetes: {
      total: filasTiquete.length, conClaveLegible: conClave, confirmadosTipo04: tipo04,
      inconsistentes, coladosComoFactura,
      veredicto: (inconsistentes.length + coladosComoFactura.length) === 0
        ? "Consistente: ningún tiquete se registró como factura."
        : "Revisar: la clasificación no calza con la clave."
    },
    receptores: listaReceptores,
    paraVictor: {
      externo: paqueteExterno,
      interno: paqueteInterno,
      archivo: "data/bandeja-victor.json"
    },
    sinReceptor: sinReceptor.slice(0, 50),
    companias: lista,
    alertas,
    tiposDocumento: TIPO_DOC
  };
}
