// La API del servicio. node:http, sin framework: una tabla de rutas y JSON.
//
// Seguridad en esta fase: si SERVICIO_TOKEN está configurado (global o por inquilino), TODA
// petición a ese inquilino —lectura incluida— tiene que traer el token: como cabecera
// Authorization: Bearer <token>, o como cookie puesta por POST /api/entrar {token}. La app web
// pide el token una vez y lo guarda en cookie; la oficina 2D funciona con esa misma cookie.
// Quién decide se toma de la cabecera X-Quien (o del cuerpo, campo "quien"). El login por
// enlace mágico para receptores viene después; la API ya deja todo auditado con nombre.
import { createHmac, createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { enviarCorreo } from "../mailer.js";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, extname, normalize, sep } from "node:path";

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

import { resolverInquilino, marcaDe } from "./inquilinos.js";
import { generarOficina } from "../oficina.js";
import { proponerRegla } from "./reglas.js";
import * as asientos from "./asientos.js";
import { esRemota, ipDe, Limitador, cabeceras, origenAjeno, esJSON, RUTAS_CON_SESION } from "./seguridad.js";
import * as cambios from "./cambios.js";
import * as diferidosSrv from "./diferidos.js";
import * as activosSrv from "./activos.js";
import * as cierreMes from "./cierreMes.js";
import { avance, calendario } from "../lib/diferidos.js";
import { canonizarCorreo, dominiosEquivalentes } from "../lib/correo.js";

// Un contexto por inquilino: { inquilino, db, corridas, programador, director, cfg, raiz }.
// Por compatibilidad también se acepta un solo contexto suelto (un inquilino "iasima").
export function crearApi(opciones) {
  const { contextos, raizProyecto, log = () => {} } = normalizar(opciones);
  const inquilinos = contextos.map(c => c.inquilino);
  const rutas = [];
  // Cada manejador recibe (q, params, cuerpo, quien, ctx) donde ctx es el contexto del inquilino.
  const ruta = (metodo, patron, fn, roles = ["contable"]) => rutas.push({ metodo, re: new RegExp("^" + patron.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn, roles });
  const AMBOS = ["contable", "receptor"];
  // Un receptor solo ve lo suyo: sus casos (por su correo) y los correos dirigidos a él.
  const esReceptor = ctx => ctx.usuario?.rol === "receptor";
  // El buzón del receptor, con el dominio canónico si hubo cambio de dominio (RECEPTORES_DOMINIOS):
  // quien entra con su correo nuevo ve también lo que llegó a la dirección vieja, y al revés.
  const buzon = ctx => canonizarCorreo(ctx.usuario?.correo, dominiosEquivalentes(ctx.cfg.RECEPTORES_DOMINIOS));

  // --- estado general
  ruta("GET", "/api/estado", (q, p, c, quien, ctx) => esReceptor(ctx) ? estadoReceptor(ctx) : ({
    ahora: new Date().toISOString(),
    usuario: ctx.usuario ? { correo: ctx.usuario.correo, nombre: ctx.usuario.nombre, rol: ctx.usuario.rol } : { rol: "contable", porToken: true },
    inquilino: marcaDe(ctx.inquilino), prefijo: ctx.prefijo || "", inquilinos: inquilinos.length,
    odoo: ctx.cfg.ODOO_SIMULADO ? { simulado: ctx.cfg.ODOO_SIMULADO } : { url: ctx.cfg.ODOO_URL, db: ctx.cfg.ODOO_DB },
    escrituraPermitida: String(ctx.cfg.PERMITIR_ESCRITURA || "").toLowerCase() === "si",
    acceso: { remota: ctx.remota === true, token: Boolean(ctx.cfg.SERVICIO_TOKEN), sesion: Boolean(ctx.usuario) },
    escrituraAsientos: asientos.escrituraAsientos(ctx.cfg), escrituraCuentas: cambios.escrituraCuentas(ctx.cfg), publicarAsientos: String(ctx.cfg.ASIENTOS_PUBLICAR || "").toLowerCase() === "si",
    smtp: Boolean(ctx.cfg.SMTP_HOST && ctx.cfg.SMTP_USER),
    enCurso: ctx.corridas.enCurso,
    programador: ctx.programador ? { plan: ctx.programador.describir(), ultimoTick: ctx.programador.ultimoTick } : null,
    director: ctx.director ? { modo: ctx.director.disponible ? "llm" : "palabras", modelo: ctx.director.disponible ? ctx.director.modelo : null } : null,
    ultimas: Object.fromEntries(["recepcion", "comunicacion", "conciliacion", "cuentas", "diagnostico", "recurrentes", "bancos", "documentos", "cierre", "estados", "cambiario", "diferidos", "depreciacion", "cartera", "datos"].map(a => {
      const u = ctx.db.ultimaCorrida(a);
      return [a, u ? { id: u.id, inicio: u.inicio, fin: u.fin, totales: u.totales, alertas: u.alertas, compania: u.compania, modo: u.modo } : null];
    })),
    casos: ctx.db.resumenCasos(),
    pendientes: {
      propuestas: ctx.db.propuestas({ estado: "propuesta" }).length,
      aprobadas: ctx.db.propuestas({ estado: "aprobada" }).length,
      correos: ctx.db.correos({ estado: "borrador" }).length,
      correosAprobados: ctx.db.correos({ estado: "aprobado" }).length,
      reglas: ctx.db.reglas().length,
      asientos: ctx.db.asientos({ estado: "propuesta" }).length,
      asientosAprobados: ctx.db.asientos({ estado: "aprobada" }).length,
      cambios: ctx.db.cambios({ estado: "propuesta" }).length,
      consultas: ctx.db.consultas().length
    }
  }), AMBOS);
  function estadoReceptor(ctx) {
    const u = ctx.usuario;
    const abiertos = ctx.db.casos({ receptor: buzon(ctx), seguimiento: "abierto", limite: 5000 });
    const porCia = {};
    for (const c of abiertos) { const k = c.compania_id; porCia[k] = porCia[k] || { compania_id: k, compania: c.compania, afuera: 0, adentro: 0, total: 0 }; porCia[k][c.frente]++; porCia[k].total++; }
    const rec = ctx.db.ultimaCorrida("recepcion");
    return {
      ahora: new Date().toISOString(), usuario: { correo: u.correo, nombre: u.nombre, rol: u.rol },
      inquilino: marcaDe(ctx.inquilino), prefijo: ctx.prefijo || "", inquilinos: inquilinos.length,
      ultimaRecepcion: rec ? rec.fin : null,
      casos: { afuera: abiertos.filter(c => c.frente === "afuera").length, adentro: abiertos.filter(c => c.frente === "adentro").length,
        resueltos: ctx.db.casos({ receptor: buzon(ctx), seguimiento: "resuelto", limite: 5000 }).length, porCompania: Object.values(porCia).sort((a, b) => b.total - a.total) },
      correos: ctx.db.correos({ estado: "todos" }).filter(c => c.para === buzon(ctx) && ["aprobado", "enviado"].includes(c.estado)).length
    };
  }

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
  ruta("GET", "/api/casos", (q, p, c, quien, ctx) => ctx.db.casos({ receptor: esReceptor(ctx) ? buzon(ctx) : (q.receptor || null), companiaId: q.compania ? Number(q.compania) : null,
    frente: q.frente || null, seguimiento: q.seguimiento || "abierto", limite: Number(q.limite || 500) }), AMBOS);
  const casoPropio = (ctx, id) => !esReceptor(ctx) || ctx.db.casos({ receptor: buzon(ctx), seguimiento: "todos", limite: 10000 }).some(c => c.id === id);
  ruta("POST", "/api/casos/:id/resolver", (q, p, cuerpo, quien, ctx) => casoPropio(ctx, Number(p.id)) ? ({ ok: ctx.db.resolverCaso(Number(p.id), quien, cuerpo.nota || null) }) : error(403, "Ese caso no es suyo."), AMBOS);
  ruta("POST", "/api/casos/:id/reabrir", (q, p, cuerpo, quien, ctx) => casoPropio(ctx, Number(p.id)) ? ({ ok: ctx.db.reabrirCaso(Number(p.id), quien) }) : error(403, "Ese caso no es suyo."), AMBOS);

  // --- propuestas de Cuentas
  ruta("GET", "/api/propuestas", (q, p, c, quien, ctx) => ctx.db.propuestas({ estado: q.estado || "propuesta", companiaId: q.compania ? Number(q.compania) : null }));
  ruta("POST", "/api/propuestas/:id/aprobar", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.decidirPropuesta(Number(p.id), "aprobada", quien, cuerpo.motivo || null) }));
  ruta("POST", "/api/propuestas/:id/rechazar", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.decidirPropuesta(Number(p.id), "rechazada", quien, cuerpo.motivo || null) }));
  ruta("POST", "/api/propuestas/aplicar", async (q, p, cuerpo, quien, ctx) => {
    if (!cuerpo.compania) return error(400, "Falta la compañía (compania).");
    return ctx.corridas.aplicarAprobadas(Number(cuerpo.compania), { quienPide: quien });
  });

  // --- hallazgos de la fase 3A: el resultado completo de la última corrida de cada agente de lectura
  ruta("GET", "/api/hallazgos/:agente", (q, p, c, quien, ctx) => {
    if (!["diagnostico", "recurrentes", "bancos", "documentos", "cierre", "estados", "cambiario", "diferidos", "depreciacion", "cartera", "datos"].includes(p.agente)) return error(404, "No existe ese agente.");
    const u = ctx.db.ultimaCorrida(p.agente);
    return u ? { corrida: u.id, inicio: u.inicio, fin: u.fin, ...u.resultado } : { corrida: null };
  });

  // --- consultas al contador (lo que Cuentas no cierra solo, según la guía de clasificación)
  ruta("GET", "/api/consultas", (q, p, c, quien, ctx) => ctx.db.consultas({ estado: q.estado || "abierta", companiaId: q.compania ? Number(q.compania) : null }));
  ruta("POST", "/api/consultas/:id/descartar", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.cerrarConsulta(Number(p.id), "descartada", quien, cuerpo.nota || null) }));
  // Resolver una consulta = dejar el criterio como regla propia del cliente (principio 7 de la guía).
  // La consulta sigue abierta hasta que la regla se aprueba y Cuentas deja de levantarla.
  ruta("POST", "/api/consultas/:id/regla", async (q, p, cuerpo, quien, ctx) => {
    const k = ctx.db.consulta(Number(p.id));
    if (!k) return error(404, "No existe esa consulta.");
    const porProveedor = cuerpo.alcance === "proveedor", porNaturaleza = cuerpo.alcance === "naturaleza";
    if (porProveedor && !k.proveedor_id) return error(400, "Esa línea no tiene proveedor identificado; use una regla por artículo.");
    if (porNaturaleza && !k.naturaleza) return error(400, "Esa línea no tiene una naturaleza reconocida; use una regla por artículo o por proveedor.");
    const codigo = String(cuerpo.codigo || "").trim() || String(k.sugerida || "").split(" ")[0];
    if (!codigo) return error(400, "Falta la cuenta (codigo).");
    const r = await proponerRegla({ corridas: ctx.corridas, db: ctx.db, compania: k.compania_id, codigo,
      proveedorId: porProveedor ? k.proveedor_id : null, articulos: porProveedor || porNaturaleza ? [] : [k.articulo], naturaleza: porNaturaleza ? k.naturaleza : null,
      motivo: cuerpo.motivo || `Consulta #${k.id}: ${k.motivo || ""}`.slice(0, 300), factura: k.factura_id, propuso: quien });
    if (r.error) return error(400, r.error + (r.parecidas?.length ? ` Parecidas: ${r.parecidas.join(", ")}` : ""));
    ctx.db.anotarConsulta(k.id, `regla #${r.propuestas.map(x => x.id).join(", #")} propuesta por ${quien}`);
    return r;
  });

  // --- reglas contables dictadas en el chat (propuestas por el Director, aprobadas por un contable)
  ruta("GET", "/api/reglas", (q, p, c, quien, ctx) => ctx.db.reglas({ estado: q.estado || "propuesta" }));
  ruta("POST", "/api/reglas/:id/rechazar", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.decidirRegla(Number(p.id), "rechazada", quien) }));
  ruta("POST", "/api/reglas/:id/aprobar", async (q, p, cuerpo, quien, ctx) => {
    const r = ctx.db.regla(Number(p.id));
    if (!r) return error(404, "No existe esa regla.");
    if (r.estado !== "propuesta") return error(409, `La regla ya está ${r.estado}.`);
    // 1) se escribe en data/reglas.json del inquilino: desde aquí manda sobre el catálogo
    const rutaReglas = join(ctx.raiz, "data", "reglas.json");
    const archivo = existsSync(rutaReglas) ? JSON.parse(readFileSync(rutaReglas, "utf8")) : { reglas: [] };
    archivo.reglas = archivo.reglas || [];
    archivo.reglas.push({ ...(r.articulo ? { articulo: r.articulo } : r.naturaleza ? { naturaleza: r.naturaleza } : { proveedorId: r.proveedor_id, proveedor: r.proveedor }),
      codigo: r.codigo, cuenta: r.cuenta, alcance: r.compania || "todas", decidio: quien, fecha: new Date().toISOString().slice(0, 10),
      motivo: r.motivo || "", origen: `regla propuesta #${r.id} (${r.propuso})` });
    writeFileSync(rutaReglas, JSON.stringify(archivo, null, 2) + "\n");
    ctx.db.decidirRegla(r.id, "aprobada", quien);
    // 2) Cuentas revisa de nuevo esa compañía (todas sus facturas, no solo las nuevas) y deja las
    //    líneas afectadas como propuestas. Si falla, la regla queda igual guardada.
    if (!r.compania_id) return { ok: true, regla: r.id, mensaje: "Regla guardada para todas las compañías. Corra Cuentas en cada una para ver las líneas afectadas." };
    try {
      const { corridaId, resultado } = await ctx.corridas.correr("cuentas", [`--empresa=${r.compania_id}`, "--revisar-todo"], { quienPide: quien });
      ctx.db.marcarCorridaRegla(r.id, corridaId);
      const afectadas = (resultado.propuestas || []).filter(x => String(x.cuentaNueva || "").startsWith(r.codigo)).length;
      return { ok: true, regla: r.id, corridaId, propuestas: afectadas, mensaje: `Regla guardada. Cuentas propuso ${afectadas} líneas a ${r.codigo}; están en Aprobaciones para decidir.` };
    } catch (e) {
      return { ok: true, regla: r.id, mensaje: `Regla guardada, pero Cuentas no pudo correr ahora: ${e.message}. Córralo desde el Tablero.` };
    }
  });

  // --- asientos propuestos (fase 3B): Cierre o el Director los proponen; un contable decide
  ruta("GET", "/api/asientos", (q, p, c, quien, ctx) => ctx.db.asientos({ estado: q.estado || "abiertos", companiaId: q.compania ? Number(q.compania) : null }));
  ruta("GET", "/api/asientos/:id/opciones", async (q, p, c, quien, ctx) => {
    const a = ctx.db.asiento(Number(p.id));
    if (!a) return error(404, "No existe ese asiento.");
    return asientos.opciones({ corridas: ctx.corridas, companiaId: a.compania_id });
  });
  // Elegir el banco de la contrapartida (y con él, el diario) o cambiar la fecha.
  ruta("POST", "/api/asientos/:id/editar", async (q, p, cuerpo, quien, ctx) => {
    const a = ctx.db.asiento(Number(p.id));
    if (!a) return error(404, "No existe ese asiento.");
    if (a.estado !== "propuesta") return error(409, `El asiento ya está ${a.estado}.`);
    const cambios = {};
    if (cuerpo.fecha) { if (!/^\d{4}-\d{2}-\d{2}$/.test(cuerpo.fecha)) return error(400, "Fecha inválida (AAAA-MM-DD)."); cambios.fecha = cuerpo.fecha; }
    if (cuerpo.diarioId) {
      const d = (await asientos.opciones({ corridas: ctx.corridas, companiaId: a.compania_id })).find(x => x.id === Number(cuerpo.diarioId));
      if (!d) return error(400, "Ese diario no es de la compañía.");
      cambios.diarioId = d.id; cambios.diario = d.nombre;
      // un pago: el banco del diario elegido pasa a la contrapartida
      if (d.cuentaId && ["bank", "cash"].includes(d.tipo) && a.lineas.some(l => l.rol === "contrapartida"))
        cambios.lineas = a.lineas.map(l => l.rol === "contrapartida" ? { ...l, cuentaId: d.cuentaId, cuenta: d.cuenta, editada: true, fuente: `elegido por ${quien}` } : l);
    }
    // cuentas por código para las líneas que no la tienen (o las de contrapartida), en el plan de esa compañía
    if (Array.isArray(cuerpo.cuentas) && cuerpo.cuentas.length) {
      const r = await asientos.cuentasPorCodigo({ corridas: ctx.corridas, companiaId: a.compania_id, codigos: cuerpo.cuentas.map(c => c.codigo) });
      const lineas = (cambios.lineas || a.lineas).map(l => ({ ...l }));
      for (const c of cuerpo.cuentas) {
        const l = lineas[Number(c.indice)];
        if (!l || (l.cuentaId && !/^contrapartida/.test(l.rol || ""))) return error(400, `La línea ${Number(c.indice) + 1} no se puede cambiar aquí.`);
        const cta = r.get(String(c.codigo).trim());
        if (!cta) return error(400, `La cuenta ${c.codigo} no existe (o está obsoleta) en el plan de ${a.compania}.`);
        Object.assign(l, { cuentaId: cta.id, cuenta: `${cta.code} ${cta.name}`, editada: true, fuente: `elegida por ${quien}` });
      }
      cambios.lineas = lineas;
    }
    if (!Object.keys(cambios).length) return error(400, "Nada que cambiar (fecha, diarioId o cuentas).");
    ctx.db.editarAsiento(a.id, cambios, quien);
    return ctx.db.asiento(a.id);
  });
  ruta("POST", "/api/asientos/:id/aprobar", async (q, p, cuerpo, quien, ctx) => {
    const a = ctx.db.asiento(Number(p.id));
    if (!a) return error(404, "No existe ese asiento.");
    if (a.estado !== "propuesta") return error(409, `El asiento ya está ${a.estado}.`);
    const forma = asientos.revisarForma(a);
    if (forma.errores.length) return error(400, forma.errores.join(" "));
    let v = { ok: true, errores: [], avisos: [] };
    try { v = await asientos.validar(ctx.corridas.crearCliente({ meta: { escribe: false } }), a); }
    catch (e) { v.avisos.push(`No se pudo validar contra Odoo ahora: ${e.message}`); }
    if (!v.ok) return error(400, "No se puede aprobar: " + v.errores.join(" "));
    ctx.db.decidirAsiento(a.id, "aprobada", quien, cuerpo.nota || null);
    return { ok: true, avisos: v.avisos, mensaje: asientos.escrituraAsientos(ctx.cfg) ? "Aprobado. Ya se puede crear en Odoo." : "Aprobado. Crearlo en Odoo requiere PERMITIR_ESCRITURA_ASIENTOS=si." };
  });
  ruta("POST", "/api/asientos/:id/rechazar", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.decidirAsiento(Number(p.id), "rechazada", quien, cuerpo.motivo || null) }));
  ruta("POST", "/api/asientos/:id/aplicar", async (q, p, cuerpo, quien, ctx) => {
    const r = await asientos.aplicar({ corridas: ctx.corridas, db: ctx.db, id: p.id, quien });
    return r.error ? error(r.codigo || 400, r.error) : r;
  });

  // --- cambios masivos al plan de cuentas (objetivo 5)
  ruta("GET", "/api/cambios", (q, p, c, quien, ctx) => ctx.db.cambios({ estado: q.estado || "abiertos" }));
  ruta("POST", "/api/cambios", async (q, p, cuerpo, quien, ctx) => {
    const r = await cambios.proponer({ corridas: ctx.corridas, db: ctx.db, instruccion: cuerpo, propuso: quien });
    return r.error ? error(400, r.error) : r;
  });
  ruta("POST", "/api/cambios/:id/incluir", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.incluirEnCambio(Number(p.id), Number(cuerpo.compania), cuerpo.incluido !== false, quien) }));
  ruta("POST", "/api/cambios/:id/aprobar", (q, p, cuerpo, quien, ctx) => {
    const c = ctx.db.cambio(Number(p.id));
    if (!c) return error(404, "No existe ese cambio.");
    if (!c.items.some(i => i.incluido)) return error(400, "No hay ninguna compañía incluida.");
    return { ok: ctx.db.decidirCambio(c.id, "aprobada", quien, cuerpo.nota || null),
      mensaje: cambios.escrituraCuentas(ctx.cfg) ? "Aprobado. Ya se puede ejecutar en Odoo." : "Aprobado. Ejecutarlo en Odoo requiere PERMITIR_ESCRITURA_CUENTAS=si." };
  });
  ruta("POST", "/api/cambios/:id/rechazar", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.decidirCambio(Number(p.id), "rechazada", quien, cuerpo.motivo || null) }));
  ruta("POST", "/api/cambios/:id/aplicar", async (q, p, cuerpo, quien, ctx) => {
    const r = await cambios.aplicar({ corridas: ctx.corridas, db: ctx.db, id: p.id, quien });
    return r.error ? error(r.codigo || 400, r.error) : r;
  });

  // --- gastos diferidos (ítem 15): registro en la app; las cuotas van a la cola de asientos
  ruta("GET", "/api/diferidos", (q, p, c, quien, ctx) => {
    const aplicados = ctx.db.mesesAplicadosDiferidos();
    return ctx.db.diferidos({ estado: q.estado || "activo", companiaId: q.compania ? Number(q.compania) : null })
      .map(d => ({ ...d, ...avance(d, aplicados.get(d.id) || new Set()), cuota: calendario(d)[0].cuota }));
  });
  ruta("POST", "/api/diferidos", async (q, p, cuerpo, quien, ctx) => {
    const r = await diferidosSrv.registrar({ corridas: ctx.corridas, db: ctx.db, d: cuerpo, quien });
    return r.error ? error(400, r.error) : r;
  });
  ruta("POST", "/api/diferidos/importar", async (q, p, cuerpo, quien, ctx) => {
    const r = await diferidosSrv.importar({ corridas: ctx.corridas, db: ctx.db, texto: cuerpo.texto, quien, probar: cuerpo.probar === true, companiaPorDefecto: cuerpo.compania || null });
    return r.error ? error(400, r.error) : r;
  });
  ruta("POST", "/api/diferidos/:id/anular", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.anularDiferido(Number(p.id), quien, cuerpo.nota || null) }));

  // --- activos fijos (ítem 16): registro en la app; la depreciación va a la cola de asientos
  ruta("GET", "/api/activos", (q, p, c, quien, ctx) => {
    const ap = ctx.db.mesesAplicadosActivos();
    return ctx.db.activos({ estado: q.estado || "activo", companiaId: q.compania ? Number(q.compania) : null }).map(a => {
      const s = { monto: Number(a.costo) - Number(a.residual || 0), meses: a.vida_meses, inicio: a.inicio }, av = avance(s, ap.get(a.id) || new Set(), { hechoHasta: a.hecho_hasta });
      return { ...a, ...av, cuota: calendario(s)[0].cuota, valorEnLibros: Math.round((Number(a.costo) - av.amortizado) * 100) / 100 };
    });
  });
  ruta("POST", "/api/activos", async (q, p, cuerpo, quien, ctx) => {
    const r = await activosSrv.registrar({ corridas: ctx.corridas, db: ctx.db, d: cuerpo, quien });
    return r.error ? error(400, r.error) : r;
  });
  ruta("POST", "/api/activos/importar", async (q, p, cuerpo, quien, ctx) => {
    const r = await activosSrv.importar({ corridas: ctx.corridas, db: ctx.db, texto: cuerpo.texto, quien, probar: cuerpo.probar === true, companiaPorDefecto: cuerpo.compania || null });
    return r.error ? error(400, r.error) : r;
  });
  ruta("POST", "/api/activos/:id/baja", (q, p, cuerpo, quien, ctx) => {
    if (!/^\d{4}-\d{2}$/.test(String(cuerpo.mes || ""))) return error(400, "Indique el mes de la baja (AAAA-MM).");
    return { ok: ctx.db.darDeBajaActivo(Number(p.id), cuerpo.mes, quien, cuerpo.nota || null) };
  });

  // --- cierre de mes por compañía (junta lo de todos los agentes y la cola)
  const companiasDe = ctx => { const r = join(ctx.raiz, "data", "companias.json"); return existsSync(r) ? JSON.parse(readFileSync(r, "utf8")) : []; };
  const mesValido = m => /^\d{4}-\d{2}$/.test(String(m || ""));
  ruta("GET", "/api/cierre-mes", (q, p, c, quien, ctx) => {
    const mes = q.mes || cierreMes.mesPorOmision(ctx.db);
    if (!mesValido(mes)) return error(400, "Mes inválido (AAAA-MM).");
    return cierreMes.lista(ctx.db, { mes, companias: companiasDe(ctx), companiaId: q.compania || null });
  });
  ruta("POST", "/api/cierre-mes/:compania/:mes/revisar", (q, p, cuerpo, quien, ctx) => {
    if (!mesValido(p.mes)) return error(400, "Mes inválido.");
    if (!cierreMes.ITEMS.some(i => i.id === cuerpo.item)) return error(400, "Ítem inválido.");
    if (cuerpo.nota != null && !String(cuerpo.nota).trim()) return error(400, "Escriba por qué se da por bueno.");
    const cia = companiasDe(ctx).find(c => c.id === Number(p.compania));
    return { ok: ctx.db.revisarItemCierre(Number(p.compania), cia?.name, p.mes, cuerpo.item, quien, cuerpo.nota ?? null) };
  });
  ruta("POST", "/api/cierre-mes/:compania/:mes/cerrar", (q, p, cuerpo, quien, ctx) => {
    if (!mesValido(p.mes)) return error(400, "Mes inválido.");
    const l = cierreMes.lista(ctx.db, { mes: p.mes, companias: companiasDe(ctx), companiaId: Number(p.compania) });
    const fila = l.companias[0];
    if (!fila) return error(404, "No existe esa compañía.");
    if (fila.pendientes) return error(409, `Quedan ${fila.pendientes} ítems pendientes: resuélvalos o dé por bueno cada uno con una nota.`);
    return { ok: ctx.db.cerrarMes(fila.companiaId, fila.compania, p.mes, quien, cuerpo.nota || null, fila.items) };
  });
  ruta("POST", "/api/cierre-mes/:compania/:mes/reabrir", (q, p, cuerpo, quien, ctx) => {
    if (!String(cuerpo.nota || "").trim()) return error(400, "Diga por qué se reabre.");
    return { ok: ctx.db.reabrirMes(Number(p.compania), p.mes, quien, cuerpo.nota) };
  });

  // --- correos de Victor
  ruta("GET", "/api/correos", (q, p, c, quien, ctx) => esReceptor(ctx)
    ? ctx.db.correos({ estado: "todos" }).filter(x => x.para === buzon(ctx) && ["aprobado", "enviado"].includes(x.estado))
    : ctx.db.correos({ estado: q.estado || "borrador" }), AMBOS);
  ruta("GET", "/api/correos/:id", (q, p, c, quien, ctx) => {
    const x = ctx.db.correo(Number(p.id));
    if (!x) return error(404, "No existe ese correo.");
    if (esReceptor(ctx) && (x.para !== buzon(ctx) || !["aprobado", "enviado"].includes(x.estado))) return error(403, "Ese correo no es suyo.");
    return x;
  }, AMBOS);
  ruta("POST", "/api/correos/:id/aprobar", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.decidirCorreo(Number(p.id), "aprobado", quien) }));
  ruta("POST", "/api/correos/:id/rechazar", (q, p, cuerpo, quien, ctx) => ({ ok: ctx.db.decidirCorreo(Number(p.id), "rechazado", quien) }));
  ruta("POST", "/api/correos/enviar", (q, p, cuerpo, quien, ctx) =>
    ctx.corridas.enviarAprobados({ quienPide: quien, prueba: cuerpo.real !== true, ids: Array.isArray(cuerpo.ids) ? cuerpo.ids.map(Number) : null }));

  // --- el Director (modelo de lenguaje con los agentes como herramientas; solo lee y propone)
  // Cada persona tiene una conversación abierta que sigue entre visitas (app y oficina 2D comparten
  // la misma); el historial se guarda DIRECTOR_RETENCION_DIAS días (30). Lo que se devuelve al
  // navegador es el "resumen" (pregunta, respuesta, pasos), nunca los mensajes crudos del modelo.
  const retencion = ctx => Number(ctx.cfg.DIRECTOR_RETENCION_DIAS || 30);
  const vista = c => c && ({ id: c.id, quien: c.quien, inicio: c.inicio, ultimo: c.ultimo, modo: c.modo, abierta: c.abierta, titulo: c.titulo, resumen: c.resumen || [] });
  ruta("GET", "/api/director", (q, p, c, quien, ctx) => ({ disponible: Boolean(ctx.director?.disponible), modelo: ctx.director?.modelo || null, modo: ctx.director?.disponible ? "llm" : "palabras",
    retencionDias: retencion(ctx), actual: vista(ctx.db.conversacionActual(quien)), conversaciones: ctx.db.conversaciones({ quien, limite: 30, dias: retencion(ctx) }).map(c => ({ ...vista(c), resumen: undefined, turnos: (c.resumen || []).length })) }));
  ruta("GET", "/api/director/actual", (q, p, c, quien, ctx) => vista(ctx.db.conversacionActual(quien)) || { id: null, resumen: [] });
  ruta("GET", "/api/director/:id", (q, p, c, quien, ctx) => {
    const x = ctx.db.conversacion(Number(p.id));
    if (!x) return error(404, "No existe esa conversación.");
    if (x.quien !== quien) return error(403, "Esa conversación es de otra persona.");
    return vista(x);
  });
  ruta("POST", "/api/director/:id/cerrar", (q, p, c, quien, ctx) => {
    const x = ctx.db.conversacion(Number(p.id));
    if (!x || x.quien !== quien) return error(404, "No existe esa conversación.");
    return { ok: ctx.db.cerrarConversacion(x.id) };
  });
  ruta("POST", "/api/director/:id/reabrir", (q, p, c, quien, ctx) => ctx.db.reabrirConversacion(Number(p.id), quien) ? vista(ctx.db.conversacion(Number(p.id))) : error(404, "No existe esa conversación."));
  ruta("POST", "/api/director", async (q, p, cuerpo, quien, ctx) => {
    if (!ctx.director) return error(503, "El Director no está configurado.");
    const texto = String(cuerpo.mensaje || "").trim();
    if (!texto) return error(400, "Falta el mensaje.");
    // Sin id: sigue la conversación abierta de esta persona (salvo nueva:true). Con id: esa, si es suya.
    let previa = null;
    if (cuerpo.conversacion) { previa = ctx.db.conversacion(Number(cuerpo.conversacion)); if (previa && previa.quien !== quien) previa = null; }
    else if (!cuerpo.nueva) previa = ctx.db.conversacionActual(quien);
    const r = await ctx.director.responder(texto, { conversacion: previa?.mensajes || [], conversacionId: previa?.id || null, quien });
    const id = ctx.db.guardarConversacion(previa?.id || null, { quien, modo: r.modo, mensajes: r.conversacion, turno: { pregunta: texto, respuesta: r.respuesta, pasos: r.pasos, cuando: new Date().toISOString(), truncado: r.truncado || undefined } });
    if (!previa) ctx.db.purgarConversaciones(retencion(ctx));
    ctx.db.auditar(quien, "preguntar", "conversacion", id, { pregunta: texto.slice(0, 200), pasos: r.pasos.map(x => x.herramienta) });
    return { conversacion: id, respuesta: r.respuesta, pasos: r.pasos, modo: r.modo, truncado: r.truncado || false };
  });

  ruta("GET", "/api/auditoria", (q, p, c, quien, ctx) => ctx.db.auditoria(Number(q.limite || 100)));
  ruta("GET", "/api/companias", (q, p, c, quien, ctx) => {
    const r = join(ctx.raiz, "data", "companias.json");
    const todas = existsSync(r) ? JSON.parse(readFileSync(r, "utf8")) : [];
    if (!esReceptor(ctx)) return todas;
    const mias = new Set(ctx.db.casos({ receptor: buzon(ctx), seguimiento: "todos", limite: 10000 }).map(x => x.compania_id));
    return todas.filter(x => mias.has(x.id));
  }, AMBOS);

  // --- usuarios (solo contable): alta, baja, invitación por enlace (correo si hay SMTP, y siempre copiable)
  ruta("GET", "/api/usuarios", (q, p, c, quien, ctx) => ctx.db.usuarios());
  ruta("POST", "/api/usuarios", (q, p, cuerpo, quien, ctx) => ctx.db.crearUsuario({ correo: cuerpo.correo, nombre: cuerpo.nombre || null, rol: cuerpo.rol || "receptor", quien }));
  ruta("POST", "/api/usuarios/:id/desactivar", (q, p, cuerpo, quien, ctx) => { ctx.db.desactivarUsuario(Number(p.id), quien); return { ok: true }; });
  ruta("POST", "/api/usuarios/:id/invitar", async (q, p, cuerpo, quien, ctx) => {
    const u = ctx.db.usuario(Number(p.id));
    if (!u || !u.activo) return error(404, "No existe ese usuario o está desactivado.");
    const token = randomBytes(24).toString("base64url");
    const vence = ctx.db.crearInvitacion(u.id, hash(token), { quien });
    const base = String(cuerpo.base || "").replace(/\/+$/, "");
    const enlace = `${base}${ctx.prefijo || ""}/?t=${token}`;
    let enviado = false, errorCorreo = null;
    if (cuerpo.enviar !== false && ctx.cfg.SMTP_HOST && ctx.cfg.SMTP_USER && ctx.cfg.SMTP_PASS) {
      try {
        await enviarCorreo({ cfg: ctx.cfg, para: u.correo, asunto: `Su acceso a la Oficina ${ctx.inquilino.nombre}`,
          html: `<p>Hola${u.nombre ? " " + esc(u.nombre) : ""}. Entre a la Oficina ${esc(ctx.inquilino.nombre)} con este enlace (vale una sola vez, hasta ${esc(vence.slice(0, 16).replace("T", " "))} UTC):</p><p><a href="${esc(enlace)}">${esc(enlace)}</a></p>`,
          texto: `Entre a la Oficina ${ctx.inquilino.nombre} con este enlace (una sola vez): ${enlace}` });
        enviado = true;
      } catch (e) { errorCorreo = e.message; }
    }
    return { enlace, vence, enviado, errorCorreo };
  });
  // Un usuario ya registrado pide su enlace por correo (solo funciona con SMTP; nunca revela si el correo existe).
  ruta("POST", "/api/acceso/pedir", async (q, p, cuerpo, quien, ctx) => {
    const u = ctx.db.usuarioPorCorreo(cuerpo.correo);
    if (!(ctx.cfg.SMTP_HOST && ctx.cfg.SMTP_USER && ctx.cfg.SMTP_PASS)) return error(503, "El envío de correo no está configurado; pida el enlace a su contador.");
    if (u && u.activo) {
      const token = randomBytes(24).toString("base64url");
      ctx.db.crearInvitacion(u.id, hash(token), { minutos: 30, quien: "acceso/pedir" });
      const enlace = `${String(cuerpo.base || "").replace(/\/+$/, "")}${ctx.prefijo || ""}/?t=${token}`;
      try { await enviarCorreo({ cfg: ctx.cfg, para: u.correo, asunto: `Su enlace de acceso a la Oficina ${ctx.inquilino.nombre}`, html: `<p><a href="${esc(enlace)}">${esc(enlace)}</a> (vale 30 minutos, una sola vez)</p>`, texto: enlace }); }
      catch { /* no se revela nada */ }
    }
    return { ok: true, mensaje: "Si el correo está registrado, el enlace va en camino." };
  }, ["publico"]);

  // lista de inquilinos (para el selector cuando hay varios y ninguno se puede deducir)
  const listaInquilinos = () => inquilinos.map(i => ({ ...marcaDe(i), prefijo: `/t/${i.id}` }));

  // --- el servidor
  const intentos = new Limitador({ maximo: 10, ventanaMs: 15 * 60 * 1000 });
  const servidor = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const q = Object.fromEntries(url.searchParams);
    const remota = esRemota(req), ip = ipDe(req);
    try {
      if (url.pathname === "/api/inquilinos") return responder(res, 200, listaInquilinos());
      const r0 = resolverInquilino(inquilinos, { host: req.headers.host || "", pathname: url.pathname });
      if (!r0) {
        // varios inquilinos y la URL no dice cuál: la app muestra el selector
        if (url.pathname.startsWith("/api/")) return responder(res, 404, { error: "Indique el inquilino: /t/<id>/api/…", inquilinos: listaInquilinos() });
        return estatico(res, raizProyecto, url.pathname);
      }
      const ctx0 = contextos.find(c => c.inquilino === r0.inquilino);
      const ctx = { ...ctx0, prefijo: r0.prefijo, remota };
      const pathname = r0.ruta;
      const token = ctx.cfg.SERVICIO_TOKEN || "";
      const nombreCookie = `oficina_${ctx.inquilino.id}`;
      // Sin token, nada se sirve hacia afuera (túnel, proxy u otra máquina): solo esta PC.
      if (remota && !token) {
        log(`Acceso remoto rechazado (${ip}) a ${url.pathname}: falta SERVICIO_TOKEN`);
        return responder(res, 403, { error: "Esta oficina no acepta conexiones remotas: configure SERVICIO_TOKEN en el servicio." });
      }
      if (req.method === "POST" && !esJSON(req)) return responder(res, 415, { error: "Las peticiones tienen que ser JSON." });
      const porBearer = Boolean(token) && igual(String(req.headers.authorization || ""), `Bearer ${token}`);
      if (req.method === "POST" && !porBearer && origenAjeno(req)) {
        log(`POST con origen ajeno rechazado (${ip}): ${req.headers.origin} → ${url.pathname}`);
        return responder(res, 403, { error: "Origen no permitido." });
      }
      const entradas = ["/api/entrar", "/api/acceso/entrar"];
      if (req.method === "POST" && entradas.includes(pathname) && intentos.bloqueado(ip)) return responder(res, 429, { error: "Demasiados intentos. Espere 15 minutos." });

      // Entrar: valida el token y lo deja en una cookie (HttpOnly) para la app y la oficina 2D.
      if (pathname === "/api/entrar" && req.method === "POST") {
        const cuerpo = await leerCuerpo(req);
        if (!token) return responder(res, 200, { ok: true, token: false });
        if (!igual(String(cuerpo.token || ""), token)) { intentos.fallo(ip); log(`Token incorrecto desde ${ip}`); return responder(res, 401, { error: "Token incorrecto." }); }
        intentos.limpiar(ip);
        res.setHeader("Set-Cookie", `${nombreCookie}=${firmar(token)}; Path=${r0.prefijo || "/"}; HttpOnly; SameSite=Strict; Max-Age=2592000${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
        return responder(res, 200, { ok: true, token: true });
      }
      if (pathname === "/api/salir" && req.method === "POST") {
        res.setHeader("Set-Cookie", `${nombreCookie}=; Path=${r0.prefijo || "/"}; HttpOnly; Max-Age=0`);
        return responder(res, 200, { ok: true });
      }
      // Canje de una invitación: POST /api/acceso/entrar {token} → sesión en cookie.
      const nombreSesion = `sesion_${ctx.inquilino.id}`;
      if (pathname === "/api/acceso/entrar" && req.method === "POST") {
        const cuerpo = await leerCuerpo(req);
        const u = ctx.db.canjearInvitacion(hash(String(cuerpo.token || "")));
        if (!u) { intentos.fallo(ip); return responder(res, 401, { error: "El enlace no es válido, ya se usó o venció. Pida uno nuevo." }); }
        const id = randomBytes(24).toString("base64url");
        ctx.db.crearSesion(hash(id), u.id);
        ctx.db.auditar(u.correo, "entrar", "usuario", u.id);
        res.setHeader("Set-Cookie", `${nombreSesion}=${id}; Path=${r0.prefijo || "/"}; HttpOnly; SameSite=Strict; Max-Age=2592000${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
        return responder(res, 200, { ok: true, usuario: { correo: u.correo, nombre: u.nombre, rol: u.rol } });
      }
      if (pathname === "/api/acceso/salir" && req.method === "POST") {
        ctx.db.cerrarSesion(hash(cookie(req, nombreSesion)));
        res.setHeader("Set-Cookie", `${nombreSesion}=; Path=${r0.prefijo || "/"}; HttpOnly; Max-Age=0`);
        return responder(res, 200, { ok: true });
      }

      // ¿Quién es? (1) token de servicio: contable sin nombre fijo; (2) sesión de un usuario registrado.
      const porToken = porBearer || (Boolean(token) && igual(cookie(req, nombreCookie), firmar(token)));
      const usuario = ctx.db.usuarioDeSesion(hash(cookie(req, nombreSesion)));
      ctx.usuario = usuario;
      // Sin SERVICIO_TOKEN configurado y sin sesión, todo es contable (modo local de siempre).
      const autorizado = !token || porToken || Boolean(usuario);
      if (!autorizado) {
        if (pathname.startsWith("/api/")) {
          const r = rutas.find(x => x.metodo === req.method && x.re.test(pathname));
          if (r && r.roles.includes("publico")) {
            const cuerpo = req.method === "POST" ? await leerCuerpo(req) : {};
            const out = await r.fn(q, pathname.match(r.re).groups || {}, cuerpo, "anónimo", ctx);
            return out && out.__error ? responder(res, out.__error, { error: out.mensaje }) : responder(res, 200, out ?? {});
          }
          return responder(res, 401, { error: "Hace falta entrar.", entrar: true, inquilino: marcaDe(ctx.inquilino), prefijo: ctx.prefijo || "", smtp: Boolean(ctx.cfg.SMTP_HOST && ctx.cfg.SMTP_USER && ctx.cfg.SMTP_PASS) });
        }
        if (pathname === "/oficina") return redirigir(res, (r0.prefijo || "") + "/");
        return estatico(res, raizProyecto, pathname);
      }

      if (pathname.startsWith("/api/")) {
        const r = rutas.find(x => x.metodo === req.method && x.re.test(pathname));
        if (!r) return responder(res, 404, { error: "No existe esa ruta." });
        const rol = usuario ? usuario.rol : "contable";
        if (!r.roles.includes(rol) && !r.roles.includes("publico")) return responder(res, 403, { error: "Su acceso no permite esta acción." });
        // Escribir en Odoo o mandar correos desde afuera: con sesión personal, no con el token compartido.
        if (remota && !usuario && RUTAS_CON_SESION.some(re => re.test(pathname)) && String(ctx.cfg.ESCRITURA_SIN_SESION || "").toLowerCase() !== "si") {
          ctx.db.auditar(`token (${ip})`, "rechazado", "ruta", null, { ruta: pathname, motivo: "escritura remota sin sesión" });
          return responder(res, 403, { error: "Desde fuera de la PC del servicio, ejecutar en Odoo o enviar correos requiere entrar con su enlace personal (pestaña Usuarios): así la auditoría lleva su nombre verificado." });
        }
        let cuerpo = {};
        if (req.method === "POST") cuerpo = await leerCuerpo(req);
        const quien = usuario ? (usuario.nombre ? `${usuario.nombre} <${usuario.correo}>` : usuario.correo) : String(req.headers["x-quien"] || cuerpo.quien || "anónimo").slice(0, 120);
        const params = pathname.match(r.re).groups || {};
        const out = await r.fn(q, params, cuerpo, quien, ctx);
        if (out && out.__error) return responder(res, out.__error, { error: out.mensaje });
        return responder(res, 200, out ?? {});
      }
      // la oficina 2D del inquilino, armada en cada visita con la plantilla ACTUAL y las cifras de la
      // última corrida: así un despliegue nuevo se ve sin esperar a que corra Recepción.
      if (pathname === "/oficina") {
        if (esReceptor(ctx)) return redirigir(res, (r0.prefijo || "") + "/");
        const rutaEstado = join(ctx.raiz, "data", "estado.json");
        const estado = existsSync(rutaEstado) ? JSON.parse(readFileSync(rutaEstado, "utf8")) : { agentes: [] };
        const html = generarOficina({ raizProyecto, raiz: ctx.raiz, cfg: ctx.cfg, estado, marca: ctx.corridas?.marca || ctx.inquilino, prefijo: ctx.corridas?.prefijo ?? (r0.prefijo || "") });
        res.writeHead(200, cabeceras({ "Content-Type": TIPOS[".html"], "Cache-Control": "no-store" }, { html: true }));
        return res.end(html);
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
  res.writeHead(200, cabeceras({ "Content-Type": TIPOS[extname(archivo)] || "application/octet-stream" }, { html: extname(archivo) === ".html" }));
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
const hash = t => createHash("sha256").update(String(t)).digest("hex");
const esc = s => String(s ?? "").replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
function igual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y); }
function cookie(req, nombre) {
  const m = String(req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(nombre + "="));
  return m ? decodeURIComponent(m.slice(nombre.length + 1)) : "";
}
function redirigir(res, a) { res.writeHead(302, cabeceras({ Location: a })); res.end(); }
function responder(res, codigo, obj) {
  res.writeHead(codigo, cabeceras({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }));
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
