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
// usa el Director de palabras clave), DIRECTOR_MODELO (por defecto claude-sonnet-4-5),
// DIRECTOR_MAX_PASOS (8).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { causasDominantes } from "../lib/correo.js";
import { DirectorCore } from "../director.js";

const API = "https://api.anthropic.com/v1/messages";

export class DirectorLLM {
  constructor({ db, corridas, cfg, raiz, log = () => {}, fetchImpl = globalThis.fetch }) {
    this.db = db; this.corridas = corridas; this.cfg = cfg; this.raiz = raiz; this.log = log; this.fetch = fetchImpl;
    this.modelo = cfg.DIRECTOR_MODELO || "claude-sonnet-4-5";
    this.maxPasos = Number(cfg.DIRECTOR_MAX_PASOS || 8);
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
      { name: "leer_odoo", description: "Lectura directa de Odoo (search_read) con un dominio. SOLO LECTURA. Modelos útiles: bdt.invoice.email (buzón), account.move (asientos; e_key es la clave de Hacienda), account.move.line, res.partner (vat = cédula), res.company. Máximo 200 filas; para conteos usa agrupar_odoo.",
        input_schema: { type: "object", properties: { modelo: { type: "string" }, dominio: { type: "array", description: "dominio Odoo, p. ej. [[\"state\",\"=\",\"done\"],[\"company_id\",\"=\",126]]" }, campos: { type: "array", items: { type: "string" } }, limite: { type: "integer" }, orden: { type: "string" } }, required: ["modelo", "dominio", "campos"] } },
      { name: "agrupar_odoo", description: "Conteos y agregados en Odoo (read_group). SOLO LECTURA. Ej.: correos por estado y compañía: modelo bdt.invoice.email, agrupar [\"company_id\",\"state\"].",
        input_schema: { type: "object", properties: { modelo: { type: "string" }, dominio: { type: "array" }, agrupar: { type: "array", items: { type: "string" } }, campos: { type: "array", items: { type: "string" }, description: "agregados como \"date:max\" o \"amount_total:sum\"" } }, required: ["modelo", "dominio", "agrupar"] } }
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
      case "leer_odoo": {
        const odoo = this.corridas.crearCliente({ meta: { escribe: false } });
        const filas = await odoo.leer(args.modelo, "search_read", [args.dominio || [], args.campos || []],
          { limit: Math.min(args.limite || 50, 200), ...(args.orden ? { order: args.orden } : {}), context: contextoTodas(this.raiz) });
        return filas;
      }
      case "agrupar_odoo": {
        const odoo = this.corridas.crearCliente({ meta: { escribe: false } });
        return odoo.leer(args.modelo, "read_group", [args.dominio || [], args.campos || ["id"], args.agrupar || []], { lazy: false, context: contextoTodas(this.raiz) });
      }
      default: return { error: `No existe la herramienta ${nombre}.` };
    }
  }

  // --- El bucle de conversación -------------------------------------------------------
  sistema() {
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
3. No existe herramienta para escribir en Odoo ni para enviar correos, y así debe ser. Si piden corregir, publicar, enviar o borrar algo, explicá exactamente qué se cambiaría y terminá con: "Esto requiere aprobación humana en la pestaña Aprobaciones; no lo ejecuté."
4. Respondé en español, breve, con las cifras y, cuando sea útil, el agente y la herramienta que usaste. Usá listas solo si hay varios elementos.
5. Estados del buzón: done registrada; isticket tiquete (no deducible, se reclama al establecimiento); rejected rechazada (se reclama); duplicate, error, process, vatiderror (se revisan adentro). La clave de Hacienda son 50 dígitos; tipo de documento en posiciones 30-31 (04 = tiquete); cédula del emisor en 10-21.${congelada}`;
  }

  async responder(mensaje, { conversacion = [], quien = "anónimo" } = {}) {
    if (!this.disponible) {
      // Sin clave: el Director de palabras, que al menos sabe a quién va.
      const d = DirectorCore.decidir(mensaje, this.roster, leerJSON(join(this.raiz, "data", "companias.json"), []));
      return { respuesta: d.mensaje + (d.accion === "ejecutar" ? ` (Director de palabras: para ejecutarlo use el tablero o configure CLAUDE_API_KEY.)` : ""), pasos: [], conversacion: [...conversacion, { role: "user", content: mensaje }, { role: "assistant", content: d.mensaje }], modo: "palabras" };
    }
    const mensajes = [...conversacion, { role: "user", content: mensaje }];
    const pasos = [];
    for (let i = 0; i < this.maxPasos; i++) {
      const r = await this.#llamar(mensajes);
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
    return { respuesta: "Me quedé sin pasos antes de terminar. Intente con una pregunta más acotada.", pasos, conversacion: mensajes, modo: "llm" };
  }

  async #llamar(mensajes) {
    const res = await this.fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.cfg.CLAUDE_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: this.modelo, max_tokens: 2000, system: this.sistema(), tools: this.herramientas(), messages: mensajes })
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`API de Claude: ${j.error?.message || res.status}`);
    return j;
  }
}

function leerJSON(ruta, siNoExiste) { return existsSync(ruta) ? JSON.parse(readFileSync(ruta, "utf8")) : siNoExiste; }
function contextoTodas(raiz) {
  const ids = leerJSON(join(raiz, "data", "companias.json"), []).map(c => c.id);
  return ids.length ? { allowed_company_ids: ids } : {};
}
