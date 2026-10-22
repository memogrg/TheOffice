// La base de datos del servicio. SQLite incorporado en Node (>= 22.13), sin dependencias.
// Un solo archivo (data/oficina.db). Cuando haga falta Postgres, esta es la única capa que cambia.
//
// Qué guarda:
//   corridas    — cada ejecución de un agente: quién, cuándo, totales, alertas, resultado completo.
//   casos       — lo que Recepción encuentra, UNO POR DOCUMENTO Y RECEPTOR: tiquete, rechazado,
//                 duplicado, error... Con estado de seguimiento (abierto / resuelto) que la
//                 corrida siguiente no pisa: si el documento sigue apareciendo, sigue abierto;
//                 si ya no aparece, se cierra solo.
//   propuestas  — lo que Cuentas quiere corregir, línea por línea. Pasa por aprobación humana
//                 antes de aplicarse.
//   correos     — lo que Victor redacta. Pasa por aprobación antes de enviarse.
//   auditoria   — quién aprobó, rechazó, aplicó, envió, y cuándo.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS corridas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agente     TEXT NOT NULL,
  inicio     TEXT NOT NULL,
  fin        TEXT,
  estado     TEXT NOT NULL DEFAULT 'corriendo',   -- corriendo | ok | fallo
  modo       TEXT,
  compania   TEXT,
  totales    TEXT,          -- JSON
  alertas    TEXT,          -- JSON
  resultado  TEXT,          -- JSON completo (lo que hoy va a reportes/*.json)
  error      TEXT,
  llamadas_odoo INTEGER DEFAULT 0,
  segundos   REAL
);
CREATE INDEX IF NOT EXISTS corridas_agente ON corridas(agente, inicio DESC);

CREATE TABLE IF NOT EXISTS casos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  llave         TEXT NOT NULL UNIQUE,     -- receptor|clave  (o receptor|estado|archivo|asunto si no hay clave)
  receptor      TEXT NOT NULL,
  compania_id   INTEGER,
  compania      TEXT,
  frente        TEXT NOT NULL,            -- afuera | adentro
  estado_buzon  TEXT NOT NULL,            -- isticket | rejected | duplicate | error | process | vatiderror
  clave         TEXT,
  tipo          TEXT,
  consecutivo   TEXT,
  fecha_documento TEXT,
  cedula_emisor TEXT,
  establecimiento TEXT,
  identificado_por TEXT,
  asunto        TEXT,
  remitente     TEXT,
  error         TEXT,
  veces         INTEGER DEFAULT 1,
  correo_ids    TEXT,                     -- JSON [ids de bdt.invoice.email]
  primera_vez   TEXT NOT NULL,
  ultima_vez    TEXT NOT NULL,
  corrida_id    INTEGER REFERENCES corridas(id),
  seguimiento   TEXT NOT NULL DEFAULT 'abierto',  -- abierto | resuelto | cerrado (dejó de aparecer)
  resuelto_por  TEXT,
  resuelto_en   TEXT,
  nota          TEXT
);
CREATE INDEX IF NOT EXISTS casos_receptor ON casos(receptor, seguimiento);
CREATE INDEX IF NOT EXISTS casos_compania ON casos(compania_id, seguimiento);

CREATE TABLE IF NOT EXISTS propuestas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  corrida_id    INTEGER REFERENCES corridas(id),
  compania_id   INTEGER NOT NULL,
  compania      TEXT,
  factura_id    INTEGER NOT NULL,
  factura       TEXT,
  factura_estado TEXT,
  linea_id      INTEGER NOT NULL,
  cargo_id      INTEGER,
  articulo      TEXT,
  cuenta_actual_id INTEGER,
  cuenta_actual TEXT,
  cuenta_nueva_id INTEGER NOT NULL,
  cuenta_nueva  TEXT,
  fuente        TEXT,
  confianza     REAL,
  estado        TEXT NOT NULL DEFAULT 'propuesta',  -- propuesta | aprobada | rechazada | aplicada | verificada | fallo | obsoleta
  decidio       TEXT,
  decidido_en   TEXT,
  motivo        TEXT,
  aplicada_en   TEXT,
  resultado     TEXT,
  creada_en     TEXT NOT NULL,
  UNIQUE(linea_id, cuenta_nueva_id)
);
CREATE INDEX IF NOT EXISTS propuestas_estado ON propuestas(estado, compania_id);

CREATE TABLE IF NOT EXISTS correos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  corrida_id    INTEGER REFERENCES corridas(id),
  frente        TEXT NOT NULL,            -- afuera | adentro
  para          TEXT NOT NULL,
  asunto        TEXT NOT NULL,
  html          TEXT NOT NULL,
  casos         INTEGER,
  companias     TEXT,                     -- JSON
  estado        TEXT NOT NULL DEFAULT 'borrador',   -- borrador | aprobado | rechazado | enviado | fallo | obsoleto
  decidio       TEXT,
  decidido_en   TEXT,
  enviado_a     TEXT,
  enviado_en    TEXT,
  error         TEXT,
  creado_en     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS correos_estado ON correos(estado);

CREATE TABLE IF NOT EXISTS auditoria (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  cuando    TEXT NOT NULL,
  quien     TEXT NOT NULL,
  accion    TEXT NOT NULL,
  objeto    TEXT NOT NULL,     -- caso | propuesta | correo | corrida
  objeto_id INTEGER,
  detalle   TEXT               -- JSON
);
`;

export class BaseDeDatos {
  constructor(ruta = ":memory:") {
    if (ruta !== ":memory:") mkdirSync(dirname(ruta), { recursive: true });
    this.db = new DatabaseSync(ruta);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(ESQUEMA);
  }

  cerrar() { this.db.close(); }

  // --- utilidades
  #ahora() { return new Date().toISOString(); }
  uno(sql, ...p) { return this.db.prepare(sql).get(...p) ?? null; }
  todos(sql, ...p) { return this.db.prepare(sql).all(...p); }
  correr(sql, ...p) { return this.db.prepare(sql).run(...p); }
  transaccion(fn) {
    this.db.exec("BEGIN");
    try { const r = fn(); this.db.exec("COMMIT"); return r; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  auditar(quien, accion, objeto, objetoId, detalle = null) {
    this.correr("INSERT INTO auditoria (cuando, quien, accion, objeto, objeto_id, detalle) VALUES (?,?,?,?,?,?)",
      this.#ahora(), quien, accion, objeto, objetoId, detalle == null ? null : JSON.stringify(detalle));
  }

  // --- corridas
  abrirCorrida(agente, { modo = null, compania = null } = {}) {
    const r = this.correr("INSERT INTO corridas (agente, inicio, estado, modo, compania) VALUES (?,?,?,?,?)",
      agente, this.#ahora(), "corriendo", modo, compania);
    return Number(r.lastInsertRowid);
  }
  cerrarCorrida(id, resultado) {
    this.correr(`UPDATE corridas SET fin=?, estado='ok', modo=?, compania=?, totales=?, alertas=?, resultado=?, llamadas_odoo=?, segundos=? WHERE id=?`,
      this.#ahora(), resultado.modo ?? null, resultado.compania ?? null,
      JSON.stringify(resultado.totales ?? {}), JSON.stringify(resultado.alertas ?? []), JSON.stringify(resultado),
      resultado.llamadasOdoo ?? 0, resultado.segundos ?? null, id);
  }
  fallarCorrida(id, error) {
    this.correr("UPDATE corridas SET fin=?, estado='fallo', error=? WHERE id=?", this.#ahora(), String(error), id);
  }
  corrida(id) { return desempacar(this.uno("SELECT * FROM corridas WHERE id=?", id)); }
  corridas({ agente = null, limite = 50 } = {}) {
    const filas = agente
      ? this.todos("SELECT id, agente, inicio, fin, estado, modo, compania, totales, alertas, error, llamadas_odoo, segundos FROM corridas WHERE agente=? ORDER BY id DESC LIMIT ?", agente, limite)
      : this.todos("SELECT id, agente, inicio, fin, estado, modo, compania, totales, alertas, error, llamadas_odoo, segundos FROM corridas ORDER BY id DESC LIMIT ?", limite);
    return filas.map(desempacar);
  }
  ultimaCorrida(agente) {
    return desempacar(this.uno("SELECT * FROM corridas WHERE agente=? AND estado='ok' ORDER BY id DESC LIMIT 1", agente));
  }

  // --- casos: se sincronizan con lo que trae la corrida.
  // Los que ya existían y siguen apareciendo se actualizan (ultima_vez, veces); los nuevos se
  // insertan; los abiertos que ya no aparecen se cierran como 'cerrado'. Los 'resuelto' no se tocan.
  sincronizarCasos(corridaId, casos) {
    const ahora = this.#ahora();
    const vistas = new Set();
    let nuevos = 0, actualizados = 0, cerrados = 0;
    this.transaccion(() => {
      const ins = this.db.prepare(`INSERT INTO casos (llave, receptor, compania_id, compania, frente, estado_buzon, clave, tipo, consecutivo,
        fecha_documento, cedula_emisor, establecimiento, identificado_por, asunto, remitente, error, veces, correo_ids, primera_vez, ultima_vez, corrida_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const upd = this.db.prepare(`UPDATE casos SET veces=?, correo_ids=?, ultima_vez=?, corrida_id=?, error=?, establecimiento=COALESCE(?, establecimiento),
        seguimiento = CASE WHEN seguimiento='cerrado' THEN 'abierto' ELSE seguimiento END WHERE llave=?`);
      const existe = this.db.prepare("SELECT id FROM casos WHERE llave=?");
      for (const c of casos) {
        vistas.add(c.llave);
        if (existe.get(c.llave)) {
          upd.run(c.veces, JSON.stringify(c.correoIds || []), ahora, corridaId, c.error || null, c.establecimiento || null, c.llave);
          actualizados++;
        } else {
          ins.run(c.llave, c.receptor, c.companiaId, c.compania, c.frente, c.estadoBuzon, c.clave, c.tipo, c.consecutivo,
            c.fechaDocumento, c.cedulaEmisor, c.establecimiento, c.identificadoPor, c.asunto, c.remitente, c.error || null,
            c.veces, JSON.stringify(c.correoIds || []), ahora, ahora, corridaId);
          nuevos++;
        }
      }
      const abiertos = this.todos("SELECT id, llave FROM casos WHERE seguimiento='abierto'");
      const cerrar = this.db.prepare("UPDATE casos SET seguimiento='cerrado', resuelto_en=? WHERE id=?");
      for (const a of abiertos) if (!vistas.has(a.llave)) { cerrar.run(ahora, a.id); cerrados++; }
    });
    return { nuevos, actualizados, cerrados };
  }
  casos({ receptor = null, companiaId = null, frente = null, seguimiento = "abierto", limite = 500 } = {}) {
    const cond = [], p = [];
    if (receptor) { cond.push("receptor=?"); p.push(receptor); }
    if (companiaId) { cond.push("compania_id=?"); p.push(companiaId); }
    if (frente) { cond.push("frente=?"); p.push(frente); }
    if (seguimiento && seguimiento !== "todos") { cond.push("seguimiento=?"); p.push(seguimiento); }
    const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
    return this.todos(`SELECT * FROM casos ${where} ORDER BY ultima_vez DESC, id DESC LIMIT ?`, ...p, limite).map(desempacar);
  }
  resolverCaso(id, quien, nota = null) {
    const r = this.correr("UPDATE casos SET seguimiento='resuelto', resuelto_por=?, resuelto_en=?, nota=? WHERE id=? AND seguimiento<>'resuelto'",
      quien, this.#ahora(), nota, id);
    if (r.changes) this.auditar(quien, "resolver", "caso", id, { nota });
    return r.changes > 0;
  }
  reabrirCaso(id, quien) {
    const r = this.correr("UPDATE casos SET seguimiento='abierto', resuelto_por=NULL, resuelto_en=NULL WHERE id=?", id);
    if (r.changes) this.auditar(quien, "reabrir", "caso", id);
    return r.changes > 0;
  }
  resumenCasos() {
    return {
      porFrente: this.todos("SELECT frente, seguimiento, COUNT(*) n FROM casos GROUP BY frente, seguimiento"),
      porReceptor: this.todos(`SELECT receptor, SUM(frente='afuera') afuera, SUM(frente='adentro') adentro, COUNT(*) total
                               FROM casos WHERE seguimiento='abierto' GROUP BY receptor ORDER BY total DESC`),
      porCompania: this.todos(`SELECT compania_id, compania, SUM(frente='afuera') afuera, SUM(frente='adentro') adentro, COUNT(*) total
                               FROM casos WHERE seguimiento='abierto' GROUP BY compania_id, compania ORDER BY total DESC`)
    };
  }

  // --- propuestas de Cuentas
  registrarPropuestas(corridaId, propuestas, { companiaId, compania }) {
    const ahora = this.#ahora();
    let nuevas = 0, repetidas = 0;
    this.transaccion(() => {
      const ins = this.db.prepare(`INSERT OR IGNORE INTO propuestas (corrida_id, compania_id, compania, factura_id, factura, factura_estado, linea_id, cargo_id,
        articulo, cuenta_actual_id, cuenta_actual, cuenta_nueva_id, cuenta_nueva, fuente, confianza, creada_en) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const p of propuestas) {
        const r = ins.run(corridaId, companiaId, compania, p.facturaId, p.factura, p.estado, p.lineaId, p.cargoId ?? null,
          p.articulo, p.cuentaActualId ?? null, p.cuentaActual, p.cuentaNuevaId, p.cuentaNueva, p.fuente, p.confianza ?? null, ahora);
        if (r.changes) nuevas++; else repetidas++;
      }
    });
    return { nuevas, repetidas };
  }
  propuestas({ estado = "propuesta", companiaId = null, limite = 500 } = {}) {
    const cond = [], p = [];
    if (estado && estado !== "todas") { cond.push("estado=?"); p.push(estado); }
    if (companiaId) { cond.push("compania_id=?"); p.push(companiaId); }
    const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
    return this.todos(`SELECT * FROM propuestas ${where} ORDER BY factura_id, linea_id LIMIT ?`, ...p, limite);
  }
  propuesta(id) { return this.uno("SELECT * FROM propuestas WHERE id=?", id); }
  decidirPropuesta(id, decision, quien, motivo = null) {
    if (!["aprobada", "rechazada"].includes(decision)) throw new Error(`Decisión inválida: ${decision}`);
    const r = this.correr("UPDATE propuestas SET estado=?, decidio=?, decidido_en=?, motivo=? WHERE id=? AND estado='propuesta'",
      decision, quien, this.#ahora(), motivo, id);
    if (r.changes) this.auditar(quien, decision === "aprobada" ? "aprobar" : "rechazar", "propuesta", id, { motivo });
    return r.changes > 0;
  }
  marcarPropuestas(ids, estado, resultado = null) {
    const ahora = this.#ahora();
    this.transaccion(() => {
      const u = this.db.prepare("UPDATE propuestas SET estado=?, aplicada_en=?, resultado=? WHERE id=?");
      for (const id of ids) u.run(estado, ahora, resultado == null ? null : JSON.stringify(resultado), id);
    });
  }

  // --- correos de Victor
  registrarCorreos(corridaId, piezas) {
    const ahora = this.#ahora();
    const ids = [];
    this.transaccion(() => {
      // Un borrador nuevo para el mismo receptor y frente deja obsoleto al anterior no enviado.
      const obs = this.db.prepare("UPDATE correos SET estado='obsoleto' WHERE para=? AND frente=? AND estado IN ('borrador','aprobado')");
      const ins = this.db.prepare("INSERT INTO correos (corrida_id, frente, para, asunto, html, casos, companias, creado_en) VALUES (?,?,?,?,?,?,?,?)");
      for (const p of piezas) {
        obs.run(p.para, p.frente);
        const r = ins.run(corridaId, p.frente, p.para, p.asunto, p.html, p.casos ?? null, JSON.stringify(p.companias || []), ahora);
        ids.push(Number(r.lastInsertRowid));
      }
    });
    return ids;
  }
  correos({ estado = "borrador", limite = 200 } = {}) {
    const filas = estado && estado !== "todos"
      ? this.todos("SELECT id, corrida_id, frente, para, asunto, casos, companias, estado, decidio, decidido_en, enviado_a, enviado_en, error, creado_en FROM correos WHERE estado=? ORDER BY id DESC LIMIT ?", estado, limite)
      : this.todos("SELECT id, corrida_id, frente, para, asunto, casos, companias, estado, decidio, decidido_en, enviado_a, enviado_en, error, creado_en FROM correos ORDER BY id DESC LIMIT ?", limite);
    return filas.map(desempacar);
  }
  correo(id) { return desempacar(this.uno("SELECT * FROM correos WHERE id=?", id)); }
  decidirCorreo(id, decision, quien) {
    if (!["aprobado", "rechazado"].includes(decision)) throw new Error(`Decisión inválida: ${decision}`);
    const r = this.correr("UPDATE correos SET estado=?, decidio=?, decidido_en=? WHERE id=? AND estado='borrador'", decision, quien, this.#ahora(), id);
    if (r.changes) this.auditar(quien, decision === "aprobado" ? "aprobar" : "rechazar", "correo", id);
    return r.changes > 0;
  }
  marcarCorreo(id, estado, { enviadoA = null, error = null } = {}) {
    this.correr("UPDATE correos SET estado=?, enviado_a=?, enviado_en=?, error=? WHERE id=?", estado, enviadoA, estado === "enviado" ? this.#ahora() : null, error, id);
  }

  auditoria(limite = 100) { return this.todos("SELECT * FROM auditoria ORDER BY id DESC LIMIT ?", limite).map(desempacar); }
}

// Columnas JSON vuelven a ser objetos.
const JSON_COLS = new Set(["totales", "alertas", "resultado", "correo_ids", "companias", "detalle"]);
function desempacar(fila) {
  if (!fila) return fila;
  const out = { ...fila };
  for (const k of JSON_COLS) if (typeof out[k] === "string") { try { out[k] = JSON.parse(out[k]); } catch { /* texto plano */ } }
  return out;
}
