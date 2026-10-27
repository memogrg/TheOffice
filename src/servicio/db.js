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

CREATE TABLE IF NOT EXISTS conversaciones (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  quien     TEXT NOT NULL,
  inicio    TEXT NOT NULL,
  ultimo    TEXT NOT NULL,
  modo      TEXT,
  mensajes  TEXT NOT NULL,     -- JSON: el historial tal cual lo consume la API del modelo
  resumen   TEXT               -- JSON: [{pregunta, respuesta, pasos}] para mostrar
);

CREATE TABLE IF NOT EXISTS usuarios (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  correo    TEXT NOT NULL UNIQUE,     -- en minúsculas
  nombre    TEXT,
  rol       TEXT NOT NULL DEFAULT 'receptor',   -- contable | receptor
  activo    INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL,
  creado_por TEXT,
  ultimo_acceso TEXT
);

CREATE TABLE IF NOT EXISTS invitaciones (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  token_hash TEXT NOT NULL UNIQUE,   -- nunca el token en claro
  vence     TEXT NOT NULL,
  usada_en  TEXT,
  creada_en TEXT NOT NULL,
  creada_por TEXT
);

CREATE TABLE IF NOT EXISTS sesiones (
  id        TEXT PRIMARY KEY,         -- hash del id que viaja en la cookie
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  creada_en TEXT NOT NULL,
  vence     TEXT NOT NULL,
  ultimo_uso TEXT
);

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
    this.#migrar();
  }

  // Columnas que llegaron después del primer esquema. ALTER TABLE es idempotente aquí porque
  // se mira primero si la columna existe (bases ya creadas en producción no se recrean).
  #migrar() {
    const columnas = t => new Set(this.todos(`PRAGMA table_info(${t})`).map(c => c.name));
    const conv = columnas("conversaciones");
    if (!conv.has("abierta")) this.db.exec("ALTER TABLE conversaciones ADD COLUMN abierta INTEGER NOT NULL DEFAULT 1");
    if (!conv.has("titulo")) this.db.exec("ALTER TABLE conversaciones ADD COLUMN titulo TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS conversaciones_quien ON conversaciones(quien, abierta, ultimo)");
    // Consultas al contador que deja Cuentas (paso 3 y 4 de la guía de clasificación)
    this.db.exec(`CREATE TABLE IF NOT EXISTS consultas (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      corrida_id  INTEGER,
      compania_id INTEGER,
      compania    TEXT,
      factura_id  INTEGER,
      factura     TEXT,
      linea_id    INTEGER NOT NULL,
      articulo    TEXT,
      proveedor   TEXT,
      proveedor_id INTEGER,
      actividad   TEXT,
      cuenta_actual TEXT,
      sugerida    TEXT,
      tipo        TEXT,      -- personal | choque | dividido | naturaleza | no-identificado | salvaguarda | pagada | plan | parecido | poco-historial | consulta
      motivo      TEXT,
      pasos       TEXT,      -- JSON
      naturaleza  TEXT,
      estado      TEXT NOT NULL DEFAULT 'abierta',   -- abierta | resuelta | descartada | cerrada (dejó de salir)
      resolvio    TEXT,
      resuelto_en TEXT,
      nota        TEXT,
      creada_en   TEXT NOT NULL,
      vista_en    TEXT
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS consultas_estado ON consultas(estado, compania_id)");
    const prop = columnas("propuestas");
    if (!prop.has("razon")) this.db.exec("ALTER TABLE propuestas ADD COLUMN razon TEXT");
    // Reglas contables que alguien dicta en el chat («esto siempre va a 5.04.17.01»). El Director
    // las deja aquí; un contable las aprueba y recién entonces se escriben en data/reglas.json.
    this.db.exec(`CREATE TABLE IF NOT EXISTS reglas_propuestas (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      compania_id INTEGER,
      compania    TEXT,                 -- alcance: nombre de la compañía (o NULL = todas)
      proveedor_id INTEGER,
      proveedor   TEXT,
      articulo    TEXT,                 -- o artículo, o proveedor
      codigo      TEXT NOT NULL,
      cuenta      TEXT NOT NULL,
      cuenta_id   INTEGER,
      motivo      TEXT,
      ejemplo     TEXT,                 -- factura que la originó
      lineas      INTEGER,              -- cuántas líneas tocaría hoy (estimado al proponer)
      propuso     TEXT NOT NULL,
      creado_en   TEXT NOT NULL,
      estado      TEXT NOT NULL DEFAULT 'propuesta',   -- propuesta | aprobada | rechazada
      decidio     TEXT,
      decidido_en TEXT,
      corrida_id  INTEGER
    )`);
    if (!columnas("reglas_propuestas").has("naturaleza")) this.db.exec("ALTER TABLE reglas_propuestas ADD COLUMN naturaleza TEXT");
    // Fase 3B: asientos de diario propuestos (sin comprobante electrónico). Los deja Cierre o el
    // Director; un contable los aprueba; con PERMITIR_ESCRITURA_ASIENTOS=si se crean en Odoo.
    this.db.exec(`CREATE TABLE IF NOT EXISTS asientos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      clave       TEXT,                 -- origen estable (cierre|cia|cuenta) para no duplicar
      origen      TEXT NOT NULL,        -- cierre | director | manual
      corrida_id  INTEGER,
      mes         TEXT,
      compania_id INTEGER NOT NULL,
      compania    TEXT,
      fecha       TEXT NOT NULL,
      diario_id   INTEGER,
      diario      TEXT,
      referencia  TEXT,
      motivo      TEXT,
      aviso       TEXT,
      lineas      TEXT NOT NULL,        -- JSON [{cuentaId, cuenta, descripcion, debito, credito, rol, fuente}]
      total       REAL,
      propuso     TEXT NOT NULL,
      creado_en   TEXT NOT NULL,
      actualizado_en TEXT,
      estado      TEXT NOT NULL DEFAULT 'propuesta',  -- propuesta | aprobada | rechazada | aplicada | fallo | obsoleta
      decidio     TEXT,
      decidido_en TEXT,
      nota        TEXT,
      move_id     INTEGER,
      move_name   TEXT,
      resultado   TEXT                  -- JSON: verificación o error al aplicar
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS asientos_estado ON asientos(estado, compania_id)");
    // Cambios masivos al plan de cuentas (objetivo 5): una instrucción, N compañías.
    this.db.exec(`CREATE TABLE IF NOT EXISTS cambios (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo        TEXT NOT NULL,        -- renombrar | recodificar | crear | obsoleta
      instruccion TEXT NOT NULL,        -- JSON {codigo, nombreActual, nuevoCodigo, nuevoNombre, tipoCuenta, companias, excluir}
      motivo      TEXT,
      items       TEXT NOT NULL,        -- JSON, uno por compañía: actual, nuevo, estado, incluido
      propuso     TEXT NOT NULL,
      creado_en   TEXT NOT NULL,
      estado      TEXT NOT NULL DEFAULT 'propuesta',  -- propuesta | aprobada | rechazada | aplicada | parcial | fallo
      decidio     TEXT,
      decidido_en TEXT,
      nota        TEXT,
      aplicado_en TEXT
    )`);
  }

  // --- cambios masivos al plan de cuentas
  #filaCambio(c) { return c ? { ...c, instruccion: JSON.parse(c.instruccion), items: JSON.parse(c.items) } : null; }
  proponerCambio({ tipo, instruccion, motivo, items }, quien) {
    const x = this.correr("INSERT INTO cambios (tipo, instruccion, motivo, items, propuso, creado_en) VALUES (?,?,?,?,?,?)",
      tipo, JSON.stringify(instruccion), motivo ?? null, JSON.stringify(items), quien, this.#ahora());
    const id = Number(x.lastInsertRowid);
    this.auditar(quien, "proponer", "cambio", id, { tipo, codigo: instruccion.codigo, companias: items.filter(i => i.incluido).length });
    return this.cambio(id);
  }
  cambio(id) { return this.#filaCambio(this.uno("SELECT * FROM cambios WHERE id=?", id)); }
  cambios({ estado = "abiertos", limite = 50 } = {}) {
    const sql = estado === "todos" ? "SELECT * FROM cambios ORDER BY id DESC LIMIT ?"
      : estado === "abiertos" ? "SELECT * FROM cambios WHERE estado IN ('propuesta','aprobada') ORDER BY id DESC LIMIT ?"
      : "SELECT * FROM cambios WHERE estado=? ORDER BY id DESC LIMIT ?";
    return (estado === "todos" || estado === "abiertos" ? this.todos(sql, limite) : this.todos(sql, estado, limite)).map(c => this.#filaCambio(c));
  }
  // Incluir o dejar fuera una compañía, solo mientras el cambio está propuesto.
  incluirEnCambio(id, companiaId, incluido, quien) {
    const c = this.cambio(id);
    if (!c || c.estado !== "propuesta") return false;
    const it = c.items.find(i => i.companiaId === Number(companiaId));
    if (!it || (incluido && !["listo", "revisar"].includes(it.estado))) return false;
    it.incluido = Boolean(incluido);
    this.correr("UPDATE cambios SET items=? WHERE id=?", JSON.stringify(c.items), id);
    this.auditar(quien, incluido ? "incluir" : "excluir", "cambio", id, { companiaId: Number(companiaId) });
    return true;
  }
  decidirCambio(id, decision, quien, nota = null) {
    const r = this.correr("UPDATE cambios SET estado=?, decidio=?, decidido_en=?, nota=? WHERE id=? AND estado='propuesta'", decision, quien, this.#ahora(), nota, id);
    if (r.changes) this.auditar(quien, decision === "aprobada" ? "aprobar" : "rechazar", "cambio", id, nota ? { nota } : null);
    return r.changes > 0;
  }
  marcarCambio(id, estado, items) {
    this.correr("UPDATE cambios SET estado=?, items=?, aplicado_en=? WHERE id=?", estado, JSON.stringify(items), this.#ahora(), id);
  }

  // --- asientos propuestos (fase 3B)
  #filaAsiento(a) {
    if (!a) return null;
    const lineas = JSON.parse(a.lineas || "[]");
    return { ...a, lineas, resultado: a.resultado ? JSON.parse(a.resultado) : null, porDefinir: lineas.some(l => !l.cuentaId) || !a.diario_id };
  }
  #total(lineas) { return Math.round(lineas.reduce((t, l) => t + (Number(l.debito) || 0), 0) * 100) / 100; }
  proponerAsiento(a, quien) {
    const ahora = this.#ahora();
    const x = this.correr(`INSERT INTO asientos (clave, origen, corrida_id, mes, compania_id, compania, fecha, diario_id, diario, referencia, motivo, aviso, lineas, total, propuso, creado_en)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, a.clave ?? null, a.origen || "manual", a.corridaId ?? null, a.mes ?? null, a.companiaId, a.compania ?? null, a.fecha,
      a.diarioId ?? null, a.diario ?? null, a.referencia ?? null, a.motivo ?? null, a.aviso ?? null, JSON.stringify(a.lineas), this.#total(a.lineas), quien, ahora);
    const id = Number(x.lastInsertRowid);
    this.auditar(quien, "proponer", "asiento", id, { compania: a.compania, referencia: a.referencia, total: this.#total(a.lineas) });
    return this.asiento(id);
  }
  // Lo que deja Cierre: uno abierto por clave. Si ya hay uno propuesto se actualiza (mes y montos
  // nuevos); si alguien lo rechazó para ese mismo mes no se repite; los propuestos que ya no salen
  // (la cuenta quedó liquidada) pasan a obsoletos.
  sincronizarAsientos(corridaId, sugeridos, { origen = "cierre" } = {}) {
    const ahora = this.#ahora();
    let nuevos = 0, actualizados = 0, obsoletos = 0;
    this.transaccion(() => {
      const vistas = new Set();
      for (const a of sugeridos) {
        vistas.add(a.clave);
        const abierto = this.uno("SELECT * FROM asientos WHERE clave=? AND estado IN ('propuesta','aprobada') ORDER BY id DESC", a.clave);
        if (abierto) {
          if (abierto.estado === "aprobada") continue;          // ya decidido: no se cambia por debajo
          // si una persona eligió el banco, se respeta su elección
          const previas = JSON.parse(abierto.lineas);
          const lineas = a.lineas.map(l => { const p = previas.find(x => x.rol === l.rol && x.editada); return p && !l.cuentaId ? { ...l, cuentaId: p.cuentaId, cuenta: p.cuenta, editada: true, fuente: p.fuente } : l; });
          const diarioEditado = abierto.diario_id && previas.some(x => x.editada);
          this.correr(`UPDATE asientos SET corrida_id=?, mes=?, fecha=?, referencia=?, motivo=?, aviso=?, lineas=?, total=?, actualizado_en=?${diarioEditado ? "" : ", diario_id=?, diario=?"} WHERE id=?`,
            corridaId, a.mes, a.fecha, a.referencia, a.motivo, a.aviso ?? null, JSON.stringify(lineas), this.#total(lineas), ahora,
            ...(diarioEditado ? [] : [a.diarioId ?? null, a.diario ?? null]), abierto.id);
          actualizados++;
          continue;
        }
        if (this.uno("SELECT id FROM asientos WHERE clave=? AND mes=? AND estado IN ('rechazada','aplicada')", a.clave, a.mes)) continue;
        this.correr(`INSERT INTO asientos (clave, origen, corrida_id, mes, compania_id, compania, fecha, diario_id, diario, referencia, motivo, aviso, lineas, total, propuso, creado_en)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, a.clave, origen, corridaId, a.mes, a.companiaId, a.compania, a.fecha, a.diarioId ?? null, a.diario ?? null,
          a.referencia, a.motivo, a.aviso ?? null, JSON.stringify(a.lineas), this.#total(a.lineas), `agente:${origen}`, ahora);
        nuevos++;
      }
      for (const v of this.todos("SELECT id, clave FROM asientos WHERE origen=? AND estado='propuesta'", origen))
        if (!vistas.has(v.clave)) { this.correr("UPDATE asientos SET estado='obsoleta', actualizado_en=? WHERE id=?", ahora, v.id); obsoletos++; }
    });
    return { nuevos, actualizados, obsoletos };
  }
  asientos({ estado = "propuesta", companiaId = null, limite = 300 } = {}) {
    const cond = [], p = [];
    if (estado !== "todos") { cond.push(estado === "abiertos" ? "estado IN ('propuesta','aprobada')" : "estado=?"); if (estado !== "abiertos") p.push(estado); }
    if (companiaId) { cond.push("compania_id=?"); p.push(companiaId); }
    return this.todos(`SELECT * FROM asientos${cond.length ? " WHERE " + cond.join(" AND ") : ""} ORDER BY compania, id LIMIT ?`, ...p, limite).map(a => this.#filaAsiento(a));
  }
  asiento(id) { return this.#filaAsiento(this.uno("SELECT * FROM asientos WHERE id=?", id)); }
  // Solo mientras está propuesto: fecha, diario y la cuenta de alguna línea (el banco por definir).
  editarAsiento(id, { fecha = null, diarioId = null, diario = null, lineas = null }, quien) {
    const a = this.asiento(id);
    if (!a || a.estado !== "propuesta") return false;
    const nuevas = lineas || a.lineas;
    this.correr("UPDATE asientos SET fecha=?, diario_id=?, diario=?, lineas=?, total=?, actualizado_en=? WHERE id=?",
      fecha || a.fecha, diarioId ?? a.diario_id, diario ?? a.diario, JSON.stringify(nuevas), this.#total(nuevas), this.#ahora(), id);
    this.auditar(quien, "editar", "asiento", id, { fecha, diarioId, lineas: lineas ? nuevas.filter(l => l.editada).map(l => l.cuenta) : undefined });
    return true;
  }
  decidirAsiento(id, decision, quien, nota = null) {
    const r = this.correr("UPDATE asientos SET estado=?, decidio=?, decidido_en=?, nota=? WHERE id=? AND estado='propuesta'", decision, quien, this.#ahora(), nota, id);
    if (r.changes) this.auditar(quien, decision === "aprobada" ? "aprobar" : "rechazar", "asiento", id, nota ? { nota } : null);
    return r.changes > 0;
  }
  marcarAsiento(id, estado, { moveId = null, moveName = null, resultado = null } = {}) {
    this.correr("UPDATE asientos SET estado=?, move_id=COALESCE(?, move_id), move_name=COALESCE(?, move_name), resultado=?, actualizado_en=? WHERE id=?",
      estado, moveId, moveName, resultado == null ? null : JSON.stringify(resultado), this.#ahora(), id);
  }

  // --- consultas al contador (paso 3 y 4 de la guía): lo que Cuentas no cierra solo
  sincronizarConsultas(corridaId, consultas, { companiaId, compania }) {
    const ahora = this.#ahora();
    let nuevas = 0, siguen = 0, cerradas = 0;
    this.transaccion(() => {
      const vistas = new Set();
      for (const c of consultas) {
        vistas.add(c.lineaId);
        const ya = this.uno("SELECT id, estado FROM consultas WHERE linea_id=? AND estado='abierta'", c.lineaId);
        const valores = [corridaId, c.facturaId, c.factura, c.articulo, c.proveedor ?? null, c.proveedorId ?? null, c.actividad ?? null, c.cuentaActual ?? null,
          c.sugerida ?? null, c.tipo || "consulta", c.motivo || "", JSON.stringify(c.pasos || []), c.naturaleza ?? null, ahora];
        if (ya) {
          this.correr(`UPDATE consultas SET corrida_id=?, factura_id=?, factura=?, articulo=?, proveedor=?, proveedor_id=?, actividad=?, cuenta_actual=?, sugerida=?,
            tipo=?, motivo=?, pasos=?, naturaleza=?, vista_en=? WHERE id=?`, ...valores, ya.id);
          siguen++;
        } else {
          // si ya se resolvió antes con una regla o se descartó, no se reabre sola
          const resuelta = this.uno("SELECT id FROM consultas WHERE linea_id=? AND estado IN ('resuelta','descartada')", c.lineaId);
          if (resuelta) continue;
          this.correr(`INSERT INTO consultas (corrida_id, factura_id, factura, articulo, proveedor, proveedor_id, actividad, cuenta_actual, sugerida, tipo, motivo, pasos,
            naturaleza, vista_en, compania_id, compania, linea_id, estado, creada_en) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'abierta',?)`,
            ...valores, companiaId, compania, c.lineaId, ahora);
          nuevas++;
        }
      }
      // las abiertas de esta compañía que ya no salen: la línea cambió o tiene regla → se cierran solas
      for (const a of this.todos("SELECT id, linea_id FROM consultas WHERE compania_id=? AND estado='abierta'", companiaId)) {
        if (!vistas.has(a.linea_id)) { this.correr("UPDATE consultas SET estado='cerrada', resuelto_en=? WHERE id=?", ahora, a.id); cerradas++; }
      }
    });
    return { nuevas, siguen, cerradas };
  }
  consultas({ estado = "abierta", companiaId = null, limite = 500 } = {}) {
    const cond = [], p = [];
    if (estado !== "todas") { cond.push("estado=?"); p.push(estado); }
    if (companiaId) { cond.push("compania_id=?"); p.push(companiaId); }
    return this.todos(`SELECT * FROM consultas${cond.length ? " WHERE " + cond.join(" AND ") : ""} ORDER BY compania, factura, id LIMIT ?`, ...p, limite).map(desempacar);
  }
  consulta(id) { return desempacar(this.uno("SELECT * FROM consultas WHERE id=?", id)); }
  anotarConsulta(id, nota) { this.correr("UPDATE consultas SET nota=? WHERE id=?", nota, id); }
  cerrarConsulta(id, estado, quien, nota = null) {
    const r = this.correr("UPDATE consultas SET estado=?, resolvio=?, resuelto_en=?, nota=? WHERE id=? AND estado='abierta'", estado, quien, this.#ahora(), nota, id);
    if (r.changes) this.auditar(quien, estado === "resuelta" ? "resolver" : "descartar", "consulta", id, nota ? { nota } : null);
    return r.changes > 0;
  }

  // --- reglas propuestas
  proponerRegla(r) {
    const x = this.correr(`INSERT INTO reglas_propuestas (compania_id, compania, proveedor_id, proveedor, articulo, naturaleza, codigo, cuenta, cuenta_id, motivo, ejemplo, lineas, propuso, creado_en)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, r.companiaId ?? null, r.compania ?? null, r.proveedorId ?? null, r.proveedor ?? null, r.articulo ?? null, r.naturaleza ?? null,
      r.codigo, r.cuenta, r.cuentaId ?? null, r.motivo ?? null, r.ejemplo ?? null, r.lineas ?? null, r.propuso, this.#ahora());
    const id = Number(x.lastInsertRowid);
    this.auditar(r.propuso, "proponer", "regla", id, { codigo: r.codigo, proveedor: r.proveedor, articulo: r.articulo, naturaleza: r.naturaleza, compania: r.compania });
    return this.regla(id);
  }
  regla(id) { return this.uno("SELECT * FROM reglas_propuestas WHERE id=?", id); }
  reglas({ estado = "propuesta" } = {}) {
    return estado === "todas" ? this.todos("SELECT * FROM reglas_propuestas ORDER BY id DESC LIMIT 200")
      : this.todos("SELECT * FROM reglas_propuestas WHERE estado=? ORDER BY id DESC LIMIT 200", estado);
  }
  decidirRegla(id, decision, quien) {
    const r = this.correr("UPDATE reglas_propuestas SET estado=?, decidio=?, decidido_en=? WHERE id=? AND estado='propuesta'", decision, quien, this.#ahora(), id);
    if (r.changes) this.auditar(quien, decision === "aprobada" ? "aprobar" : "rechazar", "regla", id);
    return r.changes > 0;
  }
  marcarCorridaRegla(id, corridaId) { this.correr("UPDATE reglas_propuestas SET corrida_id=? WHERE id=?", corridaId, id); }

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
        articulo, cuenta_actual_id, cuenta_actual, cuenta_nueva_id, cuenta_nueva, fuente, confianza, creada_en, razon) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const p of propuestas) {
        const r = ins.run(corridaId, companiaId, compania, p.facturaId, p.factura, p.estado, p.lineaId, p.cargoId ?? null,
          p.articulo, p.cuentaActualId ?? null, p.cuentaActual, p.cuentaNuevaId, p.cuentaNueva, p.fuente, p.confianza ?? null, ahora,
          [p.motivo, ...(p.pasos || [])].filter(Boolean).join(" · ").slice(0, 600) || null);
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

  // --- conversaciones con el Director
  // Cada persona (quien) tiene a lo sumo UNA conversación abierta: es la que sigue al volver,
  // desde la app o desde la oficina 2D. «Nueva conversación» la cierra. Se guardan 30 días
  // (DIRECTOR_RETENCION_DIAS) y luego se purgan.
  conversacion(id) { return desempacar(this.uno("SELECT * FROM conversaciones WHERE id=?", id)); }
  conversacionActual(quien) {
    return desempacar(this.uno("SELECT * FROM conversaciones WHERE quien=? AND abierta=1 ORDER BY ultimo DESC LIMIT 1", quien));
  }
  guardarConversacion(id, { quien, modo, mensajes, turno }) {
    const ahora = this.#ahora();
    if (id) {
      const c = this.conversacion(id);
      const resumen = [...(c?.resumen || []), turno];
      this.correr("UPDATE conversaciones SET ultimo=?, modo=?, mensajes=?, resumen=? WHERE id=?", ahora, modo, JSON.stringify(mensajes), JSON.stringify(resumen), id);
      return id;
    }
    // una sola abierta por persona
    this.correr("UPDATE conversaciones SET abierta=0 WHERE quien=? AND abierta=1", quien);
    const titulo = String(turno?.pregunta || "").slice(0, 80) || null;
    const r = this.correr("INSERT INTO conversaciones (quien, inicio, ultimo, modo, mensajes, resumen, abierta, titulo) VALUES (?,?,?,?,?,?,1,?)",
      quien, ahora, ahora, modo, JSON.stringify(mensajes), JSON.stringify([turno]), titulo);
    return Number(r.lastInsertRowid);
  }
  cerrarConversacion(id) { return this.correr("UPDATE conversaciones SET abierta=0 WHERE id=?", id).changes > 0; }
  reabrirConversacion(id, quien) {
    const c = this.conversacion(id);
    if (!c || c.quien !== quien) return false;
    this.correr("UPDATE conversaciones SET abierta=0 WHERE quien=? AND abierta=1", quien);
    this.correr("UPDATE conversaciones SET abierta=1 WHERE id=?", id);
    return true;
  }
  conversaciones({ quien = null, limite = 30, dias = null } = {}) {
    const desde = dias ? new Date(Date.now() - dias * 86_400_000).toISOString() : null;
    const cond = [], p = [];
    if (quien) { cond.push("quien=?"); p.push(quien); }
    if (desde) { cond.push("ultimo>=?"); p.push(desde); }
    const sql = `SELECT id, quien, inicio, ultimo, modo, abierta, titulo, resumen FROM conversaciones${cond.length ? " WHERE " + cond.join(" AND ") : ""} ORDER BY ultimo DESC LIMIT ?`;
    return this.todos(sql, ...p, limite).map(desempacar);
  }
  purgarConversaciones(dias = 30) {
    const limite = new Date(Date.now() - dias * 86_400_000).toISOString();
    return this.correr("DELETE FROM conversaciones WHERE ultimo < ?", limite).changes;
  }

  // --- usuarios, invitaciones y sesiones
  usuarios() { return this.todos("SELECT id, correo, nombre, rol, activo, creado_en, creado_por, ultimo_acceso FROM usuarios ORDER BY rol, correo"); }
  usuario(id) { return this.uno("SELECT * FROM usuarios WHERE id=?", id); }
  usuarioPorCorreo(correo) { return this.uno("SELECT * FROM usuarios WHERE correo=?", String(correo || "").trim().toLowerCase()); }
  crearUsuario({ correo, nombre = null, rol = "receptor", quien = "sistema" }) {
    const c = String(correo || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c)) throw new Error("Correo inválido.");
    if (!["contable", "receptor"].includes(rol)) throw new Error("Rol inválido.");
    const existe = this.usuarioPorCorreo(c);
    if (existe) {
      this.correr("UPDATE usuarios SET nombre=COALESCE(?, nombre), rol=?, activo=1 WHERE id=?", nombre, rol, existe.id);
      return this.usuario(existe.id);
    }
    const r = this.correr("INSERT INTO usuarios (correo, nombre, rol, creado_en, creado_por) VALUES (?,?,?,?,?)", c, nombre, rol, this.#ahora(), quien);
    this.auditar(quien, "crear-usuario", "usuario", Number(r.lastInsertRowid), { correo: c, rol });
    return this.usuario(Number(r.lastInsertRowid));
  }
  desactivarUsuario(id, quien) {
    this.correr("UPDATE usuarios SET activo=0 WHERE id=?", id);
    this.correr("DELETE FROM sesiones WHERE usuario_id=?", id);
    this.auditar(quien, "desactivar-usuario", "usuario", id);
  }
  crearInvitacion(usuarioId, tokenHash, { minutos = 60 * 24 * 3, quien = "sistema" } = {}) {
    const vence = new Date(Date.now() + minutos * 60e3).toISOString();
    this.correr("INSERT INTO invitaciones (usuario_id, token_hash, vence, creada_en, creada_por) VALUES (?,?,?,?,?)", usuarioId, tokenHash, vence, this.#ahora(), quien);
    this.auditar(quien, "invitar", "usuario", usuarioId, { vence });
    return vence;
  }
  // Canjea una invitación: una sola vez, antes de vencer, usuario activo. Devuelve el usuario o null.
  canjearInvitacion(tokenHash) {
    const inv = this.uno("SELECT * FROM invitaciones WHERE token_hash=?", tokenHash);
    if (!inv || inv.usada_en || inv.vence < this.#ahora()) return null;
    const u = this.usuario(inv.usuario_id);
    if (!u || !u.activo) return null;
    this.correr("UPDATE invitaciones SET usada_en=? WHERE id=?", this.#ahora(), inv.id);
    return u;
  }
  crearSesion(idHash, usuarioId, { dias = 30 } = {}) {
    const ahora = this.#ahora();
    this.correr("INSERT INTO sesiones (id, usuario_id, creada_en, vence, ultimo_uso) VALUES (?,?,?,?,?)", idHash, usuarioId, ahora, new Date(Date.now() + dias * 864e5).toISOString(), ahora);
    this.correr("UPDATE usuarios SET ultimo_acceso=? WHERE id=?", ahora, usuarioId);
  }
  // Devuelve el usuario de una sesión viva, o null.
  usuarioDeSesion(idHash) {
    if (!idHash) return null;
    const s = this.uno("SELECT * FROM sesiones WHERE id=?", idHash);
    if (!s || s.vence < this.#ahora()) return null;
    const u = this.usuario(s.usuario_id);
    if (!u || !u.activo) return null;
    this.correr("UPDATE sesiones SET ultimo_uso=? WHERE id=?", this.#ahora(), idHash);
    return u;
  }
  cerrarSesion(idHash) { this.correr("DELETE FROM sesiones WHERE id=?", idHash); }

  auditoria(limite = 100) { return this.todos("SELECT * FROM auditoria ORDER BY id DESC LIMIT ?", limite).map(desempacar); }
}

// Columnas JSON vuelven a ser objetos.
const JSON_COLS = new Set(["totales", "alertas", "resultado", "correo_ids", "companias", "detalle", "mensajes", "resumen", "pasos"]);
function desempacar(fila) {
  if (!fila) return fila;
  const out = { ...fila };
  for (const k of JSON_COLS) if (typeof out[k] === "string") { try { out[k] = JSON.parse(out[k]); } catch { /* texto plano */ } }
  return out;
}
