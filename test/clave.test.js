import { test } from "node:test";
import assert from "node:assert/strict";
import { clave, tipoDeClave, cedulaEmisor, consecutivoDoc, fechaDeClave, descomponer, esClave, TIPO_DOC } from "../src/lib/clave.js";

// país 506 · 11/03/26 · cédula 3101123456 · sucursal 001 terminal 00001 tipo 04 número 0000000042 · situación 1 · seguridad 12345678
const K = "506" + "110326" + "003101123456" + "001" + "00001" + "04" + "0000000042" + "1" + "12345678";

test("la clave de prueba mide 50 dígitos", () => {
  assert.equal(K.length, 50);
  assert.ok(esClave(K));
});

test("clave() la encuentra en el nombre del archivo o en el asunto; partida no vale", () => {
  assert.equal(clave(`${K}.xml`), K);
  assert.equal(clave(null, `Factura clave ${K} adjunta`), K);
  assert.equal(clave(`FE-${K}_firmada.xml`), K);
  assert.equal(clave(`clave: ${K.slice(0, 25)}-${K.slice(25)}`), null, "un separador en medio la invalida a propósito");
  assert.equal(clave(`${K}1`), K, "con más de 50 seguidos toma los primeros 50 (comportamiento histórico, p. ej. clave+sufijo numérico)");
  assert.equal(clave("adjunto.xml", "sin clave"), null);
  assert.equal(clave("", undefined, null), null);
});

test("el tipo de documento vive en las posiciones 30-31", () => {
  assert.equal(tipoDeClave(K), "04");
  assert.equal(TIPO_DOC[tipoDeClave(K)], "Tiquete electrónico");
  assert.equal(tipoDeClave(K.slice(0, 29) + "01" + K.slice(31)), "01");
  assert.equal(tipoDeClave(null), null);
  assert.equal(tipoDeClave("123"), null);
});

test("cédula del emisor sin ceros a la izquierda, consecutivo de 20 y fecha ddmmaa", () => {
  assert.equal(cedulaEmisor(K), "3101123456");
  assert.equal(consecutivoDoc(K), "00100001040000000042");
  assert.equal(fechaDeClave(K), "2026-03-11");
});

test("descomponer() devuelve todas las partes", () => {
  const d = descomponer(K);
  assert.deepEqual(d, {
    clave: K, pais: "506", fecha: "2026-03-11", cedulaEmisor: "3101123456",
    consecutivo: "00100001040000000042", tipo: "04", tipoNombre: "Tiquete electrónico",
    situacion: "1", seguridad: "12345678"
  });
  assert.equal(descomponer("x"), null);
});
