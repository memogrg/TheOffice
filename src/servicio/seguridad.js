// Seguridad del servicio, en un solo lugar.
//
//  · Acceso remoto: una petición que llega por un proxy o túnel (Cloudflare, Fly, Render) o desde
//    otra máquina es «remota». Sin SERVICIO_TOKEN, lo remoto se rechaza entero: la app solo se usa
//    en la propia PC. Con token, lo remoto necesita el token o una sesión de usuario.
//  · Escrituras en Odoo y envío de correos desde afuera: solo con sesión personal (enlace de
//    acceso), para que la auditoría tenga un nombre verificado y no uno escrito en «Soy».
//    ESCRITURA_SIN_SESION=si lo desactiva (no recomendado).
//  · Intentos: 10 tokens o enlaces fallidos por IP en 15 minutos bloquean esa IP 15 minutos.
//  · Cabeceras: nosniff, sin marcos de otros sitios, sin referer (el enlace de acceso lleva un
//    token en la URL) y una política de contenido que solo deja cargar lo propio y las fuentes.
//  · CSRF: un POST con cookie que trae Origin de otro sitio se rechaza; los POST tienen que ser JSON.

const LOCALES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const CABECERAS_PROXY = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-real-ip", "fly-client-ip", "true-client-ip"];

export function esRemota(req) {
  if (CABECERAS_PROXY.some(h => req.headers[h])) return true;
  return !LOCALES.has(req.socket?.remoteAddress || "");
}
export function ipDe(req) {
  return String(req.headers["cf-connecting-ip"] || req.headers["fly-client-ip"] || req.headers["true-client-ip"] || req.headers["x-real-ip"]
    || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "?");
}

// Ventana deslizante simple en memoria.
export class Limitador {
  constructor({ maximo = 10, ventanaMs = 15 * 60 * 1000 } = {}) { this.maximo = maximo; this.ventanaMs = ventanaMs; this.fallos = new Map(); }
  #vigentes(ip, ahora) { const xs = (this.fallos.get(ip) || []).filter(t => ahora - t < this.ventanaMs); this.fallos.set(ip, xs); return xs; }
  bloqueado(ip, ahora = Date.now()) { return this.#vigentes(ip, ahora).length >= this.maximo; }
  fallo(ip, ahora = Date.now()) { const xs = this.#vigentes(ip, ahora); xs.push(ahora); this.fallos.set(ip, xs); }
  limpiar(ip) { this.fallos.delete(ip); }
}

export const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:", "img-src 'self' data: blob: https:", "connect-src 'self'",
  "frame-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"
].join("; ");

export function cabeceras(extra = {}, { html = false } = {}) {
  return { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()", ...(html ? { "Content-Security-Policy": CSP } : {}), ...extra };
}

// Un POST con cookie de otro sitio (CSRF): si trae Origin, tiene que ser el mismo host.
export function origenAjeno(req) {
  const o = req.headers.origin;
  if (!o || o === "null") return false;
  try { return new URL(o).host !== String(req.headers["x-forwarded-host"] || req.headers.host || ""); } catch { return true; }
}
export const esJSON = req => /^application\/json\b/i.test(String(req.headers["content-type"] || ""));

// Rutas que escriben en Odoo o mandan correo: desde afuera, solo con sesión personal.
export const RUTAS_CON_SESION = [/^\/api\/asientos\/[^/]+\/aplicar$/, /^\/api\/cambios\/[^/]+\/aplicar$/, /^\/api\/propuestas\/aplicar$/, /^\/api\/correos\/enviar$/, /^\/api\/autonomia\/otorgar$/, /^\/api\/hacienda\/[^/]+\/(aprobar|presentada)$/];

// Avisos al arrancar: lo que conviene corregir antes de exponer el servicio.
export function avisosDeArranque(cfg) {
  const si = k => String(cfg[k] || "").toLowerCase() === "si";
  const escribe = ["PERMITIR_ESCRITURA", "PERMITIR_ESCRITURA_ASIENTOS", "PERMITIR_ESCRITURA_CUENTAS"].filter(si);
  const out = [];
  if (!cfg.SERVICIO_TOKEN) out.push("Sin SERVICIO_TOKEN: el acceso remoto (túnel, otra máquina) está bloqueado; la app solo funciona en esta PC.");
  else if (String(cfg.SERVICIO_TOKEN).length < 24) out.push("SERVICIO_TOKEN tiene menos de 24 caracteres: use uno largo y al azar.");
  if (escribe.length && /^admin$/i.test(String(cfg.ODOO_USER || ""))) out.push(`Escritura habilitada (${escribe.join(", ")}) con el usuario admin de Odoo: use un usuario de servicio con permisos solo de contabilidad.`);
  if (si("ESCRITURA_SIN_SESION")) out.push("ESCRITURA_SIN_SESION=si: desde afuera se puede escribir en Odoo solo con el token, sin nombre verificado.");
  return out;
}
