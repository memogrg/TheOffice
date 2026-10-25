// Corre los agentes desde el servicio y guarda lo que encuentran en la base de datos.
//
// Sigue dejando reportes/ y la oficina 2D como antes (compatibilidad con los .command),
// pero la fuente de verdad pasa a ser data/oficina.db.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Odoo } from "../odoo.js";
import { OdooSimulado } from "../odoo-simulado.js";
import * as recepcion from "../agents/recepcion.js";
import * as conciliacion from "../agents/conciliacion.js";
import * as cuentas from "../agents/cuentas.js";
import * as comunicacion from "../agents/comunicacion.js";
import { reporteHTML, resumenTexto, ETIQUETA } from "../reporte.js";
import { enviar, enviarCorreo } from "../mailer.js";
import { escribirOficina } from "../oficina.js";

export const AGENTES = { recepcion, conciliacion, cuentas, comunicacion };

export class Corridas {
  constructor({ db, cfg, raiz, raizProyecto = raiz, marca = null, prefijo = "", log = () => {} }) {
    this.db = db; this.cfg = cfg; this.raiz = raiz; this.raizProyecto = raizProyecto; this.marca = marca; this.prefijo = prefijo; this.logExterno = log;
    this.enCurso = null;
  }

  crearCliente(agente) {
    const cfg = this.cfg;
    if (cfg.ODOO_SIMULADO) {
      // relativo a la raíz del inquilino o, si no está ahí, a la del proyecto (test/simulado/…)
      const ruta = [join(this.raiz, cfg.ODOO_SIMULADO), join(this.raizProyecto, cfg.ODOO_SIMULADO)].find(existsSync) || join(this.raiz, cfg.ODOO_SIMULADO);
      return new OdooSimulado(existsSync(ruta) ? JSON.parse(readFileSync(ruta, "utf8")) : null, { permitirEscritura: agente.meta.escribe === true });
    }
    for (const k of ["ODOO_URL", "ODOO_DB", "ODOO_USER", "ODOO_PASSWORD"]) if (!cfg[k]) throw new Error(`Falta ${k} en .env`);
    return new Odoo({ url: cfg.ODOO_URL, db: cfg.ODOO_DB, user: cfg.ODOO_USER, password: cfg.ODOO_PASSWORD,
      permitirEscritura: agente.meta.escribe === true, timeoutMs: Number(cfg.ODOO_TIMEOUT_SEGUNDOS || 60) * 1000 });
  }

  // Ejecuta un agente. Devuelve { corridaId, resultado, resumen }.
  async correr(quien, args = [], { quienPide = "servicio" } = {}) {
    const agente = AGENTES[quien];
    if (!agente) throw new Error(`No existe el agente "${quien}".`);
    if (this.enCurso) throw new Error(`Ya hay una corrida en curso: ${this.enCurso.agente} (#${this.enCurso.id}).`);

    const bitacora = [];
    const log = m => { const l = `${new Date().toLocaleTimeString("es-CR", { hour12: false })}  ${m}`; bitacora.push(l); this.logExterno(`[${quien}] ${m}`); };
    const corridaId = this.db.abrirCorrida(quien);
    this.enCurso = { id: corridaId, agente: quien };
    this.db.auditar(quienPide, "correr", "corrida", corridaId, { agente: quien, args });

    let r;
    try {
      const odoo = this.crearCliente(agente);
      r = await agente.ejecutar({ odoo, cfg: this.cfg, log, raiz: this.raiz, args });
      r.bitacora = bitacora;
      r.corridaId = corridaId;
      const resumen = this.#persistir(quien, corridaId, r, args);
      this.db.cerrarCorrida(corridaId, { ...r, resumenServicio: resumen });
      this.#escribirArchivos(quien, agente, r, bitacora);
      return { corridaId, resultado: r, resumen };
    } catch (e) {
      this.db.fallarCorrida(corridaId, e.message);
      throw e;
    } finally {
      this.enCurso = null;
    }
  }

  // Lo que cada agente deja en la base de datos.
  #persistir(quien, corridaId, r, args) {
    if (quien === "recepcion") {
      return this.db.sincronizarCasos(corridaId, r.casosReceptor || []);
    }
    if (quien === "cuentas") {
      const s = this.db.registrarPropuestas(corridaId, r.propuestas || [], { companiaId: r.companiaId, compania: r.compania });
      // Lo que no cierra solo va a consulta del contador. En modo escritura con --solo-lineas no se
      // sincroniza: esa corrida no revisó todo.
      if (r.modo !== "escritura") s.consultas = this.db.sincronizarConsultas(corridaId, r.revisionHumana || [], { companiaId: r.companiaId, compania: r.compania });
      // Las que se aplicaron en esta corrida (modo escritura) se marcan por línea.
      if (r.modo === "escritura") {
        const aplicadasFactura = new Set((r.aplicadas || []).map(a => a.facturaId));
        const pend = this.db.propuestas({ estado: "aprobada", companiaId: r.companiaId });
        const ids = pend.filter(p => aplicadasFactura.has(p.factura_id)).map(p => p.id);
        if (ids.length) this.db.marcarPropuestas(ids, "aplicada", { corridaId });
        const fallos = new Set((r.fallos || []).map(f => f.facturaId));
        const idsFallo = pend.filter(p => fallos.has(p.factura_id)).map(p => p.id);
        if (idsFallo.length) this.db.marcarPropuestas(idsFallo, "fallo", { corridaId, fallos: r.fallos });
      }
      return s;
    }
    if (quien === "comunicacion") {
      const carpeta = join(this.raiz, r.carpeta || "");
      const piezas = (r.correos || []).map(c => ({ ...c, html: existsSync(join(carpeta, c.archivo || "")) ? readFileSync(join(carpeta, c.archivo), "utf8") : "" }));
      const ids = this.db.registrarCorreos(corridaId, piezas);
      return { correos: ids.length };
    }
    return {};
  }

  // Compatibilidad: reportes/, data/estado.json y la oficina 2D, igual que run.js.
  #escribirArchivos(quien, agente, r, bitacora) {
    const fecha = new Date().toISOString().slice(0, 10);
    mkdirSync(join(this.raiz, "reportes"), { recursive: true });
    mkdirSync(join(this.raiz, "data"), { recursive: true });
    const base = join(this.raiz, "reportes", `${quien}-${fecha}`);
    writeFileSync(base + ".json", JSON.stringify(r, null, 2));
    writeFileSync(base + ".html", reporteHTML(r));
    const rutaEstado = join(this.raiz, "data", "estado.json");
    const previo = existsSync(rutaEstado) ? JSON.parse(readFileSync(rutaEstado, "utf8")) : { agentes: [] };
    const ficha = {
      id: agente.meta.id, nombre: agente.meta.nombre, rol: agente.meta.rol || agente.meta.nombre, puesto: agente.meta.puesto, estado: "done",
      resultado: Object.entries(r.totales || {}).slice(0, 6).map(([k, v]) => [ETIQUETA[k] || k, typeof v === "number" ? v.toLocaleString("de-DE") : String(v)]),
      bitacora: bitacora.slice(-6).map(l => [l.slice(0, 5), l.slice(7)]),
      alertas: r.alertas || []
    };
    const estado = { actualizado: r.corrida, agentes: (previo.agentes || []).filter(a => a.id !== ficha.id).concat([ficha]) };
    writeFileSync(rutaEstado, JSON.stringify(estado, null, 2));
    try { escribirOficina({ raizProyecto: this.raizProyecto, raiz: this.raiz, cfg: this.cfg, estado, marca: this.marca, prefijo: this.prefijo }); }
    catch (e) { this.logExterno("oficina: " + e.message); }
  }

  // --- Cola de aprobaciones -------------------------------------------------

  // Aplica en Odoo las propuestas APROBADAS de una compañía: corre Cuentas en modo escritura,
  // restringido a esas líneas. Requiere PERMITIR_ESCRITURA=si, igual que la terminal.
  async aplicarAprobadas(companiaId, { quienPide = "servicio" } = {}) {
    const aprobadas = this.db.propuestas({ estado: "aprobada", companiaId });
    if (!aprobadas.length) return { aplicadas: 0, mensaje: "No hay propuestas aprobadas para esa compañía." };
    if (String(this.cfg.PERMITIR_ESCRITURA || "").toLowerCase() !== "si") {
      throw new Error("PERMITIR_ESCRITURA no es 'si': el servicio no puede escribir en Odoo.");
    }
    const lineas = aprobadas.map(p => p.linea_id).join(",");
    const { corridaId, resultado } = await this.correr("cuentas", [`--empresa=${companiaId}`, "--aplicar", "--revisar-todo", `--solo-lineas=${lineas}`], { quienPide });
    this.db.auditar(quienPide, "aplicar", "corrida", corridaId, { companiaId, propuestas: aprobadas.map(p => p.id) });
    return { corridaId, aplicadas: (resultado.aplicadas || []).length, fallos: resultado.fallos || [], alertas: resultado.alertas };
  }

  // Envía los correos APROBADOS. Con prueba=true van todos a REPORTE_PARA con el asunto marcado.
  async enviarAprobados({ quienPide = "servicio", prueba = true, ids = null } = {}) {
    let lista = this.db.correos({ estado: "aprobado" });
    if (ids) lista = lista.filter(c => ids.includes(c.id));
    const destinoPrueba = this.cfg.COMUNICACION_PRUEBA_A || this.cfg.REPORTE_PARA || "";
    const enviados = [], fallos = [];
    for (const c of lista) {
      const completo = this.db.correo(c.id);
      const para = prueba ? destinoPrueba : c.para;
      if (!para) { fallos.push({ id: c.id, motivo: "sin destinatario" }); this.db.marcarCorreo(c.id, "fallo", { error: "sin destinatario" }); continue; }
      try {
        await enviarCorreo({ cfg: this.cfg, para, asunto: (prueba ? `[PRUEBA · iba a ${c.para}] ` : "") + c.asunto, html: completo.html });
        this.db.marcarCorreo(c.id, "enviado", { enviadoA: para });
        this.db.auditar(quienPide, "enviar", "correo", c.id, { para, prueba });
        enviados.push(c.id);
      } catch (e) {
        this.db.marcarCorreo(c.id, "fallo", { error: e.message });
        fallos.push({ id: c.id, motivo: e.message });
      }
    }
    return { enviados, fallos, prueba };
  }

  // El reporte diario por correo (lo que hacía run.js al final).
  async reportar(corridaId) {
    const c = this.db.corrida(corridaId);
    if (!c || !c.resultado) return { enviado: false, motivo: "corrida sin resultado" };
    const r = c.resultado;
    const cab = (r.alertas || []).filter(a => a.nivel !== "ok").map(a => a.texto).slice(0, 2).join(" · ");
    return enviar({ cfg: this.cfg, asunto: `IASIMA · ${r.agente} — ${cab || "sin novedades"}`, html: reporteHTML(r), texto: resumenTexto(r), log: this.logExterno });
  }
}
