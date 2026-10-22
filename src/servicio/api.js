// La API del servicio. node:http, sin framework: una tabla de rutas y JSON.
//
// Seguridad en esta fase: si SERVICIO_TOKEN está en .env, toda petición que modifique algo
// (POST) tiene que traer  Authorization: Bearer <token>. Quién decide se toma de la cabecera
// X-Quien (o del cuerpo, campo "quien"). El login por enlace mágico para receptores viene en
// la fase 2; la API ya deja todo auditado con nombre.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize, sep } from "node:path";

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

export function crearApi({ db, corridas, programador, cfg, raiz, log = () => {} }) {
  const rutas = [];
  const ruta = (metodo, patron, fn) => rutas.push({ metodo, re: new RegExp("^" + patron.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn });

  // --- estado general
  ruta("GET", "/api/estado", () => ({
    ahora: new Date().toISOString(),
    odoo: cfg.ODOO_SIMULADO ? { simulado: cfg.ODOO_SIMULADO } : { url: cfg.ODOO_URL, db: cfg.ODOO_DB },
    escrituraPermitida: String(cfg.PERMITIR_ESCRITURA || "").toLowerCase() === "si",
    smtp: Boolean(cfg.SMTP_HOST && cfg.SMTP_USER),
    enCurso: corridas.enCurso,
    programador: programador ? { plan: programador.describir(), ultimoTick: programador.ultimoTick } : null,
    ultimas: Object.fromEntries(["recepcion", "comunicacion", "conciliacion", "cuentas"].map(a => {
      const u = db.ultimaCorrida(a);
      return [a, u ? { id: u.id, inicio: u.inicio, fin: u.fin, totales: u.totales, alertas: u.alertas, compania: u.compania, modo: u.modo } : null];
    })),
    casos: db.resumenCasos(),
    pendientes: {
      propuestas: db.propuestas({ estado: "propuesta" }).length,
      aprobadas: db.propuestas({ estado: "aprobada" }).length,
      correos: db.correos({ estado: "borrador" }).length,
      correosAprobados: db.correos({ estado: "aprobado" }).length
    }
  }));

  // --- corridas
  ruta("GET", "/api/corridas", (q) => db.corridas({ agente: q.agente || null, limite: Number(q.limite || 50) }));
  ruta("GET", "/api/corridas/:id", (q, p) => db.corrida(Number(p.id)) || error(404, "No existe esa corrida."));
  ruta("POST", "/api/corridas/:agente", async (q, p, cuerpo, quien) => {
    const args = [];
    if (cuerpo.empresa) args.push(`--empresa=${cuerpo.empresa}`);
    if (cuerpo.revisarTodo) args.push("--revisar-todo");
    // Nunca --aplicar ni --enviar por aquí: eso pasa por la cola de aprobaciones.
    const { corridaId, resumen, resultado } = await corridas.correr(p.agente, args, { quienPide: quien });
    return { corridaId, resumen, totales: resultado.totales, alertas: resultado.alertas };
  });

  // --- casos (lo que Recepción encontró, por receptor y compañía)
  ruta("GET", "/api/casos", (q) => db.casos({ receptor: q.receptor || null, companiaId: q.compania ? Number(q.compania) : null,
    frente: q.frente || null, seguimiento: q.seguimiento || "abierto", limite: Number(q.limite || 500) }));
  ruta("POST", "/api/casos/:id/resolver", (q, p, cuerpo, quien) => ({ ok: db.resolverCaso(Number(p.id), quien, cuerpo.nota || null) }));
  ruta("POST", "/api/casos/:id/reabrir", (q, p, cuerpo, quien) => ({ ok: db.reabrirCaso(Number(p.id), quien) }));

  // --- propuestas de Cuentas
  ruta("GET", "/api/propuestas", (q) => db.propuestas({ estado: q.estado || "propuesta", companiaId: q.compania ? Number(q.compania) : null }));
  ruta("POST", "/api/propuestas/:id/aprobar", (q, p, cuerpo, quien) => ({ ok: db.decidirPropuesta(Number(p.id), "aprobada", quien, cuerpo.motivo || null) }));
  ruta("POST", "/api/propuestas/:id/rechazar", (q, p, cuerpo, quien) => ({ ok: db.decidirPropuesta(Number(p.id), "rechazada", quien, cuerpo.motivo || null) }));
  ruta("POST", "/api/propuestas/aplicar", async (q, p, cuerpo, quien) => {
    if (!cuerpo.compania) return error(400, "Falta la compañía (compania).");
    return corridas.aplicarAprobadas(Number(cuerpo.compania), { quienPide: quien });
  });

  // --- correos de Victor
  ruta("GET", "/api/correos", (q) => db.correos({ estado: q.estado || "borrador" }));
  ruta("GET", "/api/correos/:id", (q, p) => db.correo(Number(p.id)) || error(404, "No existe ese correo."));
  ruta("POST", "/api/correos/:id/aprobar", (q, p, cuerpo, quien) => ({ ok: db.decidirCorreo(Number(p.id), "aprobado", quien) }));
  ruta("POST", "/api/correos/:id/rechazar", (q, p, cuerpo, quien) => ({ ok: db.decidirCorreo(Number(p.id), "rechazado", quien) }));
  ruta("POST", "/api/correos/enviar", (q, p, cuerpo, quien) =>
    corridas.enviarAprobados({ quienPide: quien, prueba: cuerpo.real !== true, ids: Array.isArray(cuerpo.ids) ? cuerpo.ids.map(Number) : null }));

  ruta("GET", "/api/auditoria", (q) => db.auditoria(Number(q.limite || 100)));
  ruta("GET", "/api/companias", () => {
    const r = join(raiz, "data", "companias.json");
    return existsSync(r) ? JSON.parse(readFileSync(r, "utf8")) : [];
  });

  // --- el servidor
  const servidor = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const q = Object.fromEntries(url.searchParams);
    try {
      if (url.pathname.startsWith("/api/")) {
        const r = rutas.find(x => x.metodo === req.method && x.re.test(url.pathname));
        if (!r) return responder(res, 404, { error: "No existe esa ruta." });
        let cuerpo = {};
        if (req.method === "POST") {
          if (cfg.SERVICIO_TOKEN && req.headers.authorization !== `Bearer ${cfg.SERVICIO_TOKEN}`) return responder(res, 401, { error: "Falta o no coincide el token." });
          cuerpo = await leerCuerpo(req);
        }
        const quien = String(req.headers["x-quien"] || cuerpo.quien || "anónimo").slice(0, 120);
        const params = url.pathname.match(r.re).groups || {};
        const out = await r.fn(q, params, cuerpo, quien);
        if (out && out.__error) return responder(res, out.__error, { error: out.mensaje });
        return responder(res, 200, out ?? {});
      }
      // archivos estáticos de la app web (ui/app) y la oficina 2D regenerada
      if (url.pathname === "/oficina") {
        const of = join(raiz, "Oficina IASIMA.html");
        if (!existsSync(of)) return responder(res, 404, { error: "Todavía no hay oficina: corra Recepción primero." });
        res.writeHead(200, { "Content-Type": TIPOS[".html"] });
        return res.end(readFileSync(of));
      }
      const base = join(raiz, "ui", "app");
      const archivo = normalize(join(base, url.pathname === "/" ? "index.html" : url.pathname));
      if (!archivo.startsWith(base + sep) || !existsSync(archivo)) return responder(res, 404, { error: "No existe." });
      res.writeHead(200, { "Content-Type": TIPOS[extname(archivo)] || "application/octet-stream" });
      res.end(readFileSync(archivo));
    } catch (e) {
      log(`API ${req.method} ${url.pathname}: ${e.message}`);
      responder(res, 500, { error: e.message });
    }
  });
  return servidor;
}

const error = (codigo, mensaje) => ({ __error: codigo, mensaje });
function responder(res, codigo, obj) {
  res.writeHead(codigo, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function leerCuerpo(req) {
  return new Promise((ok, mal) => {
    let s = "";
    req.on("data", c => { s += c; if (s.length > 1e6) { mal(new Error("Cuerpo demasiado grande")); req.destroy(); } });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { mal(new Error("JSON inválido")); } });
    req.on("error", mal);
  });
}
