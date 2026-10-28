// Fase 3C: extractos bancarios (lectura de CSV/Excel de cualquier banco, emparejamiento con los
// libros, asientos de cargos, intereses y transferencias) y comprobantes en zip (PDF + XML).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OdooSimulado } from "../src/odoo-simulado.js";
import { BaseDeDatos } from "../src/servicio/db.js";
import { Corridas } from "../src/servicio/corridas.js";
import { interpretar, leerMonto, reconocerColumnas, clasificarTexto } from "../src/lib/extractos.js";
import { filasDeArchivo, leerZip } from "../src/lib/archivos.js";
import { leerComprobante } from "../src/lib/comprobantes.js";
import * as extractosSrv from "../src/servicio/extractos.js";
import * as comprobantesSrv from "../src/servicio/comprobantes.js";
import { crearZip, crearXLSX } from "./simulado/zip.js";
import * as cierreMes from "../src/servicio/cierreMes.js";
import { DirectorCore } from "../src/director.js";
import { readFileSync } from "node:fs";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const b64 = s => Buffer.from(s, "utf8").toString("base64");

test("Montos y columnas como los dan los bancos", () => {
  assert.equal(leerMonto("1.250.000,50"), 1250000.5);
  assert.equal(leerMonto("(1.000,00)"), -1000);
  assert.equal(leerMonto("1,000.00-"), -1000);
  assert.equal(leerMonto("-₡ 2 500,00"), -2500);
  assert.equal(leerMonto(""), null);
  const m = reconocerColumnas(["Fecha Contable", "Fecha", "Número de documento", "Descripción del movimiento", "Débitos", "Créditos", "Saldo disponible"]);
  assert.deepEqual(m, { fecha: 1, referencia: 2, descripcion: 3, debito: 4, credito: 5, saldo: 6 });
  assert.equal(clasificarTexto("COMISION TRANSFERENCIA SINPE", -250), "cargo");
  assert.equal(clasificarTexto("INTERESES GANADOS", 1200), "interes");
  assert.equal(clasificarTexto("TRANSF A CTA 100-02", -5000), "transferencia");
});

test("CSV con encabezado del banco, saldos, orden inverso y descripción partida en dos filas", () => {
  const csv = [
    "BANCO DE PRUEBA S.A.;;;;",
    "Cuenta: 100-01-000-0001;;;;",
    "Fecha;Referencia;Concepto;Monto;Saldo",
    "28/02/2026;9003;COMISION SINPE;-250,00;1.069.750,00",
    "15/02/2026;9002;DEPOSITO;20.000,00;1.070.000,00",
    ";;CLIENTE ABC FACTURA 77;;",
    "03/02/2026;9001;PAGO PROVEEDOR XYZ;-30.000,00;1.050.000,00",
    "Saldo inicial;;;;1.080.000,00"
  ].join("\n");
  const r = interpretar(filasDeArchivo({ nombre: "feb.csv", base64: b64(csv) }).filas);
  assert.equal(r.filaEncabezados, 2);
  assert.equal(r.ordenInverso, true);
  assert.deepEqual(r.movimientos.map(m => [m.fecha, m.monto]), [["2026-02-03", -30000], ["2026-02-15", 20000], ["2026-02-28", -250]]);
  assert.equal(r.movimientos[1].descripcion, "DEPOSITO CLIENTE ABC FACTURA 77", "la fila sin fecha continúa la descripción");
  assert.equal(r.cuadra, true);
  assert.deepEqual([r.saldoInicial, r.saldoFinal, r.entradas, r.salidas], [1080000, 1069750, 20000, 30250]);
});

test("Excel con débitos y créditos; y signos al revés que se corrigen con el saldo", () => {
  const x = crearXLSX([["Estado de cuenta"], ["Fecha", "Descripción", "Débitos", "Créditos", "Saldo"], [46055, "COMISION", 500, "", 99500], [46056, "DEPOSITO", "", 10000, 109500]]);
  const r = interpretar(filasDeArchivo({ nombre: "e.xlsx", base64: x.toString("base64") }).filas);
  assert.deepEqual(r.movimientos.map(m => [m.fecha, m.monto]), [["2026-02-02", -500], ["2026-02-03", 10000]]);
  assert.equal(r.cuadra, true);
  const al = "Fecha,Detalle,Monto,Saldo\n02/02/2026,COMISION,500,99500\n03/02/2026,DEPOSITO,-10000,109500\n";
  const s = interpretar(filasDeArchivo({ nombre: "e.csv", base64: b64(al) }).filas);
  assert.deepEqual(s.movimientos.map(m => m.monto), [-500, 10000]);
  assert.match(s.avisos[0], /signos venían al revés/);
  const sinCab = interpretar([["x", "y"], ["02/02/2026", "5"]]);
  assert.match(sinCab.error, /encabezados/);
  const aMano = interpretar([["x", "y"], ["02/02/2026", "5"]], { filaEncabezados: 0, mapa: { fecha: 0, monto: 1 } });
  assert.equal(aMano.movimientos[0].monto, 5);
  assert.throws(() => filasDeArchivo({ nombre: "viejo.xls", base64: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]).toString("base64") }), /\.xls antiguo/);
});

// --- Odoo de prueba: una compañía con dos bancos
const C1 = [1, "Puuk"], CRC = [3, "CRC"];
function instancia() {
  const ml = (id, cuenta, fecha, balance, nombre, extra = {}) => ({ id, account_id: cuenta, date: fecha, balance, amount_currency: 0, name: nombre, ref: false, move_id: [id + 1000, `BNK/${id}`],
    partner_id: false, parent_state: "posted", company_id: C1, journal_id: [50, "BCR"], ...extra });
  return {
    "res.company": [{ id: 1, name: "Puuk", currency_id: CRC, vat: "3101000001" }],
    "account.journal": [
      { id: 50, name: "BCR Colones", type: "bank", company_id: C1, default_account_id: [500, "1-01-01 BCR"], currency_id: false, bank_acc_number: "CR01" },
      { id: 51, name: "BN Colones", type: "bank", company_id: C1, default_account_id: [501, "1-01-02 BN"], currency_id: false, bank_acc_number: "CR02" },
      { id: 60, name: "Diario general", type: "general", company_id: C1, default_account_id: false, currency_id: false }],
    "account.account": [
      { id: 500, code: "1-01-01", name: "BCR", company_ids: [1], account_type: "asset_cash", deprecated: false },
      { id: 501, code: "1-01-02", name: "BN", company_ids: [1], account_type: "asset_cash", deprecated: false },
      { id: 600, code: "6-01-05", name: "Comisiones bancarias", company_ids: [1], account_type: "expense", deprecated: false },
      { id: 700, code: "4-02-01", name: "Intereses ganados", company_ids: [1], account_type: "income_other", deprecated: false }],
    "account.move.line": [
      ml(1, [500, "1-01-01 BCR"], "2026-02-04", -30000, "Pago proveedor XYZ"),                       // en libros (un día después)
      ml(2, [500, "1-01-01 BCR"], "2026-02-20", -15000, "Cheque 88"),                                // en libros y no en el banco
      ml(3, [500, "1-01-01 BCR"], "2026-01-31", 1080000, "Saldo anterior"),
      ml(4, [600, "6-01-05 Comisiones bancarias"], "2026-01-31", 300, "Comisión SINPE enero"),        // historial: así se aprende la cuenta
      ml(5, [700, "4-02-01 Intereses ganados"], "2026-01-31", -90, "Intereses ganados enero")
    ].map(l => (l.id >= 4 ? { ...l, journal_id: [50, "BCR"] } : l)),
    "account.move": [
      { id: 900, name: "FV-77", move_type: "out_invoice", state: "posted", payment_state: "not_paid", company_id: C1, partner_id: [10, "Cliente ABC"], amount_residual: 20000, amount_residual_signed: 20000, currency_id: CRC, invoice_date_due: "2026-02-10", e_key: false }]
  };
}
const BCR = [
  "Fecha;Referencia;Concepto;Monto;Saldo",
  "03/02/2026;9001;PAGO PROVEEDOR XYZ;-30.000,00;1.050.000,00",
  "10/02/2026;9002;TRANSF A CTA BN;-100.000,00;950.000,00",
  "15/02/2026;9003;DEPOSITO CLIENTE ABC;20.000,00;970.000,00",
  "27/02/2026;9004;INTERESES SOBRE SALDO;120,00;970.120,00",
  "28/02/2026;9005;COMISION SINPE;-250,00;969.870,00",
  "28/02/2026;9006;COMISION MANTENIMIENTO;-1.000,00;968.870,00",
  "28/02/2026;9007;PAGO DESCONOCIDO;-7.777,00;961.093,00"].join("\n");
const BN = "Fecha,Descripcion,Debitos,Creditos,Saldo\n10/02/2026,TRANSFERENCIA RECIBIDA BCR,,100000,100000\n";

function servicio() {
  const raiz = mkdtempSync(join(tmpdir(), "extractos-"));
  writeFileSync(join(raiz, "sim.json"), JSON.stringify(instancia()));
  const db = new BaseDeDatos(":memory:");
  const corridas = new Corridas({ db, cfg: { ODOO_SIMULADO: "sim.json" }, raiz, raizProyecto: RAIZ });
  return { db, corridas };
}

test("Vista previa e importación: los movimientos repetidos no se duplican", async () => {
  const { db, corridas } = servicio();
  const ds = await extractosSrv.diarios({ corridas });
  assert.deepEqual(ds.map(d => d.nombre), ["BCR Colones", "BN Colones"], "solo diarios de banco");
  const cuerpo = { diarioId: 50, archivo: { nombre: "bcr-feb.csv", base64: b64(BCR) } };
  const v = await extractosSrv.vistaPrevia({ corridas, db, cuerpo });
  assert.equal(v.total, 7);
  assert.equal(v.cuadra, true);
  assert.equal(v.nuevos, 7);
  const r = await extractosSrv.importar({ corridas, db, cuerpo, quien: "prueba" });
  assert.equal(r.nuevos, 7);
  const otra = await extractosSrv.importar({ corridas, db, cuerpo, quien: "prueba" });
  assert.deepEqual([otra.nuevos, otra.repetidos], [0, 7]);
  const mal = await extractosSrv.vistaPrevia({ corridas, db, cuerpo: { diarioId: 60, archivo: cuerpo.archivo } });
  assert.match(mal.error, /no es de banco/);
});

test("Emparejamiento: en libros, cargos e intereses del mes, transferencia propia, cobro con su factura y saldo contra libros", async () => {
  const { db, corridas } = servicio();
  await extractosSrv.importar({ corridas, db, cuerpo: { diarioId: 50, archivo: { nombre: "bcr.csv", base64: b64(BCR) } }, quien: "prueba" });
  await extractosSrv.importar({ corridas, db, cuerpo: { diarioId: 51, archivo: { nombre: "bn.csv", base64: b64(BN) } }, quien: "prueba" });
  const { resultado: r, resumen } = await corridas.correr("extractos");
  assert.equal(r.cambios, undefined, "los cambios por línea no se guardan en la corrida");
  const ls = db.lineasExtracto({});
  const de = txt => ls.find(l => l.descripcion.startsWith(txt));
  assert.equal(de("PAGO PROVEEDOR").estado, "en-libros");
  assert.equal(de("PAGO PROVEEDOR").emparejado.dias, 1);
  assert.deepEqual([de("COMISION SINPE").estado, de("COMISION SINPE").tipo], ["propuesta", "cargo"]);
  assert.deepEqual([de("TRANSF A CTA BN").tipo, de("TRANSFERENCIA RECIBIDA").tipo], ["transferencia", "transferencia"]);
  assert.equal(de("DEPOSITO CLIENTE").tipo, "cobro");
  assert.equal(de("DEPOSITO CLIENTE").emparejado.candidatos[0].factura, "FV-77");
  assert.deepEqual([de("PAGO DESCONOCIDO").estado, de("PAGO DESCONOCIDO").tipo], ["pendiente", "salida"]);
  assert.equal(resumen.asientos.nuevos, 3);

  const as = db.asientos({ estado: "propuesta" });
  const cargos = as.find(a => a.referencia.startsWith("Cargos bancarios"));
  assert.deepEqual(cargos.lineas.map(l => [l.cuentaId, l.debito, l.credito]), [[600, 1250, 0], [500, 0, 1250]], "un asiento con las dos comisiones; la cuenta se aprendió del historial");
  const intereses = as.find(a => a.referencia.startsWith("Intereses"));
  assert.deepEqual(intereses.lineas.map(l => [l.cuentaId, l.debito, l.credito]), [[500, 120, 0], [700, 0, 120]]);
  const tr = as.find(a => a.referencia.startsWith("Transferencia"));
  assert.deepEqual(tr.lineas.map(l => [l.cuentaId, l.debito, l.credito]), [[501, 100000, 0], [500, 0, 100000]]);

  const bcr = r.bancos.find(b => b.banco === "BCR Colones");
  assert.equal(bcr.saldoExtracto, 961093);
  assert.equal(bcr.saldoLibros, 1035000, "1 080 000 − 30 000 − 15 000");
  assert.equal(bcr.transito.length, 1, "el cheque 88 está en libros y no en el banco");
  assert.equal(bcr.sinExplicar, 0, "la diferencia la explican los movimientos pendientes y el cheque en tránsito");
  assert.ok(r.alertas.some(a => /sin factura que calce/.test(a.texto)));

  // la corrida siguiente no duplica; un asiento aplicado deja sus líneas como registradas
  const otra = await corridas.correr("extractos");
  assert.deepEqual(otra.resumen.asientos, { nuevos: 0, actualizados: 3, obsoletos: 0 });
  db.decidirAsiento(cargos.id, "aprobada", "prueba");
  db.marcarAsiento(cargos.id, "aplicada", { moveId: 77, moveName: "MISC/77" });
  await corridas.correr("extractos");
  assert.equal(db.lineasExtracto({}).find(l => l.descripcion === "COMISION SINPE").estado, "registrada");

  // en el cierre de mes de la compañía
  const item = cierreMes.lista(db, { mes: "2026-02", companias: [{ id: 1, name: "Puuk" }] }).companias[0].items.find(i => i.id === "extractos");
  assert.equal(item.estado, "pendiente");
  assert.match(item.detalle, /movimientos del banco sin registrar/);

  // ignorar con motivo y reabrir
  const id = de("PAGO DESCONOCIDO").id;
  assert.equal(db.ignorarLineaExtracto(id, "prueba", "ya registrado en otra compañía"), true);
  await corridas.correr("extractos");
  assert.equal(db.lineasExtracto({}).find(l => l.id === id).estado, "ignorada", "el agente no toca las ignoradas");
  assert.equal(db.ignorarLineaExtracto(id, "prueba", null, false), true);
});

// --- comprobantes en zip
const factura = (clave, emisor, receptor, total) => `<?xml version="1.0" encoding="utf-8"?>
<FacturaElectronica xmlns="https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronica">
  <Clave>${clave}</Clave><NumeroConsecutivo>${clave.slice(21, 41)}</NumeroConsecutivo><FechaEmision>2026-02-10T10:00:00-06:00</FechaEmision>
  <Emisor><Nombre>${emisor[0]}</Nombre><Identificacion><Tipo>02</Tipo><Numero>${emisor[1]}</Numero></Identificacion></Emisor>
  <Receptor><Nombre>${receptor[0]}</Nombre><Identificacion><Tipo>02</Tipo><Numero>${receptor[1]}</Numero></Identificacion></Receptor>
  <ResumenFactura><CodigoTipoMoneda><CodigoMoneda>CRC</CodigoMoneda><TipoCambio>1</TipoCambio></CodigoTipoMoneda><TotalImpuesto>1300</TotalImpuesto><TotalComprobante>11300</TotalComprobante></ResumenFactura>
</FacturaElectronica>`;
const k = n => `50610022600310100000200100001010000000${String(n).padStart(3, "0")}100000001`.slice(0, 50);

test("Comprobantes en zip: cuáles faltan en Odoo, cuáles están en el buzón, rechazados por Hacienda y PDF sin XML", async () => {
  const [k1, k2, k3, k4] = [1, 2, 3, 4].map(k);
  assert.equal(k1.length, 50);
  const yo = ["Puuk S.A.", "3101000001"], prov = ["Proveedor Uno", "3102000002"];
  const zip = crearZip({
    [`${k1}.xml`]: factura(k1, prov, yo), [`${k1}.pdf`]: "%PDF-1.4",
    [`${k2}.xml`]: factura(k2, prov, yo),
    [`${k3}.xml`]: factura(k3, prov, yo), [`R-${k3}.xml`]: `<MensajeHacienda><Clave>${k3}</Clave><Mensaje>3</Mensaje></MensajeHacienda>`,
    [`otra/${k4}.xml`]: factura(k4, prov, ["Ajena", "3101999999"]),
    "suelto.pdf": "%PDF-1.4", "notas.txt": "hola"
  });
  assert.equal(leerZip(zip).length, 8);
  assert.equal(leerComprobante(factura(k1, prov, yo)).total, 11300);
  const raiz = mkdtempSync(join(tmpdir(), "comprobantes-"));
  writeFileSync(join(raiz, "sim.json"), JSON.stringify({
    "res.company": [{ id: 1, name: "Puuk", vat: "3-101-000001" }],
    "account.move": [{ id: 1, name: "FC-1", state: "posted", move_type: "in_invoice", company_id: C1, partner_id: [5, "Proveedor Uno"], amount_total: 11300, e_key: k1 }],
    "bdt.invoice.email": [{ id: 1, company_id: C1, state: "error", error: "Periodo fiscal cerrado", e_invoice_name: `${k2}.xml`, date: "2026-02-11" }]
  }));
  const corridas = new Corridas({ db: new BaseDeDatos(":memory:"), cfg: { ODOO_SIMULADO: "sim.json" }, raiz, raizProyecto: RAIZ });
  const r = await comprobantesSrv.revisar({ corridas, archivo: { nombre: "urbano.zip", base64: zip.toString("base64") } });
  const por = Object.fromEntries(r.documentos.map(d => [d.clave, d]));
  assert.equal(por[k1].estado, "registrado");
  assert.equal(por[k1].pdf, `${k1}.pdf`);
  assert.equal(por[k2].estado, "en-buzon");
  assert.equal(por[k2].buzon.error, "Periodo fiscal cerrado");
  assert.deepEqual([por[k3].estado, por[k3].hacienda], ["falta", "rechazado"]);
  assert.equal(por[k4].estado, "ajeno");
  assert.equal(por[k1].lado, "compra");
  assert.deepEqual(r.pdfSinXML, ["suelto.pdf"]);
  assert.deepEqual([r.totales.faltan, r.totales.rechazadosHacienda], [1, 1]);
  assert.match((await comprobantesSrv.revisar({ corridas, archivo: { nombre: "x.doc", base64: b64("hola") } })).error, /zip/);
});

test("El Director lleva las preguntas del extracto al agente Extractos", () => {
  const roster = JSON.parse(readFileSync(join(RAIZ, "data", "roster.json"), "utf8"));
  assert.equal(DirectorCore.decidir("qué movimientos del extracto no están en libros", roster, []).agente.id, "extractos");
  assert.equal(DirectorCore.decidir("qué cargos bancarios faltan", roster, []).agente.id, "extractos");
});
