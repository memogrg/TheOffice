// Fase 3A (solo lectura): Cierre (cuentas puente y cuadre de IVA) y Estados financieros, contra un
// Odoo simulado con asientos armados a mano.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OdooSimulado } from "../src/odoo-simulado.js";
import * as cierre from "../src/agents/cierre.js";
import * as estados from "../src/agents/estados.js";
import { arrastre, cargarPuentes, tipoDePuente } from "../src/agents/cierre.js";

const silencio = () => {};
const CIA = [1, "Compañía Uno"], CIA2 = [2, "Compañía Dos"];
const VENTA = [1, "IVA 13% ventas"], COMPRA = [2, "IVA 13% compras"];

function libro(cuentas, movimientos) {
  let id = 0;
  const cta = Object.fromEntries(cuentas.map(c => [c.id, c]));
  const lineas = movimientos.map(([fecha, cuenta, balance, { cia = CIA, impuesto = false } = {}]) => ({
    id: ++id, company_id: cia, account_id: [cuenta, cta[cuenta].name], date: fecha, parent_state: "posted", tax_line_id: impuesto,
    balance, debit: balance > 0 ? balance : 0, credit: balance < 0 ? -balance : 0
  }));
  return { "account.account": cuentas, "account.move.line": lineas };
}

test("Cierre: reconoce las cuentas puente por nombre y tipo", () => {
  const p = cargarPuentes();
  assert.equal(tipoDePuente("Salarios por pagar personal de proyectos", "liability_current", p).id, "salarios");
  assert.equal(tipoDePuente("A pagar CCSS", "liability_current", p).id, "cargas-sociales");
  assert.equal(tipoDePuente("Créditos por IVA 13%", "asset_current", p).id, "iva-credito");
  assert.equal(tipoDePuente("Impuesto de renta por pagar", "liability_current", p).id, "renta");
  assert.equal(tipoDePuente("Retenciones de renta por salarios", "liability_current", p).id, "retenciones");
  assert.equal(tipoDePuente("Cargas sociales", "expense", p), null, "el gasto de cargas sociales no es puente");
  assert.equal(tipoDePuente("Retenciones renta 2%", "asset_current", p), null, "lo que le retuvieron a la compañía es un activo, no un puente");
  assert.deepEqual(arrastre({ pendiente: 2000000, entradas: 1000000, periodicidad: 1, tolerancia: 1000 }), { arrastre: 1000000, estado: "arrastra" });
  assert.equal(arrastre({ pendiente: 1000400, entradas: 1000000, periodicidad: 1, tolerancia: 1000 }).estado, "ok", "redondeos dentro de la tolerancia");
  assert.equal(arrastre({ pendiente: -20000, entradas: 0, periodicidad: 1, tolerancia: 1000 }).estado, "al-reves");
  assert.equal(arrastre({ pendiente: 5000, entradas: 0, periodicidad: 0, tolerancia: 1000 }).estado, "con-saldo");
});

test("Cierre: saldos sin liquidar, saldo al revés, transitorias, IVA del mes, IVA mal ubicado y diferencia con el Reporte IVA", async () => {
  const cuentas = [
    { id: 101, name: "Salarios por pagar", account_type: "liability_current" },
    { id: 102, name: "A pagar CCSS", account_type: "liability_current" },
    { id: 103, name: "IVA por pagar", account_type: "liability_current" },
    { id: 104, name: "Créditos por IVA 13%", account_type: "asset_current" },
    { id: 105, name: "Cuenta transitoria", account_type: "asset_current" },
    { id: 106, name: "Retenciones por pagar", account_type: "liability_current" },
    { id: 107, name: "Ventas de servicios", account_type: "income" },
    { id: 108, name: "Cargas sociales", account_type: "expense" },
    { id: 109, name: "Bancos", account_type: "asset_cash" }
  ];
  const datos = libro(cuentas, [
    ["2026-01-31", 101, -1000000], ["2026-02-28", 101, -1000000],                 // salarios de enero sin pagar
    ["2026-01-31", 102, -300000], ["2026-02-14", 102, 300000], ["2026-02-28", 102, -300000],   // CCSS al día
    ["2026-01-20", 103, -100000, { impuesto: VENTA }], ["2026-02-15", 103, 100000], ["2026-02-20", 103, -130000, { impuesto: VENTA }],
    ["2026-01-10", 104, 40000, { impuesto: COMPRA }], ["2026-02-10", 104, 50000, { impuesto: COMPRA }],   // crédito fiscal que se arrastra
    ["2026-02-05", 105, 5000],
    ["2026-02-25", 106, 20000],                                                    // retención pagada sin provisión
    ["2026-02-20", 107, -13000, { impuesto: VENTA }],                               // IVA de venta a una cuenta de ingreso
    ["2026-02-28", 108, 300000], ["2026-02-28", 109, -100],
    ["2026-01-15", 103, -50000, { cia: CIA2, impuesto: VENTA }]                     // la compañía dos no registró febrero
  ]);
  datos["account.tax"] = [{ id: 1, name: "IVA 13% ventas", type_tax_use: "sale" }, { id: 2, name: "IVA 13% compras", type_tax_use: "purchase" }];
  datos["account.move"] = [{ id: 1, company_id: CIA, state: "draft", move_type: "in_invoice", invoice_date: "2026-02-27", amount_tax: 6500 }];
  datos["tecnodem_iva_reporter.vat_report"] = [{ id: 1, company_id: CIA, init_date: "2026-02-01", end_date: "2026-02-28", state: "done", total_vat_sale: 130000, total_vat_purchase: 40000 }];
  const odoo = new OdooSimulado(datos);
  const r = await cierre.ejecutar({ odoo, cfg: { CIERRE_MES: "2026-02", CIERRE_VENTANA: 2 }, log: silencio });
  assert.equal(odoo.escrituras, 0);
  assert.equal(r.mes, "2026-02");
  assert.deepEqual(r.ventana, ["2026-01", "2026-02"]);
  const de = nombre => r.cuentas.find(c => c.cuenta === nombre && c.companiaId === 1);
  assert.equal(de("Salarios por pagar").estado, "arrastra");
  assert.equal(de("Salarios por pagar").arrastre, 1000000);
  assert.equal(de("A pagar CCSS"), undefined, "la CCSS se pagó: no aparece");
  assert.equal(de("IVA por pagar"), undefined, "el IVA de enero se liquidó en febrero");
  assert.equal(de("Créditos por IVA 13%").saldoAFavor, true);
  assert.equal(de("Créditos por IVA 13%").arrastre, 40000);
  assert.equal(de("Cuenta transitoria").estado, "con-saldo");
  assert.equal(de("Retenciones por pagar").estado, "al-reves");
  assert.ok(!r.cuentas.some(c => c.cuenta === "Cargas sociales"), "una cuenta de gasto nunca es puente");
  assert.equal(r.cuentas.find(c => c.companiaId === 2).estado, "sin-registro");
  assert.deepEqual(r.sinRegistro.map(s => s.compania), ["Compañía Dos"]);
  assert.equal(r.totales.arrastran, 1, "el crédito fiscal se informa aparte");
  assert.equal(r.totales.saldoAFavor, 1);

  const iva = r.iva.find(i => i.companiaId === 1);
  assert.equal(iva.debito, 143000, "incluye el IVA de venta mal ubicado");
  assert.equal(iva.credito, 50000);
  assert.equal(iva.neto, 93000);
  assert.equal(iva.resultado, "a pagar");
  assert.equal(iva.borradores.compras, 1);
  assert.equal(iva.borradores.ivaCompras, 6500);
  assert.deepEqual([iva.declarado.difDebito, iva.declarado.difCredito], [13000, 10000]);
  assert.equal(r.ivaMalUbicado.length, 1);
  assert.equal(r.ivaMalUbicado[0].cuenta, "Ventas de servicios");
  assert.equal(r.totales.difDeclaracion, 1);
  assert.ok(r.alertas.some(a => /arrastran saldo sin liquidar/.test(a.texto)));
  assert.ok(r.alertas.some(a => /saldo al revés/.test(a.texto)));
  assert.ok(r.alertas.some(a => /IVA cargado a cuentas que no son de IVA/.test(a.texto)));
});

test("Estados: balance que cuadra, resultados del mes y del año, caja negativa, proveedores al revés y año sin cerrar", async () => {
  const cuentas = [
    { id: 201, name: "Caja general", account_type: "asset_cash" },
    { id: 202, name: "Cuentas por cobrar clientes", account_type: "asset_receivable" },
    { id: 203, name: "Cuentas por pagar proveedores", account_type: "liability_payable" },
    { id: 204, name: "Capital social", account_type: "equity" },
    { id: 205, name: "Ingresos por servicios", account_type: "income" },
    { id: 206, name: "Gastos de oficina", account_type: "expense" }
  ];
  const datos = libro(cuentas, [
    ["2025-01-01", 201, 10000], ["2025-01-01", 204, -10000],
    ["2025-06-10", 201, 80000], ["2025-06-10", 205, -80000],
    ["2025-07-10", 206, 30000], ["2025-07-10", 201, -30000],
    ["2026-01-15", 202, 100000], ["2026-01-15", 205, -100000],
    ["2026-01-20", 206, 40000], ["2026-01-20", 203, -40000],
    ["2026-02-10", 202, 150000], ["2026-02-10", 205, -150000],
    ["2026-02-12", 206, 50000], ["2026-02-12", 201, -50000],
    ["2026-02-20", 203, 60000], ["2026-02-20", 201, -60000],
    ["2025-03-01", 201, 5000, { cia: CIA2 }], ["2025-03-01", 204, -5000, { cia: CIA2 }]
  ]);
  datos["account.move"] = [{ id: 1, company_id: CIA, state: "draft", date: "2026-02-27", amount_total: 1000 }];
  const odoo = new OdooSimulado(datos);
  const r = await estados.ejecutar({ odoo, cfg: { ESTADOS_MES: "2026-02", ESTADOS_VENTANA: 3 }, log: silencio });
  assert.equal(odoo.escrituras, 0);
  const c = r.companias.find(x => x.companiaId === 1);
  assert.deepEqual(
    [c.balance.activo, c.balance.pasivo, c.balance.patrimonio, c.balance.resultadosAnteriores, c.balance.resultadoDelAnio, c.balance.diferencia],
    [200000, -20000, 10000, 50000, 160000, 0]);
  assert.equal(c.resultadosMes.mes, "2026-02");
  assert.deepEqual([c.resultadosMes.ingresos, c.resultadosMes.gastos, c.resultadosMes.utilidad], [150000, 50000, 100000]);
  assert.deepEqual([c.resultadosAnio.ingresos, c.resultadosAnio.gastos, c.resultadosAnio.utilidad], [250000, 90000, 160000]);
  assert.deepEqual(c.serie.map(s => s.mes), ["2025-12", "2026-01", "2026-02"]);
  assert.equal(c.borradores, 1);
  assert.equal(r.cajasNegativas[0].saldo, -50000);
  assert.equal(r.ladoContrario[0].rubro, "Cuentas por pagar");
  assert.equal(r.anioSinCerrar[0].monto, 50000);
  assert.equal(r.totales.descuadres, 0);
  assert.equal(r.companias.find(x => x.companiaId === 2).sinMovimientoEnElMes, true);
  assert.ok(r.alertas.some(a => /caja o banco con saldo negativo/.test(a.texto)));
  assert.ok(r.alertas.some(a => /años anteriores/.test(a.texto)));
});
