// Seguridad del servicio: lo remoto sin token no entra; con token, escribir en Odoo desde afuera
// pide sesión personal; límite de intentos; JSON y mismo origen en los POST; cabeceras.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BaseDeDatos } from "../src/servicio/db.js";
import { crearApi } from "../src/servicio/api.js";
import { avisosDeArranque, Limitador } from "../src/servicio/seguridad.js";

const TOKEN = "un-token-largo-y-al-azar-de-prueba-123456";
async function levantar(cfg) {
  const raiz = mkdtempSync(join(tmpdir(), "seg-"));
  mkdirSync(join(raiz, "data")); mkdirSync(join(raiz, "ui", "app"), { recursive: true });
  writeFileSync(join(raiz, "ui", "app", "index.html"), "<!doctype html><title>x</title>");
  const db = new BaseDeDatos(":memory:");
  const corridas = { enCurso: null, cfg, crearCliente: () => { throw new Error("sin Odoo en esta prueba"); } };
  const srv = crearApi({ db, corridas, cfg, raiz, raizProyecto: raiz, log: () => {} });
  await new Promise(ok => srv.listen(0, "127.0.0.1", ok));
  return { db, srv, url: `http://127.0.0.1:${srv.address().port}` };
}
const REMOTO = { "X-Forwarded-For": "200.1.2.3", "CF-Connecting-IP": "200.1.2.3" };
const json = { "Content-Type": "application/json" };

test("Sin SERVICIO_TOKEN: local entra, remoto (túnel) no", async () => {
  const { srv, url } = await levantar({});
  try {
    assert.equal((await fetch(url + "/api/auditoria")).status, 200);
    const r = await fetch(url + "/api/auditoria", { headers: REMOTO });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /SERVICIO_TOKEN/);
    assert.equal((await fetch(url + "/", { headers: REMOTO })).status, 403, "ni la página");
  } finally { srv.close(); }
});

test("Con token: remoto necesita token; escribir en Odoo desde afuera pide sesión personal", async () => {
  const { db, srv, url } = await levantar({ SERVICIO_TOKEN: TOKEN, PERMITIR_ESCRITURA_ASIENTOS: "si" });
  try {
    assert.equal((await fetch(url + "/api/auditoria", { headers: REMOTO })).status, 401);
    const conToken = { ...REMOTO, ...json, Authorization: `Bearer ${TOKEN}` };
    assert.equal((await fetch(url + "/api/auditoria", { headers: conToken })).status, 200);
    // aplicar un asiento desde afuera solo con el token: no
    let r = await fetch(url + "/api/asientos/1/aplicar", { method: "POST", headers: conToken, body: "{}" });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /enlace personal/);
    assert.ok(db.auditoria(10).some(a => a.accion === "rechazado"), "queda en la auditoría");
    // con sesión de un contable: pasa el control (y responde que no existe el asiento)
    const u = db.crearUsuario({ correo: "victor@ejemplo.cr", nombre: "Victor", rol: "contable" });
    const id = "sesion-de-prueba";
    db.crearSesion(createHash("sha256").update(id).digest("hex"), u.id);
    r = await fetch(url + "/api/asientos/1/aplicar", { method: "POST", headers: { ...REMOTO, ...json, Cookie: `sesion_iasima=${id}` }, body: "{}" });
    assert.equal(r.status, 404);
    // localmente (en la PC del servicio) el token alcanza
    r = await fetch(url + "/api/asientos/1/aplicar", { method: "POST", headers: { ...json, Authorization: `Bearer ${TOKEN}` }, body: "{}" });
    assert.equal(r.status, 404);
  } finally { srv.close(); }
});

test("Intentos, JSON, origen y cabeceras", async () => {
  const { srv, url } = await levantar({ SERVICIO_TOKEN: TOKEN });
  try {
    for (let i = 0; i < 10; i++) assert.equal((await fetch(url + "/api/entrar", { method: "POST", headers: { ...REMOTO, ...json }, body: JSON.stringify({ token: "malo" + i }) })).status, 401);
    const bloqueado = await fetch(url + "/api/entrar", { method: "POST", headers: { ...REMOTO, ...json }, body: JSON.stringify({ token: TOKEN }) });
    assert.equal(bloqueado.status, 429, "ni con el token correcto mientras dure el bloqueo");
    assert.equal((await fetch(url + "/api/entrar", { method: "POST", headers: json, body: JSON.stringify({ token: TOKEN }) })).status, 200, "otra IP (esta PC) no está bloqueada");

    const formulario = await fetch(url + "/api/salir", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${TOKEN}` }, body: "a=1" });
    assert.equal(formulario.status, 415);
    const ajeno = await fetch(url + "/api/salir", { method: "POST", headers: { ...json, Origin: "https://malo.example", Cookie: "oficina_iasima=x" }, body: "{}" });
    assert.equal(ajeno.status, 403);

    const r = await fetch(url + "/");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const entrar = await fetch(url + "/api/entrar", { method: "POST", headers: json, body: JSON.stringify({ token: TOKEN }) });
    assert.match(entrar.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  } finally { srv.close(); }
});

test("Avisos al arrancar y limitador", () => {
  assert.match(avisosDeArranque({}).join(), /SERVICIO_TOKEN/);
  assert.match(avisosDeArranque({ SERVICIO_TOKEN: "corto" }).join(), /menos de 24/);
  assert.match(avisosDeArranque({ SERVICIO_TOKEN: TOKEN, ODOO_USER: "admin", PERMITIR_ESCRITURA_ASIENTOS: "si" }).join(), /usuario admin/);
  assert.deepEqual(avisosDeArranque({ SERVICIO_TOKEN: TOKEN, ODOO_USER: "oficina@iasima.cr", PERMITIR_ESCRITURA_ASIENTOS: "si" }), []);
  const l = new Limitador({ maximo: 2, ventanaMs: 1000 });
  l.fallo("a", 0); l.fallo("a", 10);
  assert.equal(l.bloqueado("a", 20), true);
  assert.equal(l.bloqueado("a", 2000), false, "la ventana vence");
});
