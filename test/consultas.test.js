// Consultas al contador: Cuentas deja lo que no cierra solo; el contador lo resuelve con una regla
// (que pasa por aprobación) o lo descarta; al aprobar la regla la consulta se cierra sola.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseDeDatos } from "../src/servicio/db.js";
import { Corridas } from "../src/servicio/corridas.js";
import { crearApi } from "../src/servicio/api.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..");

function proyecto() {
  const r = mkdtempSync(join(tmpdir(), "consultas-"));
  mkdirSync(join(r, "data")); mkdirSync(join(r, "ui", "app"), { recursive: true }); mkdirSync(join(r, "src")); mkdirSync(join(r, "test", "simulado"), { recursive: true });
  for (const f of ["roster.json", "reglas.json"]) copyFileSync(join(RAIZ, "data", f), join(r, "data", f));
  copyFileSync(join(AQUI, "simulado", "catalogo-cuentas.json"), join(r, "data", "catalogo-cuentas.json"));
  copyFileSync(join(AQUI, "simulado", "instancia.json"), join(r, "test", "simulado", "instancia.json"));
  copyFileSync(join(RAIZ, "ui", "plantilla.html"), join(r, "ui", "plantilla.html"));
  copyFileSync(join(RAIZ, "src", "director-core.cjs"), join(r, "src", "director-core.cjs"));
  writeFileSync(join(r, "ui", "app", "index.html"), "<!doctype html>");
  return r;
}

test("Cuentas deja consultas; se resuelven con una regla aprobada o se descartan", async () => {
  const raiz = proyecto();
  const db = new BaseDeDatos(":memory:");
  const cfg = { ODOO_SIMULADO: "test/simulado/instancia.json" };
  const corridas = new Corridas({ db, cfg, raiz, raizProyecto: raiz });
  const srv = crearApi({ db, corridas, cfg, raiz, raizProyecto: raiz });
  await new Promise(ok => srv.listen(0, ok));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, cuerpo = {}) => fetch(url + p, { method: "POST", headers: { "Content-Type": "application/json", "X-Quien": "Victor" }, body: JSON.stringify(cuerpo) });
  try {
    await post("/api/corridas/cuentas", { empresa: 144 });
    let abiertas = await fetch(url + "/api/consultas").then(r => r.json());
    assert.equal(abiertas.length, 2, "tornillos (la cuenta de la naturaleza no está en el plan) y el eléctrico de la factura pagada");
    const tornillos = abiertas.find(c => /TORNILLOS/.test(c.articulo));
    assert.equal(tornillos.tipo, "plan");
    assert.equal(tornillos.proveedor, "Ferretería El Mar");
    assert.equal(tornillos.proveedor_id, 2);
    assert.ok(Array.isArray(tornillos.pasos) && tornillos.pasos.length);
    assert.equal((await fetch(url + "/api/estado").then(r => r.json())).pendientes.consultas, 2);
    // las propuestas guardan el porqué
    const prop = db.propuestas({ estado: "propuesta", companiaId: 144 });
    assert.ok(prop.length && prop.every(p => p.razon), "cada propuesta lleva su razón");

    // correr de nuevo no duplica
    await post("/api/corridas/cuentas", { empresa: 144 });
    assert.equal(db.consultas().length, 2);

    // resolver con una regla por artículo: queda propuesta, la consulta sigue abierta con nota
    const mala = await post(`/api/consultas/${tornillos.id}/regla`, { alcance: "articulo", codigo: "5.04.999" });
    assert.equal(mala.status, 400, "un comodín no puede ser destino");
    const r = await (await post(`/api/consultas/${tornillos.id}/regla`, { alcance: "articulo", codigo: "5.01.001", motivo: "Tornillería es insumo de venta" })).json();
    assert.equal(r.propuestas.length, 1);
    assert.match(db.consulta(tornillos.id).nota, /regla #\d+ propuesta por Victor/);
    assert.equal(db.consulta(tornillos.id).estado, "abierta");

    // al aprobar la regla Cuentas re-revisa la compañía: la línea pasa a propuesta y la consulta se cierra sola
    const ap = await (await post(`/api/reglas/${r.propuestas[0].id}/aprobar`)).json();
    assert.equal(ap.ok, true);
    assert.equal(db.consulta(tornillos.id).estado, "cerrada");
    assert.ok(db.propuestas({ estado: "propuesta", companiaId: 144 }).some(p => /TORNILLOS/.test(p.articulo) && p.fuente === "regla-humana"));

    // descartar la otra
    const otra = db.consultas()[0];
    assert.equal((await (await post(`/api/consultas/${otra.id}/descartar`, { nota: "pagada, se deja así" })).json()).ok, true);
    assert.equal(db.consultas().length, 0);
    // y no vuelve a abrirse en la siguiente corrida
    await post("/api/corridas/cuentas", { empresa: 144 });
    assert.equal(db.consultas().length, 0);
    assert.ok(db.auditoria().some(a => a.objeto === "consulta" && a.accion === "descartar" && a.quien === "Victor"));
  } finally { srv.close(); }
});
