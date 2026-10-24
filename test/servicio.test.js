// El servicio de punta a punta: base de datos en memoria, Odoo simulado, API por HTTP real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseDeDatos } from "../src/servicio/db.js";
import { Corridas } from "../src/servicio/corridas.js";
import { Programador } from "../src/servicio/programador.js";
import { crearApi } from "../src/servicio/api.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..");

// Una raíz temporal con lo mínimo: reglas, catálogo de prueba, instancia simulada, plantilla de la oficina.
function raizTemporal() {
  const r = mkdtempSync(join(tmpdir(), "servicio-"));
  mkdirSync(join(r, "data")); mkdirSync(join(r, "test", "simulado"), { recursive: true }); mkdirSync(join(r, "ui"));
  copyFileSync(join(RAIZ, "data", "reglas.json"), join(r, "data", "reglas.json"));
  copyFileSync(join(RAIZ, "data", "roster.json"), join(r, "data", "roster.json"));
  copyFileSync(join(AQUI, "simulado", "catalogo-cuentas.json"), join(r, "data", "catalogo-cuentas.json"));
  copyFileSync(join(AQUI, "simulado", "instancia.json"), join(r, "test", "simulado", "instancia.json"));
  return r;
}
const cfg = { ODOO_SIMULADO: "test/simulado/instancia.json", ALERTA_REFERENCIA: "ultimo-correo", PERMITIR_ESCRITURA: "si" };

function armar(extraCfg = {}) {
  const raiz = raizTemporal();
  const db = new BaseDeDatos(":memory:");
  const c = { ...cfg, ...extraCfg };
  const corridas = new Corridas({ db, cfg: c, raiz });
  return { raiz, db, corridas, cfg: c };
}

test("corridas: Recepción deja casos; la segunda corrida no pisa lo resuelto y cierra lo que ya no aparece", async () => {
  const { db, corridas } = armar();
  const r1 = await corridas.correr("recepcion", [], { quienPide: "test" });
  assert.equal(r1.resumen.nuevos, 12);
  assert.equal(db.corrida(r1.corridaId).estado, "ok");
  assert.equal(db.casos().length, 12);
  const afuera = db.casos({ frente: "afuera" });
  assert.equal(afuera.length, 7);
  const c = afuera[0];
  assert.ok(db.resolverCaso(c.id, "memo", "ya se pidió la factura"));
  assert.ok(!db.resolverCaso(c.id, "memo"), "resolver dos veces no cuenta");

  const r2 = await corridas.correr("recepcion", []);
  assert.deepEqual(r2.resumen, { nuevos: 0, actualizados: 12, cerrados: 0 });
  assert.equal(db.casos({ seguimiento: "resuelto" }).length, 1, "lo resuelto sigue resuelto");

  // si un caso deja de aparecer en Odoo, se cierra solo; si vuelve, se reabre
  const casoViejo = db.casos()[0];
  db.correr("UPDATE casos SET llave='fantasma|x' WHERE id=?", casoViejo.id);
  const r3 = await corridas.correr("recepcion", []);
  assert.equal(r3.resumen.cerrados, 1);
  assert.equal(r3.resumen.nuevos, 1);
  assert.equal(db.casos({ seguimiento: "cerrado" }).length, 1);
  assert.equal(db.resumenCasos().porReceptor[0].receptor, "contabilidad@puuk.cr");
});

test("corridas: Comunicación deja borradores con HTML; un borrador nuevo deja obsoleto al anterior", async () => {
  const { db, corridas } = armar();
  await corridas.correr("recepcion", []);
  const r = await corridas.correr("comunicacion", []);
  assert.equal(r.resumen.correos, 5);
  const b = db.correos({ estado: "borrador" });
  assert.equal(b.length, 5);
  assert.match(db.correo(b[0].id).html, /<!doctype html>/i);
  await corridas.correr("comunicacion", []);
  assert.equal(db.correos({ estado: "borrador" }).length, 5);
  assert.equal(db.correos({ estado: "obsoleto" }).length, 5);
});

test("cola de aprobaciones: solo lo aprobado se aplica; lo rechazado y lo pendiente no se tocan", async () => {
  const { db, corridas } = armar();
  const r = await corridas.correr("cuentas", ["--empresa=144"]);
  assert.equal(r.resumen.nuevas, 2);
  const [p1, p2] = db.propuestas({ estado: "propuesta" });
  assert.ok(db.decidirPropuesta(p1.id, "aprobada", "memo"));
  assert.ok(db.decidirPropuesta(p2.id, "rechazada", "memo", "esa cuenta es otra cosa"));
  assert.ok(!db.decidirPropuesta(p1.id, "rechazada", "memo"), "una decisión tomada no se cambia por aquí");

  const a = await corridas.aplicarAprobadas(144, { quienPide: "memo" });
  assert.equal(a.aplicadas, 1);
  assert.equal(a.fallos.length, 0);
  assert.equal(db.propuesta(p1.id).estado, "aplicada");
  assert.equal(db.propuesta(p2.id).estado, "rechazada");
  // en Odoo (simulado) solo cambió la línea aprobada
  const corrida = db.corrida(a.corridaId);
  assert.equal(corrida.agente, "cuentas");
  assert.equal(corrida.modo, "escritura");
  assert.equal(corrida.resultado.aplicadas.length, 1);
  assert.equal(corrida.resultado.aplicadas[0].facturaId, p1.factura_id);
  const acciones = db.auditoria().map(x => x.accion);
  assert.ok(acciones.includes("aprobar") && acciones.includes("rechazar") && acciones.includes("aplicar"));

  // sin PERMITIR_ESCRITURA el servicio se niega aunque haya aprobadas
  const otro = armar({ PERMITIR_ESCRITURA: "" });
  await otro.corridas.correr("cuentas", ["--empresa=144"]);
  const [q] = otro.db.propuestas();
  otro.db.decidirPropuesta(q.id, "aprobada", "memo");
  await assert.rejects(() => otro.corridas.aplicarAprobadas(144), /PERMITIR_ESCRITURA/);
});

test("correos: enviar aprobados sin SMTP marca fallo y no revienta", async () => {
  const { db, corridas } = armar();
  await corridas.correr("recepcion", []);
  await corridas.correr("comunicacion", []);
  const [c] = db.correos({ estado: "borrador" });
  db.decidirCorreo(c.id, "aprobado", "memo");
  const r = await corridas.enviarAprobados({ prueba: true });
  assert.equal(r.enviados.length, 0);
  assert.equal(r.fallos.length, 1);
  assert.match(r.fallos[0].motivo, /sin destinatario|SMTP/);
  assert.equal(db.correo(c.id).estado, "fallo");
});

test("programador: dispara una vez al día a la hora dicha y no repite tras reiniciar", async () => {
  // El reloj falso usa la fecha de HOY (la base guarda la hora real de cada corrida) y mueve solo la hora.
  const hoy = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
  const diaSemana = String(new Date().getDay());
  const { db, corridas, cfg: c } = armar({ CORRIDA_DIARIA: "07:00", CONCILIACION_SEMANAL: diaSemana });
  let reloj = hoy(6, 59);
  const prog = new Programador({ corridas, db, cfg: c, reloj: () => reloj });
  assert.deepEqual(await prog.tick(), []);
  reloj = hoy(7, 0);
  assert.deepEqual(await prog.tick(), ["recepcion", "comunicacion", "conciliacion"]);
  reloj = hoy(9, 30);
  assert.deepEqual(await prog.tick(), [], "ya corrió hoy");
  const prog2 = new Programador({ corridas, db, cfg: c, reloj: () => reloj });
  assert.deepEqual(await prog2.tick(), [], "un servicio reiniciado lee la base y tampoco repite");
  assert.match(prog.describir(), /07:00/);
  assert.match(new Programador({ corridas, db, cfg: {} }).describir(), /sin corridas programadas/);
});

test("API: estado, correr, casos, propuestas, correos, token", async () => {
  const { raiz, db, corridas, cfg: c } = armar({ SERVICIO_TOKEN: "secreto" });
  writeFileSync(join(raiz, "ui", "app.html"), ""); mkdirSync(join(raiz, "ui", "app"), { recursive: true });
  writeFileSync(join(raiz, "ui", "app", "index.html"), "<!doctype html><title>app</title>");
  const api = crearApi({ db, corridas, programador: null, cfg: c, raiz });
  await new Promise(ok => api.listen(0, ok));
  const base = `http://127.0.0.1:${api.address().port}`;
  const get = (p, token = "secreto") => fetch(base + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then(r => r.json());
  const post = (p, cuerpo, token = "secreto") => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Quien": "memo", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(cuerpo || {}) });

  try {
    // sin token no se lee nada; con /api/entrar queda una cookie que sí sirve
    const cerrado = await fetch(base + "/api/estado");
    assert.equal(cerrado.status, 401);
    assert.equal((await cerrado.json()).entrar, true);
    const mal = await post("/api/entrar", { token: "otro" }, null);
    assert.equal(mal.status, 401);
    const entrar = await post("/api/entrar", { token: "secreto" }, null);
    assert.equal(entrar.status, 200);
    const galleta = entrar.headers.get("set-cookie");
    assert.match(galleta, /^oficina_iasima=[0-9a-f]{64}; Path=\/; HttpOnly/);
    assert.ok(!galleta.includes("secreto"), "la cookie no lleva el token en claro");
    const conCookie = await fetch(base + "/api/estado", { headers: { Cookie: galleta.split(";")[0] } });
    assert.equal(conCookie.status, 200);
    const sinOficina = await fetch(base + "/oficina", { redirect: "manual" });
    assert.equal(sinOficina.status, 302, "la oficina sin token manda a la app para entrar");

    const e0 = await get("/api/estado");
    assert.equal(e0.ultimas.recepcion, null);
    assert.equal(e0.escrituraPermitida, true);

    const sinToken = await post("/api/corridas/recepcion", {}, null);
    assert.equal(sinToken.status, 401);

    const r1 = await (await post("/api/corridas/recepcion")).json();
    assert.equal(r1.resumen.nuevos, 12);
    const casos = await get("/api/casos?receptor=contabilidad%40puuk.cr&frente=adentro");
    assert.equal(casos.length, 5);
    assert.deepEqual(await (await post(`/api/casos/${casos[0].id}/resolver`, { nota: "ok" })).json(), { ok: true });
    assert.equal((await get("/api/casos?seguimiento=resuelto")).length, 1);

    const noAplicar = await post("/api/corridas/cuentas", { empresa: 144, aplicar: true });
    assert.equal(noAplicar.status, 200, "la API ignora 'aplicar': solo propone");
    const props = await get("/api/propuestas");
    assert.equal(props.length, 2);
    assert.equal(db.corridas({ agente: "cuentas" })[0].modo, "solo lectura (propuesta)");
    assert.deepEqual(await (await post(`/api/propuestas/${props[0].id}/aprobar`)).json(), { ok: true });
    const ap = await (await post("/api/propuestas/aplicar", { compania: 144 })).json();
    assert.equal(ap.aplicadas, 1);
    assert.equal((await get("/api/propuestas?estado=aplicada")).length, 1);

    await post("/api/corridas/comunicacion");
    const correos = await get("/api/correos");
    assert.equal(correos.length, 5);
    assert.equal(correos[0].html, undefined, "la lista no trae el HTML");
    assert.match((await get(`/api/correos/${correos[0].id}`)).html, /doctype/i);

    const e1 = await get("/api/estado");
    assert.equal(e1.pendientes.propuestas, 1);
    assert.equal(e1.casos.porFrente.length >= 2, true);
    const aud = await get("/api/auditoria");
    assert.equal(aud[0].quien, "memo");

    const html = await fetch(base + "/").then(r => r.text());
    assert.match(html, /<title>app<\/title>/);
    assert.equal((await fetch(base + "/../package.json")).status, 404);
    assert.equal((await fetch(base + "/api/nada")).status, 401, "sin token ni siquiera se sabe qué rutas existen");
    assert.equal((await fetch(base + "/api/nada", { headers: { Authorization: "Bearer secreto" } })).status, 404);
  } finally {
    api.close();
  }
});
