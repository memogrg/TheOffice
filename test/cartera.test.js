// Cartera (ítems 9 y 10): antigüedad por tramos, morosos, pagos próximos, notas sin aplicar y
// recordatorios de cobro que quedan como borradores en Correos (con respuesta al correo de la compañía).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OdooSimulado } from "../src/odoo-simulado.js";
import { BaseDeDatos } from "../src/servicio/db.js";
import { Corridas } from "../src/servicio/corridas.js";
import * as cartera from "../src/agents/cartera.js";
import { tramoDe } from "../src/agents/cartera.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const C1 = [1, "Puuk"], CRC = [3, "CRC"], USD = [2, "USD"];
function instancia() {
  let id = 0;
  const m = (tipo, partner, fecha, vence, saldo, extra = {}) => ({ id: ++id, company_id: C1, partner_id: partner, name: `${tipo}-${id}`, move_type: tipo, state: "posted", payment_state: "not_paid",
    invoice_date: fecha, invoice_date_due: vence, amount_residual_signed: tipo.startsWith("in_") ? -saldo : saldo, amount_residual: saldo, currency_id: CRC, ...extra });
  const A = [10, "Cliente A"], B = [11, "Cliente B"], P = [20, "Proveedor X"];
  return {
    "res.company": [{ id: 1, name: "Puuk", email: "contabilidad@puuk.cr", currency_id: CRC }],
    "res.partner": [{ id: 10, email: "pagos@clientea.cr" }, { id: 11, email: false }, { id: 20, email: "x@prov.cr" }],
    "account.move": [
      m("out_invoice", A, "2026-01-05", "2026-01-20", 500000),                 // 39 días
      m("out_invoice", A, "2025-08-01", "2025-08-31", 200000, { currency_id: USD, amount_residual: 400 }),   // 181 días, en dólares
      m("out_invoice", A, "2026-02-20", "2026-03-20", 100000),                 // por vencer
      m("out_invoice", B, "2026-01-30", "2026-02-10", 300000),                 // 18 días, sin correo
      m("out_invoice", B, "2026-03-05", "2026-03-20", 999999),                 // después del corte: no cuenta
      m("out_refund", A, "2026-02-01", "2026-02-01", 50000),                  // nota sin aplicar
      m("in_invoice", P, "2026-02-15", "2026-03-05", 80000),                   // vence en 5 días
      m("in_invoice", P, "2025-12-01", "2025-12-31", 120000),                  // vencida 59 días
      m("out_invoice", A, "2026-01-02", "2026-01-10", 700000, { payment_state: "paid" })
    ],
    "account.move.line": [{ id: 1, company_id: C1, date: "2026-02-28", parent_state: "posted" }]
  };
}

test("Tramos de antigüedad", () => {
  assert.deepEqual([-5, 0, 1, 30, 31, 90, 91, 180, 181].map(tramoDe), ["por-vencer", "por-vencer", "1-30", "1-30", "31-60", "61-90", "91-180", "91-180", "mas-180"]);
});

test("Cartera: antigüedad, morosos, sin correo, pagos próximos, notas sin aplicar y recordatorios", async () => {
  const r = await cartera.ejecutar({ odoo: new OdooSimulado(instancia()), cfg: { CARTERA_CORTE: "2026-02-28" }, log: () => {} });
  const c = r.companias[0];
  assert.deepEqual(c.cobrar, { "por-vencer": 100000, "1-30": 250000, "31-60": 500000, "61-90": 0, "91-180": 0, "mas-180": 200000 }, "la nota (−50 000, de hace 27 días) resta en su tramo");
  assert.equal(c.vencidoCobrar, 1000000);
  assert.deepEqual([c.pagar["por-vencer"], c.pagar["31-60"]], [80000, 120000]);
  assert.equal(r.morosos.length, 2);
  assert.equal(r.morosos[0].cliente, "Cliente A");
  assert.equal(r.sinCorreo[0].cliente, "Cliente B");
  assert.equal(r.recordatorios.length, 1);
  const rec = r.recordatorios[0];
  assert.equal(rec.para, "pagos@clientea.cr");
  assert.equal(rec.responderA, "contabilidad@puuk.cr");
  assert.match(rec.html, /de parte de <b>Puuk<\/b>/);
  assert.match(rec.html, /USD 400/, "la factura en dólares va en dólares");
  assert.equal(rec.documentos, 2, "solo las vencidas");
  assert.equal(r.pagosProximos[0].enDias, 5);
  assert.equal(r.notas.length, 1);
});

test("Los recordatorios quedan como borradores en Correos y la corrida siguiente reemplaza los no enviados", async () => {
  const raiz = mkdtempSync(join(tmpdir(), "cartera-"));
  writeFileSync(join(raiz, "sim.json"), JSON.stringify(instancia()));
  const db = new BaseDeDatos(":memory:");
  const corridas = new Corridas({ db, cfg: { ODOO_SIMULADO: "sim.json", CARTERA_CORTE: "2026-02-28" }, raiz, raizProyecto: RAIZ });
  const { resultado, resumen } = await corridas.correr("cartera");
  assert.deepEqual(resumen, { recordatorios: 1, obsoletos: 0 });
  assert.equal(resultado.recordatorios[0].html, undefined, "el HTML vive en Correos, no dos veces en la corrida");
  const [x] = db.correos({ estado: "borrador" });
  assert.equal(x.frente, "cobro:1");
  assert.equal(db.correo(x.id).responder_a, "contabilidad@puuk.cr");
  const otra = await corridas.correr("cartera");
  assert.deepEqual(otra.resumen, { recordatorios: 1, obsoletos: 1 });
  assert.equal(db.correos({ estado: "borrador" }).length, 1);
});
