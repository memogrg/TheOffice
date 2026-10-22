import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Director, DirectorCore } from "../src/director.js";

const require = createRequire(import.meta.url);
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const roster = JSON.parse(readFileSync(join(RAIZ, "data", "roster.json"), "utf8"));
const companias = [{ id: 144, name: "Puuk" }, { id: 126, name: "International Animal Rescue" }];

test("el núcleo se carga igual como CommonJS y en un entorno tipo navegador", () => {
  const core = require("../src/director-core.cjs");
  assert.equal(typeof core.decidir, "function");
  const win = {};
  new Function("window", readFileSync(join(RAIZ, "src", "director-core.cjs"), "utf8"))(win);
  assert.equal(typeof win.DirectorCore.decidir, "function");
  assert.deepEqual(
    win.DirectorCore.decidir("revisá las cuentas de Puuk", roster, companias).comando,
    core.decidir("revisá las cuentas de Puuk", roster, companias).comando);
});

test("enruta a Cuentas con la compañía y a Marta para el buzón", () => {
  const d = DirectorCore.decidir("revisá las cuentas de Puuk", roster, companias);
  assert.equal(d.accion, "ejecutar");
  assert.equal(d.agente.id, "cuentas");
  assert.deepEqual(d.args, ["--empresa=144"]);
  assert.match(d.mensaje, /primero propone/);

  const m = DirectorCore.decidir("cuántos tiquetes entraron al buzón hoy", roster, companias);
  assert.equal(m.agente.id, "recepcion");
});

test("pide la compañía cuando falta, avisa de puestos no construidos, y dice cuando no entiende", () => {
  assert.equal(DirectorCore.decidir("revisá las cuentas", roster, companias).accion, "falta-dato");
  assert.equal(DirectorCore.decidir("qué causa tienen los errores", roster, companias).accion, "no-construido");
  assert.equal(DirectorCore.decidir("hola", roster, companias).accion, "no-entiendo");
  assert.equal(DirectorCore.decidir("hola", null, companias).accion, "sin-roster");
});

test("la clase Director lee los archivos y delega", () => {
  const dir = new Director(join(RAIZ, "data", "roster.json"), join(RAIZ, "no-existe.json"));
  assert.equal(dir.companias.length, 0);
  assert.equal(dir.decidir("revisá las cuentas de Puuk").accion, "falta-dato", "sin compañías no puede resolver la empresa");
});
