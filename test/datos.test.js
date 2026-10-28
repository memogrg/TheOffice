// Calidad de datos de contactos: duplicados por cédula y por nombre, cédulas inválidas, sin cédula
// con documentos, clientes sin correo, correos inválidos, archivados con documentos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OdooSimulado } from "../src/odoo-simulado.js";
import * as datos from "../src/agents/datos.js";
import { cedulaInvalida, nombreNormal, correoValido } from "../src/agents/datos.js";
import { DirectorCore } from "../src/director.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");

test("Reglas: cédula por tipo, nombre normalizado y correo", () => {
  assert.equal(cedulaInvalida("3101123456", "02"), null);
  assert.match(cedulaInvalida("310112345", "02"), /9 dígitos/);
  assert.match(cedulaInvalida("1-0847-0964", "01"), /caracteres/);
  assert.equal(cedulaInvalida("155812345678", "03"), null);
  assert.equal(cedulaInvalida("AB123", "05"), null, "extranjero: no se valida el largo");
  assert.equal(nombreNormal("Distribuidora Pérez, S.A."), nombreNormal("DISTRIBUIDORA PEREZ SOCIEDAD ANONIMA"));
  assert.equal(correoValido("pagos@empresa.cr"), true);
  assert.equal(correoValido("pagos@empresa"), false);
});

test("Calidad de datos: lo que frena el buzón y lo que deja clientes sin factura ni recordatorio", async () => {
  const C1 = [1, "Ceiba"], C2 = [2, "Lirio"];
  const p = (id, name, vat, cia, extra = {}) => ({ id, name, vat, type_vat: vat && String(vat).replace(/\D/g, "").length === 9 ? "01" : "02", email: false, company_id: cia, active: true, parent_id: false, ...extra });
  const odoo = new OdooSimulado({
    "res.partner": [
      p(1, "Ferretería El Mar", "3101000001", C1), p(2, "FERRETERIA EL MAR S.A.", "3-101-000001", C1),   // misma cédula
      p(3, "Ferretería El Mar", "3101000001", C2),                                                         // otra compañía: no es duplicado
      p(4, "Distribuidora Pérez S.A.", "3101000002", C1, { email: "ventas@perez" }), p(5, "Distribuidora Perez", false, C1),   // mismo nombre, cédula distinta/vacía
      p(6, "Juan Mora", "10847096", C1, { type_vat: "01" }),                                               // física con 8 dígitos
      p(7, "Cliente Sin Correo", "3101000003", C1),
      p(8, "Viejo Proveedor", "3101000004", C1, { active: false })
    ],
    "account.move": [
      { id: 1, partner_id: [1, "Ferretería El Mar"], move_type: "in_invoice", state: "posted" }, { id: 2, partner_id: [1, "Ferretería El Mar"], move_type: "in_invoice", state: "posted" },
      { id: 3, partner_id: [2, "FERRETERIA"], move_type: "in_invoice", state: "posted" },
      { id: 4, partner_id: [5, "Distribuidora Perez"], move_type: "in_invoice", state: "posted" },
      { id: 5, partner_id: [7, "Cliente Sin Correo"], move_type: "out_invoice", state: "posted" },
      { id: 6, partner_id: [8, "Viejo Proveedor"], move_type: "in_invoice", state: "posted" }
    ]
  });
  const r = await datos.ejecutar({ odoo, cfg: {}, log: () => {} });
  assert.equal(odoo.escrituras, 0);
  assert.equal(r.duplicados.length, 1, "la misma cédula en otra compañía no es duplicado");
  assert.equal(r.duplicados[0].conservar, 1, "se conserva el que tiene más documentos");
  assert.equal(r.parecidos.length, 1);
  assert.equal(r.parecidos[0].compania, "Ceiba");
  assert.deepEqual(r.cedulas.map(c => c.nombre).sort(), ["FERRETERIA EL MAR S.A.", "Juan Mora"], "con guiones y con un dígito de menos");
  assert.deepEqual(r.sinCedula.map(s => [s.nombre, s.rol]), [["Distribuidora Perez", "proveedor"]]);
  assert.deepEqual(r.sinCorreo.map(s => s.nombre), ["Cliente Sin Correo"]);
  assert.deepEqual(r.correosMalos.map(s => s.nombre), ["Distribuidora Pérez S.A."]);
  assert.deepEqual(r.archivados.map(a => a.nombre), ["Viejo Proveedor"]);
  assert.match(r.alertas[0].texto, /supplier exists more than once/);
});

test("El Director lleva las preguntas de contactos al agente de calidad de datos", () => {
  const roster = JSON.parse(readFileSync(join(RAIZ, "data", "roster.json"), "utf8"));
  assert.equal(DirectorCore.decidir("qué proveedores están duplicados", roster, []).agente.id, "datos");
  assert.equal(DirectorCore.decidir("qué clientes no tienen correo, sin correo", roster, []).agente.id, "datos");
});
