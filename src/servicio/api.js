// La API del servicio. node:http, sin framework: una tabla de rutas y JSON.
//
// Seguridad en esta fase: si SERVICIO_TOKEN está configurado (global o por inquilino), TODA
// petición a ese inquilino —lectura incluida— tiene que traer el token: como cabecera
// Authorization: Bearer <token>, o como cookie puesta por POST /api/entrar {token}. La app web
// pide el token una vez y lo guarda en cookie; la oficina 2D funciona con esa misma cookie.
// Quién decide se toma de la cabecera X-Quien (o del cuerpo, campo "quien"). El login por
// enlace mágico para receptores viene después; la API ya deja todo auditado con nombre.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize, sep } from "node:path";

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

import { resolverInquilino, marcaDe } from "./inquilinos.js";

// Un contexto por inquilino: { inquilino, db, corridas, programador, director, cfg, raiz }.
// Por compatibilidad también se acepta un solo contexto suelto (un inquilino "iasima").
export function crearApi(opciones) {
  const { contextos, raizProyecto, log = () => {} } = normalizar(opciones);
  const inquilinos = contextos.map(c => c.inquilino);
  const rutas = [];
  // Cada manejador recibe (q, params, cuerpo, quien, ctx) donde ctx es el contexto del inquilino.
  const ruta = (metodo, patron, fn) => rutas.push({ metodo, re: new RegExp("^" + patron.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn });

  // --- estado general
  ruta("GET", "/api/estado", (q, p, c, quien, ctx) => ({
    ahora: new Date().toISOString(),
    inquilino: marcaDe(ctx.inquilino), prefijo: ctx.prefijo || "", inquilinos: inquilinos.length,
    odoo: ctx.cfg.ODOO_SIMULADO ? { simulado: ctx.cfg.ODOO_SIMULADO } : { url: ctx.cfg.ODOO_URL, db: ctx.cfg.ODOO_DB },
    escrituraPermitida: String(ctx.cfg.PERMITIR_ESCRITURA || "").toLowerCase() === "si",
    smtp: Boolean(ctx.cfg.SMTP_HOST && ctx.cfg.SMTP_USER),
    enCurso: ctx.corridas.enCurso,
    programador: ctx.programador ? { plan: ctx.programador.describir(), ultimoTick: ctx.programador.ultimoTick } : null,
    director: ctx.director ? { modo: ctx.director.disponible ? "llm" : "palabras", modelo: ctx.director.disponible ? ctx.director.modelo : null } : null,
    ultimas: Object.fromEntries(["recepcion", "comunicacion", "conciliacion", "cuentas"].map(a => {
      const u = ctx.db.ultimaCorrida(a);
      return [a, u ? { id: u.id, inicio: u.inicio, fin: u.fin, totales: u.totales, alertas: u.alertas, compania: u.compania, modo: u.modo } : null];
    })),
    casos: ctx.db.resumenCasos(),
    pendientes: {
      propuestas: ctx.db.propuestas({ estado: "propuesta" }).length,
      aprobadas: ctx.db.propuestas({ estado: "aprobada" }).length,
      correos: ctx.db.correos({ estado: "borrador" }).length,
      correosAprobados: ctx.db.correos({ estado: "aprobado" }).length
    }
  }));

  // --- corridas
  ruta("GET", "/api/corridas", (q, p, c, quien, ctx) => ctx.db.corridas({ agente: q.agente || null, limite: Number(q.limite || 50) }));
  ruta("GET", "/api/corridas/:id", (q, p, c, quien, ctx) => ctx.db.corrida(Number(p.id)) || error(404, "No existe esa corrida."));
  ruta("POST", "/api/corridas/:agente", async (q, p, cuerpo, quien, ctx) => {
    const args = [];
    if (cuerpo.empresa) args.push(`--empresa=${cuerpo.empresa}`);
    if (cuerpo.revisarTodo) args.push("--revisar-todo");
    // Nunca --aplicar ni --enviar por aquí: eso pasa por la cola de aprobaciones.
    const { corridaId, resumen, resultado } = await ctx.corridas.correr(p.agente, args, { quienPide: quien });
    return { corridaId, resumen, totales: resultado.totales, alertas: resultado.alertas };
  });

  // --- casos (lo que Recepción encontró, por receptor y compañía)
  ruta("GET", "/api/casos", (q, p, c, quien, ctx) => ctx.db.casos({ receptor: q.receptor || null, companiaId: q.compania ? Number(q.compania) : null,
    frente: q.frente || null, seguimiento: q.seguimiento || "abierto", limite: Number(q.limite || 500) }));
  ruta("POST", "/api/casos/:id/resolver", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.resolverCaso(Number(p.id), quien, cuerpo.nota || null) }));
  ruta("POST", "/api/casos/:id/reabrir", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.reabrirCaso(Number(p.id), quien) }));

  // --- propuestas de Cuentas
  ruta("GET", "/api/propuestas", (q, p, c, quien, ctx) => ctx.db.propuestas({ estado: q.estado || "propuesta", companiaId: q.compania ? Number(q.compania) : null }));
  ruta("POST", "/api/propuestas/:id/aprobar", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.decidirPropuesta(Number(p.id), "aprobada", quien, cuerpo.motivo || null) }));
  ruta("POST", "/api/propuestas/:id/rechazar", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.decidirPropuesta(Number(p.id), "rechazada", quien, cuerpo.motivo || null) }));
  ruta("POST", "/api/propuestas/aplicar", async (q, p, cuerpo, quien, ctx) => {
    if (!cuerpo.compania) return error(400, "Falta la compañía (compania).");
    return ctx.corridas.aplicarAprobadas(Number(cuerpo.compania), { quienPide: quien });
  });

  // --- correos de Victor
  ruta("GET", "/api/correos", (q, p, c, quien, ctx) => ctx.db.correos({ estado: q.estado || "borrador" }));
  ruta("GET", "/api/correos/:id", (q, p, c, quien, ctx) => ctx.db.correo(Number(p.id)) || error(404, "No existe ese correo."));
  ruta("POST", "/api/correos/:id/aprobar", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.decidirCorreo(Number(p.id), "aprobado", quien) }));
  ruta("POST", "/api/correos/:id/rechazar", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.decidirCorreo(Number(p.id), "rechazado", quien) }));
  ruta("POST", "/api/correos/enviar", (q, p, cuerpo, quien, ctx) =>
    ctx.corridas.enviarAprobados({ quienPide: quien, prueba: cuerpo.real !== true, ids: Array.isArray(cuerpo.ids) ? cuerpo.ids.map(Number) : null }));

  // --- el Director (modelo de lenguaje con los agentes como herramientas; solo lee y propone)
  ruta("GET", "/api/director", (q, p, c, quien, ctx) => ({ disponible: Boolean(ctx.director?.disponible), modelo: ctx.director?.modelo || null, modo: ctx.director?.disponible ? "llm" : "palabras",
    conversaciones: ctx.db.conversaciones(20) }));
  ruta("GET", "/api/director/:id", (q, p, c, quien, ctx) => ctx.db.conversacion(Number(p.id)) || error(404, "No existe esa conversación."));
  ruta("POST", "/api/director", async (q, p, cuerpo, quien, ctx) => {
    if (!ctx.director) return error(503, "El Director no está configurado.");
    const texto = String(cuerpo.mensaje || "").trim();
    if (!texto) return error(400, "Falta el mensaje.");
    const previa = cuerpo.conversacion ? ctx.db.conversacion(Number(cuerpo.conversacion)) : null;
    const r = await ctx.director.responder(texto, { conversacion: previa?.mensajes || [], quien });
    const id = ctx.db.guardarConversacion(previa?.id || null, { quien, modo: r.modo, mensajes: r.conversacion, turno: { pregunta: texto, respuesta: r.respuesta, pasos: r.pasos, cuando: new Date().toISOString() } });
    ctx.db.auditar(quien, "preguntar", "conversacion", id, { pregunta: texto.slice(0, 200), pasos: r.pasos.map(x => x.herramienta) });
    return { conversacion: id, respuesta: r.respuesta, pasos: r.pasos, modo: r.modo };
  });

  ruta("GET", "/api/auditoria", (q, p, c, quien, ctx) => ctx.db.auditoria(Number(q.limite || 100)));
  ruta("GET", "/api/companias", (q, p, c, quien, ctx) => {
    const r = join(ctx.raiz, "data", "companias.json");
    return existsSync(r) ? JSON.parse(readFileSync(r, "utf8")) : [];
  });

  // lista de inquilinos (para el selector cuando hay varios y ninguno se puede deducir)
  const listaInquilinos = () => inquilinos.map(i => ({ ...marcaDe(i), prefijo: `/t/${i.id}` }));

  // --- el servidor
  const servidor = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const q = Object.fromEntries(url.searchParams);
    try {
      if (url.pathname === "/api/inquilinos") return responder(res, 200, listaInquilinos());
      const r0 = resolverInquilino(inquilinos, { host: req.headers.host || "", pathname: url.pathname });
      if (!r0) {
        // varios inquilinos y la URL no dice cuál: la app muestra el selector
        if (url.pathname.startsWith("/api/")) return responder(res, 404, { error: "Indique el inquilino: /t/<id>/api/…", inquilinos: listaInquilinos() });
        return estatico(res, raizProyecto, url.pathname);
      }
      const ctx0 = contextos.find(c => c.inquilino === r0.inquilino);
      const ctx = { ...ctx0, prefijo: r0.prefijo };
      const pathname = r0.ruta;
      const token = ctx.cfg.SERVICIO_TOKEN || "";
      const nombreCookie = `oficina_${ctx.inquilino.id}`;

      // Entrar: valida el token y lo deja en una cookie (HttpOnly) para la app y la oficina 2D.
      if (pathname === "/api/entrar" && req.method === "POST") {
        const cuerpo = await leerCuerpo(req);
        if (!token) return responder(res, 200, { ok: true, token: false });
        if (!igual(String(cuerpo.token || ""), token)) return responder(res, 401, { error: "Token incorrecto." });
        res.setHeader("Set-Cookie", `${nombreCookie}=${firmar(token)}; Path=${r0.prefijo || "/"}; HttpOnly; SameSite=Lax; Max-Age=2592000${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
        return responder(res, 200, { ok: true, token: true });
      }
      if (pathname === "/api/salir" && req.method === "POST") {
        res.setHeader("Set-Cookie", `${nombreCookie}=; Path=${r0.prefijo || "/"}; HttpOnly; Max-Age=0`);
        return responder(res, 200, { ok: true });
      }
      // ¿Tiene token? Cabecera Bearer o cookie firmada. Sin SERVICIO_TOKEN configurado, pasa todo.
      const autorizado = !token
        || (req.headers.authorization === `Bearer ${token}`)
        || igual(cookie(req, nombreCookie), firmar(token));
      // Sin token no se ve nada del inquilino salvo la app en sí (que pedirá el token) y el estado
      // mínimo para saber que hay que entrar.
      if (!autorizado) {
        if (pathname.startsWith("/api/")) return responder(res, 401, { error: "Hace falta el token de acceso.", entrar: true, inquilino: marcaDe(ctx.inquilino), prefijo: ctx.prefijo || "" });
        if (pathname === "/oficina") return redirigir(res, (r0.prefijo || "") + "/");
        return estatico(res, raizProyecto, pathname);
      }

      if (pathname.startsWith("/api/")) {
        const r = rutas.find(x => x.metodo === req.method && x.re.test(pathname));
        if (!r) return responder(res, 404, { error: "No existe esa ruta." });
        let cuerpo = {};
        if (req.method === "POST") cuerpo = await leerCuerpo(req);
        const quien = String(req.headers["x-quien"] || cuerpo.quien || "anónimo").slice(0, 120);
        const params = pathname.match(r.re).groups || {};
        const out = await r.fn(q, params, cuerpo, quien, ctx);
        if (out && out.__error) return responder(res, out.__error, { error: out.mensaje });
        return responder(res, 200, out ?? {});
      }
      // la oficina 2D regenerada del inquilino
      if (pathname === "/oficina") {
        const of = join(ctx.raiz, "Oficina IASIMA.html");
        if (!existsSync(of)) return responder(res, 404, { error: "Todavía no hay oficina: corra Recepción primero." });
        res.writeHead(200, { "Content-Type": TIPOS[".html"] });
        return res.end(readFileSync(of));
      }
      return estatico(res, raizProyecto, pathname);
    } catch (e) {
      log(`API ${req.method} ${url.pathname}: ${e.message}`);
      responder(res, 500, { error: e.message });
    }
  });
  return servidor;
}

// archivos estáticos de la app web (ui/app), compartidos por todos los inquilinos
function estatico(res, raizProyecto, pathname) {
  const base = join(raizProyecto, "ui", "app");
  const archivo = normalize(join(base, pathname === "/" ? "index.html" : pathname));
  if (!archivo.startsWith(base + sep) || !existsSync(archivo)) return responder(res, 404, { error: "No existe." });
  res.writeHead(200, { "Content-Type": TIPOS[extname(archivo)] || "application/octet-stream" });
  res.end(readFileSync(archivo));
}

function normalizar(o) {
  if (o.contextos) return { contextos: o.contextos, raizProyecto: o.raizProyecto, log: o.log };
  const inquilino = o.inquilino || { id: "iasima", nombre: "IASIMA", color: null, logo: null, dominio: null, unico: true };
  return { contextos: [{ inquilino, db: o.db, corridas: o.corridas, programador: o.programador || null, director: o.director || null, cfg: o.cfg, raiz: o.raiz }],
    raizProyecto: o.raizProyecto || o.raiz, log: o.log };
}

const error = (codigo, mensaje) => ({ __error: codigo, mensaje });
// La cookie no lleva el token en claro sino un HMAC de él: sirve para entrar, no para leer el token.
const firmar = t => createHmac("sha256", "oficina-cookie|" + t).update(t).digest("hex");
function igual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); }
function cookie(req, nombre) {
  const m = String(req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(nombre + "="));
  return m ? decodeURIComponent(m.slice(nombre.length + 1)) : "";
}
function redirigir(res, a) { res.writeHead(302, { Location: a }); res.end(); }
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
