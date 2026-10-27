// Diferencial cambiario (fase 3B, ítem 17): revaluación a fin de mes con la tasa de Odoo, asiento
// con reversión el día 1, cola que reemplaza el mes anterior sin aplicar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OdooSimulado } from "../src/odoo-simulado.js";
import { BaseDeDatos } from "../src/servicio/db.js";
import * as cambiario from "../src/agents/cambiario.js";
import * as asientos from "../src/servicio/asientos.js";

const silencio = () => {};
const C1 = [1, "Uno"], C2 = [2, "Dos"], USD = [2, "USD"], CRC = [3, "CRC"];

function instancia() {
  let id = 0;
  const l = (cia, cuenta, nombre, fecha, balance, me, extra = {}) => ({ id: ++id, company_id: cia, account_id: [cuenta, nombre], date: fecha, parent_state: "posted",
    balance, amount_currency: me, currency_id: USD, ...extra });
  return {
    "res.company": [
      { id: 1, name: "Uno", currency_id: CRC, income_currency_exchange_account_id: [90, "Ganancia cambiaria"], expense_currency_exchange_account_id: [91, "Pérdida cambiaria"], currency_exchange_journal_id: [7, "Diferencias de cambio"] },
      { id: 2, name: "Dos", currency_id: CRC, income_currency_exchange_account_id: false, expense_currency_exchange_account_id: false, currency_exchange_journal_id: false }
    ],
    "res.currency": [{ id: 2, name: "USD" }, { id: 3, name: "CRC" }],
    // tasa = dólares por colón: 1/500 a fin de febrero, 1/490 a fin de enero
    "res.currency.rate": [{ id: 1, currency_id: USD, company_id: false, name: "2026-01-31", rate: 1 / 490 }, { id: 2, currency_id: USD, company_id: false, name: "2026-02-27", rate: 1 / 500 },
      { id: 3, currency_id: USD, company_id: false, name: "2026-03-05", rate: 1 / 520 }],
    "account.account": [
      { id: 10, name: "Banco BAC dólares", account_type: "asset_cash", currency_id: USD },
      { id: 20, name: "Clientes", account_type: "asset_receivable", currency_id: false },
      { id: 30, name: "Proveedores", account_type: "liability_payable", currency_id: false },
      { id: 40, name: "Préstamo en dólares", account_type: "liability_non_current", currency_id: false },
      { id: 90, name: "Ganancia cambiaria", account_type: "income_other", currency_id: false },
      { id: 91, name: "Pérdida cambiaria", account_type: "expense", currency_id: false }
    ],
    "account.journal": [{ id: 7, name: "Diferencias de cambio", type: "general", company_id: C1 }],
    "account.move": [],
    "account.move.line": [
      l(C1, 10, "Banco BAC dólares", "2026-01-10", 480000, 1000),                         // $1.000 a 480 → a 500 = +20.000
      l(C1, 20, "Clientes", "2026-02-10", 960000, 2000, { partner_id: [5, "Cliente A"], reconciled: false, amount_residual: 960000, amount_residual_currency: 2000 }),   // +40.000
      l(C1, 20, "Clientes", "2026-01-05", 490000, 1000, { partner_id: [6, "Cliente B"], reconciled: true, amount_residual: 0, amount_residual_currency: 0 }),            // pagada: no
      l(C1, 30, "Proveedores", "2026-02-15", -505000, -1000, { partner_id: [8, "Proveedor C"], reconciled: false, amount_residual: -505000, amount_residual_currency: -1000 }), // −500.000 vs −505.000 = +5.000
      l(C1, 30, "Proveedores", "2026-03-02", -520000, -1000, { partner_id: [8, "Proveedor C"], reconciled: false, amount_residual: -520000, amount_residual_currency: -1000 }), // marzo: no
      l(C1, 40, "Préstamo en dólares", "2026-01-15", -4800000, -10000),                    // sin moneda propia: se informa
      l(C2, 10, "Banco BAC dólares", "2026-02-01", 5200000, 10000)                         // $10.000 a 520 → a 500 = −200.000
    ],
    "taerp.fiscal.period": [{ id: 1, company_id: C1, name: "2026", date_from: "2026-01-01", date_to: "2026-12-31", state: "open" }]
  };
}

test("Cambiario: revalúa bancos en dólares y abiertos de clientes y proveedores; informa lo que no tiene moneda", async () => {
  const datos = instancia();
  const r = await cambiario.ejecutar({ odoo: new OdooSimulado(datos), cfg: { CAMBIARIO_MES: "2026-02" }, log: silencio });
  assert.equal(r.fecha, "2026-02-28");
  assert.equal(r.reversa, "2026-03-01");
  const uno = r.companias.find(c => c.companiaId === 1);
  assert.deepEqual([uno.ganancia, uno.perdida, uno.neto], [65000, 0, 65000]);
  assert.equal(uno.monedas.USD.tipoCambio, 500);
  const a1 = r.asientosSugeridos.find(a => a.companiaId === 1);
  assert.equal(a1.diarioId, 7);
  assert.deepEqual(a1.lineas.map(l => [l.cuentaId, l.partnerId ?? null, l.debito, l.credito, l.monedaId ?? null]),
    [[10, null, 20000, 0, 2], [20, 5, 40000, 0, null], [30, 8, 5000, 0, null], [90, null, 0, 65000, null]], "el banco con moneda propia lleva su moneda; clientes y proveedores, su tercero");
  const a2 = r.asientosSugeridos.find(a => a.companiaId === 2);
  assert.deepEqual(a2.lineas.map(l => [l.cuentaId, l.debito, l.credito]), [[10, 0, 200000], [null, 200000, 0]], "sin cuentas configuradas: contrapartida por definir");
  assert.equal(r.totales.sinConfiguracion, 1);
  assert.equal(r.sinMoneda.length, 1);
  assert.equal(r.sinMoneda[0].cuenta, "Préstamo en dólares");
});

test("Cambiario: el asiento se crea con su reversión el día 1 y el del mes siguiente reemplaza al anterior sin aplicar", async () => {
  const datos = instancia(), db = new BaseDeDatos(":memory:");
  const ene = await cambiario.ejecutar({ odoo: new OdooSimulado(datos), cfg: { CAMBIARIO_MES: "2026-01" }, log: silencio });
  db.sincronizarAsientos(1, ene.asientosSugeridos, { origen: "cambiario", reemplazarAnteriores: true });
  const eneUno = db.asientos().find(a => a.clave === "cambiario|1|2026-01");
  db.decidirAsiento(eneUno.id, "aprobada", "victor");
  const feb = await cambiario.ejecutar({ odoo: new OdooSimulado(datos), cfg: { CAMBIARIO_MES: "2026-02" }, log: silencio });
  db.sincronizarAsientos(2, feb.asientosSugeridos, { origen: "cambiario", reemplazarAnteriores: true });
  assert.equal(db.asiento(eneUno.id).estado, "obsoleta", "enero aprobado sin aplicar: lo reemplaza febrero");

  const febUno = db.asientos().find(a => a.clave === "cambiario|1|2026-02");
  assert.equal(febUno.reversa, "2026-03-01");
  db.decidirAsiento(febUno.id, "aprobada", "victor");
  const corridas = { cfg: { PERMITIR_ESCRITURA_ASIENTOS: "si", ASIENTOS_PUBLICAR: "si" }, crearCliente: ag => new OdooSimulado(datos, { permitirEscritura: ag.meta.escribe === true }) };
  const x = await asientos.aplicar({ corridas, db, id: febUno.id, quien: "victor" });
  assert.equal(x.ok, true, JSON.stringify(x));
  assert.ok(x.reversion);
  const [m, rev] = datos["account.move"].slice(-2);
  assert.equal(m.date, "2026-02-28");
  assert.equal(rev.date, "2026-03-01");
  assert.match(rev.ref, /^Reversión de/);
  const lineasDe = id => datos["account.move.line"].filter(l => l.move_id?.[0] === id);
  assert.equal(lineasDe(m.id).find(l => l.account_id[0] === 10).currency_id[0] ?? lineasDe(m.id).find(l => l.account_id[0] === 10).currency_id, 2, "el banco en dólares lleva su moneda");
  assert.equal(lineasDe(m.id).find(l => l.account_id[0] === 20).partner_id[0] ?? lineasDe(m.id).find(l => l.account_id[0] === 20).partner_id, 5);
  const suma = id => lineasDe(id).reduce((t, l) => t + (l.debit || 0), 0);
  assert.equal(suma(m.id), suma(rev.id));
  assert.equal(lineasDe(rev.id).find(l => l.account_id[0] === 90).debit, 65000, "la reversión invierte débito y crédito");
  assert.equal(db.asiento(febUno.id).resultado.reversion.ok, true);
});
