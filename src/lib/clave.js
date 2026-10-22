// La clave numérica de 50 dígitos de Hacienda (Costa Rica).
//
//   país(3) + fecha ddmmaa(6) + cédula emisor(12) + consecutivo(20) + situación(1) + seguridad(8)
//
// Dentro del consecutivo: sucursal(3) + terminal(5) + tipo de documento(2) + número(10).
// Por eso el tipo de documento vive en las posiciones 30-31 (contando desde 1).
//
// Todo aquí es puro: sin Odoo, sin disco. Se prueba solo.

export const TIPO_DOC = {
  "01": "Factura electrónica", "02": "Nota de débito", "03": "Nota de crédito",
  "04": "Tiquete electrónico", "05": "Confirmación de aceptación", "06": "Confirmación de aceptación parcial",
  "07": "Confirmación de rechazo", "08": "Factura de compra", "09": "Factura de exportación",
  "10": "Recibo electrónico de pago"
};

export const LARGO_CLAVE = 50;

// La clave puede venir en el nombre del archivo o, si no, en el asunto del correo.
// Se admite cualquier separador entre dígitos ("clave: 506…" o "506-…").
export function clave(...textos) {
  for (const t of textos) {
    const m = String(t || "").replace(/[^0-9]/g, " ").match(/\d{50}/);
    if (m) return m[0];
  }
  return null;
}

export const esClave = k => typeof k === "string" && /^\d{50}$/.test(k);
export const tipoDeClave = k => (esClave(k) ? k.slice(29, 31) : null);
export const nombreTipo = k => TIPO_DOC[tipoDeClave(k)] || null;
export const cedulaEmisor = k => (esClave(k) ? k.slice(9, 21).replace(/^0+/, "") : null);
export const consecutivoDoc = k => (esClave(k) ? k.slice(21, 41) : null);
export const paisDeClave = k => (esClave(k) ? k.slice(0, 3) : null);
export const situacionDeClave = k => (esClave(k) ? k.slice(41, 42) : null);

export function fechaDeClave(k) {
  if (!esClave(k)) return null;
  const d = k.slice(3, 5), m = k.slice(5, 7), a = k.slice(7, 9);
  return `20${a}-${m}-${d}`;
}

export function descomponer(k) {
  if (!esClave(k)) return null;
  return {
    clave: k, pais: paisDeClave(k), fecha: fechaDeClave(k), cedulaEmisor: cedulaEmisor(k),
    consecutivo: consecutivoDoc(k), tipo: tipoDeClave(k), tipoNombre: nombreTipo(k),
    situacion: situacionDeClave(k), seguridad: k.slice(42, 50)
  };
}
