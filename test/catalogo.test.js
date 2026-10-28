import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Catalogo, norm, canon } from "../src/catalogo.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..");

test("norm() quita acentos, prefijos [CEIBA] y el carácter de reemplazo", () => {
  assert.equal(norm("[CEIBA] Servicio Eléctrico"), "SERVICIO ELECTRICO");
  assert.equal(norm("Tornillos 3/8\""), "TORNILLOS 3 8");
  assert.equal(norm("El�ctrico"), "EL CTRICO");
  assert.equal(norm(null), "");
});

test("canon() normaliza códigos de cuenta", () => {
  assert.equal(canon("5.04.02.02"), "5.04.002.002");
  assert.equal(canon("5.04.002.002.000.000"), "5.04.002.002");
  assert.equal(canon("5.04.999"), "5.04.999");
  assert.equal(canon(""), "");
});

test("resolver(): regla humana > cliente exacto > global exacto > aproximado", () => {
  const cat = new Catalogo(join(AQUI, "simulado", "catalogo-cuentas.json"), join(RAIZ, "data", "reglas.json"));
  assert.equal(cat.nReglas, 1);

  // regla humana manda aunque el histórico diga Costo de ventas
  const r = cat.resolver("Ceiba", "TRB-TRIBUTO BOMBEROS");
  assert.equal(r.fuente, "regla-humana");
  assert.equal(r.cuenta, "Electricidad");
  assert.equal(r.codigo, "5.04.002.002");

  assert.equal(cat.resolver("Ceiba", "Servicio Eléctrico").fuente, "cliente-exacto");
  assert.equal(cat.resolver("Otra Cía", "Servicio Eléctrico").fuente, "global-exacto");

  const ap = cat.resolver("Ceiba", "SERVICIO DE AGUA POTABLE");   // 3 de 4 palabras = 0.75
  assert.equal(ap.fuente, "cliente-aproximado");
  assert.equal(ap.confianza, 0.75);
  assert.equal(ap.parecidoA, "SERVICIO DE AGUA");
  assert.equal(cat.resolver("Ceiba", "SERVICIO ELECTRICO MARZO"), null, "2 de 3 = 0.67 no alcanza el umbral de 0.7");

  assert.equal(cat.resolver("Ceiba", "ALGO QUE NO EXISTE"), null);
  assert.equal(cat.resolver("Ceiba", ""), null);
});
