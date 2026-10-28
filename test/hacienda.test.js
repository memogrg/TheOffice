// Declaraciones de Hacienda (TRIBU-CR): paquete del IVA (150) por tarifa, 270 e informativo de renta,
// juez de reglas y de IA, ciclo preparada → cargada → aprobada → presentada, notificación.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OdooSimulado } from "../src/odoo-simulado.js";
import { BaseDeDatos } from "../src/servicio/db.js";
import { Corridas } from "../src/servicio/corridas.js";
import { crearApi } from "../src/servicio/api.js";
import * as agente from "../src/agents/hacienda.js";
import * as hacienda from "../src/servicio/hacienda.js";
import * as cierreMes from "../src/servicio/cierreMes.js";
import { clasificarImpuesto, paquete150, juezDeReglas, comparar } from "../src/lib/hacienda.js";
import { DirectorCore } from "../src/director.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const C1 = [1, "Ceiba"];
const T13V = [1, "IVA 13% ventas"], T13C = [2, "IVA 13% compras"], TEX = [3, "IVA con tarifa 10 - Exento"], TNA = [4, "IVA 13% no acreditable"], TRARO = [5, "Impuesto raro"];
function instancia() {
  let id = 0;
  const mv = (tipo, fecha, extra = {}) => ({ id: ++id, company_id: C1, move_type: tipo, state: "posted", date: fecha, invoice_date: fecha, partner_id: [10, "Proveedor Uno"], e_key: "5" + String(id).padStart(49, "0"), amount_untaxed: 0, reversed_entry_id: false, ...extra });
  const ln = (move, tax_ids, balance, extra = {}) => ({ id: 100 + id++, company_id: C1, move_id: [move.id, `M${move.id}`], move_type: move.move_type, date: move.date, parent_state: move.state, tax_ids, balance, tax_line_id: false, account_id: [700, "4-01 Ventas"], ...extra });
  const tl = (move, tax, balance) => ({ id: 100 + id++, company_id: C1, move_id: [move.id, `M${move.id}`], move_type: move.move_type, date: move.date, parent_state: move.state, tax_ids: [], balance, tax_line_id: tax, account_id: [210, "2-01 IVA por pagar"] });
  const v1 = mv("out_invoice", "2026-02-05"), v2 = mv("out_invoice", "2026-02-10"), nc = mv("out_refund", "2026-02-20", { reversed_entry_id: [v1.id, "x"] }), c1 = mv("in_invoice", "2026-02-12"), c2 = mv("in_invoice", "2026-02-15"), c3 = mv("in_invoice", "2026-02-18", { e_key: false, amount_untaxed: 50000 });
  const vEne = mv("out_invoice", "2026-01-10");
  const borr = mv("in_invoice", "2026-02-25", { state: "draft" });
  return {
    "res.company": [{ id: 1, name: "Ceiba", vat: "3101000001" }],
    "account.tax": [{ id: 1, name: "IVA 13% ventas", amount: 13, amount_type: "percent", type_tax_use: "sale", company_id: C1 }, { id: 2, name: "IVA 13% compras", amount: 13, amount_type: "percent", type_tax_use: "purchase", company_id: C1 },
      { id: 3, name: "IVA con tarifa 10 - Exento", amount: 0, amount_type: "percent", type_tax_use: "sale", company_id: C1 }, { id: 4, name: "IVA 13% no acreditable", amount: 13, amount_type: "percent", type_tax_use: "purchase", company_id: C1 },
      { id: 5, name: "Impuesto raro", amount: 7, amount_type: "percent", type_tax_use: "sale", company_id: C1 }],
    "account.account": [{ id: 700, name: "Ventas", account_type: "income" }, { id: 600, name: "Gastos generales", account_type: "expense" }, { id: 601, name: "Multas no deducibles", account_type: "expense" }, { id: 210, name: "IVA por pagar", account_type: "liability_current" }],
    "account.move": [v1, v2, nc, c1, c2, c3, vEne, borr],
    "account.move.line": [
      ln(v1, [1], -1000000), tl(v1, T13V, -130000),                 // venta 13%
      ln(v2, [3], -200000),                                           // venta exenta
      ln(nc, [1], 100000), tl(nc, T13V, 13000),                       // nota de crédito: resta
      ln(c1, [2], 400000, { account_id: [600, "Gastos"] }), tl(c1, T13C, 52000),   // compra 13%
      ln(c2, [4], 100000, { account_id: [600, "Gastos"] }), tl(c2, TNA, 13000),    // no acreditable
      ln(vEne, [1], -100000), tl(vEne, T13V, -13000),                 // enero (mes anterior)
      { id: 900, company_id: C1, move_id: [c1.id, "x"], move_type: "in_invoice", date: "2026-02-12", parent_state: "posted", tax_ids: [], balance: 30000, tax_line_id: false, account_id: [601, "Multas no deducibles"] }
    ],
    "res.partner": [{ id: 10, name: "Proveedor Uno", vat: "3102000002" }]
  };
}

test("Tarifas: por el código del nombre o por el porcentaje; el no acreditable se marca", () => {
  assert.equal(clasificarImpuesto({ name: "IVA con tarifa 08 - 13%", amount: 13, type_tax_use: "sale" }).tarifa, "13");
  assert.deepEqual([clasificarImpuesto({ name: "IVA 4%", amount: 4 }).tarifa, clasificarImpuesto({ name: "IVA con tarifa 11", amount: 0 }).derecho, clasificarImpuesto({ name: "Exento", amount: 0 }).tarifa], ["4", false, "ex"]);
  assert.equal(clasificarImpuesto({ name: "IVA 13% no acreditable", amount: 13, type_tax_use: "purchase" }).noAcreditable, true);
  assert.equal(clasificarImpuesto({ name: "Impuesto raro", amount: 7 }), null);
});

test("Paquete 150: ventas y compras por tarifa, notas que restan, proporción, saldo anterior y determinación", () => {
  const p = paquete150({ compania: "Ceiba", companiaId: 1, periodo: "2026-02", agregados: [
    { impuestoId: 1, nombre: "13% v", tarifa: "13", tasa: 13, derecho: true, uso: "sale", base: 900000, impuesto: 117000, documentos: 2 },
    { impuestoId: 3, nombre: "exento", tarifa: "ex", tasa: 0, derecho: false, uso: "sale", base: 100000, impuesto: 0, documentos: 1 },
    { impuestoId: 2, nombre: "13% c", tarifa: "13", tasa: 13, derecho: true, uso: "purchase", base: 400000, impuesto: 52000, documentos: 1 },
    { impuestoId: 4, nombre: "13% na", tarifa: "13", tasa: 13, derecho: true, noAcreditable: true, uso: "purchase", base: 100000, impuesto: 13000, documentos: 1 }
  ], extra: { saldoAFavorAnterior: 2000 } });
  const c = Object.fromEntries(p.casillas.map(x => [x.id, x.monto]));
  assert.equal(c.v13, 900000); assert.equal(c.vex, 100000); assert.equal(c.vtot, 1000000); assert.equal(c.dtot, 117000);
  assert.equal(c.s13, 52000, "el no acreditable no entra al crédito"); assert.equal(c.sna, 13000);
  assert.equal(c.prop, 90, "10% de ventas sin derecho → proporción 90%");
  assert.equal(c.cf, 46800); assert.equal(c.saf, 2000); assert.equal(c.pagar, 68200); assert.equal(c.favor, 0);
  const j = juezDeReglas(p);
  assert.equal(j.semaforo, "amarillo", "la proporción calculada y no confirmada pide revisión");
  assert.ok(j.observaciones.some(o => o.regla === "prorrata"));
  const p2 = paquete150({ compania: "Ceiba", companiaId: 1, periodo: "2026-02", agregados: p.fuentes || [], extra: { proporcion: 100 } });
  assert.equal(juezDeReglas(p2).semaforo, "verde");
  assert.deepEqual(comparar(p, { v13: 900000, dtot: 117001, pagar: 70000 }).map(d => d.casilla), ["pagar"], "1 colón de diferencia se tolera; 1 800 no");
});

test("El agente arma las tres declaraciones desde Odoo y el juez marca lo que hay que mirar", async () => {
  const odoo = new OdooSimulado(instancia());
  const r = await agente.ejecutar({ odoo, cfg: { HACIENDA_MES: "2026-02" }, log: () => {} });
  assert.equal(odoo.escrituras, 0);
  const p150 = r.paquetes.find(p => p.impuesto === "150"), p270 = r.paquetes.find(p => p.impuesto === "270"), p102 = r.paquetes.find(p => p.impuesto === "102");
  const c = Object.fromEntries(p150.casillas.map(x => [x.id, x.monto]));
  assert.equal(c.v13, 900000, "1 000 000 menos la nota de 100 000"); assert.equal(c.d13, 117000); assert.equal(c.vex, 200000);
  assert.equal(c.c13, 500000); assert.equal(c.s13, 52000); assert.equal(c.sna, 13000);
  assert.equal(p150.extra.borradores, 1);
  assert.deepEqual(p150.extra.anterior, { debito: 13000, credito: 0 });
  assert.equal(p150.juez.semaforo, "amarillo");
  assert.ok(p150.juez.observaciones.some(o => o.regla === "borradores"));
  assert.ok(p150.juez.observaciones.some(o => o.regla === "variacion"), "117 000 contra 13 000 es más de 50 %");
  assert.equal(p270.totales.total, 50000); assert.equal(p270.filas[0].cedula, "3102000002");
  const c102 = Object.fromEntries(p102.casillas.map(x => [x.id, x.monto]));
  assert.equal(c102.ing, 1200000, "acumulado del año: incluye enero"); assert.equal(c102.nd, 30000, "la cuenta «no deducible» se separa"); assert.equal(c102.gas, 500000);
  assert.equal(p102.porValidar, true);
  assert.equal(r.totales.declaraciones150, 1);
});

function servicio(extraCfg = {}) {
  const raiz = mkdtempSync(join(tmpdir(), "hacienda-"));
  writeFileSync(join(raiz, "sim.json"), JSON.stringify(instancia()));
  const db = new BaseDeDatos(":memory:");
  const cfg = { ODOO_SIMULADO: "sim.json", HACIENDA_MES: "2026-02", ...extraCfg };
  return { raiz, db, cfg, corridas: new Corridas({ db, cfg, raiz, raizProyecto: RAIZ }) };
}

test("Ciclo: corrida → ajuste de proporción → carga del plugin con diferencias → aprobar → presentar; la corrida siguiente respeta lo decidido", async () => {
  const { db, corridas, cfg } = servicio();
  const { resumen, resultado } = await corridas.correr("hacienda");
  assert.deepEqual(resumen.declaraciones, { nuevas: 3, actualizadas: 0, desactualizadas: 0 });
  assert.equal(resultado.paquetes, undefined, "los paquetes viven en la tabla, no en la corrida");
  const d = db.declaraciones({ impuesto: "150" })[0];
  assert.equal(d.estado, "preparada");
  // la persona confirma la prorrata: 100 %
  const aj = hacienda.ajustar({ db, id: d.id, ajustes: { proporcion: "100" }, quien: "victor" });
  assert.equal(aj.paquete.totales.credito, 52000);
  assert.ok(!aj.juez.observaciones.some(o => o.regla === "prorrata"));
  // la corrida siguiente vuelve a armar con el ajuste guardado
  await corridas.correr("hacienda");
  const d2 = db.declaracion(d.id);
  assert.equal(d2.paquete.totales.proporcion, 100);
  assert.equal(d2.estado, "preparada");
  // el plugin carga: una casilla quedó distinta
  const carga = hacienda.registrarCarga({ db, id: d.id, cuerpo: { campos: { v13: 900000, dtot: 117000, pagar: 60000 }, prellenado: { v13: 950000 }, capturas: ["150-ceiba-2026-02.png"], borradorGuardado: true }, quien: "plugin" });
  assert.equal(carga.diferencias.length, 1);
  assert.equal(carga.difPrellenado.length, 1);
  assert.equal(carga.semaforo, "rojo", "una casilla distinta en el portal frena");
  assert.equal(db.declaracion(d.id).estado, "cargada");
  // corregida: segunda carga limpia
  const carga2 = hacienda.registrarCarga({ db, id: d.id, cuerpo: { campos: { v13: 900000, dtot: 117000, pagar: 65000 }, borradorGuardado: true }, quien: "plugin" });
  assert.equal(carga2.diferencias.length, 0);
  assert.notEqual(db.declaracion(d.id).juez.semaforo, "rojo");
  assert.ok(db.decidirDeclaracion(d.id, "aprobada", "victor", null));
  assert.ok(!db.presentarDeclaracion(999, { numero: "x" }, "victor"));
  assert.ok(db.presentarDeclaracion(d.id, { numero: "1502026000123" }, "victor"));
  assert.equal(db.declaracion(d.id).estado, "presentada");
  // la corrida siguiente no toca lo presentado, pero si las cifras cambian lo marca
  await corridas.correr("hacienda");
  assert.equal(db.declaracion(d.id).estado, "presentada");
  assert.equal(db.declaracion(d.id).desactualizada, 0);
  // cierre de mes
  const item = cierreMes.lista(db, { mes: "2026-02", companias: [{ id: 1, name: "Ceiba" }] }).companias[0].items.find(i => i.id === "hacienda");
  assert.equal(item.estado, "ok");
  // el mes siguiente arrastra el saldo a favor de una declaración aprobada
  db.correr("UPDATE declaraciones SET paquete=json_set(paquete,'$.totales.favor',5000) WHERE id=?", d.id);
  assert.deepEqual(db.declaracionAnterior(1, "150", "2026-03"), { periodo: "2026-02", favor: 5000 });
  // notificación: queda como borrador en Correos
  const n = hacienda.notificar({ db, periodo: "2026-02", para: "victor@contadores.example", quien: "memo" });
  assert.equal(n.declaraciones, 1);
  const [correo] = db.correos({ estado: "borrador" });
  assert.equal(correo.frente, "hacienda:2026-02");
  assert.match(db.correo(correo.id).html, /Ceiba/);
  assert.ok(db.declaracion(d.id).notificada_en);
});

test("El juez de IA no cambia cifras: agrega observaciones y solo puede empeorar el semáforo", async () => {
  const { db, corridas } = servicio({ CLAUDE_API_KEY: "sk-prueba" });
  await corridas.correr("hacienda");
  const d = db.declaraciones({ impuesto: "150" })[0];
  const fetchFalso = async (url, op) => {
    const cuerpo = JSON.parse(op.body);
    assert.equal(cuerpo.messages[0].role, "user");
    assert.ok(JSON.parse(cuerpo.messages[0].content).casillas.length > 5);
    return { ok: true, json: async () => ({ content: [{ type: "text", text: 'Aquí va: {"semaforo":"rojo","resumen":"Las compras son la mitad de las ventas sin IVA de servicios: raro.","observaciones":[{"nivel":"critico","texto":"Sin compras de servicios en un mes con ventas altas."}]}' }] }) };
  };
  const r = await hacienda.juezIA({ db, cfg: { CLAUDE_API_KEY: "sk-prueba" }, id: d.id, quien: "memo", fetchImpl: fetchFalso });
  assert.equal(r.juez.semaforo, "rojo");
  assert.ok(r.juez.observaciones.some(o => o.regla === "ia"));
  assert.equal(db.declaracion(d.id).estado, "revisada");
  assert.equal(db.declaracion(d.id).paquete.totales.pagar, d.paquete.totales.pagar, "las cifras no cambian");
  const sin = await hacienda.juezIA({ db, cfg: {}, id: d.id, quien: "memo" });
  assert.match(sin.error, /CLAUDE_API_KEY/);
});

test("API: pendientes para el plugin, aprobar en rojo exige nota, presentar solo aprobadas, rutas con sesión", async () => {
  const { db, corridas, cfg, raiz } = servicio({ SERVICIO_TOKEN: "secreto" });
  await corridas.correr("hacienda");
  const api = crearApi({ db, corridas, programador: null, cfg, raiz, raizProyecto: RAIZ });
  await new Promise(ok => api.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${api.address().port}`;
  const get = p => fetch(base + p, { headers: { Authorization: "Bearer secreto" } }).then(r => r.json());
  const post = (p, cuerpo) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secreto", "X-Quien": "memo" }, body: JSON.stringify(cuerpo) });
  try {
    const lista = await get("/api/hacienda");
    assert.equal(lista.periodo, "2026-02");
    assert.equal(lista.declaraciones.length, 3);
    const pend = await get("/api/hacienda/pendientes");
    assert.equal(pend.declaraciones.length, 1, "solo el 150 (amarillo, no rojo) está para cargar");
    assert.ok(pend.declaraciones[0].casillas.every(c => c.rastro === undefined));
    const id = pend.declaraciones[0].id;
    const det = await get(`/api/hacienda/${id}`);
    assert.ok(det.paquete.casillas.some(c => c.rastro && c.rastro.length));
    // rojo → no se aprueba sin nota
    const r1 = await post(`/api/hacienda/${id}/cargada`, { campos: { pagar: 1 }, borradorGuardado: true });
    assert.equal((await r1.json()).semaforo, "rojo");
    assert.equal((await post(`/api/hacienda/${id}/aprobar`, {})).status, 400);
    assert.equal((await post(`/api/hacienda/${id}/presentada`, { numero: "1" })).status, 409);
    assert.equal((await post(`/api/hacienda/${id}/aprobar`, { aunEnRojo: true, nota: "revisado a mano con Victor" })).status, 200);
    assert.equal((await post(`/api/hacienda/${id}/presentada`, { numero: "1502026000123" })).status, 200);
    assert.equal((await get(`/api/hacienda/${id}`)).estado, "presentada");
    const n = await post("/api/hacienda/notificar", { periodo: "2026-02", para: "victor@contadores.example" });
    assert.equal(n.status, 200);
    const { RUTAS_CON_SESION } = await import("../src/servicio/seguridad.js");
    assert.ok(RUTAS_CON_SESION.some(re => re.test("/api/hacienda/5/aprobar")) && RUTAS_CON_SESION.some(re => re.test("/api/hacienda/5/presentada")));
  } finally { api.close(); }
});

test("El Director lleva las preguntas de declaraciones al agente Hacienda", () => {
  const roster = JSON.parse(readFileSync(join(RAIZ, "data", "roster.json"), "utf8"));
  assert.equal(DirectorCore.decidir("prepará las declaraciones de IVA de febrero", roster, []).agente.id, "hacienda");
  assert.equal(DirectorCore.decidir("qué declaraciones están en rojo", roster, []).agente.id, "hacienda");
});

test("El servidor MCP del plugin habla con la Oficina: lista pendientes, registra la carga y la presentación", async () => {
  const { spawn } = await import("node:child_process");
  const { db, corridas, cfg, raiz } = servicio({ SERVICIO_TOKEN: "secreto" });
  await corridas.correr("hacienda");
  const api = crearApi({ db, corridas, programador: null, cfg, raiz, raizProyecto: RAIZ });
  await new Promise(ok => api.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${api.address().port}`;
  const hijo = spawn(process.execPath, [join(RAIZ, "plugin", "oficina-hacienda", "servidor", "index.js")], { env: { ...process.env, OFICINA_URL: url, OFICINA_TOKEN: "secreto", OFICINA_QUIEN: "plugin (prueba)" } });
  const respuestas = []; let buf = "";
  hijo.stdout.on("data", d => { buf += d; const partes = buf.split("\n"); buf = partes.pop(); for (const l of partes) if (l.trim()) respuestas.push(JSON.parse(l)); });
  const pedir = (id, method, params) => { hijo.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return new Promise(ok => { const t = setInterval(() => { const r = respuestas.find(x => x.id === id); if (r) { clearInterval(t); ok(r); } }, 20); }); };
  try {
    const ini = await pedir(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "prueba" } });
    assert.equal(ini.result.serverInfo.name, "oficina-hacienda");
    hijo.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const lista = await pedir(2, "tools/list", {});
    assert.deepEqual(lista.result.tools.map(t => t.name), ["declaraciones_pendientes", "declaracion", "registrar_carga", "registrar_presentacion", "estado_oficina"]);
    const pend = JSON.parse((await pedir(3, "tools/call", { name: "declaraciones_pendientes", arguments: {} })).result.content[0].text);
    assert.equal(pend.declaraciones.length, 1);
    const id = pend.declaraciones[0].id;
    const carga = JSON.parse((await pedir(4, "tools/call", { name: "registrar_carga", arguments: { id, campos: { pagar: pend.declaraciones[0].totales.pagar }, borradorGuardado: true, capturas: ["150-ceiba-2026-02.png"] } })).result.content[0].text);
    assert.equal(carga.estado, "cargada"); assert.equal(carga.diferencias.length, 0);
    const noAprobada = await pedir(5, "tools/call", { name: "registrar_presentacion", arguments: { id, numero: "1" } });
    assert.equal(noAprobada.result.isError, true, "sin aprobación no se registra presentación");
    db.decidirDeclaracion(id, "aprobada", "victor");
    const ok = JSON.parse((await pedir(6, "tools/call", { name: "registrar_presentacion", arguments: { id, numero: "1502026000123" } })).result.content[0].text);
    assert.equal(ok.ok, true);
    assert.equal(db.declaracion(id).estado, "presentada");
    assert.equal(db.auditoria(5).find(a => a.accion === "cargar").quien, "plugin (prueba)");
  } finally { hijo.kill(); api.close(); }
});
