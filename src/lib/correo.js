// Lectura de los campos de correo que trae el buzón (from_mail, to_mail) y
// deduplicación de documentos. Puro: sin Odoo, sin disco.

// to_mail viene sucio: '"alea@x.com" <alea@x.com>' o dos direcciones separadas por coma.
export function receptores(toMail) {
  return [...new Set(String(toMail || "")
    .split(/[,;]/)
    .map(s => {
      const m = s.match(/<([^>]+)>/);
      return (m ? m[1] : s).replace(/["'<>\s]/g, "").toLowerCase();
    })
    .filter(s => s.includes("@")))];
}

// '"Colina Hermanos" <facturas@colina.com>' -> nombre "Colina Hermanos", dominio colina.com
export function remitenteVisible(fromMail) {
  const s = String(fromMail || "");
  const nom = s.match(/^\s*"?([^"<]+?)"?\s*</);
  const dir = (s.match(/<([^>]+)>/) || [null, s])[1].trim().toLowerCase();
  const dom = dir.includes("@") ? dir.split("@")[1] : null;
  const nombre = nom ? nom[1].trim() : null;
  return { nombre, direccion: dir, dominio: dom };
}

// El buzón de Hacienda no es el emisor: es el acuse del Ministerio. Igual pasa con los
// remitentes automáticos de las casas de facturación.
export const DOMINIO_HACIENDA = /hacienda\.go\.cr$/i;
export const REMITENTE_AUTOMATICO = /^(no-?reply|noreply|facturaci[oó]n|facturas?|documento|comprobante|notificaci|info|soporte|admin)/i;

// Un documento que entró 30 veces al buzón es una conversación, no 30.
// Se agrupa por clave; sin clave, por estado + archivo + asunto. Devuelve una fila por
// documento con `veces` y la fecha más reciente.
export function unificarDocumentos(items) {
  const g = new Map();
  for (const c of items) {
    const llave = c.clave || `${c.estado}|${c.archivo}|${c.asunto}`;
    const y = g.get(llave);
    if (y) { y.veces++; if (c.id != null) y.correoIds.push(c.id); if ((c.fecha || "") > (y.fecha || "")) y.fecha = c.fecha; continue; }
    g.set(llave, { ...c, veces: 1, correoIds: c.id != null ? [c.id] : [] });
  }
  return [...g.values()];
}

// El texto del error se repite casi igual centenares de veces; lo que importa es la causa.
// Se quitan fechas y números largos para que "periodo fiscal 2025-11-01" y "…2025-12-01"
// cuenten como la misma causa.
export function causasDominantes(items, { descripcionEstado = {}, max = 8 } = {}) {
  const g = {};
  for (const c of items) {
    const raw = (c.error || descripcionEstado[c.estado] || c.estado || "").trim();
    const llave = raw.replace(/\d{4}-\d{2}-\d{2}/g, "«fecha»").replace(/\d{6,}/g, "«número»").slice(0, 160);
    const e = g[llave] || (g[llave] = { causa: llave, correos: 0, ejemplo: raw });
    e.correos++;
  }
  return Object.values(g).sort((a, b) => b.correos - a.correos).slice(0, max);
}

export const horasEntre = (desde, hasta) => (hasta - desde) / 36e5;

// Odoo entrega datetimes como "2026-03-11 14:05:00" en UTC.
export const fechaOdoo = s => (s ? new Date(String(s).replace(" ", "T") + "Z") : null);
