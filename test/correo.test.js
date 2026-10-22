import { test } from "node:test";
import assert from "node:assert/strict";
import { receptores, remitenteVisible, unificarDocumentos, causasDominantes, fechaOdoo, horasEntre,
         DOMINIO_HACIENDA, REMITENTE_AUTOMATICO } from "../src/lib/correo.js";

test("receptores() limpia comillas, ángulos, mayúsculas y duplicados", () => {
  assert.deepEqual(receptores('"alea@x.com" <Alea@X.com>'), ["alea@x.com"]);
  assert.deepEqual(receptores("a@x.com, b@y.com; a@x.com"), ["a@x.com", "b@y.com"]);
  assert.deepEqual(receptores("sin arroba"), []);
  assert.deepEqual(receptores(null), []);
});

test("remitenteVisible() separa nombre, dirección y dominio", () => {
  assert.deepEqual(remitenteVisible('"Colina Hermanos" <facturas@colina.com>'),
    { nombre: "Colina Hermanos", direccion: "facturas@colina.com", dominio: "colina.com" });
  assert.deepEqual(remitenteVisible("ventas@vega.cr"),
    { nombre: null, direccion: "ventas@vega.cr", dominio: "vega.cr" });
  assert.equal(remitenteVisible("").dominio, null);
});

test("Hacienda y remitentes automáticos se reconocen", () => {
  assert.ok(DOMINIO_HACIENDA.test("comprobantes.hacienda.go.cr"));
  assert.ok(!DOMINIO_HACIENDA.test("hacienda.go.cr.evil.com"));
  assert.ok(REMITENTE_AUTOMATICO.test("Facturación Electrónica"));
  assert.ok(REMITENTE_AUTOMATICO.test("no-reply"));
  assert.ok(!REMITENTE_AUTOMATICO.test("Colina Hermanos"));
});

test("unificarDocumentos() agrupa por clave y, sin clave, por estado+archivo+asunto", () => {
  const k = "5".repeat(50);
  const u = unificarDocumentos([
    { clave: k, estado: "isticket", fecha: "2026-03-01" },
    { clave: k, estado: "isticket", fecha: "2026-03-05" },
    { clave: null, estado: "rejected", archivo: "a.xml", asunto: "x", fecha: "2026-02-01" },
    { clave: null, estado: "rejected", archivo: "a.xml", asunto: "x", fecha: "2026-02-02" },
    { clave: null, estado: "error", archivo: "a.xml", asunto: "x", fecha: "2026-02-02" }
  ]);
  assert.equal(u.length, 3);
  assert.equal(u[0].veces, 2);
  assert.equal(u[0].fecha, "2026-03-05", "se queda con la fecha más reciente");
  assert.equal(u[1].veces, 2);
  assert.equal(u[2].veces, 1);
});

test("causasDominantes() normaliza fechas y números largos", () => {
  const c = causasDominantes([
    { estado: "error", error: "periodo fiscal 2025-11-01 cerrado" },
    { estado: "error", error: "periodo fiscal 2025-12-01 cerrado" },
    { estado: "error", error: "proveedor 3101555555 no existe" },
    { estado: "process", error: "" }
  ], { descripcionEstado: { process: "En cola" } });
  assert.equal(c[0].causa, "periodo fiscal «fecha» cerrado");
  assert.equal(c[0].correos, 2);
  assert.equal(c[1].causa, "proveedor «número» no existe");
  assert.equal(c[2].causa, "En cola");
});

test("fechaOdoo() interpreta el datetime de Odoo como UTC", () => {
  const d = fechaOdoo("2026-03-11 14:00:00");
  assert.equal(d.toISOString(), "2026-03-11T14:00:00.000Z");
  assert.equal(horasEntre(d, new Date("2026-03-12T14:00:00Z")), 24);
  assert.equal(fechaOdoo(null), null);
});
