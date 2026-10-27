// AGENTE DIAGNÓSTICO — solo lectura. Fase 3A.
// Lee los correos del buzón que no terminaron bien (error, cédula inválida, en cola, duplicados,
// rechazados) de TODAS las compañías, reconoce la causa en el texto del error y dice qué hay que
// hacer, quién lo hace y si se arregla con configuración (adentro) o pidiéndole algo al emisor
// (afuera). Determinista: las causas conocidas son expresiones en CAUSAS; lo que no reconoce lo
// agrupa por texto para que una persona le ponga nombre.
import { clave } from "../lib/clave.js";

export const meta = {
  id: "diagnostico", nombre: "DIAGNÓSTICO", puesto: "Explica por qué fallan los correos",
  modelo: "bdt.invoice.email", escribe: false
};

// Cada causa: cómo se reconoce, qué significa, qué hacer, quién, y de qué tipo es el arreglo.
export const CAUSAS = [
  { id: "periodo-fiscal", re: /periodo fiscal\D*?(\d{4}-\d{2})-\d{2}/i,
    titulo: "Periodo fiscal cerrado o sin crear", detalle: m => `mes ${m[1]}`,
    accion: "Abrir (o crear) el periodo fiscal de ese mes en la compañía y reprocesar los correos.",
    responsable: "Contador de la compañía", arreglo: "configuración", frente: "adentro" },
  { id: "impuesto-inexistente", re: /impuesto de (\d+) - IVA con tarifa (\d+) - (.+?) no existe/i,
    titulo: "Impuesto de compra que no existe en la compañía", detalle: m => `IVA ${m[1]} tarifa ${m[2]} (${m[3].trim()})`,
    accion: "Crear o reactivar en la compañía el impuesto de compra indicado (código y tarifa) y reprocesar.",
    responsable: "TecnoDEM o contador", arreglo: "configuración", frente: "adentro" },
  { id: "medio-de-pago", re: /Payment method not found for code/i,
    titulo: "Medio de pago del XML sin configurar", detalle: () => null,
    accion: "Configurar el medio de pago (código de Hacienda) que traen estos XML, o uno por omisión, y reprocesar.",
    responsable: "TecnoDEM", arreglo: "configuración", frente: "adentro" },
  { id: "receptor-otra-cedula", re: /Tax ID of the receptor is (\d+) and does not match/i,
    titulo: "Factura a nombre de otra cédula", detalle: m => `cédula ${m[1]}`,
    accion: "No es de esta compañía o el emisor puso mal la cédula del receptor: pedir que la anule y la emita a la cédula correcta, o pasarla a la compañía dueña de esa cédula.",
    responsable: "Receptor (reclamo al emisor)", arreglo: "emisor", frente: "afuera" },
  { id: "proveedor-duplicado", re: /supplier exists more than once:?\s*(.*)$/i,
    titulo: "Proveedor repetido en Contactos", detalle: m => (m[1] || "").trim().slice(0, 70) || null,
    accion: "Fusionar los contactos repetidos del proveedor (misma cédula) y reprocesar.",
    responsable: "Contador", arreglo: "datos", frente: "adentro" },
  { id: "proveedor-inexistente", re: /proveedor no existe|supplier (does not exist|not found)/i,
    titulo: "Proveedor que no existe en Contactos", detalle: () => null,
    accion: "Crear el proveedor con la cédula del emisor (o revisar que no esté archivado) y reprocesar.",
    responsable: "Contador", arreglo: "datos", frente: "adentro" },
  { id: "cuenta-obsoleta", re: /La cuenta (.+?) es obsoleta/i,
    titulo: "Cuenta obsoleta en la configuración", detalle: m => m[1],
    accion: "Cambiar la cuenta obsoleta por la vigente en el proveedor o en la configuración de la compañía, y reprocesar.",
    responsable: "Contador", arreglo: "configuración", frente: "adentro" },
  { id: "xml-danado", re: /unclosed token|not well-formed|mismatched tag|Secci[oó]n \w+ no encontrada|syntax error/i,
    titulo: "XML dañado o incompleto", detalle: () => null,
    accion: "Pedir al emisor que reenvíe el XML completo.",
    responsable: "Receptor (reclamo al emisor)", arreglo: "emisor", frente: "afuera" },
  { id: "duplicado", re: /Duplicate invoice detected/i,
    titulo: "Documento ya registrado (reenvío)", detalle: () => null,
    accion: "Nada que corregir: es un reenvío. Confirmar que el original está registrado y marcar resuelto.",
    responsable: "—", arreglo: "ninguno", frente: "adentro" }
];
// Sin texto de error, el estado dice la causa.
const SIN_TEXTO = {
  process: { id: "en-cola", titulo: "Correo en cola sin procesar", accion: "Reprocesar (TecnoDEM, o el agente Corrección cuando exista).", responsable: "TecnoDEM", arreglo: "reproceso", frente: "adentro" },
  rejected: { id: "rechazado-sin-motivo", titulo: "Rechazado sin motivo (en la práctica, reenvío)", accion: "Verificar que la factura original esté registrada; si lo está, no hay nada que hacer.", responsable: "—", arreglo: "ninguno", frente: "afuera" },
  duplicate: { id: "duplicado", titulo: "Documento ya registrado (reenvío)", accion: "Nada que corregir: es un reenvío.", responsable: "—", arreglo: "ninguno", frente: "adentro" },
  vatiderror: { id: "cedula-invalida", titulo: "Cédula de emisor o receptor inválida", accion: "Revisar la cédula del documento contra la de la compañía y la del proveedor.", responsable: "Contador", arreglo: "datos", frente: "adentro" },
  error: { id: "error-sin-texto", titulo: "Error sin descripción", accion: "Revisar el correo en Odoo; reportar a TecnoDEM si se repite.", responsable: "TecnoDEM", arreglo: "revisar", frente: "adentro" }
};

// La causa de un correo: { causa, detalle } — o una causa «desconocida» con el texto normalizado.
export function diagnosticar({ state, error }) {
  const texto = String(error || "").trim();
  if (texto) {
    for (const c of CAUSAS) {
      const m = texto.match(c.re);
      if (m) return { causa: c, detalle: c.detalle(m) };
    }
    const firma = texto.replace(/^Error de (proceso|validación):\s*/i, "").replace(/\d+/g, "#").replace(/\s+/g, " ").slice(0, 90);
    return { causa: { id: `otra:${firma}`, titulo: firma, accion: "Causa no catalogada: revisar y agregarla a CAUSAS si se repite.", responsable: "Por definir", arreglo: "revisar", frente: "adentro", desconocida: true }, detalle: null };
  }
  const c = SIN_TEXTO[state] || SIN_TEXTO.error;
  return { causa: c, detalle: null };
}

export async function ejecutar({ odoo, cfg, log }) {
  const t0 = Date.now();
  await odoo.conectar();
  const correos = await odoo.leerTodo(meta.modelo, [["state", "in", ["error", "vatiderror", "process", "duplicate", "rejected"]]],
    ["company_id", "state", "error", "date", "name", "e_invoice_name"]);
  log(`${correos.length} correos con problema en el buzón`);

  const porCausa = new Map(), porCia = new Map();
  for (const c of correos) {
    const { causa, detalle } = diagnosticar(c);
    const cia = c.company_id ? c.company_id[1] : "(sin compañía)", ciaId = c.company_id ? c.company_id[0] : null;
    const g = porCausa.get(causa.id) || { ...causa, re: undefined, correos: 0, claves: new Set(), companias: new Map(), detalles: new Map(), ejemplos: [], estados: {} };
    g.correos++;
    g.estados[c.state] = (g.estados[c.state] || 0) + 1;
    const k = clave(c.e_invoice_name, c.name); if (k) g.claves.add(k);
    g.companias.set(cia, { compania: cia, companiaId: ciaId, correos: (g.companias.get(cia)?.correos || 0) + 1 });
    if (detalle) { const kd = `${cia}|${detalle}`; g.detalles.set(kd, { compania: cia, detalle, correos: (g.detalles.get(kd)?.correos || 0) + 1 }); }
    if (g.ejemplos.length < 5) g.ejemplos.push({ correoId: c.id, compania: cia, fecha: String(c.date || "").slice(0, 10), asunto: String(c.name || "").slice(0, 80), error: String(c.error || "").slice(0, 160) });
    porCausa.set(causa.id, g);
    const pc = porCia.get(cia) || { compania: cia, companiaId: ciaId, correos: 0, causas: {} };
    pc.correos++; pc.causas[causa.id] = (pc.causas[causa.id] || 0) + 1;
    porCia.set(cia, pc);
  }

  const causas = [...porCausa.values()].map(g => ({
    id: g.id, titulo: g.titulo, accion: g.accion, responsable: g.responsable, arreglo: g.arreglo, frente: g.frente, desconocida: Boolean(g.desconocida),
    correos: g.correos, documentos: g.claves.size, estados: g.estados,
    companias: [...g.companias.values()].sort((a, b) => b.correos - a.correos),
    // lo concreto que hay que hacer: qué mes abrir, qué impuesto crear, qué cédula reclamar…
    pendientes: [...g.detalles.values()].sort((a, b) => b.correos - a.correos).slice(0, 40),
    ejemplos: g.ejemplos
  })).sort((a, b) => b.correos - a.correos);

  const suma = f => causas.filter(f).reduce((s, c) => s + c.correos, 0);
  const totales = {
    correosConProblema: correos.length, causas: causas.length,
    porConfiguracion: suma(c => c.arreglo === "configuración"), porEmisor: suma(c => c.arreglo === "emisor"),
    porDatos: suma(c => c.arreglo === "datos"), sinArreglo: suma(c => c.arreglo === "ninguno"), sinCatalogar: suma(c => c.desconocida),
    companias: porCia.size
  };

  const alertas = [];
  const conf = causas.filter(c => c.arreglo === "configuración");
  if (conf.length) alertas.push({ nivel: "alto",
    texto: `${totales.porConfiguracion} correos se destraban con configuración en Odoo, sin pedirle nada a nadie afuera.`,
    detalle: conf.slice(0, 6).map(c => `${c.titulo}: ${c.correos} correos — ${c.accion}`) });
  const periodo = causas.find(c => c.id === "periodo-fiscal");
  if (periodo) alertas.push({ nivel: "alto",
    texto: `Periodos fiscales por abrir: ${periodo.pendientes.length} compañía·mes, ${periodo.correos} correos.`,
    detalle: periodo.pendientes.slice(0, 8).map(p => `${p.compania} — ${p.detalle} (${p.correos})`) });
  const emisor = causas.filter(c => c.arreglo === "emisor");
  if (emisor.length) alertas.push({ nivel: "alto",
    texto: `${totales.porEmisor} correos necesitan que el emisor corrija o reenvíe (Victor los incluye en el reclamo de afuera).`,
    detalle: emisor.map(c => `${c.titulo}: ${c.correos}`) });
  if (totales.sinCatalogar) alertas.push({ nivel: "info",
    texto: `${totales.sinCatalogar} correos con causas que el agente todavía no conoce.`,
    detalle: causas.filter(c => c.desconocida).slice(0, 5).map(c => `${c.titulo} (${c.correos})`) });
  if (!correos.length) alertas.push({ nivel: "ok", texto: "No hay correos con problema en el buzón.", detalle: [] });

  return {
    agente: meta.nombre, titulo: "Por qué fallan los correos del buzón", corrida: new Date().toISOString(),
    segundos: Math.round((Date.now() - t0) / 100) / 10, llamadasOdoo: odoo.llamadas,
    totales, causas, companias: [...porCia.values()].sort((a, b) => b.correos - a.correos).slice(0, 80), alertas
  };
}
