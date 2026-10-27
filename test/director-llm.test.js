// El Director por modelo de lenguaje, con la API de Claude simulada: el bucle de herramientas,
// que no exista ninguna herramienta de escritura, y la caída al Director de palabras sin clave.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { BaseDeDatos } from "../src/servicio/db.js";
import { Corridas } from "../src/servicio/corridas.js";
import { DirectorLLM } from "../src/servicio/director-llm.js";
import { crearApi } from "../src/servicio/api.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..");

function raizTemporal() {
  const r = mkdtempSync(join(tmpdir(), "director-"));
  mkdirSync(join(r, "data")); mkdirSync(join(r, "test", "simulado"), { recursive: true }); mkdirSync(join(r, "ui", "app"), { recursive: true });
  for (const f of ["reglas.json", "roster.json"]) copyFileSync(join(RAIZ, "data", f), join(r, "data", f));
  copyFileSync(join(AQUI, "simulado", "catalogo-cuentas.json"), join(r, "data", "catalogo-cuentas.json"));
  copyFileSync(join(AQUI, "simulado", "instancia.json"), join(r, "test", "simulado", "instancia.json"));
  writeFileSync(join(r, "data", "companias.json"), JSON.stringify([{ id: 144, name: "Puuk" }, { id: 126, name: "International Animal Rescue" }, { id: 82, name: "Aurora" }]));
  writeFileSync(join(r, "ui", "app", "index.html"), "<!doctype html>");
  return r;
}
const base = { ODOO_SIMULADO: "test/simulado/instancia.json", ALERTA_REFERENCIA: "ultimo-correo" };

// Una API de Claude de mentira: un guion de respuestas; registra lo que recibe.
function apiFalsa(guion) {
  const llamadas = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    llamadas.push(body);
    const paso = guion[Math.min(llamadas.length - 1, guion.length - 1)];
    const r = typeof paso === "function" ? paso(body) : paso;
    return { ok: true, status: 200, json: async () => r };
  };
  f.llamadas = llamadas;
  return f;
}
const textoFinal = t => ({ stop_reason: "end_turn", content: [{ type: "text", text: t }] });
const usar = (name, input, id = "tu_1") => ({ stop_reason: "tool_use", content: [{ type: "text", text: "Voy a consultar." }, { type: "tool_use", id, name, input }] });

function armar(extra = {}, fetchImpl) {
  const raiz = raizTemporal();
  const db = new BaseDeDatos(":memory:");
  const cfg = { ...base, ...extra };
  const corridas = new Corridas({ db, cfg, raiz });
  const director = new DirectorLLM({ db, corridas, cfg, raiz, fetchImpl });
  return { raiz, db, cfg, corridas, director };
}

test("ninguna herramienta escribe: nombres, y correr_agente nunca pasa --aplicar ni --enviar", async () => {
  const { director, corridas, db } = armar({ CLAUDE_API_KEY: "x", PERMITIR_ESCRITURA: "si" });
  const nombres = director.herramientas().map(h => h.name);
  for (const n of nombres) assert.ok(!/escrib|aplicar|enviar|write|unlink|create|post/i.test(n), n);
  assert.deepEqual(nombres.sort(), ["agrupar_odoo", "casos", "causas_errores", "companias", "consultas", "correos", "correr_agente", "estado", "hallazgos", "leer_odoo", "proponer_regla", "propuestas", "revisar_factura"]);

  await director.ejecutarHerramienta("correr_agente", { agente: "cuentas", empresa: 144 }, "memo");
  const c = db.corridas({ agente: "cuentas" })[0];
  assert.equal(c.modo, "solo lectura (propuesta)", "aunque PERMITIR_ESCRITURA=si, por el Director solo propone");
  const sin = await director.ejecutarHerramienta("correr_agente", { agente: "cuentas" }, "memo");
  assert.match(sin.error, /compañía/);
  assert.equal(corridas.enCurso, null);
});

test("leer_odoo y agrupar_odoo pasan por el candado de lectura del cliente", async () => {
  const { director } = armar({ CLAUDE_API_KEY: "x" });
  const g = await director.ejecutarHerramienta("agrupar_odoo", { modelo: "bdt.invoice.email", dominio: [], agrupar: ["state"] }, "memo");
  assert.equal(g.find(x => x.state === "done").__count, 7);
  const f = await director.ejecutarHerramienta("leer_odoo", { modelo: "res.company", dominio: [], campos: ["name"], limite: 500 }, "memo");
  assert.equal(f.length, 3);
  // el cliente que crea es de solo lectura: no hay forma de escribir desde aquí
  const odoo = director.corridas.crearCliente({ meta: { escribe: false } });
  await assert.rejects(() => odoo.escribir("res.company", "write", [[1], {}]), /BLOQUEADO/);
});

test("bucle de herramientas: el modelo pide estado, luego casos, y responde con cifras", async () => {
  const api = apiFalsa([
    usar("correr_agente", { agente: "recepcion" }, "a"),
    usar("casos", { frente: "afuera", receptor: "contabilidad@puuk.cr" }, "b"),
    b => {
      // el último mensaje del usuario trae los resultados de la herramienta
      const ult = b.messages[b.messages.length - 1];
      assert.equal(ult.role, "user");
      assert.equal(ult.content[0].type, "tool_result");
      assert.equal(ult.content[0].tool_use_id, "b");
      const casos = JSON.parse(ult.content[0].content);
      return textoFinal(`Hay ${casos.length} documentos por reclamar afuera para contabilidad@puuk.cr.`);
    }
  ]);
  const { director, db } = armar({ CLAUDE_API_KEY: "clave" }, api);
  const r = await director.responder("¿qué le reclamo a los proveedores de Puuk?", { quien: "memo" });
  assert.equal(r.modo, "llm");
  assert.match(r.respuesta, /4 documentos por reclamar afuera/);
  assert.deepEqual(r.pasos.map(p => p.herramienta), ["correr_agente", "casos"]);
  assert.equal(api.llamadas.length, 3);
  assert.equal(api.llamadas[0].tools.length, 13);
  assert.match(api.llamadas[0].system, /Director de la Oficina IASIMA/);
  assert.match(api.llamadas[0].system, /copia de pruebas congelada/);
  assert.equal(db.corridas({ agente: "recepcion" }).length, 1, "la herramienta corrió a Marta de verdad");
  // la conversación sigue con historial
  const api2 = apiFalsa([b => { assert.equal(b.messages.length, r.conversacion.length + 1); return textoFinal("Sigo con el contexto."); }]);
  const d2 = new DirectorLLM({ db, corridas: director.corridas, cfg: director.cfg, raiz: director.raiz, fetchImpl: api2 });
  const r2 = await d2.responder("¿y adentro?", { conversacion: r.conversacion, quien: "memo" });
  assert.equal(r2.respuesta, "Sigo con el contexto.");
});

test("límite de pasos: una última llamada sin herramientas responde con lo que hay; errores de herramienta no revientan", async () => {
  const pide = usar("leer_odoo", { modelo: "no.existe", dominio: [], campos: [] }, "z");   // siempre pide lo mismo
  const api = apiFalsa([pide, pide, pide, b => {
    assert.deepEqual(b.tool_choice, { type: "none" }, "el cierre no permite más herramientas");
    assert.equal(b.tools.length, 13, "pero las herramientas siguen declaradas: la conversación trae tool_use");
    assert.match(b.messages[b.messages.length - 1].content, /Se agotó el límite de 3/);
    return textoFinal("Con lo que tengo: nada; faltó leer el modelo.");
  }]);
  const { director } = armar({ CLAUDE_API_KEY: "clave", DIRECTOR_MAX_PASOS: "3" }, api);
  const r = await director.responder("algo", { quien: "memo" });
  assert.equal(r.respuesta, "Con lo que tengo: nada; faltó leer el modelo.");
  assert.equal(r.truncado, true);
  assert.equal(r.pasos.length, 3);
  assert.match(r.pasos[0].resumen, /error/);
  assert.equal(api.llamadas.length, 4);

  // si hasta el cierre insiste en herramientas (o falla), queda el mensaje de siempre
  const api2 = apiFalsa([pide]);
  const d2 = armar({ CLAUDE_API_KEY: "clave", DIRECTOR_MAX_PASOS: "2" }, api2).director;
  assert.match((await d2.responder("algo")).respuesta, /sin pasos/);
});

test("revisar_factura: una factura con el criterio de Cuentas, sin escribir", async () => {
  const { director, db } = armar({ CLAUDE_API_KEY: "x", PERMITIR_ESCRITURA: "si" });
  const r = await director.ejecutarHerramienta("revisar_factura", { factura: 901 }, "memo");
  assert.equal(r.factura.nombre, "FAC/2026/002");
  assert.equal(r.factura.compania, "Puuk");
  assert.equal(r.lineas.length, 2);
  const luz = r.lineas.find(l => l.articulo === "SERVICIO ELECTRICO");
  assert.equal(luz.esComodin, true);
  assert.equal(luz.decision, "proponer");
  assert.equal(luz.sugerida, "5.04.002.002 Electricidad");
  assert.match(luz.fuente, /historial/);
  assert.match(luz.veredicto, /propondría cambiarla a 5.04.002.002 Electricidad/);
  assert.ok(luz.pasos.some(p => /historial de esta compañía/.test(p)), "explica los pasos de la guía");
  const tornillos = r.lineas.find(l => /TORNILLOS/.test(l.articulo));
  assert.equal(tornillos.naturaleza, "Materiales y servicios de mantenimiento del local u oficina", "naturaleza por la palabra, con plural");
  assert.match(tornillos.veredicto, /consulta/, "Mantenimiento de local no existe en el plan simulado de Puuk");
  assert.equal(db.propuestas({ estado: "todas" }).length, 0, "no registra propuestas: solo cuenta lo que haría");

  // por número o proveedor; ambigua → lista
  const porNombre = await director.ejecutarHerramienta("revisar_factura", { nombre: "FAC/2026/001" }, "memo");
  assert.equal(porNombre.factura.id, 900);
  assert.match(porNombre.lineas.find(l => /AGUA/.test(l.articulo)).veredicto, /correcta/);
  const varias = await director.ejecutarHerramienta("revisar_factura", { proveedor: "Ferretería" }, "memo");
  assert.equal(varias.varias.length, 2);
  assert.match((await director.ejecutarHerramienta("revisar_factura", {}, "memo")).error, /Indique/);
  assert.match((await director.ejecutarHerramienta("revisar_factura", { factura: 1 }, "memo")).error, /No encontré/);
});

test("proponer_regla: valida la cuenta en el plan, no toca Odoo; al aprobar se guarda y Cuentas propone las líneas", async () => {
  const { director, db, corridas, cfg, raiz } = armar({ CLAUDE_API_KEY: "x" });
  // cuenta inexistente en el plan de Puuk
  const mala = await director.ejecutarHerramienta("proponer_regla", { compania: 144, codigo: "5.04.17.01", proveedor_id: 2, motivo: "x" }, "memo");
  assert.match(mala.error, /no existe/);
  assert.match((await director.ejecutarHerramienta("proponer_regla", { compania: 144, codigo: "5.01.001", motivo: "x" }, "memo")).error, /alcance/);
  // por proveedor: todo lo de Ferretería El Mar en Puuk va a Costo de ventas
  const r = await director.ejecutarHerramienta("proponer_regla", { compania: 144, codigo: "5.01.1", proveedor_id: 2, motivo: "Lo de ferretería es costo de venta", factura: 901 }, "memo");
  assert.equal(r.propuestas.length, 1);
  assert.match(r.propuestas[0].alcance, /Ferretería El Mar/);
  assert.equal(r.propuestas[0].cuenta, "5.01.001 Costo de ventas", "el código se normaliza al del plan");
  const fila = db.reglas()[0];
  assert.equal(fila.propuso, "director:memo");
  assert.equal(fila.ejemplo, "FAC/2026/002 (id 901)");
  assert.equal(db.auditoria().find(a => a.objeto === "regla").accion, "proponer");

  // aprobar por la API: se escribe en data/reglas.json del inquilino y corre Cuentas con --revisar-todo
  const srv = crearApi({ db, corridas, programador: null, director, cfg, raiz });
  await new Promise(ok => srv.listen(0, ok));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const j = await fetch(url + `/api/reglas/${fila.id}/aprobar`, { method: "POST", headers: { "Content-Type": "application/json", "X-Quien": "Victor" }, body: "{}" }).then(x => x.json());
    assert.equal(j.ok, true);
    assert.equal(j.propuestas, 2, "las dos líneas de la factura no pagada; la pagada va a revisión humana");
    const reglas = JSON.parse(readFileSync(join(raiz, "data", "reglas.json"), "utf8")).reglas;
    const nueva = reglas[reglas.length - 1];
    assert.deepEqual([nueva.proveedorId, nueva.codigo, nueva.alcance, nueva.decidio], [2, "5.01.001", "Puuk", "Victor"]);
    const props = db.propuestas({ estado: "propuesta", companiaId: 144 }).filter(p => p.factura_id === 901);   // la 900 trae su propia regla (bomberos)
    assert.ok(props.length === 2 && props.every(p => p.fuente === "regla-humana" && /^5\.01\.001/.test(p.cuenta_nueva)), JSON.stringify(props.map(p => [p.fuente, p.cuenta_nueva])));
    assert.equal(db.corridas({ agente: "cuentas" })[0].modo, "solo lectura (propuesta)");
    // dos veces no
    assert.equal((await fetch(url + `/api/reglas/${fila.id}/aprobar`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 409);
    const est = await fetch(url + "/api/estado").then(x => x.json());
    assert.equal(est.pendientes.reglas, 0);
  } finally { srv.close(); }
});

test("leer_odoo con compania: esa compañía va primera en el contexto (códigos de cuenta por compañía)", async () => {
  const { director, corridas } = armar({ CLAUDE_API_KEY: "x" });
  const vistos = [];
  const real = corridas.crearCliente.bind(corridas);
  corridas.crearCliente = o => { const c = real(o); const leer = c.leer.bind(c); c.leer = (m, met, a, kw) => { vistos.push(kw?.context?.allowed_company_ids); return leer(m, met, a, kw); }; return c; };
  await director.ejecutarHerramienta("leer_odoo", { modelo: "account.account", dominio: [], campos: ["code"], compania: 82 }, "memo");
  assert.deepEqual(vistos[0], [82, 144, 126]);
  await director.ejecutarHerramienta("leer_odoo", { modelo: "account.account", dominio: [], campos: ["code"] }, "memo");
  assert.deepEqual(vistos[1], [144, 126, 82]);
});

test("sin CLAUDE_API_KEY cae al Director de palabras", async () => {
  const { director } = armar({});
  assert.equal(director.disponible, false);
  const r = await director.responder("revisá las cuentas de Puuk");
  assert.equal(r.modo, "palabras");
  assert.match(r.respuesta, /CUENTAS para Puuk/);
  assert.equal(r.pasos.length, 0);
});

test("API: la conversación sigue sola entre visitas, es por persona, se cierra con nueva y se retoma", async () => {
  const api = apiFalsa([usar("estado", {}, "e"), textoFinal("Sin corrida todavía."), textoFinal("Segunda respuesta."), textoFinal("Tercera."), textoFinal("Cuarta."), textoFinal("Quinta.")]);
  const { db, corridas, cfg, raiz, director } = armar({ CLAUDE_API_KEY: "clave" }, api);
  const srv = crearApi({ db, corridas, programador: null, director, cfg, raiz });
  await new Promise(ok => srv.listen(0, ok));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, cuerpo, quien = "memo") => fetch(url + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Quien": quien }, body: JSON.stringify(cuerpo) }).then(r => r.json());
  const get = (p, quien = "memo") => fetch(url + p, { headers: { "X-Quien": quien } });
  try {
    const r1 = await post("/api/director", { mensaje: "¿cómo está el buzón?" });
    assert.equal(r1.respuesta, "Sin corrida todavía.");
    assert.deepEqual(r1.pasos.map(p => p.herramienta), ["estado"]);
    // sin id (como al volver mañana): sigue la misma conversación
    const r2 = await post("/api/director", { mensaje: "¿y?" });
    assert.equal(r2.conversacion, r1.conversacion);
    assert.equal(api.llamadas[2].messages.length, 5, "el modelo recibió el historial: user, assistant(tool), user(result), assistant, user");
    assert.match(api.llamadas[2].system, /Tenés memoria/);
    // la conversación abierta de memo, con su resumen para pintar
    const actual = await get("/api/director/actual").then(r => r.json());
    assert.equal(actual.id, r1.conversacion);
    assert.equal(actual.resumen.length, 2);
    assert.equal(actual.titulo, "¿cómo está el buzón?");
    // otra persona no la ve ni la continúa
    assert.equal((await get("/api/director/" + r1.conversacion, "victor")).status, 403);
    assert.deepEqual(await get("/api/director/actual", "victor").then(r => r.json()), { id: null, resumen: [] });
    const rv = await post("/api/director", { mensaje: "hola", conversacion: r1.conversacion }, "victor");
    assert.notEqual(rv.conversacion, r1.conversacion, "pedir la de otro abre una propia");
    // nueva: cierra la anterior y abre otra; la anterior queda en la lista y se puede retomar
    const r3 = await post("/api/director", { mensaje: "otra cosa", nueva: true });
    assert.notEqual(r3.conversacion, r1.conversacion);
    assert.equal(db.conversacion(r1.conversacion).abierta, 0);
    const info = await get("/api/director").then(r => r.json());
    assert.equal(info.modo, "llm");
    assert.equal(info.actual.id, r3.conversacion);
    assert.deepEqual(info.conversaciones.map(c => c.id).sort(), [r1.conversacion, r3.conversacion].sort(), "solo las de memo, de los últimos 30 días");
    assert.equal(info.conversaciones.find(c => c.id === r1.conversacion).turnos, 2);
    assert.match(api.llamadas[api.llamadas.length - 1].system, /Conversaciones anteriores con esta persona:\n- \[\d{4}-\d\d-\d\d\] P: ¿cómo está el buzón\? \/ R: Sin corrida todavía\./, "la nueva conversación recuerda la anterior");
    const re = await post("/api/director/" + r1.conversacion + "/reabrir", {}).then(j => j);
    assert.equal(re.id, r1.conversacion);
    assert.equal(db.conversacionActual("memo").id, r1.conversacion);
    assert.equal(db.conversacion(r3.conversacion).abierta, 0, "una sola abierta por persona");
    assert.equal((await post("/api/director/" + r1.conversacion + "/cerrar", {})).ok, true);
    assert.equal(db.conversacionActual("memo"), null);
    const aud = db.auditoria().filter(a => a.accion === "preguntar");
    assert.equal(aud.length, 4);
    const vacio = await fetch(url + "/api/director", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(vacio.status, 400);
  } finally { srv.close(); }
});

test("memoria: retención de 30 días, poda del historial y migración de bases viejas", () => {
  const { db, director } = armar({ CLAUDE_API_KEY: "x", DIRECTOR_TURNOS_COMPLETOS: "1", DIRECTOR_MAX_CONTEXTO: "100000" });
  // purga por fecha
  const viejo = db.guardarConversacion(null, { quien: "memo", modo: "llm", mensajes: [], turno: { pregunta: "vieja", respuesta: "r" } });
  db.correr("UPDATE conversaciones SET ultimo=? WHERE id=?", new Date(Date.now() - 31 * 86_400_000).toISOString(), viejo);
  const nuevo = db.guardarConversacion(null, { quien: "memo", modo: "llm", mensajes: [], turno: { pregunta: "nueva", respuesta: "r" } });
  assert.equal(db.conversaciones({ quien: "memo", dias: 30 }).length, 1);
  assert.equal(db.purgarConversaciones(30), 1);
  assert.equal(db.conversacion(viejo), null);
  assert.ok(db.conversacion(nuevo));

  // poda: los turnos viejos quedan como texto, sin herramientas; la estructura sigue válida
  const turno = (p, r) => [{ role: "user", content: p }, { role: "assistant", content: [{ type: "text", text: "Voy." }, { type: "tool_use", id: "t", name: "estado", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x".repeat(5000) }] }, { role: "assistant", content: [{ type: "text", text: r }] }];
  const hist = [...turno("uno", "r1"), ...turno("dos", "r2"), ...turno("tres", "r3")];
  const podado = director.podar(hist);
  assert.deepEqual(podado.slice(0, 4), [{ role: "user", content: "uno" }, { role: "assistant", content: [{ type: "text", text: "Voy.\nr1" }] }, { role: "user", content: "dos" }, { role: "assistant", content: [{ type: "text", text: "Voy.\nr2" }] }]);
  assert.equal(podado.length, 8, "el último turno va completo (4 mensajes)");
  assert.equal(podado[6].content[0].type, "tool_result");
  // tope de tamaño: suelta lo más viejo
  const d2 = armar({ CLAUDE_API_KEY: "x", DIRECTOR_TURNOS_COMPLETOS: "3", DIRECTOR_MAX_CONTEXTO: "6000" }).director;
  const p2 = d2.podar(hist);
  assert.ok(JSON.stringify(p2).length <= 6000);
  assert.equal(p2[0].role, "user");

  // una base creada con el esquema anterior (sin abierta/titulo) se migra sola
  const ruta = join(mkdtempSync(join(tmpdir(), "db-")), "vieja.db");
  const cruda = new DatabaseSync(ruta);
  cruda.exec("CREATE TABLE conversaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, quien TEXT NOT NULL, inicio TEXT NOT NULL, ultimo TEXT NOT NULL, modo TEXT, mensajes TEXT NOT NULL, resumen TEXT)");
  cruda.exec(`INSERT INTO conversaciones (quien, inicio, ultimo, mensajes, resumen) VALUES ('memo', '2026-10-01', '${new Date().toISOString()}', '[]', '[{"pregunta":"p","respuesta":"r"}]')`);
  cruda.close();
  const migrada = new BaseDeDatos(ruta);
  assert.ok(migrada.todos("PRAGMA table_info(conversaciones)").some(c => c.name === "abierta"));
  assert.equal(migrada.conversacionActual("memo").resumen.length, 1, "lo guardado antes sigue abierto y se retoma");
  migrada.cerrar();
});

test("corrección 2 del log: el Director nunca manda a editar a mano en Odoo; ante una decisión «de ahora en adelante» propone regla", () => {
  const { director } = armar({ CLAUDE_API_KEY: "x" });
  const s = director.sistema();
  assert.match(s, /Nunca le digas a la persona que lo cambie a mano en Odoo/);
  assert.match(s, /proponer_regla/);
  assert.match(s, /naturaleza/);
  assert.match(s, /Nunca propongas 7\.01\.01 ni 5\.04\.99\/5\.04\.999/);
});
