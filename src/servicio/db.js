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
    // fecha en que se revierte solo (revaluaciones de fin de mes: se revierten el día 1)
    if (!columnas("asientos").has("reversa")) this.db.exec("ALTER TABLE asientos ADD COLUMN reversa TEXT");
    this.#tablaDiferidos();
    this.#tablaActivos();
    this.#tablaCierres();
    this.#tablaExtractos();
    this.#tablaAutonomia();
    this.#tablaDeclaraciones();
    if (!columnas("correos").has("responder_a")) this.db.exec("ALTER TABLE correos ADD COLUMN responder_a TEXT");
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

  // --- extractos bancarios (fase 3C): lo que se sube queda aquí, línea por línea, con su estado
  #tablaExtractos() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS extractos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      compania_id INTEGER NOT NULL,
      compania    TEXT,
      diario_id   INTEGER NOT NULL,
      diario      TEXT,
      cuenta_id   INTEGER,
      moneda      TEXT,
      archivo     TEXT,
      formato     TEXT,
      desde       TEXT,
      hasta       TEXT,
      saldo_inicial REAL,
      saldo_final REAL,
      cuadra      INTEGER,
      movimientos INTEGER NOT NULL DEFAULT 0,
      repetidos   INTEGER NOT NULL DEFAULT 0,
      estado      TEXT NOT NULL DEFAULT 'activo',   -- activo | anulado
      subio       TEXT NOT NULL,
      creado_en   TEXT NOT NULL,
      nota        TEXT
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS extracto_lineas (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      extracto_id INTEGER NOT NULL,
      compania_id INTEGER NOT NULL,
      diario_id   INTEGER NOT NULL,
      fecha       TEXT NOT NULL,
      descripcion TEXT,
      referencia  TEXT,
      monto       REAL NOT NULL,
      saldo       REAL,
      huella      TEXT NOT NULL,
      estado      TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente | en-libros | propuesta | registrada | ignorada
      tipo        TEXT,                 -- cargo | interes | transferencia | cobro | pago | entrada | salida
      emparejado  TEXT,                 -- JSON: apunte de Odoo, candidatos o la otra cuenta
      asiento_clave TEXT,
      nota        TEXT,
      actualizado_en TEXT,
      UNIQUE (diario_id, huella)
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS extracto_lineas_diario ON extracto_lineas (diario_id, estado, fecha)");
    const columnas = t => new Set(this.todos(`PRAGMA table_info(${t})`).map(c => c.name));
    if (!columnas("extractos").has("referencia")) this.db.exec("ALTER TABLE extractos ADD COLUMN referencia TEXT");          // tecnodem:<id de la conciliación>
    if (!columnas("extracto_lineas").has("externo")) this.db.exec("ALTER TABLE extracto_lineas ADD COLUMN externo TEXT");    // JSON: lo que dice TecnoDEM de la línea
  }
  // Un extracto que viene del módulo de TecnoDEM: una fila por conciliación; en cada corrida solo se agregan las líneas nuevas.
  extractoPorReferencia(referencia) { return this.uno("SELECT * FROM extractos WHERE referencia=?", referencia) || null; }
  agregarLineasExtracto(extractoId, movimientos, { hasta = null, saldoFinal = null } = {}) {
    const e = this.extracto(extractoId);
    if (!e) return { nuevos: 0 };
    let nuevos = 0;
    this.transaccion(() => {
      for (const m of movimientos) {
        const r = this.correr(`INSERT OR IGNORE INTO extracto_lineas (extracto_id, compania_id, diario_id, fecha, descripcion, referencia, monto, saldo, huella, externo) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          extractoId, e.compania_id, e.diario_id, m.fecha, m.descripcion ?? null, m.referencia ?? null, m.monto, m.saldo ?? null, m.huella, m.externo ? JSON.stringify(m.externo) : null);
        nuevos += r.changes;
      }
      if (nuevos || hasta || saldoFinal != null) this.correr("UPDATE extractos SET movimientos=movimientos+?, hasta=COALESCE(?, hasta), saldo_final=COALESCE(?, saldo_final), desde=MIN(COALESCE(desde, ?), ?) WHERE id=?",
        nuevos, hasta, saldoFinal, movimientos[0]?.fecha ?? null, movimientos.reduce((a, m) => (!a || m.fecha < a ? m.fecha : a), null) ?? e.desde, extractoId);
    });
    return { nuevos };
  }
  // e: {companiaId, compania, diarioId, diario, cuentaId, moneda, archivo, formato, desde, hasta, saldoInicial, saldoFinal, cuadra}
  registrarExtracto(e, movimientos, quien) {
    let id, nuevos = 0;
    this.transaccion(() => {
      const x = this.correr(`INSERT INTO extractos (compania_id, compania, diario_id, diario, cuenta_id, moneda, archivo, formato, desde, hasta, saldo_inicial, saldo_final, cuadra, subio, creado_en, referencia)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, e.companiaId, e.compania ?? null, e.diarioId, e.diario ?? null, e.cuentaId ?? null, e.moneda ?? null, e.archivo ?? null, e.formato ?? null,
        e.desde ?? null, e.hasta ?? null, e.saldoInicial ?? null, e.saldoFinal ?? null, e.cuadra == null ? null : (e.cuadra ? 1 : 0), quien, this.#ahora(), e.referencia ?? null);
      id = Number(x.lastInsertRowid);
      for (const m of movimientos) {
        const r = this.correr(`INSERT OR IGNORE INTO extracto_lineas (extracto_id, compania_id, diario_id, fecha, descripcion, referencia, monto, saldo, huella, externo)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, id, e.companiaId, e.diarioId, m.fecha, m.descripcion ?? null, m.referencia ?? null, m.monto, m.saldo ?? null, m.huella, m.externo ? JSON.stringify(m.externo) : null);
        nuevos += r.changes;
      }
      this.correr("UPDATE extractos SET movimientos=?, repetidos=? WHERE id=?", nuevos, movimientos.length - nuevos, id);
    });
    this.auditar(quien, "importar", "extracto", id, { diario: e.diario, compania: e.compania, archivo: e.archivo, movimientos: nuevos, repetidos: movimientos.length - nuevos });
    return { id, nuevos, repetidos: movimientos.length - nuevos };
  }
  // Huellas ya importadas de un diario (para la vista previa).
  huellasExtracto(diarioId) { return new Set(this.todos("SELECT huella FROM extracto_lineas WHERE diario_id=?", diarioId).map(x => x.huella)); }
  extractos({ estado = "activo", companiaId = null } = {}) {
    const cond = [], p = [];
    if (estado !== "todos") { cond.push("e.estado=?"); p.push(estado); }
    if (companiaId) { cond.push("e.compania_id=?"); p.push(companiaId); }
    return this.todos(`SELECT e.*,
        (SELECT COUNT(*) FROM extracto_lineas l WHERE l.extracto_id=e.id AND l.estado='pendiente') AS pendientes,
        (SELECT COUNT(*) FROM extracto_lineas l WHERE l.extracto_id=e.id AND l.estado='en-libros') AS en_libros,
        (SELECT COUNT(*) FROM extracto_lineas l WHERE l.extracto_id=e.id AND l.estado IN ('propuesta','registrada')) AS con_asiento,
        (SELECT COUNT(*) FROM extracto_lineas l WHERE l.extracto_id=e.id AND l.estado='ignorada') AS ignoradas
      FROM extractos e${cond.length ? " WHERE " + cond.join(" AND ") : ""} ORDER BY e.compania, e.diario, e.desde DESC, e.id DESC`, ...p);
  }
  extracto(id) { return this.uno("SELECT * FROM extractos WHERE id=?", id); }
  lineasExtracto({ extractoId = null, diarioId = null, estados = null, limite = 5000 } = {}) {
    const cond = ["e.estado='activo'"], p = [];
    if (extractoId) { cond.push("l.extracto_id=?"); p.push(extractoId); }
    if (diarioId) { cond.push("l.diario_id=?"); p.push(diarioId); }
    if (estados) { cond.push(`l.estado IN (${estados.map(() => "?").join(",")})`); p.push(...estados); }
    return this.todos(`SELECT l.* FROM extracto_lineas l JOIN extractos e ON e.id=l.extracto_id WHERE ${cond.join(" AND ")} ORDER BY l.diario_id, l.fecha, l.id LIMIT ?`, ...p, limite)
      .map(l => ({ ...l, emparejado: l.emparejado ? JSON.parse(l.emparejado) : null, externo: l.externo ? JSON.parse(l.externo) : null }));
  }
  // Resultado del emparejamiento: [{id, estado, tipo, emparejado, asientoClave}]. Las ignoradas no se tocan.
  actualizarLineasExtracto(cambios) {
    const ahora = this.#ahora();
    let n = 0;
    this.transaccion(() => {
      for (const c of cambios) n += this.correr(`UPDATE extracto_lineas SET estado=?, tipo=?, emparejado=?, asiento_clave=?, actualizado_en=? WHERE id=? AND estado!='ignorada'`,
        c.estado, c.tipo ?? null, c.emparejado ? JSON.stringify(c.emparejado) : null, c.asientoClave ?? null, ahora, c.id).changes;
    });
    return n;
  }
  ignorarLineaExtracto(id, quien, nota = null, ignorar = true) {
    const r = ignorar
      ? this.correr("UPDATE extracto_lineas SET estado='ignorada', nota=?, actualizado_en=? WHERE id=? AND estado IN ('pendiente','propuesta')", nota, this.#ahora(), id)
      : this.correr("UPDATE extracto_lineas SET estado='pendiente', nota=NULL, actualizado_en=? WHERE id=? AND estado='ignorada'", this.#ahora(), id);
    if (r.changes) this.auditar(quien, ignorar ? "ignorar" : "reabrir", "linea-extracto", id, nota ? { nota } : null);
    return r.changes > 0;
  }
  anularExtracto(id, quien, nota = null) {
    const r = this.correr("UPDATE extractos SET estado='anulado', nota=? WHERE id=? AND estado='activo'", nota, id);
    if (r.changes) {
      this.correr("DELETE FROM extracto_lineas WHERE extracto_id=? AND estado IN ('pendiente','en-libros','ignorada')", id);
      this.auditar(quien, "anular", "extracto", id, nota ? { nota } : null);
    }
    return r.changes > 0;
  }
  // Estado de los asientos que salieron de líneas de extracto, por clave.
  estadoAsientosPorClave(origen) {
    const out = new Map();
    for (const a of this.todos("SELECT clave, estado, move_name FROM asientos WHERE origen=? ORDER BY id", origen)) out.set(a.clave, { estado: a.estado, asiento: a.move_name });
    return out;
  }

  // --- autonomía (fase 4): qué tipo de propuesta, en qué compañía, se aprueba sola
  #tablaAutonomia() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS autonomia (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo        TEXT NOT NULL,        -- cierre | cambiario | diferidos | depreciacion | extractos-cargos | … | cuentas
      compania_id INTEGER NOT NULL,
      compania    TEXT,
      estado      TEXT NOT NULL DEFAULT 'activa',   -- activa | revocada
      otorgo      TEXT NOT NULL,
      otorgada_en TEXT NOT NULL,
      nota        TEXT,
      evidencia   TEXT,                 -- JSON: los meses que la justificaron
      revoco      TEXT,
      revocada_en TEXT,
      motivo      TEXT
    )`);
  }
  autonomias({ estado = "activa" } = {}) {
    return this.todos(`SELECT * FROM autonomia${estado === "todas" ? "" : " WHERE estado=?"} ORDER BY tipo, compania, id DESC`, ...(estado === "todas" ? [] : [estado]))
      .map(a => ({ ...a, evidencia: a.evidencia ? JSON.parse(a.evidencia) : null }));
  }
  autonomiaActiva(tipo, companiaId) { return this.uno("SELECT * FROM autonomia WHERE tipo=? AND compania_id=? AND estado='activa'", tipo, companiaId) || null; }
  otorgarAutonomia({ tipo, companiaId, compania, nota = null, evidencia = null }, quien) {
    if (this.autonomiaActiva(tipo, companiaId)) return null;
    const x = this.correr("INSERT INTO autonomia (tipo, compania_id, compania, otorgo, otorgada_en, nota, evidencia) VALUES (?,?,?,?,?,?,?)",
      tipo, companiaId, compania ?? null, quien, this.#ahora(), nota, evidencia ? JSON.stringify(evidencia) : null);
    const id = Number(x.lastInsertRowid);
    this.auditar(quien, "otorgar", "autonomia", id, { tipo, compania, nota });
    return id;
  }
  revocarAutonomia(id, quien, motivo = null) {
    const r = this.correr("UPDATE autonomia SET estado='revocada', revoco=?, revocada_en=?, motivo=? WHERE id=? AND estado='activa'", quien, this.#ahora(), motivo, id);
    if (r.changes) this.auditar(quien, "revocar", "autonomia", id, motivo ? { motivo } : null);
    return r.changes > 0;
  }
  // Para medir: asientos y propuestas ya decididos, y qué asientos editó una persona.
  decisionesAsientos() { return this.todos("SELECT id, clave, origen, mes, fecha, compania_id, compania, estado, decidio, decidido_en, lineas, resultado FROM asientos WHERE decidio IS NOT NULL OR estado IN ('aplicada','fallo')"); }
  decisionesPropuestas() { return this.todos("SELECT id, compania_id, compania, estado, decidio, decidido_en FROM propuestas WHERE decidio IS NOT NULL"); }
  asientosEditados() { return new Set(this.todos("SELECT DISTINCT objeto_id FROM auditoria WHERE objeto='asiento' AND accion='editar'").map(x => x.objeto_id)); }

  // --- declaraciones de Hacienda (TRIBU-CR): una fila por compañía × formulario × periodo
  #tablaDeclaraciones() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS declaraciones (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      clave       TEXT NOT NULL UNIQUE,   -- impuesto|compania|periodo
      impuesto    TEXT NOT NULL,          -- 150 | 102 | 270
      compania_id INTEGER NOT NULL,
      compania    TEXT,
      periodo     TEXT NOT NULL,          -- AAAA-MM o AAAA
      corrida_id  INTEGER,
      estado      TEXT NOT NULL DEFAULT 'preparada',  -- preparada | revisada | cargada | aprobada | presentada | rechazada
      paquete     TEXT NOT NULL,          -- JSON: casillas, totales, extra
      juez        TEXT,                   -- JSON: semaforo y observaciones (reglas + IA)
      ajustes     TEXT,                   -- JSON: lo que una persona fijó (proporción, saldo anterior, tarifa…); sobrevive a las corridas
      carga       TEXT,                   -- JSON: lo que el plugin dejó en el portal (campos leídos, diferencias, capturas)
      desactualizada INTEGER NOT NULL DEFAULT 0,  -- 1 si una corrida posterior dio otras cifras después de cargar/aprobar
      paquete_nuevo TEXT,
      decidio     TEXT, decidido_en TEXT, nota TEXT,
      presentada_en TEXT, numero_presentacion TEXT, presento TEXT,
      notificada_en TEXT,
      creado_en   TEXT NOT NULL, actualizado_en TEXT
    )`);
  }
  #filaDeclaracion(d) {
    if (!d) return null;
    const j = k => (d[k] ? JSON.parse(d[k]) : null);
    return { ...d, paquete: j("paquete"), juez: j("juez"), ajustes: j("ajustes"), carga: j("carga"), paquete_nuevo: j("paquete_nuevo") };
  }
  // Lo que el agente armó. Las preparadas/revisadas se reemplazan; las que ya se cargaron o aprobaron se
  // marcan desactualizadas si las cifras cambiaron (la persona decide).
  sincronizarDeclaraciones(corridaId, paquetes) {
    const ahora = this.#ahora();
    let nuevas = 0, actualizadas = 0, desactualizadas = 0;
    const firma = p => JSON.stringify(p.totales);
    this.transaccion(() => {
      for (const p of paquetes) {
        const clave = `${p.impuesto}|${p.companiaId}|${p.periodo}`;
        const { juez, ...paquete } = p;
        const v = this.uno("SELECT id, estado, paquete FROM declaraciones WHERE clave=?", clave);
        if (!v) {
          this.correr("INSERT INTO declaraciones (clave, impuesto, compania_id, compania, periodo, corrida_id, paquete, juez, creado_en) VALUES (?,?,?,?,?,?,?,?,?)",
            clave, p.impuesto, p.companiaId, p.compania, p.periodo, corridaId, JSON.stringify(paquete), JSON.stringify(juez), ahora);
          nuevas++;
        } else if (["preparada", "revisada", "rechazada"].includes(v.estado)) {
          // el juicio de la IA (si lo hubo) se conserva solo si las cifras no cambiaron
          const prev = this.uno("SELECT juez FROM declaraciones WHERE id=?", v.id);
          const mismo = firma(JSON.parse(v.paquete)) === firma(p), jPrev = prev.juez ? JSON.parse(prev.juez) : null;
          const juezFinal = mismo && jPrev?.ia ? { ...juez, ia: jPrev.ia, semaforo: jPrev.semaforo } : juez;
          this.correr("UPDATE declaraciones SET corrida_id=?, paquete=?, juez=?, estado=CASE WHEN estado='rechazada' THEN 'preparada' ELSE (CASE WHEN ? THEN estado ELSE 'preparada' END) END, actualizado_en=? WHERE id=?",
            corridaId, JSON.stringify(paquete), JSON.stringify(juezFinal), mismo ? 1 : 0, ahora, v.id);
          actualizadas++;
        } else if (firma(JSON.parse(v.paquete)) !== firma(p)) {
          this.correr("UPDATE declaraciones SET desactualizada=1, paquete_nuevo=?, actualizado_en=? WHERE id=?", JSON.stringify({ ...paquete, juez }), ahora, v.id);
          desactualizadas++;
        }
      }
    });
    return { nuevas, actualizadas, desactualizadas };
  }
  declaraciones({ periodo = null, impuesto = null, estado = null, companiaId = null } = {}) {
    const cond = [], p = [];
    if (periodo) { cond.push("(periodo=? OR periodo=?)"); p.push(periodo, String(periodo).slice(0, 4)); }
    if (impuesto) { cond.push("impuesto=?"); p.push(impuesto); }
    if (estado) { cond.push(estado === "pendientes" ? "estado IN ('preparada','revisada','cargada')" : "estado=?"); if (estado !== "pendientes") p.push(estado); }
    if (companiaId) { cond.push("compania_id=?"); p.push(companiaId); }
    return this.todos(`SELECT * FROM declaraciones${cond.length ? " WHERE " + cond.join(" AND ") : ""} ORDER BY periodo DESC, impuesto, compania`, ...p).map(d => this.#filaDeclaracion(d));
  }
  declaracion(id) { return this.#filaDeclaracion(this.uno("SELECT * FROM declaraciones WHERE id=?", id)); }
  periodosDeclaraciones() { return this.todos("SELECT periodo, COUNT(*) n FROM declaraciones WHERE impuesto='150' GROUP BY periodo ORDER BY periodo DESC").map(x => x.periodo); }
  ajustesDeclaracion(clave) { const d = this.uno("SELECT ajustes FROM declaraciones WHERE clave=?", clave); return d && d.ajustes ? JSON.parse(d.ajustes) : null; }
  // La última declaración del mismo impuesto antes de este periodo (para el saldo a favor que arrastra).
  declaracionAnterior(companiaId, impuesto, periodo) {
    const d = this.uno("SELECT periodo, paquete FROM declaraciones WHERE compania_id=? AND impuesto=? AND periodo<? AND estado IN ('aprobada','presentada') ORDER BY periodo DESC LIMIT 1", companiaId, impuesto, periodo);
    return d ? { periodo: d.periodo, favor: JSON.parse(d.paquete).totales.favor || 0 } : null;
  }
  ajustarDeclaracion(id, ajustes, quien) {
    const d = this.uno("SELECT id, estado, ajustes FROM declaraciones WHERE id=?", id);
    if (!d || !["preparada", "revisada", "rechazada"].includes(d.estado)) return false;
    const nuevos = { ...(d.ajustes ? JSON.parse(d.ajustes) : {}), ...ajustes };
    for (const k of Object.keys(nuevos)) if (nuevos[k] == null || nuevos[k] === "") delete nuevos[k];
    this.correr("UPDATE declaraciones SET ajustes=?, actualizado_en=? WHERE id=?", JSON.stringify(nuevos), this.#ahora(), id);
    this.auditar(quien, "ajustar", "declaracion", id, ajustes);
    return true;
  }
  // Reemplaza paquete y juez (recalculados con los ajustes) sin tocar el estado.
  reemplazarPaqueteDeclaracion(id, paquete, juez) {
    const { juez: _j, ...p } = paquete;
    this.correr("UPDATE declaraciones SET paquete=?, juez=?, actualizado_en=? WHERE id=?", JSON.stringify(p), JSON.stringify(juez), this.#ahora(), id);
  }
  juzgarDeclaracion(id, juez, quien) {
    const r = this.correr("UPDATE declaraciones SET juez=?, estado=CASE WHEN estado='preparada' THEN 'revisada' ELSE estado END, actualizado_en=? WHERE id=?", JSON.stringify(juez), this.#ahora(), id);
    if (r.changes) this.auditar(quien, "juzgar", "declaracion", id, { semaforo: juez.semaforo, observaciones: (juez.observaciones || []).length });
    return r.changes > 0;
  }
  cargarDeclaracion(id, carga, quien) {
    const d = this.uno("SELECT estado FROM declaraciones WHERE id=?", id);
    if (!d || !["preparada", "revisada", "cargada"].includes(d.estado)) return false;
    this.correr("UPDATE declaraciones SET carga=?, estado='cargada', actualizado_en=? WHERE id=?", JSON.stringify(carga), this.#ahora(), id);
    this.auditar(quien, "cargar", "declaracion", id, { diferencias: (carga.diferencias || []).length, capturas: (carga.capturas || []).length });
    return true;
  }
  decidirDeclaracion(id, decision, quien, nota = null) {
    const d = this.uno("SELECT estado FROM declaraciones WHERE id=?", id);
    if (!d || !["preparada", "revisada", "cargada"].includes(d.estado)) return false;
    this.correr("UPDATE declaraciones SET estado=?, decidio=?, decidido_en=?, nota=?, desactualizada=0, paquete_nuevo=NULL, actualizado_en=? WHERE id=?", decision, quien, this.#ahora(), nota, this.#ahora(), id);
    this.auditar(quien, decision === "aprobada" ? "aprobar" : "rechazar", "declaracion", id, nota ? { nota } : null);
    return true;
  }
  presentarDeclaracion(id, { numero, fecha = null }, quien) {
    const d = this.uno("SELECT estado FROM declaraciones WHERE id=?", id);
    if (!d || d.estado !== "aprobada") return false;
    this.correr("UPDATE declaraciones SET estado='presentada', numero_presentacion=?, presentada_en=?, presento=?, actualizado_en=? WHERE id=?", numero, fecha || this.#ahora(), quien, this.#ahora(), id);
    this.auditar(quien, "presentar", "declaracion", id, { numero });
    return true;
  }
  // Toma el paquete nuevo que llegó después de cargar/aprobar: vuelve a 'preparada'.
  tomarPaqueteNuevo(id, quien) {
    const d = this.#filaDeclaracion(this.uno("SELECT * FROM declaraciones WHERE id=?", id));
    if (!d || !d.paquete_nuevo) return false;
    const { juez, ...p } = d.paquete_nuevo;
    this.correr("UPDATE declaraciones SET paquete=?, juez=?, estado='preparada', carga=NULL, desactualizada=0, paquete_nuevo=NULL, decidio=NULL, decidido_en=NULL, actualizado_en=? WHERE id=?", JSON.stringify(p), JSON.stringify(juez), this.#ahora(), id);
    this.auditar(quien, "actualizar", "declaracion", id, null);
    return true;
  }
  marcarNotificadas(ids) { const ahora = this.#ahora(); for (const id of ids) this.correr("UPDATE declaraciones SET notificada_en=? WHERE id=?", ahora, id); }

  // --- gastos diferidos (ítem 15): el registro vive aquí; las cuotas, en la cola de asientos
  #tablaDiferidos() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS diferidos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      compania_id INTEGER NOT NULL,
      compania    TEXT,
      descripcion TEXT NOT NULL,
      cuenta_activo_id INTEGER NOT NULL,
      cuenta_activo TEXT,
      cuenta_gasto_id INTEGER NOT NULL,
      cuenta_gasto TEXT,
      monto       REAL NOT NULL,
      meses       INTEGER NOT NULL,
      inicio      TEXT NOT NULL,        -- AAAA-MM de la primera cuota
      referencia  TEXT,                 -- factura o contrato de origen
      estado      TEXT NOT NULL DEFAULT 'activo',   -- activo | anulado
      creado_por  TEXT NOT NULL,
      creado_en   TEXT NOT NULL,
      nota        TEXT
    )`);
  }
  registrarDiferido(d, quien) {
    const x = this.correr(`INSERT INTO diferidos (compania_id, compania, descripcion, cuenta_activo_id, cuenta_activo, cuenta_gasto_id, cuenta_gasto, monto, meses, inicio, referencia, creado_por, creado_en)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, d.companiaId, d.compania ?? null, d.descripcion, d.cuentaActivoId, d.cuentaActivo ?? null, d.cuentaGastoId, d.cuentaGasto ?? null,
      Math.round(Number(d.monto) * 100) / 100, Number(d.meses), d.inicio, d.referencia ?? null, quien, this.#ahora());
    const id = Number(x.lastInsertRowid);
    this.auditar(quien, "registrar", "diferido", id, { compania: d.compania, descripcion: d.descripcion, monto: d.monto, meses: d.meses, inicio: d.inicio });
    return this.diferido(id);
  }
  diferido(id) { return this.uno("SELECT * FROM diferidos WHERE id=?", id); }
  diferidos({ estado = "activo", companiaId = null } = {}) {
    const cond = [], p = [];
    if (estado !== "todos") { cond.push("estado=?"); p.push(estado); }
    if (companiaId) { cond.push("compania_id=?"); p.push(companiaId); }
    return this.todos(`SELECT * FROM diferidos${cond.length ? " WHERE " + cond.join(" AND ") : ""} ORDER BY compania, inicio, id`, ...p);
  }
  anularDiferido(id, quien, nota = null) {
    const r = this.correr("UPDATE diferidos SET estado='anulado', nota=? WHERE id=? AND estado='activo'", nota, id);
    if (r.changes) this.auditar(quien, "anular", "diferido", id, nota ? { nota } : null);
    return r.changes > 0;
  }
  // Meses ya registrados en Odoo por diferido: las líneas de asientos aplicados (origen diferidos)
  // llevan diferidoId y los meses que cubren.
  mesesAplicadosDiferidos() {
    const out = new Map();
    for (const a of this.todos("SELECT lineas FROM asientos WHERE origen='diferidos' AND estado='aplicada'"))
      for (const l of JSON.parse(a.lineas || "[]")) if (l.diferidoId) {
        const s = out.get(l.diferidoId) || new Set();
        for (const m of l.meses || []) s.add(m);
        out.set(l.diferidoId, s);
      }
    return out;
  }

  // --- activos fijos (ítem 16): registro y depreciación lineal; los asientos, en la cola
  #tablaActivos() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS activos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      compania_id INTEGER NOT NULL,
      compania    TEXT,
      descripcion TEXT NOT NULL,
      categoria   TEXT,
      cuenta_activo_id INTEGER, cuenta_activo TEXT,                 -- costo (informativa)
      cuenta_acumulada_id INTEGER NOT NULL, cuenta_acumulada TEXT,  -- depreciación acumulada
      cuenta_gasto_id INTEGER NOT NULL, cuenta_gasto TEXT,          -- gasto por depreciación
      costo       REAL NOT NULL,
      residual    REAL NOT NULL DEFAULT 0,
      vida_meses  INTEGER NOT NULL,
      inicio      TEXT NOT NULL,        -- AAAA-MM del primer mes que se deprecia
      hecho_hasta TEXT,                 -- AAAA-MM: depreciado fuera de la app hasta este mes
      referencia  TEXT,
      estado      TEXT NOT NULL DEFAULT 'activo',   -- activo | baja
      baja_mes    TEXT,
      creado_por  TEXT NOT NULL,
      creado_en   TEXT NOT NULL,
      nota        TEXT
    )`);
  }
  registrarActivo(a, quien) {
    const x = this.correr(`INSERT INTO activos (compania_id, compania, descripcion, categoria, cuenta_activo_id, cuenta_activo, cuenta_acumulada_id, cuenta_acumulada, cuenta_gasto_id, cuenta_gasto,
      costo, residual, vida_meses, inicio, hecho_hasta, referencia, creado_por, creado_en) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      a.companiaId, a.compania ?? null, a.descripcion, a.categoria ?? null, a.cuentaActivoId ?? null, a.cuentaActivo ?? null, a.cuentaAcumuladaId, a.cuentaAcumulada ?? null,
      a.cuentaGastoId, a.cuentaGasto ?? null, Math.round(Number(a.costo) * 100) / 100, Math.round(Number(a.residual || 0) * 100) / 100, Number(a.vidaMeses), a.inicio, a.hechoHasta ?? null,
      a.referencia ?? null, quien, this.#ahora());
    const id = Number(x.lastInsertRowid);
    this.auditar(quien, "registrar", "activo", id, { compania: a.compania, descripcion: a.descripcion, costo: a.costo, vidaMeses: a.vidaMeses, inicio: a.inicio });
    return this.activo(id);
  }
  activo(id) { return this.uno("SELECT * FROM activos WHERE id=?", id); }
  activos({ estado = "activo", companiaId = null } = {}) {
    const cond = [], p = [];
    if (estado !== "todos") { cond.push("estado=?"); p.push(estado); }
    if (companiaId) { cond.push("compania_id=?"); p.push(companiaId); }
    return this.todos(`SELECT * FROM activos${cond.length ? " WHERE " + cond.join(" AND ") : ""} ORDER BY compania, inicio, id`, ...p);
  }
  // Baja (venta, desecho): se deprecia hasta el mes de la baja inclusive y después ya no.
  darDeBajaActivo(id, mes, quien, nota = null) {
    const r = this.correr("UPDATE activos SET estado='baja', baja_mes=?, nota=? WHERE id=? AND estado='activo'", mes, nota, id);
    if (r.changes) this.auditar(quien, "baja", "activo", id, { mes, nota });
    return r.changes > 0;
  }
  mesesAplicadosActivos() {
    const out = new Map();
    for (const a of this.todos("SELECT lineas FROM asientos WHERE origen='depreciacion' AND estado='aplicada'"))
      for (const l of JSON.parse(a.lineas || "[]")) if (l.activoId) {
        const s = out.get(l.activoId) || new Set();
        for (const m of l.meses || []) s.add(m);
        out.set(l.activoId, s);
      }
    return out;
  }

  // --- cierre de mes por compañía: lo que se dio por bueno y si el mes quedó cerrado
  #tablaCierres() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS cierres_mes (
      compania_id INTEGER NOT NULL,
      compania    TEXT,
      mes         TEXT NOT NULL,
      estado      TEXT NOT NULL DEFAULT 'abierto',   -- abierto | cerrado
      revisados   TEXT NOT NULL DEFAULT '{}',        -- JSON { item: { quien, nota, cuando } }
      cerrado_por TEXT,
      cerrado_en  TEXT,
      nota        TEXT,
      foto        TEXT,                              -- JSON: la lista al cerrar
      PRIMARY KEY (compania_id, mes)
    )`);
  }
  #cierreMes(ciaId, compania, mes) {
    this.correr("INSERT OR IGNORE INTO cierres_mes (compania_id, compania, mes) VALUES (?,?,?)", ciaId, compania ?? null, mes);
    const r = this.uno("SELECT * FROM cierres_mes WHERE compania_id=? AND mes=?", ciaId, mes);
    return { ...r, revisados: JSON.parse(r.revisados || "{}"), foto: r.foto ? JSON.parse(r.foto) : null };
  }
  cierresMes(mes) {
    return this.todos("SELECT * FROM cierres_mes WHERE mes=?", mes).map(r => ({ ...r, revisados: JSON.parse(r.revisados || "{}"), foto: undefined }));
  }
  cierreMes(ciaId, mes) {
    const r = this.uno("SELECT * FROM cierres_mes WHERE compania_id=? AND mes=?", ciaId, mes);
    return r ? { ...r, revisados: JSON.parse(r.revisados || "{}"), foto: r.foto ? JSON.parse(r.foto) : null } : null;
  }
  // Dar por bueno un ítem pendiente (o quitarlo con nota=null), mientras el mes no esté cerrado.
  revisarItemCierre(ciaId, compania, mes, item, quien, nota) {
    const c = this.#cierreMes(ciaId, compania, mes);
    if (c.estado === "cerrado") return false;
    if (nota == null) delete c.revisados[item]; else c.revisados[item] = { quien, nota: String(nota).slice(0, 500), cuando: this.#ahora() };
    this.correr("UPDATE cierres_mes SET revisados=? WHERE compania_id=? AND mes=?", JSON.stringify(c.revisados), ciaId, mes);
    this.auditar(quien, nota == null ? "quitar-revision" : "dar-por-bueno", "cierre", ciaId, { mes, item, nota });
    return true;
  }
  cerrarMes(ciaId, compania, mes, quien, nota, foto) {
    this.#cierreMes(ciaId, compania, mes);
    const r = this.correr("UPDATE cierres_mes SET estado='cerrado', cerrado_por=?, cerrado_en=?, nota=?, foto=? WHERE compania_id=? AND mes=? AND estado='abierto'",
      quien, this.#ahora(), nota ?? null, JSON.stringify(foto ?? null), ciaId, mes);
    if (r.changes) this.auditar(quien, "cerrar", "cierre", ciaId, { mes, nota });
    return r.changes > 0;
  }
  reabrirMes(ciaId, mes, quien, nota) {
    const r = this.correr("UPDATE cierres_mes SET estado='abierto', nota=? WHERE compania_id=? AND mes=? AND estado='cerrado'", nota ?? null, ciaId, mes);
    if (r.changes) this.auditar(quien, "reabrir", "cierre", ciaId, { mes, nota });
    return r.changes > 0;
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
    const x = this.correr(`INSERT INTO asientos (clave, origen, corrida_id, mes, compania_id, compania, fecha, diario_id, diario, referencia, motivo, aviso, lineas, total, propuso, creado_en, reversa)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, a.clave ?? null, a.origen || "manual", a.corridaId ?? null, a.mes ?? null, a.companiaId, a.compania ?? null, a.fecha,
      a.diarioId ?? null, a.diario ?? null, a.referencia ?? null, a.motivo ?? null, a.aviso ?? null, JSON.stringify(a.lineas), this.#total(a.lineas), quien, ahora, a.reversa ?? null);
    const id = Number(x.lastInsertRowid);
    this.auditar(quien, "proponer", "asiento", id, { compania: a.compania, referencia: a.referencia, total: this.#total(a.lineas) });
    return this.asiento(id);
  }
  // Lo que deja Cierre: uno abierto por clave. Si ya hay uno propuesto se actualiza (mes y montos
  // nuevos); si alguien lo rechazó para ese mismo mes no se repite; los propuestos que ya no salen
  // (la cuenta quedó liquidada) pasan a obsoletos.
  // reemplazarAnteriores: para lo que se recalcula entero cada mes (diferencial cambiario): al
  // proponer el de un mes, los de meses anteriores sin aplicar (aun aprobados) quedan obsoletos,
  // porque el nuevo ya incluye ese movimiento.
  sincronizarAsientos(corridaId, sugeridos, { origen = "cierre", reemplazarAnteriores = false } = {}) {
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
          this.correr(`UPDATE asientos SET corrida_id=?, mes=?, fecha=?, reversa=?, referencia=?, motivo=?, aviso=?, lineas=?, total=?, actualizado_en=?${diarioEditado ? "" : ", diario_id=?, diario=?"} WHERE id=?`,
            corridaId, a.mes, a.fecha, a.reversa ?? null, a.referencia, a.motivo, a.aviso ?? null, JSON.stringify(lineas), this.#total(lineas), ahora,
            ...(diarioEditado ? [] : [a.diarioId ?? null, a.diario ?? null]), abierto.id);
          actualizados++;
          continue;
        }
        if (this.uno("SELECT id FROM asientos WHERE clave=? AND mes=? AND estado IN ('rechazada','aplicada')", a.clave, a.mes)) continue;
        this.correr(`INSERT INTO asientos (clave, origen, corrida_id, mes, compania_id, compania, fecha, diario_id, diario, referencia, motivo, aviso, lineas, total, propuso, creado_en, reversa)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, a.clave, origen, corridaId, a.mes, a.companiaId, a.compania, a.fecha, a.diarioId ?? null, a.diario ?? null,
          a.referencia, a.motivo, a.aviso ?? null, JSON.stringify(a.lineas), this.#total(a.lineas), `agente:${origen}`, ahora, a.reversa ?? null);
        nuevos++;
      }
      for (const v of this.todos("SELECT id, clave, compania_id, mes, estado FROM asientos WHERE origen=? AND estado IN ('propuesta','aprobada')", origen)) {
        const reemplazado = reemplazarAnteriores && sugeridos.some(a => a.companiaId === v.compania_id && a.mes > (v.mes || ""));
        if ((v.estado === "propuesta" && !vistas.has(v.clave)) || reemplazado) { this.correr("UPDATE asientos SET estado='obsoleta', actualizado_en=? WHERE id=?", ahora, v.id); obsoletos++; }
      }
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
  // Los borradores sin enviar de un tipo (p. ej. todos los recordatorios de cobro) quedan obsoletos.
  obsoletarCorreos(prefijoFrente) {
    return this.correr("UPDATE correos SET estado='obsoleto' WHERE frente LIKE ? AND estado IN ('borrador','aprobado')", `${prefijoFrente}%`).changes;
  }
  registrarCorreos(corridaId, piezas) {
    const ahora = this.#ahora();
    const ids = [];
    this.transaccion(() => {
      // Un borrador nuevo para el mismo receptor y frente deja obsoleto al anterior no enviado.
      const obs = this.db.prepare("UPDATE correos SET estado='obsoleto' WHERE para=? AND frente=? AND estado IN ('borrador','aprobado')");
      const ins = this.db.prepare("INSERT INTO correos (corrida_id, frente, para, asunto, html, casos, companias, creado_en, responder_a) VALUES (?,?,?,?,?,?,?,?,?)");
      for (const p of piezas) {
        obs.run(p.para, p.frente);
        const r = ins.run(corridaId, p.frente, p.para, p.asunto, p.html, p.casos ?? null, JSON.stringify(p.companias || []), ahora, p.responderA ?? null);
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
