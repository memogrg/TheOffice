// Inquilinos: la misma app atiende varias firmas, cada una con su Odoo, su base de datos,
// sus reglas, su calendario y su marca.
//
// Configuración por variables de entorno (o .env):
//
//   INQUILINOS=iasima,sima                 lista de ids (minúsculas, sin espacios)
//   IASIMA_NOMBRE=IASIMA                   marca
//   IASIMA_COLOR=#0B4A3F                   color principal (opcional)
//   IASIMA_LOGO=https://…/logo.png         url o data: (opcional)
//   IASIMA_DOMINIO=iasima.oficina.cr       si la app se sirve por subdominio (opcional)
//   IASIMA_ODOO_URL=…  IASIMA_ODOO_DB=…  IASIMA_ODOO_USER=…  IASIMA_ODOO_PASSWORD=…
//   IASIMA_<CUALQUIER VARIABLE>=…          pisa la variable global para ese inquilino
//                                          (SMTP_*, REPORTE_*, ALERTA_*, PERMITIR_ESCRITURA,
//                                           CORRIDA_DIARIA, CONCILIACION_SEMANAL, SERVICIO_TOKEN,
//                                           CLAUDE_API_KEY, DIRECTOR_MODELO…)
//
// Sin INQUILINOS, hay un solo inquilino "iasima" que usa las variables globales y la raíz
// del proyecto tal cual (compatibilidad con todo lo anterior).
//
// Cada inquilino con lista tiene su carpeta inquilinos/<id>/ con data/ y reportes/ propios;
// roster.json y reglas.json se copian de data/ la primera vez.
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const VARIABLES_GLOBALES = /^(ODOO_|ALERTA_|SMTP_|REPORTE_|PERMITIR_ESCRITURA|COMUNICACION_|CATALOGO_|SERVICIO_|CORRIDA_|CONCILIACION_|BASE_DE_DATOS|CLAUDE_API_KEY|CLAUDE_WORKSPACE_ID|DIRECTOR_|RECEPTORES_|RECURRENTES_|ESCRITURA_|CIERRE_|ESTADOS_|ASIENTOS_|CAMBIARIO_|DIFERIDOS_|DEPRECIACION_|CARTERA_|AUTONOMIA_|HACIENDA_)/;

export function cargarInquilinos(cfg, raizProyecto) {
  const ids = String(cfg.INQUILINOS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const globales = Object.fromEntries(Object.entries(cfg).filter(([k]) => VARIABLES_GLOBALES.test(k)));

  if (!ids.length) {
    const id = (cfg.INQUILINO_ID || "iasima").toLowerCase();
    return [{ id, nombre: cfg.NOMBRE || cfg.INQUILINO_NOMBRE || id.toUpperCase(), color: cfg.COLOR || null, logo: cfg.LOGO || null,
      dominio: (cfg.DOMINIO || "").toLowerCase() || null, cfg: globales, raiz: raizProyecto, unico: true }];
  }

  return ids.map(id => {
    const P = id.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_";
    const propias = {};
    for (const [k, v] of Object.entries(cfg)) if (k.startsWith(P)) propias[k.slice(P.length)] = v;
    const { NOMBRE, COLOR, LOGO, DOMINIO, ...resto } = propias;
    const raiz = join(raizProyecto, "inquilinos", id);
    prepararRaiz(raiz, raizProyecto);
    return { id, nombre: NOMBRE || id.toUpperCase(), color: COLOR || null, logo: LOGO || null, dominio: (DOMINIO || "").toLowerCase() || null,
      cfg: { ...globales, ...resto }, raiz, unico: ids.length === 1 };
  });
}

function prepararRaiz(raiz, raizProyecto) {
  mkdirSync(join(raiz, "data"), { recursive: true });
  mkdirSync(join(raiz, "reportes"), { recursive: true });
  for (const f of ["roster.json", "reglas.json"]) {
    const destino = join(raiz, "data", f), origen = join(raizProyecto, "data", f);
    if (!existsSync(destino) && existsSync(origen)) copyFileSync(origen, destino);
  }
}

// Qué inquilino atiende una petición: por prefijo /t/<id>/… o por dominio; si hay uno solo, él.
// Devuelve { inquilino, ruta } con la ruta ya sin el prefijo, o null si no se puede decidir.
export function resolverInquilino(inquilinos, { host = "", pathname = "/" }) {
  const m = pathname.match(/^\/t\/([a-z0-9_-]+)(\/.*)?$/i);
  if (m) {
    const inq = inquilinos.find(i => i.id === m[1].toLowerCase());
    return inq ? { inquilino: inq, ruta: m[2] || "/", prefijo: `/t/${inq.id}` } : null;
  }
  const h = String(host).toLowerCase().split(":")[0];
  const porDominio = inquilinos.find(i => i.dominio && (h === i.dominio || h.endsWith("." + i.dominio)));
  if (porDominio) return { inquilino: porDominio, ruta: pathname, prefijo: "" };
  if (inquilinos.length === 1) return { inquilino: inquilinos[0], ruta: pathname, prefijo: "" };
  return null;
}

export const marcaDe = i => ({ id: i.id, nombre: i.nombre, color: i.color, logo: i.logo, dominio: i.dominio });
