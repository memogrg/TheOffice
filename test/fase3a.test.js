// Fase 3A (solo lectura): Diagnóstico, Recurrentes, Bancos y Documentos contra un Odoo simulado
// armado a la medida de cada caso.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OdooSimulado } from "../src/odoo-simulado.js";
import * as diagnostico from "../src/agents/diagnostico.js";
import * as recurrentes from "../src/agents/recurrentes.js";
import * as bancos from "../src/agents/bancos.js";
import * as documentos from "../src/agents/documentos.js";
import { diagnosticar } from "../src/agents/diagnostico.js";
import { huecos, rangos } from "../src/agents/documentos.js";

const silencio = () => {};
const CIA = [1, "Compañía Uno"], CIA2 = [2, "Compañía Dos"];
// clave de 50 dígitos: 506 + ddmmaa + cédula(12) + sucursal(3) terminal(5) tipo(2) número(10) + situación(1) + seguridad(8)
const clave = ({ cedula = "3101000001", tipo = "01", num, suc = "001", term = "00001", fecha = "150126" }) =>
  `506${fecha}${String(cedula).padStart(12, "0")}${suc}${term}${tipo}${String(num).padStart(10, "0")}1${"12345678"}`;

test("Diagnóstico: reconoce las causas, dice qué hacer y separa configuración de reclamo al emisor", async () => {
  const e = (id, state, error, company = CIA) => ({ id, state, error, company_id: company, date: "2026-02-01 10:00:00", name: `correo ${id}`, e_invoice_name: "" });
  const odoo = new OdooSimulado({ "bdt.invoice.email": [
    e(1, "error", "Error de proceso: No se encontró un periodo fiscal válido para la fecha 2024-11-12."),
    e(2, "error", "Error de proceso: No se encontró un periodo fiscal válido para la fecha 2024-11-30."),
    e(3, "error", "Error de proceso: No se encontró un periodo fiscal válido para la fecha 2024-12-02.", CIA2),
    e(4, "error", "Error de validación: El impuesto de 01 - IVA con tarifa 10 - Tarifa Exenta no existe, fue borrado o archivado, por favor verifica o crea el impuesto"),
    e(5, "error", "Error de validación: Payment method not found for code: None"),
    e(6, "vatiderror", "The Tax ID of the receptor is 108470964 and does not match the current company"),
    e(7, "error", "Error de proceso: unclosed token: line 13, column 4695"),
    e(8, "process", ""), e(9, "rejected", false),
    e(10, "error", "Error de validación: algo raro número 123"),
    e(11, "done", "")
  ] });
  const r = await diagnostico.ejecutar({ odoo, cfg: {}, log: silencio });
  assert.equal(odoo.escrituras, 0);
  assert.equal(r.totales.correosConProblema, 10, "los done no cuentan");
  const periodo = r.causas.find(c => c.id === "periodo-fiscal");
  assert.equal(periodo.correos, 3);
  assert.deepEqual(periodo.pendientes.map(p => [p.compania, p.detalle, p.correos]), [["Compañía Uno", "mes 2024-11", 2], ["Compañía Dos", "mes 2024-12", 1]]);
  assert.equal(r.causas.find(c => c.id === "impuesto-inexistente").pendientes[0].detalle, "IVA 01 tarifa 10 (Tarifa Exenta)");
  assert.equal(r.causas.find(c => c.id === "receptor-otra-cedula").frente, "afuera");
  assert.equal(r.totales.porConfiguracion, 5, "periodos (3), impuesto (1), medio de pago (1)");
  assert.equal(r.totales.porEmisor, 2, "otra cédula y XML dañado");
  assert.equal(r.totales.sinCatalogar, 1);
  assert.ok(r.causas.some(c => c.id === "en-cola") && r.causas.some(c => c.id === "rechazado-sin-motivo"));
  assert.match(r.alertas[0].texto, /5 correos se destraban con configuración/);
  // la firma de lo desconocido no depende de los números
  assert.equal(diagnosticar({ state: "error", error: "Error de validación: algo raro número 9" }).causa.id, diagnosticar({ state: "error", error: "Error de validación: algo raro número 123" }).causa.id);
});

test("Recurrentes: detecta el servicio que faltó en el mes y el que vino con monto anormal", async () => {
  let id = 0;
  const f = (partner, fecha, monto, actividad = null) => ({ id: ++id, move_type: "in_invoice", state: "posted", company_id: CIA, partner_id: partner, invoice_date: fecha,
    amount_total: monto, currency_id: [1, "CRC"], economic_activity_purchase_id: actividad });
  const luz = [10, "CNFL"], tel = [11, "Kölbi"], ocasional = [12, "Ferretería"];
  const ACT_LUZ = [1, "GENERACION Y/O DISTRIBUCION DE ENERGIA ELECTRICA"];
  const meses = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
  const moves = [
    ...meses.map(m => f(luz, `${m}-10`, 50000, ACT_LUZ)),                        // falta julio
    ...meses.map(m => f(tel, `${m}-05`, 20000)), f(tel, "2026-07-05", 61000),  // julio triplicado
    f(ocasional, "2026-02-01", 9000), f(ocasional, "2026-07-01", 9000)
  ];
  const odoo = new OdooSimulado({ "account.move": moves });
  const r = await recurrentes.ejecutar({ odoo, cfg: { RECURRENTES_MES: "2026-07" }, log: silencio });
  assert.equal(r.mes, "2026-07");
  assert.deepEqual(r.ventana, meses);
  assert.equal(r.totales.recurrentes, 2, "el ocasional no es recurrente");
  assert.equal(r.faltantes.length, 1);
  assert.equal(r.faltantes[0].proveedor, "CNFL");
  assert.equal(r.faltantes[0].servicioPublico, true);
  assert.equal(r.desvios.length, 1);
  assert.equal(r.desvios[0].proveedor, "Kölbi");
  assert.equal(r.desvios[0].desvioPct, 205);
  // base congelada: el mes evaluado es el anterior al del documento más reciente
  const r2 = await recurrentes.ejecutar({ odoo: new OdooSimulado({ "account.move": moves }), cfg: { ALERTA_REFERENCIA: "ultimo-correo" }, log: silencio });
  assert.equal(r2.mes, "2026-06");
  assert.equal(r2.faltantes.length, 0);
});

test("Bancos: al día, atrasada, en borrador, nunca conciliada, sin movimiento y fechas en el futuro", async () => {
  const j = (id, nombre, cuenta, company = CIA) => ({ id, type: "bank", name: nombre, company_id: company, default_account_id: [cuenta, `Banco ${cuenta}`] });
  const c = (id, cuenta, state, end, company = CIA) => ({ id, company_id: company, account_id: [cuenta, `Banco ${cuenta}`], name: `conc ${id}`, state, end_date: end, book_balance: 1000, initial_balance: 900 });
  const lineas = [100, 101, 102, 103].map((a, i) => ({ id: i + 1, account_id: [a, `Banco ${a}`], parent_state: "posted", date: "2026-02-20" }));
  const odoo = new OdooSimulado({
    "account.journal": [j(1, "BAC", 100), j(2, "BN", 101), j(3, "Promerica", 102), j(4, "BCR", 103), j(5, "Viejo", 104)],
    "taerp.bank.reconciliation": [c(1, 100, "done", "2026-01-31"), c(2, 100, "done", "2026-02-28"),
      c(3, 101, "done", "2025-10-31"), c(4, 101, "draft", "2025-11-30"),
      c(5, 102, "draft", "2026-02-28"), c(6, 100, "done", "2099-12-31")],
    "taerp.bank.reconciliation.unline": [{ id: 1, bank_reconcil_id: [2, "conc 2"], date: "2026-02-10", debit: 500, credit: 0, name: "depósito" }],
    "account.move.line": lineas
  });
  const r = await bancos.ejecutar({ odoo, cfg: { ALERTA_REFERENCIA: "ultimo-correo" }, log: silencio });
  assert.equal(r.esperadoHasta, "2026-02", "la última conciliación real (la de 2099 no cuenta)");
  const de = n => r.cuentas.find(x => x.diario === n);
  assert.equal(de("BAC").estado, "al-dia");
  assert.equal(de("BAC").partidasPendientes, 1);
  assert.equal(de("BAC").fechasFuturas.length, 1);
  assert.equal(de("BN").estado, "atrasada");
  assert.equal(de("BN").mesesAtraso, 4);
  assert.equal(de("BN").borradores.length, 1);
  assert.equal(de("Promerica").estado, "solo-borradores");
  assert.equal(de("BCR").estado, "nunca-conciliada");
  assert.equal(de("Viejo").estado, "sin-movimiento");
  assert.equal(r.cuentas[0].diario, "BN", "lo atrasado primero");
  assert.equal(odoo.escrituras, 0);
});

test("Documentos: notas de crédito ligables, sin original y sin referencia; huecos en consecutivos de venta", async () => {
  const PROV = "3101999999";
  const factura = { id: 1, move_type: "in_invoice", state: "posted", company_id: CIA, partner_id: [5, "Proveedor"], name: "FC-1", amount_total: 1000, e_key: clave({ cedula: PROV, num: 77 }) };
  const otra = { id: 2, move_type: "in_invoice", state: "posted", company_id: CIA, partner_id: [5, "Proveedor"], name: "FC-2", amount_total: 500, e_key: clave({ cedula: PROV, num: 78 }) };
  const nc = (id, ref, extra = {}) => ({ id, move_type: "in_refund", state: "posted", company_id: CIA, partner_id: [5, "Proveedor"], name: `NC-${id}`, amount_total: 100,
    reference_number: ref, reference_code: "03", reference_reason: "Corrige monto", reversed_entry_id: false, e_key: clave({ cedula: PROV, tipo: "03", num: id }), ...extra });
  const venta = (id, num, tipo = "01", company = CIA) => ({ id, move_type: tipo === "03" ? "out_refund" : "out_invoice", state: "posted", company_id: company, e_key: clave({ cedula: "3101000001", tipo, num }),
    ...(tipo === "03" ? { reversed_entry_id: [100, "FV-1"] } : {}) });
  const odoo = new OdooSimulado({ "account.move": [
    factura, otra,
    nc(10, factura.e_key),                                   // por clave
    nc(11, otra.e_key.slice(21, 41), { amount_total: 900 }),   // por consecutivo, y la nota supera a la factura
    nc(12, clave({ cedula: PROV, num: 999 })),               // la original no está
    nc(13, ""),                                              // sin referencia
    nc(14, factura.e_key, { reversed_entry_id: [1, "FC-1"] }), // ya ligada: no aparece
    ...[1, 2, 3, 6, 7, 10].map((n, i) => venta(100 + i, n)), venta(120, 1, "03"), venta(121, 2, "03"),
    venta(130, 1, "01", CIA2), venta(131, 5000, "01", CIA2)    // un salto enorme: serie que empezó en otro sistema
  ] });
  const r = await documentos.ejecutar({ odoo, cfg: {}, log: silencio });
  const n = id => r.notas.find(x => x.id === id);
  assert.equal(r.totales.notasSinLigar, 4);
  assert.equal(n(10).estado, "ligable"); assert.equal(n(10).original, "FC-1"); assert.equal(n(10).encontradaPor, "clave");
  assert.equal(n(11).estado, "ligable"); assert.equal(n(11).encontradaPor, "consecutivo"); assert.equal(n(11).montoMayor, true);
  assert.equal(n(12).estado, "original-no-esta");
  assert.equal(n(13).estado, "sin-referencia");
  assert.equal(n(10).motivo, "corrige monto");
  const serie = r.consecutivos.find(c => c.compania === "Compañía Uno");
  assert.equal(serie.faltantes, 4);
  assert.deepEqual(serie.rangos, ["4–5", "8–9"]);
  assert.equal(r.consecutivos.filter(c => c.compania === "Compañía Uno").length, 1, "la serie de notas de crédito venta está completa");
  const salto = r.consecutivos.find(c => c.compania === "Compañía Dos");
  assert.equal(salto.faltantes, 0); assert.equal(salto.saltos.length, 1);
  assert.deepEqual(rangos([1, 2, 3, 7, 9, 10]), ["1–3", "7", "9–10"]);
  assert.deepEqual(huecos([5, 1, 3, 3]).faltan, [2, 4]);
  assert.equal(odoo.escrituras, 0);
});
