// EL DIRECTOR por modelo de lenguaje. Recibe una instrucción en palabras, decide qué
// agente la atiende, lo ejecuta con herramientas y responde con cifras.
//
// Principios (los mismos de toda la oficina):
//   · Determinismo en el centro: las herramientas son los agentes y la base de datos.
//     El modelo no inventa cifras, las pide.
//   · Humano en cada escritura: NO EXISTE herramienta que escriba en Odoo ni que envíe
//     correo. Cuentas corre en modo propuesta, Comunicación en modo borrador. Aprobar y
//     aplicar sigue siendo trabajo de una persona en la pestaña Aprobaciones.
//   · Sin dependencias: la API de Claude se llama con fetch.
//
// Configuración (.env): CLAUDE_API_KEY (obligatoria para este Director; sin ella el servicio
// usa el Director de palabras clave), CLAUDE_WORKSPACE_ID (solo si la clave es de usuario,
// sk-ant-usr-…), DIRECTOR_MODELO (por defecto claude-sonnet-4-5), DIRECTOR_MAX_PASOS (12).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { causasDominantes } from "../lib/correo.js";
import { DirectorCore } from "../director.js";
import { Catalogo, canon, norm } from "../catalogo.js";

const API = "https://api.anthropic.com/v1/messages";

export class DirectorLLM {
  constructor({ db, corridas, cfg, raiz, log = () => {}, fetchImpl = globalThis.fetch }) {
    this.db = db; this.corridas = corridas; this.cfg = cfg; this.raiz = raiz; this.log = log; this.fetch = fetchImpl;
    this.modelo = cfg.DIRECTOR_MODELO || "claude-sonnet-4-5";
    this.maxPasos = Number(cfg.DIRECTOR_MAX_PASOS || 12);
    // Memoria: cuántos turnos recientes van completos (con resultados de herramientas) y el tope
    // de caracteres del historial que se manda al modelo. Lo anterior se conserva como texto.
    this.turnosCompletos = Number(cfg.DIRECTOR_TURNOS_COMPLETOS || 6);
    this.maxContexto = Number(cfg.DIRECTOR_MAX_CONTEXTO || 160_000);
    this.retencionDias = Number(cfg.DIRECTOR_RETENCION_DIAS || 30);
    this.roster = leerJSON(join(raiz, "data", "roster.json"), { agentes: [], noConstruidos: [] });
  }

  get disponible() { return Boolean(this.cfg.CLAUDE_API_KEY); }

  // --- Las herramientas. Solo lectura y propuesta. -----------------------------------
  herramientas() {
    return [
      { name: "companias", description: "Lista las compañías de la instancia (id y nombre). Úsala para resolver el nombre que dio el usuario a un id antes de llamar a cuentas o filtrar casos.",
        input_schema: { type: "object", properties: { buscar: { type: "string", description: "texto a buscar en el nombre (opcional)" } } } },
      { name: "estado", description: "Estado general: última corrida de cada agente con sus totales y alertas, casos abiertos por frente/receptor/compañía, pendientes de aprobación.",
        input_schema: { type: "object", properties: {} } },
      { name: "correr_agente", description: "Ejecuta un agente contra Odoo AHORA y devuelve sus totales y alertas. recepcion (Marta): buzón de todas las compañías. conciliacion: correos registrados sin asiento. cuentas: propone cuentas contables de UNA compañía (obligatorio empresa), solo propone. comunicacion (Victor): redacta borradores a partir de la última corrida de Marta, no envía. Tarda de 5 a 60 segundos.",
        input_schema: { type: "object", properties: { agente: { type: "string", enum: ["recepcion", "conciliacion", "cuentas", "comunicacion"] }, empresa: { type: "integer", description: "id de compañía, obligatorio para cuentas" } }, required: ["agente"] } },
      { name: "casos", description: "Casos abiertos que dejó Recepción (uno por documento y receptor): tiquetes, rechazados, duplicados, errores, en cola, cédulas inválidas. Filtra por receptor (correo), compañía (id) o frente (afuera = reclamar al establecimiento; adentro = revisar en la compañía).",
        input_schema: { type: "object", properties: { receptor: { type: "string" }, compania: { type: "integer" }, frente: { type: "string", enum: ["afuera", "adentro"] }, seguimiento: { type: "string", enum: ["abierto", "resuelto", "cerrado", "todos"] }, limite: { type: "integer" } } } },
      { name: "propuestas", description: "Propuestas de corrección de cuenta contable del agente Cuentas, con su estado (propuesta, aprobada, rechazada, aplicada, fallo).",
        input_schema: { type: "object", properties: { estado: { type: "string" }, compania: { type: "integer" } } } },
      { name: "correos", description: "Correos redactados por Victor y su estado (borrador, aprobado, enviado, rechazado). No incluye el HTML.",
        input_schema: { type: "object", properties: { estado: { type: "string" } } } },
      { name: "causas_errores", description: "Agrupa los correos en estado error por causa (texto del error normalizado). Es el adelanto del agente Diagnóstico, que todavía no está construido.",
        input_schema: { type: "object", properties: { compania: { type: "integer" } } } },
      { name: "revisar_factura", description: "Revisa UNA factura de proveedor línea por línea con el criterio del agente Cuentas: para cada línea devuelve la cuenta actual y la cuenta que el catálogo histórico de esa compañía (o una regla humana) sugiere, con fuente y confianza, si esa cuenta existe en el plan de la compañía y qué hacen las demás compañías con el mismo artículo. Úsala cuando pregunten en qué cuenta debería ir una factura o sus ítems. Solo lee y propone; no cambia nada.",
        input_schema: { type: "object", properties: { factura: { type: "integer", description: "id de account.move" }, nombre: { type: "string", description: "número de la factura (name) o parte, si no se sabe el id" }, proveedor: { type: "string", description: "nombre del proveedor, para acotar la búsqueda por nombre" }, compania: { type: "integer", description: "id de compañía, para acotar la búsqueda" } } } },
      { name: "proponer_regla", description: "Deja PROPUESTA una regla contable que la persona dictó («todo lo de Rostipollos va a 5.04.17.01», «este artículo siempre a tal cuenta»). No escribe en Odoo: queda en Aprobaciones → Reglas; cuando un contable la aprueba se guarda como regla humana y el agente Cuentas vuelve a revisar esa compañía y propone el cambio de cada línea afectada. Alcance: por proveedor (todo lo que factura ese proveedor a esa compañía) o por artículo (una o varias descripciones exactas de línea). Validá antes que el código exista en el plan de esa compañía (la herramienta también lo valida).",
        input_schema: { type: "object", properties: { compania: { type: "integer", description: "id de la compañía (cliente) a la que aplica" }, codigo: { type: "string", description: "código de la cuenta destino, p. ej. 5.04.17.01" }, proveedor_id: { type: "integer", description: "id de res.partner del proveedor (regla por proveedor)" }, articulos: { type: "array", items: { type: "string" }, description: "descripciones de línea (regla por artículo)" }, motivo: { type: "string", description: "la decisión en palabras de la persona" }, factura: { type: "integer", description: "id de la factura que originó la regla (opcional)" } }, required: ["compania", "codigo", "motivo"] } },
      { name: "leer_odoo", description: "Lectura directa de Odoo (search_read) con un dominio. SOLO LECTURA. Modelos útiles: bdt.invoice.email (buzón), account.move (asientos; e_key es la clave de Hacienda), account.move.line, res.partner (vat = cédula), res.company, account.account. OJO: en account.account el campo code depende de la compañía; pasá siempre compania o vendrá code=false. Máximo 200 filas; para conteos usa agrupar_odoo.",
        input_schema: { type: "object", properties: { modelo: { type: "string" }, dominio: { type: "array", description: "dominio Odoo, p. ej. [[\"state\",\"=\",\"done\"],[\"company_id\",\"=\",126]]" }, campos: { type: "array", items: { type: "string" } }, limite: { type: "integer" }, orden: { type: "string" }, compania: { type: "integer", description: "id de compañía para leer en su contexto (códigos de cuenta, campos por compañía)" } }, required: ["modelo", "dominio", "campos"] } },
      { name: "agrupar_odoo", description: "Conteos y agregados en Odoo (read_group). SOLO LECTURA. Ej.: correos por estado y compañía: modelo bdt.invoice.email, agrupar [\"company_id\",\"state\"].",
        input_schema: { type: "object", properties: { modelo: { type: "string" }, dominio: { type: "array" }, agrupar: { type: "array", items: { type: "string" } }, campos: { type: "array", items: { type: "string" }, description: "agregados como \"date:max\" o \"amount_total:sum\"" }, compania: { type: "integer", description: "id de compañía para leer en su contexto" } }, required: ["modelo", "dominio", "agrupar"] } }
    ];
  }

  async ejecutarHerramienta(nombre, args, quien) {
    const db = this.db;
    switch (nombre) {
      case "companias": {
        const lista = leerJSON(join(this.raiz, "data", "companias.json"), []);
        const q = (args.buscar || "").toLowerCase();
        return lista.filter(c => !q || c.name.toLowerCase().includes(q)).map(c => ({ id: c.id, nombre: c.name })).slice(0, 100);
      }
      case "estado": {
        const ultimas = {};
        for (const a of ["recepcion", "comunicacion", "conciliacion", "cuentas"]) {
          const u = db.ultimaCorrida(a);
          ultimas[a] = u ? { corrida: u.id, fin: u.fin, compania: u.compania, totales: u.totales, alertas: (u.alertas || []).map(x => x.texto), porEstado: u.resultado?.porEstado } : null;
        }
        return { ultimas, casos: db.resumenCasos(), pendientes: { propuestas: db.propuestas({ estado: "propuesta" }).length, correosBorrador: db.correos({ estado: "borrador" }).length } };
      }
      case "correr_agente": {
        const a = args.agente;
        const extra = [];
        if (a === "cuentas") {
          if (!args.empresa) return { error: "Para cuentas hay que indicar la compañía (empresa = id). Por seguridad se revisa una a la vez." };
          extra.push(`--empresa=${args.empresa}`);
        }
        // Nunca --aplicar ni --enviar: el Director solo lee y propone.
        const { corridaId, resultado, resumen } = await this.corridas.correr(a, extra, { quienPide: `director:${quien}` });
        return { corridaId, resumen, totales: resultado.totales, alertas: resultado.alertas, porEstado: resultado.porEstado, companias: (resultado.companias || []).slice(0, 15),
          propuestas: (resultado.propuestas || []).slice(0, 30), revisionHumana: (resultado.revisionHumana || []).slice(0, 15), correos: (resultado.correos || []).slice(0, 30) };
      }
      case "casos": return db.casos({ receptor: args.receptor || null, companiaId: args.compania || null, frente: args.frente || null, seguimiento: args.seguimiento || "abierto", limite: Math.min(args.limite || 100, 300) })
        .map(c => ({ id: c.id, receptor: c.receptor, compania: c.compania, frente: c.frente, estado: c.estado_buzon, establecimiento: c.establecimiento, cedula: c.cedula_emisor, consecutivo: c.consecutivo, fecha: c.fecha_documento, veces: c.veces, error: c.error, seguimiento: c.seguimiento }));
      case "propuestas": return db.propuestas({ estado: args.estado || "propuesta", companiaId: args.compania || null, limite: 200 })
        .map(p => ({ id: p.id, factura: p.factura, estadoFactura: p.factura_estado, articulo: p.articulo, cuentaActual: p.cuenta_actual, cuentaNueva: p.cuenta_nueva, fuente: p.fuente, confianza: p.confianza, estado: p.estado }));
      case "correos": return db.correos({ estado: args.estado || "borrador" }).map(c => ({ id: c.id, frente: c.frente, para: c.para, asunto: c.asunto, casos: c.casos, estado: c.estado }));
      case "causas_errores": {
        const casos = db.casos({ frente: "adentro", companiaId: args.compania || null, seguimiento: "todos", limite: 5000 }).filter(c => c.estado_buzon === "error");
        return { correosConError: casos.length, causas: causasDominantes(casos.map(c => ({ error: c.error, estado: "error" })), { max: 10 }) };
      }
      case "revisar_factura": return this.#revisarFactura(args);
      case "proponer_regla": return this.#proponerRegla(args, quien);
      case "leer_odoo": {
        const odoo = this.corridas.crearCliente({ meta: { escribe: false } });
        const filas = await odoo.leer(args.modelo, "search_read", [args.dominio || [], args.campos || []],
          { limit: Math.min(args.limite || 50, 200), ...(args.orden ? { order: args.orden } : {}), context: contextoTodas(this.raiz, args.compania) });
        return filas;
      }
      case "agrupar_odoo": {
        const odoo = this.corridas.crearCliente({ meta: { escribe: false } });
        return odoo.leer(args.modelo, "read_group", [args.dominio || [], args.campos || ["id"], args.agrupar || []], { lazy: false, context: contextoTodas(this.raiz, args.compania) });
      }
      default: return { error: `No existe la herramienta ${nombre}.` };
    }
  }

  // Una factura con el criterio de Cuentas, sin escribir ni registrar propuestas: lo que el
  // agente haría con esa factura, explicado línea por línea para que el Director lo cuente.
  async #revisarFactura(args) {
    const rutaCatalogo = this.cfg.CATALOGO_CUENTAS ? join(this.raiz, this.cfg.CATALOGO_CUENTAS) : join(this.raiz, "data", "catalogo-cuentas.json");
    if (!existsSync(rutaCatalogo)) return { error: "No hay catálogo de cuentas (data/catalogo-cuentas.json). Hay que construirlo con: npm run catalogo" };
    const odoo = this.corridas.crearCliente({ meta: { escribe: false } });
    const ctxTodas = { context: contextoTodas(this.raiz) };
    let dom;
    if (args.factura) dom = [["id", "=", Number(args.factura)]];
    else if (args.nombre || args.proveedor) {
      dom = [["move_type", "in", ["in_invoice", "in_refund"]]];
      if (args.nombre) dom.push(["name", "ilike", args.nombre]);
      if (args.proveedor) dom.push(["partner_id.name", "ilike", args.proveedor]);
      if (args.compania) dom.push(["company_id", "=", Number(args.compania)]);
    } else return { error: "Indique la factura: id (factura), número (nombre) o proveedor." };
    const facturas = await odoo.leer("account.move", "search_read",
      [dom, ["name", "state", "payment_state", "partner_id", "invoice_date", "amount_total", "company_id", "move_type"]], { limit: 5, order: "invoice_date desc", ...ctxTodas });
    if (!facturas.length) return { error: "No encontré esa factura." };
    if (facturas.length > 1 && !args.factura) return { varias: facturas.map(f => ({ id: f.id, nombre: f.name, proveedor: f.partner_id?.[1], compania: f.company_id?.[1], fecha: f.invoice_date, total: f.amount_total })), nota: "Hay varias; vuelva a llamar con el id (factura)." };
    const f = facturas[0];
    const CID = f.company_id?.[0], ciaNombre = f.company_id?.[1] || "";
    const ctx = { context: { allowed_company_ids: [CID] } };
    const lineas = await odoo.leer("account.move.line", "search_read",
      [[["move_id", "=", f.id], ["display_type", "in", ["product", "other"]]], ["name", "account_id", "product_id", "balance", "quantity", "price_unit"]], ctx);
    const plan = await odoo.leerTodo("account.account", [["company_ids", "in", [CID]]], ["code", "name", "account_type", "deprecated"], { context: ctx.context });
    const porCodigo = new Map(); const porNombre = new Map();
    for (const c of plan) if (!c.deprecated) { porCodigo.set(canon(c.code), c); porNombre.set(norm(c.name), c); }
    const cat = new Catalogo(rutaCatalogo, join(this.raiz, "data", "reglas.json"));
    const CAJON = ["5.04.999", "5.04.099", "5.04.99", "7.01.001", "7.01"];
    const items = lineas.map(l => {
      const texto = l.name || (l.product_id ? l.product_id[1] : "");
      const actual = l.account_id ? l.account_id[1] : "(sin cuenta)";
      const codigoActual = canon(actual.split(" ")[0]);
      const d = cat.resolver(ciaNombre, texto, { proveedorId: f.partner_id?.[0] || null, proveedor: f.partner_id?.[1] || null });
      const g = cat.global[norm(texto)];
      const r = { lineaId: l.id, articulo: String(texto).slice(0, 80), monto: l.balance, cuentaActual: actual, esCajonDeSastre: CAJON.includes(codigoActual) };
      if (!d) { r.sugerencia = null; r.veredicto = "sin referencia: el artículo no está en el catálogo histórico de esta compañía ni en el global; lo decide un contador"; }
      else {
        const destino = porCodigo.get(d.codigo) || porNombre.get(norm(d.cuenta)) || null;
        r.sugerencia = { codigo: d.codigo, cuenta: d.cuenta, fuente: d.fuente, confianza: d.confianza, veces: d.veces, parecidoA: d.parecidoA, decidio: d.decidio, existeEnPlan: Boolean(destino) };
        if (!destino) r.veredicto = `el catálogo pide ${d.codigo} ${d.cuenta} pero esa cuenta no existe en el plan de ${ciaNombre}`;
        else if (l.account_id && l.account_id[0] === destino.id) r.veredicto = "correcta: coincide con el histórico";
        else if (d.confianza < 0.9) r.veredicto = `parecido no seguro (${d.confianza}); Cuentas lo mandaría a revisión humana`;
        else r.veredicto = `Cuentas propondría cambiarla a ${destino.code} ${destino.name}`;
      }
      if (g && !actual.includes(g[1])) r.otrasCompanias = { cuenta: `${g[0]} ${g[1]}`, veces: g[2] };
      return r;
    });
    return { factura: { id: f.id, nombre: f.name, proveedor: f.partner_id?.[1], compania: ciaNombre, companiaId: CID, estado: f.state, pago: f.payment_state, fecha: f.invoice_date, total: f.amount_total },
      lineas: items, planCuentas: plan.length,
      nota: "Nada se cambió. Para que quede como propuesta formal hay que correr el agente cuentas sobre la compañía (correr_agente) y aprobar en la pestaña Aprobaciones." };
  }

  // Una regla dictada en el chat → queda propuesta (base de la app, no Odoo). Valida la cuenta en el
  // plan de esa compañía y estima cuántas líneas tocaría hoy, para que quien aprueba sepa el alcance.
  async #proponerRegla(args, quien) {
    if (!this.db?.proponerRegla) return { error: "Esta instalación no guarda reglas propuestas." };
    const CID = Number(args.compania);
    const articulos = (args.articulos || []).map(s => String(s).trim()).filter(Boolean);
    if (!CID) return { error: "Falta la compañía (compania = id)." };
    if (!args.proveedor_id && !articulos.length) return { error: "Indique el alcance: proveedor_id (todo lo de ese proveedor) o articulos (descripciones de línea)." };
    const odoo = this.corridas.crearCliente({ meta: { escribe: false } });
    const ctx = { context: { allowed_company_ids: [CID] } };
    const [cia] = await odoo.leer("res.company", "search_read", [[["id", "=", CID]], ["name"]]);
    if (!cia) return { error: `No existe la compañía ${CID}.` };
    const plan = await odoo.leerTodo("account.account", [["company_ids", "in", [CID]]], ["code", "name", "deprecated"], { context: ctx.context });
    const destino = plan.find(c => !c.deprecated && canon(c.code) === canon(args.codigo));
    if (!destino) {
      const cerca = plan.filter(c => c.code && canon(c.code).startsWith(canon(args.codigo).split(".").slice(0, 3).join("."))).slice(0, 8).map(c => `${c.code} ${c.name}`);
      return { error: `La cuenta ${args.codigo} no existe (o está obsoleta) en el plan de ${cia.name}.`, parecidas: cerca };
    }
    let proveedor = null;
    if (args.proveedor_id) {
      const [p] = await odoo.leer("res.partner", "search_read", [[["id", "=", Number(args.proveedor_id)]], ["name", "vat"]]);
      if (!p) return { error: `No existe el proveedor ${args.proveedor_id}.` };
      proveedor = p;
    }
    // alcance de hoy: líneas de facturas de proveedor no pagadas de esa compañía que cambiarían
    const dom = [["move_id.move_type", "in", ["in_invoice", "in_refund"]], ["company_id", "=", CID], ["display_type", "in", ["product", "other"]],
      ["parent_state", "in", ["draft", "posted"]], ["account_id", "!=", destino.id]];
    if (proveedor) dom.push(["partner_id", "=", proveedor.id]);
    let lineas = null;
    try {
      const filas = await odoo.leerTodo("account.move.line", dom, ["name", "move_id"], { context: ctx.context });
      lineas = proveedor ? filas.length : filas.filter(l => articulos.some(a => norm(a) === norm(l.name))).length;
    } catch { /* el estimado es informativo */ }
    let ejemplo = null;
    if (args.factura) { const [f] = await odoo.leer("account.move", "search_read", [[["id", "=", Number(args.factura)]], ["name"]], ctx); ejemplo = f ? `${f.name} (id ${f.id})` : null; }
    const creadas = (proveedor ? [{ proveedorId: proveedor.id, proveedor: proveedor.name }] : articulos.map(a => ({ articulo: a })))
      .map(alc => this.db.proponerRegla({ companiaId: CID, compania: cia.name, ...alc, codigo: destino.code, cuenta: destino.name, cuentaId: destino.id,
        motivo: String(args.motivo || "").slice(0, 500), ejemplo, lineas, propuso: `director:${quien}` }));
    return { propuestas: creadas.map(r => ({ id: r.id, alcance: r.proveedor ? `todo lo de ${r.proveedor}` : `artículo «${r.articulo}»`, compania: r.compania, cuenta: `${r.codigo} ${r.cuenta}` })),
      lineasAfectadasHoy: lineas,
      siguiente: "Queda en la pestaña Aprobaciones → Reglas. Al aprobarla, Cuentas revisa de nuevo la compañía y cada línea afectada aparece como propuesta para aprobar; aplicar en Odoo sigue bloqueado hasta que se permita la escritura." };
  }

  // --- Memoria ----------------------------------------------------------------------------
  // Lo que esta persona habló antes con el Director (otras conversaciones de los últimos
  // retencionDias días), como texto corto para el sistema. La conversación en curso va aparte,
  // completa, en los mensajes.
  memoriaDe(quien, { excepto = null, maxChars = 6000 } = {}) {
    if (!quien || !this.db?.conversaciones) return "";
    const lista = this.db.conversaciones({ quien, limite: 10, dias: this.retencionDias }).filter(c => c.id !== excepto);
    const partes = [];
    let total = 0;
    for (const c of lista) {
      const fecha = String(c.ultimo || c.inicio || "").slice(0, 10);
      for (const t of (c.resumen || []).slice(-6)) {
        const linea = `- [${fecha}] P: ${corto(t.pregunta, 160)} / R: ${corto(t.respuesta, 240)}`;
        if (total + linea.length > maxChars) break;
        partes.push(linea); total += linea.length;
      }
      if (total >= maxChars) break;
    }
    return partes.join("\n");
  }

  // El historial que se manda al modelo. Los últimos turnosCompletos turnos van tal cual
  // (con herramientas y resultados); los anteriores quedan como pregunta y respuesta en texto,
  // que es lo que importa para seguir el hilo. Y nunca más de maxContexto caracteres.
  podar(mensajes) {
    const turnos = [];
    for (const m of mensajes) {
      const esInicio = m.role === "user" && typeof m.content === "string";
      if (esInicio || !turnos.length) turnos.push([]);
      turnos[turnos.length - 1].push(m);
    }
    const compacto = turno => turno.flatMap(m => {
      if (m.role === "user") return typeof m.content === "string" ? [m] : [];
      const texto = (Array.isArray(m.content) ? m.content : []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      return texto ? [{ role: "assistant", content: [{ type: "text", text: texto }] }] : [];
    });
    let salida = turnos.map((t, i) => i >= turnos.length - this.turnosCompletos ? t : compacto(t));
    const tam = s => JSON.stringify(s).length;
    // Si aun así es mucho: primero compactar los completos más viejos, luego soltar los más viejos.
    for (let i = turnos.length - this.turnosCompletos; i < turnos.length - 1 && tam(salida) > this.maxContexto; i++) if (i >= 0) salida[i] = compacto(turnos[i]);
    while (salida.length > 1 && tam(salida) > this.maxContexto) salida.shift();
    const plano = salida.flat();
    // La API exige empezar por user y alternar; un turno compactado puede haber quedado sin assistant.
    const limpio = [];
    for (const m of plano) {
      if (!limpio.length && m.role !== "user") continue;
      if (limpio.length && limpio[limpio.length - 1].role === m.role) {
        // dos seguidos del mismo rol: fusionar textos
        const a = limpio[limpio.length - 1];
        const ta = typeof a.content === "string" ? a.content : a.content.filter(b => b.type === "text").map(b => b.text).join("\n");
        const tb = typeof m.content === "string" ? m.content : m.content.filter(b => b.type === "text").map(b => b.text).join("\n");
        limpio[limpio.length - 1] = { role: m.role, content: m.role === "user" ? `${ta}\n${tb}` : [{ type: "text", text: `${ta}\n${tb}` }] };
        continue;
      }
      limpio.push(m);
    }
    return limpio;
  }

  // --- El bucle de conversación -------------------------------------------------------
  sistema(memoria = "") {
    const ag = this.roster.agentes.map(a => `- ${a.nombre}${a.rol && a.rol !== a.nombre ? ` (${a.rol})` : ""}: ${a.hace} No hace: ${a.noHace}${a.escribe ? " ESCRIBE EN ODOO: por el Director solo propone." : ""}`).join("\n");
    const nc = (this.roster.noConstruidos || []).map(a => `- ${a.nombre}: ${a.hace}`).join("\n");
    const congelada = this.cfg.ALERTA_REFERENCIA === "ultimo-correo" ? "\nEsta instancia es una copia de pruebas congelada: las horas sin ingesta se miden contra el último correo, no contra hoy." : "";
    return `Sos el Director de la Oficina IASIMA: un equipo de agentes que operan el buzón de factura electrónica y la contabilidad de Odoo (Costa Rica, localización TecnoDEM, ${leerJSON(join(this.raiz, "data", "companias.json"), []).length || "varias"} compañías).
Recibís instrucciones en lenguaje natural de contadores y receptores. Decidís qué agente atiende, lo ejecutás con las herramientas y respondés con cifras concretas y qué sigue.

Agentes:
${ag}
No construidos todavía (si te lo piden, decilo y ofrecé el adelanto que puedas con las herramientas):
${nc}

Reglas:
1. Nunca inventés cifras: toda cifra sale de una herramienta. Si no hay corrida reciente, corré el agente.
2. Si la instrucción puede ser de dos agentes, preguntá cuál. Si falta la compañía para Cuentas, pedila (buscá primero con "companias" si dieron un nombre).
3. No existe herramienta para escribir en Odoo ni para enviar correos, y así debe ser. Nunca le digas a la persona que lo cambie a mano en Odoo «para que el agente aprenda»: el agente aprende de reglas, no de ediciones.
   - Si dicta una decisión contable que vale de ahora en adelante («este tipo de gasto siempre va a 5.04.17.01», «todo lo de este proveedor va a…»), llamá a "proponer_regla" en el mismo turno. Si dice «este tipo de gastos» refiriéndose a una factura, el alcance natural es el proveedor de esa factura en esa compañía; decí qué alcance usaste. Luego explicá: quedó en Aprobaciones → Reglas; al aprobarla, Cuentas propone cada línea afectada; aplicar en Odoo requiere que se habilite la escritura.
   - Si pide corregir, publicar, enviar o borrar algo puntual, explicá exactamente qué se cambiaría y terminá con: "Esto requiere aprobación humana en la pestaña Aprobaciones; no lo ejecuté."
4. Respondé en español, breve, con las cifras y, cuando sea útil, el agente y la herramienta que usaste. Podés usar **negrita** y listas con "- "; la app las muestra formateadas.
5. Si preguntan en qué cuenta contable debería ir una factura o sus ítems, usá "revisar_factura" (una sola llamada trae líneas, cuenta actual, sugerencia del catálogo y plan): no reconstruyas eso con leer_odoo. Si leés account.account con leer_odoo, pasá compania: sin ella el code viene vacío y NO significa que la cuenta no tenga código.
6. Estados del buzón: done registrada; isticket tiquete (no deducible, se reclama al establecimiento); rejected rechazada (se reclama); duplicate, error, process, vatiderror (se revisan adentro). La clave de Hacienda son 50 dígitos; tipo de documento en posiciones 30-31 (04 = tiquete); cédula del emisor en 10-21.${congelada}
7. Tenés memoria: la conversación en curso te llega completa y abajo va lo que esta persona habló con vos en otras conversaciones de los últimos ${this.retencionDias} días. Si se refiere a algo de antes («la factura que vimos ayer», «lo de Puuk»), usalo. Las cifras de antes pueden estar viejas: si pide un dato actual, volvé a consultar la herramienta.${memoria ? `\n\nConversaciones anteriores con esta persona:\n${memoria}` : ""}`;
  }

  // conversacion: el historial guardado de ESTA conversación; conversacionId: su id, para que la
  // memoria de otras conversaciones no la repita.
  async responder(mensaje, { conversacion = [], conversacionId = null, quien = "anónimo" } = {}) {
    if (!this.disponible) {
      // Sin clave: el Director de palabras, que al menos sabe a quién va.
      const d = DirectorCore.decidir(mensaje, this.roster, leerJSON(join(this.raiz, "data", "companias.json"), []));
      return { respuesta: d.mensaje + (d.accion === "ejecutar" ? ` (Director de palabras: para ejecutarlo use el tablero o configure CLAUDE_API_KEY.)` : ""), pasos: [], conversacion: [...conversacion, { role: "user", content: mensaje }, { role: "assistant", content: d.mensaje }], modo: "palabras" };
    }
    const mensajes = [...this.podar(conversacion), { role: "user", content: mensaje }];
    const sistema = this.sistema(this.memoriaDe(quien, { excepto: conversacionId }));
    const pasos = [];
    for (let i = 0; i < this.maxPasos; i++) {
      const r = await this.#llamar(mensajes, { sistema });
      const bloques = r.content || [];
      mensajes.push({ role: "assistant", content: bloques });
      const usos = bloques.filter(b => b.type === "tool_use");
      if (r.stop_reason !== "tool_use" || !usos.length) {
        const texto = bloques.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
        return { respuesta: texto || "(sin respuesta)", pasos, conversacion: mensajes, modo: "llm", modelo: this.modelo };
      }
      const resultados = [];
      for (const u of usos) {
        const t0 = Date.now();
        let salida;
        try { salida = await this.ejecutarHerramienta(u.name, u.input || {}, quien); }
        catch (e) { salida = { error: e.message }; }
        const texto = JSON.stringify(salida);
        pasos.push({ herramienta: u.name, args: u.input, ms: Date.now() - t0, resumen: texto.slice(0, 160) });
        this.log(`director[${quien}] ${u.name}(${JSON.stringify(u.input)}) → ${texto.length} chars`);
        resultados.push({ type: "tool_result", tool_use_id: u.id, content: texto.slice(0, 60_000) });
      }
      mensajes.push({ role: "user", content: resultados });
    }
    // Se acabaron los pasos: una última llamada sin herramientas para que responda con lo
    // que ya consultó y diga qué le faltó, en vez de rendirse en silencio.
    mensajes.push({ role: "user", content: `Se agotó el límite de ${this.maxPasos} consultas. No podés usar más herramientas: respondé ahora con lo que ya obtuviste, con las cifras que tengas, y decí en una línea qué quedó sin consultar.` });
    try {
      const r = await this.#llamar(mensajes, { sistema, sinHerramientas: true });
      const bloques = r.content || [];
      mensajes.push({ role: "assistant", content: bloques });
      const texto = bloques.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      if (texto && !bloques.some(b => b.type === "tool_use")) return { respuesta: texto, pasos, conversacion: mensajes, modo: "llm", modelo: this.modelo, truncado: true };
    } catch (e) { this.log(`director[${quien}] cierre sin herramientas falló: ${e.message}`); }
    return { respuesta: "Me quedé sin pasos antes de terminar. Intente con una pregunta más acotada.", pasos, conversacion: mensajes, modo: "llm" };
  }

  async #llamar(mensajes, { sistema = this.sistema(), sinHerramientas = false } = {}) {
    const res = await this.fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.cfg.CLAUDE_API_KEY, "anthropic-version": "2023-06-01",
        // Una clave de usuario (sk-ant-usr-…) no está atada a un workspace y la API exige decir cuál;
        // una clave de workspace (sk-ant-api03-…) no lo necesita.
        ...(this.cfg.CLAUDE_WORKSPACE_ID ? { "anthropic-workspace-id": this.cfg.CLAUDE_WORKSPACE_ID } : {}) },
      // Las herramientas van siempre (la conversación ya trae tool_use); "none" le impide pedir más.
      body: JSON.stringify({ model: this.modelo, max_tokens: 2000, system: sistema, tools: this.herramientas(), messages: mensajes,
        ...(sinHerramientas ? { tool_choice: { type: "none" } } : {}) })
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`API de Claude: ${j.error?.message || res.status}`);
    return j;
  }
}

function leerJSON(ruta, siNoExiste) { return existsSync(ruta) ? JSON.parse(readFileSync(ruta, "utf8")) : siNoExiste; }
function corto(s, n) { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; }
// Todas las compañías habilitadas; si se indica una, va PRIMERA: Odoo 18 toma de ella los campos
// que dependen de la compañía (el code de account.account, por ejemplo).
function contextoTodas(raiz, primera = null) {
  const ids = leerJSON(join(raiz, "data", "companias.json"), []).map(c => c.id);
  if (primera) return { allowed_company_ids: [Number(primera), ...ids.filter(i => i !== Number(primera))] };
  return ids.length ? { allowed_company_ids: ids } : {};
}
