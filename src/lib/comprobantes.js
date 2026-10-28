// Comprobantes electrónicos de Hacienda (XML v4.3/v4.4) y sus respuestas (MensajeHacienda): lo
// justo para saber qué documento es, de quién a quién, por cuánto y si Hacienda lo aceptó.
// Puro: sin Odoo.
import { desescapar } from "./archivos.js";
import { clave as claveDe } from "./clave.js";

const TIPOS = {
  FacturaElectronica: "Factura electrónica", NotaCreditoElectronica: "Nota de crédito", NotaDebitoElectronica: "Nota de débito",
  TiqueteElectronico: "Tiquete electrónico", FacturaElectronicaCompra: "Factura de compra", FacturaElectronicaExportacion: "Factura de exportación",
  ReciboElectronicoPago: "Recibo electrónico de pago", MensajeHacienda: "Respuesta de Hacienda", MensajeReceptor: "Mensaje receptor"
};
const etiqueta = (xml, nombre) => {
  const m = new RegExp(`<(?:[\\w-]+:)?${nombre}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${nombre}>`).exec(xml);
  return m ? m[1] : null;
};
const valor = (xml, nombre) => { const v = xml && etiqueta(xml, nombre); return v == null ? null : desescapar(v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim(); };
const numero = v => (v == null || v === "" ? null : Number(v));
const parte = (xml, nombre) => {
  const b = etiqueta(xml, nombre);
  if (!b) return null;
  const id = etiqueta(b, "Identificacion");
  return { nombre: valor(b, "Nombre"), cedula: id ? valor(id, "Numero") : null, tipoCedula: id ? valor(id, "Tipo") : null, correo: valor(b, "CorreoElectronico") };
};

// XML → { raiz, tipo, clave, … } o null si no es un comprobante ni una respuesta de Hacienda.
export function leerComprobante(texto) {
  const xml = String(texto || "").replace(/^﻿/, "");
  const raiz = /<(?:[\w-]+:)?([A-Za-z]+)\b[^>]*>/.exec(xml.replace(/<\?[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, ""))?.[1];
  if (!raiz || !TIPOS[raiz]) return null;
  if (raiz === "MensajeHacienda") {
    const m = valor(xml, "Mensaje");
    return { raiz, tipo: TIPOS[raiz], clave: valor(xml, "Clave"), respuesta: m === "1" ? "aceptado" : m === "2" ? "aceptado-parcial" : m === "3" ? "rechazado" : m,
      detalle: (valor(xml, "DetalleMensaje") || "").slice(0, 300), emisor: { nombre: valor(xml, "NombreEmisor"), cedula: valor(xml, "NumeroCedulaEmisor") },
      receptor: { nombre: valor(xml, "NombreReceptor"), cedula: valor(xml, "NumeroCedulaReceptor") }, total: numero(valor(xml, "TotalFactura")) };
  }
  if (raiz === "MensajeReceptor") return { raiz, tipo: TIPOS[raiz], clave: valor(xml, "Clave"), mensaje: valor(xml, "Mensaje") };
  const resumen = etiqueta(xml, "ResumenFactura") || etiqueta(xml, "ResumenRecibo") || "";
  const moneda = valor(resumen, "CodigoMoneda") || "CRC";
  return {
    raiz, tipo: TIPOS[raiz], clave: valor(xml, "Clave"), consecutivo: valor(xml, "NumeroConsecutivo"), fecha: (valor(xml, "FechaEmision") || "").slice(0, 10) || null,
    emisor: parte(xml, "Emisor"), receptor: parte(xml, "Receptor"), moneda, tipoCambio: numero(valor(resumen, "TipoCambio")),
    total: numero(valor(resumen, "TotalComprobante")), impuesto: numero(valor(resumen, "TotalImpuesto")),
    referencia: valor(etiqueta(xml, "InformacionReferencia") || "", "Numero")
  };
}

// Archivos sueltos (de un zip) → documentos por clave, con su PDF y la respuesta de Hacienda.
export function agrupar(archivos) {
  const docs = new Map(), respuestas = new Map(), pdfs = [], otros = [];
  for (const a of archivos) {
    const ext = a.base.toLowerCase().split(".").pop();
    if (a.error) { otros.push({ archivo: a.nombre, motivo: a.error }); continue; }
    if (ext === "pdf") { pdfs.push(a); continue; }
    if (ext !== "xml") { otros.push({ archivo: a.nombre, motivo: "no es XML ni PDF" }); continue; }
    const c = leerComprobante(a.datos.toString("utf8"));
    if (!c || !c.clave) { otros.push({ archivo: a.nombre, motivo: "XML que no es un comprobante de Hacienda" }); continue; }
    if (c.raiz === "MensajeHacienda") respuestas.set(c.clave, c);
    else if (c.raiz !== "MensajeReceptor") docs.set(c.clave, { ...c, xml: a.nombre, pdf: null });
  }
  const sinXML = [];
  for (const p of pdfs) {
    const k = claveDe(p.base);
    const d = k && docs.get(k)
      || [...docs.values()].find(x => !x.pdf && (p.base.replace(/\.pdf$/i, "") === x.xml.split("/").pop().replace(/\.xml$/i, "") || (x.consecutivo && p.base.includes(x.consecutivo))));
    if (d && !d.pdf) d.pdf = p.nombre; else sinXML.push(p.nombre);
  }
  for (const [k, r] of respuestas) { const d = docs.get(k); if (d) d.hacienda = r.respuesta; }
  const respuestasSueltas = [...respuestas.keys()].filter(k => !docs.has(k));
  return { documentos: [...docs.values()], pdfSinXML: sinXML, respuestasSinDocumento: respuestasSueltas, otros };
}
