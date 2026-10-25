// El Director por modelo de lenguaje, con la API de Claude simulada: el bucle de herramientas,
// que no exista ninguna herramienta de escritura, y la caída al Director de palabras sin clave.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
  assert.deepEqual(nombres.sort(), ["agrupar_odoo", "casos", "causas_errores", "companias", "correos", "correr_agente", "estado", "leer_odoo", "propuestas", "revisar_factura"]);

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
  assert.equal(api.llamadas[0].tools.length, 10);
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
    assert.equal(b.tools.length, 10, "pero las herramientas siguen declaradas: la conversación trae tool_use");
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
  assert.equal(luz.esCajonDeSastre, true);
  assert.equal(luz.sugerencia.codigo, "5.04.002.002");
  assert.equal(luz.sugerencia.fuente, "cliente-exacto");
  assert.equal(luz.sugerencia.existeEnPlan, true);
  assert.match(luz.veredicto, /propondría cambiarla a 5.04.002.002 Electricidad/);
  const tornillos = r.lineas.find(l => /TORNILLOS/.test(l.articulo));
  assert.equal(tornillos.sugerencia, null);
  assert.match(tornillos.veredicto, /sin referencia/);
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

test("sin CLAUDE_API_KEY cae al Director de palabras", async () => {
  const { director } = armar({});
  assert.equal(director.disponible, false);
  const r = await director.responder("revisá las cuentas de Puuk");
  assert.equal(r.modo, "palabras");
  assert.match(r.respuesta, /CUENTAS para Puuk/);
  assert.equal(r.pasos.length, 0);
});

test("API: POST /api/director guarda la conversación y la continúa", async () => {
  const api = apiFalsa([usar("estado", {}, "e"), textoFinal("Sin corrida todavía."), textoFinal("Segunda respuesta.")]);
  const { db, corridas, cfg, raiz, director } = armar({ CLAUDE_API_KEY: "clave" }, api);
  const srv = crearApi({ db, corridas, programador: null, director, cfg, raiz });
  await new Promise(ok => srv.listen(0, ok));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, cuerpo) => fetch(url + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Quien": "memo" }, body: JSON.stringify(cuerpo) }).then(r => r.json());
  try {
    const r1 = await post("/api/director", { mensaje: "¿cómo está el buzón?" });
    assert.equal(r1.respuesta, "Sin corrida todavía.");
    assert.deepEqual(r1.pasos.map(p => p.herramienta), ["estado"]);
    const r2 = await post("/api/director", { mensaje: "¿y?", conversacion: r1.conversacion });
    assert.equal(r2.conversacion, r1.conversacion);
    const c = await fetch(url + "/api/director/" + r1.conversacion).then(r => r.json());
    assert.equal(c.resumen.length, 2);
    assert.equal(c.quien, "memo");
    const info = await fetch(url + "/api/director").then(r => r.json());
    assert.equal(info.modo, "llm");
    assert.equal(info.conversaciones.length, 1);
    const aud = db.auditoria().filter(a => a.accion === "preguntar");
    assert.equal(aud.length, 2);
    const vacio = await fetch(url + "/api/director", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(vacio.status, 400);
  } finally { srv.close(); }
});
