// Lectura de los campos de correo que trae el buzón (from_mail, to_mail) y
// deduplicación de documentos. Puro: sin Odoo, sin disco.

// to_mail viene sucio: '"alea@x.com" <alea@x.com>' o dos direcciones separadas por coma.
// equivalencias: Map dominio viejo → dominio nuevo (ver dominiosEquivalentes). Así, cuando los
// receptores cambian de dominio, rv@viejo.com e rv@nuevo.com son un solo receptor y no reciben
// dos cartas (error 5 del log del 25/10).
export function receptores(toMail, equivalencias = null) {
  return [...new Set(String(toMail || "")
    .split(/[,;]/)
    .map(s => {
      const m = s.match(/<([^>]+)>/);
      return canonizarCorreo((m ? m[1] : s).replace(/["'<>\s]/g, "").toLowerCase(), equivalencias);
    })
    .filter(s => s.includes("@")))];
}

// RECEPTORES_DOMINIOS=viejo.com=nuevo.com,otro.cr=nuevo.com  →  Map { viejo.com → nuevo.com, … }
export function dominiosEquivalentes(valor) {
  const m = new Map();
  for (const par of String(valor || "").split(/[,;\s]+/).filter(Boolean)) {
    const [viejo, nuevo] = par.split("=").map(x => String(x || "").trim().toLowerCase().replace(/^@/, ""));
    if (viejo && nuevo && viejo !== nuevo) m.set(viejo, nuevo);
  }
  return m;
}
export function canonizarCorreo(correo, equivalencias = null) {
  const c = String(correo || "").trim().toLowerCase();
  if (!equivalencias || !equivalencias.size || !c.includes("@")) return c;
  const [local, dominio] = c.split("@");
  return equivalencias.has(dominio) ? `${local}@${equivalencias.get(dominio)}` : c;
}

// Posibles cambios de dominio sin declarar: la misma casilla (parte local) en dos dominios
// distintos, para las mismas compañías. receptoresConCompanias: [{ receptor, companias: [nombres] }]
export function dominiosSospechosos(receptoresConCompanias) {
  const porLocal = new Map();
  for (const r of receptoresConCompanias) {
    const [local, dominio] = r.receptor.split("@");
    if (!local || !dominio) continue;
    if (!porLocal.has(local)) porLocal.set(local, []);
    porLocal.get(local).push({ dominio, receptor: r.receptor, companias: new Set(r.companias) });
  }
  const pares = [];
  for (const [local, lista] of porLocal) {
    for (let i = 0; i < lista.length; i++) for (let j = i + 1; j < lista.length; j++) {
      const a = lista[i], b = lista[j];
      if (a.dominio === b.dominio) continue;
      const comunes = [...a.companias].filter(x => b.companias.has(x));
      if (comunes.length) pares.push({ local, a: a.receptor, b: b.receptor, companias: comunes });
    }
  }
  return pares;
}

// '"Bodegas del Valle" <facturas@bodegasdelvalle.com>' -> nombre "Bodegas del Valle", dominio bodegasdelvalle.com
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
