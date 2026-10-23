// Varios inquilinos: configuración por prefijo de variable, raíces y bases separadas,
// enrutamiento por /t/<id> y por dominio, marca en el estado y en la oficina.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cargarInquilinos, resolverInquilino } from "../src/servicio/inquilinos.js";
import { BaseDeDatos } from "../src/servicio/db.js";
import { Corridas } from "../src/servicio/corridas.js";
import { crearApi } from "../src/servicio/api.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..");

function proyectoTemporal() {
  const r = mkdtempSync(join(tmpdir(), "inq-"));
  mkdirSync(join(r, "data")); mkdirSync(join(r, "ui", "app"), { recursive: true }); mkdirSync(join(r, "src")); mkdirSync(join(r, "test", "simulado"), { recursive: true });
  for (const f of ["roster.json", "reglas.json"]) copyFileSync(join(RAIZ, "data", f), join(r, "data", f));
  copyFileSync(join(RAIZ, "ui", "plantilla.html"), join(r, "ui", "plantilla.html"));
  copyFileSync(join(RAIZ, "src", "director-core.cjs"), join(r, "src", "director-core.cjs"));
  copyFileSync(join(AQUI, "simulado", "instancia.json"), join(r, "test", "simulado", "instancia.json"));
  writeFileSync(join(r, "ui", "app", "index.html"), "<!doctype html><title>app</title>");
  return r;
}

test("sin INQUILINOS hay uno solo con las variables globales y la raíz del proyecto", () => {
  const [u] = cargarInquilinos({ ODOO_URL: "https://x", SMTP_HOST: "s", OTRA: "no" }, "/p");
  assert.equal(u.id, "iasima");
  assert.equal(u.unico, true);
  assert.equal(u.raiz, "/p");
  assert.deepEqual(u.cfg, { ODOO_URL: "https://x", SMTP_HOST: "s" }, "solo pasan las variables de la app");
});

test("con INQUILINOS cada uno hereda lo global y pisa con su prefijo; se crea su raíz con roster y reglas", () => {
  const raiz = proyectoTemporal();
  const lista = cargarInquilinos({ INQUILINOS: "iasima, SIMA", SMTP_HOST: "global", ALERTA_PCT_MINIMO: "90",
    IASIMA_NOMBRE: "IASIMA", IASIMA_ODOO_URL: "https://iasima", IASIMA_COLOR: "#0B4A3F", IASIMA_DOMINIO: "IASIMA.oficina.cr",
    SIMA_NOMBRE: "SIMA Contadores", SIMA_ODOO_URL: "https://sima", SIMA_SMTP_HOST: "propio" }, raiz);
  assert.deepEqual(lista.map(i => i.id), ["iasima", "sima"]);
  const [ia, si] = lista;
  assert.equal(ia.cfg.ODOO_URL, "https://iasima");
  assert.equal(ia.cfg.SMTP_HOST, "global");
  assert.equal(ia.dominio, "iasima.oficina.cr");
  assert.equal(si.cfg.ODOO_URL, "https://sima");
  assert.equal(si.cfg.SMTP_HOST, "propio", "la variable con prefijo pisa a la global");
  assert.equal(si.cfg.ALERTA_PCT_MINIMO, "90");
  assert.equal(si.cfg.NOMBRE, undefined, "la marca no se mezcla con la configuración");
  assert.equal(ia.unico, false);
  assert.ok(existsSync(join(raiz, "inquilinos", "sima", "data", "roster.json")));
  assert.ok(existsSync(join(raiz, "inquilinos", "sima", "data", "reglas.json")));
});

test("resolverInquilino: prefijo, dominio, único, o nada", () => {
  const inqs = [{ id: "iasima", dominio: "iasima.oficina.cr" }, { id: "sima", dominio: null }];
  assert.deepEqual(resolverInquilino(inqs, { pathname: "/t/sima/api/estado" }), { inquilino: inqs[1], ruta: "/api/estado", prefijo: "/t/sima" });
  assert.deepEqual(resolverInquilino(inqs, { pathname: "/t/IASIMA" }), { inquilino: inqs[0], ruta: "/", prefijo: "/t/iasima" });
  assert.equal(resolverInquilino(inqs, { host: "iasima.oficina.cr:4180", pathname: "/api/estado" }).inquilino, inqs[0]);
  assert.equal(resolverInquilino(inqs, { host: "app.iasima.oficina.cr", pathname: "/" }).inquilino, inqs[0]);
  assert.equal(resolverInquilino(inqs, { host: "otro.cr", pathname: "/api/estado" }), null);
  assert.equal(resolverInquilino(inqs, { pathname: "/t/nadie/api/estado" }), null);
  assert.equal(resolverInquilino([inqs[1]], { host: "lo-que-sea", pathname: "/x" }).inquilino, inqs[1]);
});

test("API con dos inquilinos: bases aisladas, prefijo en el estado, selector en la raíz, oficina con marca", async () => {
  const raiz = proyectoTemporal();
  const inqs = cargarInquilinos({ INQUILINOS: "iasima,sima", ODOO_SIMULADO: "test/simulado/instancia.json", ALERTA_REFERENCIA: "ultimo-correo",
    IASIMA_NOMBRE: "IASIMA", IASIMA_COLOR: "#0B4A3F", SIMA_NOMBRE: "SIMA", SIMA_SERVICIO_TOKEN: "secreto-sima" }, raiz);
  const contextos = inqs.map(inq => {
    const db = new BaseDeDatos(":memory:");
    const corridas = new Corridas({ db, cfg: inq.cfg, raiz: inq.raiz, raizProyecto: raiz, marca: inq, prefijo: `/t/${inq.id}` });
    return { inquilino: inq, db, corridas, programador: null, director: null, cfg: inq.cfg, raiz: inq.raiz };
  });
  const srv = crearApi({ contextos, raizProyecto: raiz });
  await new Promise(ok => srv.listen(0, ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = p => fetch(base + p).then(r => r.json());
  const post = (p, token) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Quien": "memo", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: "{}" });
  try {
    const sel = await fetch(base + "/api/estado");
    assert.equal(sel.status, 404, "sin inquilino en la URL no hay estado");
    assert.deepEqual((await get("/api/inquilinos")).map(i => i.prefijo), ["/t/iasima", "/t/sima"]);
    assert.match(await fetch(base + "/").then(r => r.text()), /<title>app<\/title>/, "la raíz sirve la app (que muestra el selector)");

    assert.equal((await post("/t/iasima/api/corridas/recepcion")).status, 200);
    const ia = await get("/t/iasima/api/estado");
    assert.equal(ia.inquilino.nombre, "IASIMA");
    assert.equal(ia.prefijo, "/t/iasima");
    assert.equal(ia.inquilinos, 2);
    assert.equal(ia.casos.porFrente.length, 2);

    const si = await get("/t/sima/api/estado");
    assert.equal(si.inquilino.nombre, "SIMA");
    assert.deepEqual(si.casos.porFrente, [], "la base de SIMA no vio la corrida de IASIMA");
    assert.equal((await post("/t/sima/api/corridas/recepcion")).status, 401, "SIMA tiene su propio token");
    assert.equal((await post("/t/sima/api/corridas/recepcion", "secreto-sima")).status, 200);

    const of = await fetch(base + "/t/iasima/oficina").then(r => r.text());
    assert.match(of, /<title>Oficina virtual IASIMA<\/title>/);
    assert.match(of, /--seal:#0B4A3F/);
    assert.match(of, /"prefijo":"\/t\/iasima"/);
    assert.ok(existsSync(join(raiz, "inquilinos", "sima", "Oficina IASIMA.html")));
    assert.match(readFileSync(join(raiz, "inquilinos", "sima", "Oficina IASIMA.html"), "utf8"), /Oficina virtual SIMA/);
    assert.ok(existsSync(join(raiz, "inquilinos", "iasima", "data", "companias.json")));
    assert.ok(existsSync(join(raiz, "inquilinos", "iasima", "reportes")));
  } finally { srv.close(); }
});
