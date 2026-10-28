// Gastos diferidos (fase 3B, ítem 15): calendario, importación de la hoja del cliente, cuota del
// mes con atrasadas, y lo ya registrado en Odoo no se vuelve a proponer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OdooSimulado } from "../src/odoo-simulado.js";
import { BaseDeDatos } from "../src/servicio/db.js";
import * as agente from "../src/agents/diferidos.js";
import * as srv from "../src/servicio/diferidos.js";
import * as asientos from "../src/servicio/asientos.js";
import { calendario, pendientes, leerCSV, leerMonto, leerMes } from "../src/lib/diferidos.js";

const silencio = () => {};
const C1 = [1, "Ceiba"], C2 = [2, "Lirio"];
function instancia() {
  const c = (id, cia, code, name, t) => ({ id, code, name, account_type: t, deprecated: false, company_ids: [cia] });
  return {
    "res.company": [{ id: 1, name: "Ceiba" }, { id: 2, name: "Lirio" }],
    "account.account": [c(11, 1, "1.01.005.001", "Seguros pagados por adelantado", "asset_prepayments"), c(12, 1, "5.04.020.001", "Gasto de seguros", "expense"),
      c(13, 1, "5.04.021.001", "Licencias de software", "expense"), c(21, 2, "1.01.005.001", "Alquileres prepagados", "asset_prepayments"), c(22, 2, "5.04.015.001", "Alquileres", "expense")],
    "account.journal": [{ id: 5, name: "Operaciones varias", type: "general", company_id: C1 }, { id: 6, name: "Varios", type: "general", company_id: C2 }],
    "account.move": [],
    "account.move.line": [{ id: 1, company_id: C1, account_id: [12, "Gasto de seguros"], date: "2026-03-05", parent_state: "posted", balance: 0 },
      { id: 2, company_id: C2, account_id: [22, "Alquileres"], date: "2026-03-02", parent_state: "posted", balance: 0 }],
    "taerp.fiscal.period": [{ id: 1, company_id: C1, name: "2026", date_from: "2026-01-01", date_to: "2026-12-31", state: "open" },
      { id: 2, company_id: C2, name: "2026", date_from: "2026-01-01", date_to: "2026-12-31", state: "open" }]
  };
}
const armar = (datos, cfg = {}) => ({ cfg, crearCliente: ag => new OdooSimulado(datos, { permitirEscritura: ag.meta.escribe === true }) });

test("Calendario y lectura de la hoja: cuotas que suman exacto, montos y meses en formatos de Costa Rica", () => {
  const cal = calendario({ monto: 1000000, meses: 3, inicio: "2025-12" });
  assert.deepEqual(cal.map(c => [c.mes, c.cuota]), [["2025-12", 333333.33], ["2026-01", 333333.33], ["2026-02", 333333.34]]);
  assert.deepEqual(pendientes({ monto: 1000000, meses: 3, inicio: "2025-12" }, "2026-01", new Set(["2025-12"])).map(c => c.numero), [2]);
  assert.equal(leerMonto("₡1.250.000,50"), 1250000.5);
  assert.equal(leerMonto("1,250,000.50"), 1250000.5);
  assert.equal(leerMonto("1250000"), 1250000);
  assert.equal(leerMonto("1.200.000"), 1200000);
  assert.equal(leerMonto("600.000"), 600000, "en Costa Rica el punto separa miles");
  assert.equal(leerMonto("1250,5"), 1250.5);
  assert.equal(leerMes("03/2026"), "2026-03");
  assert.equal(leerMes("15/3/2026"), "2026-03");
  assert.equal(leerMes("2026-3"), "2026-03");
  const filas = leerCSV('Compañía;Descripción;Cuenta activo;Cuenta gasto;Monto;Meses;Inicio\nCeiba;"Póliza INS; vehículos";1.01.005.001;5.04.020.001;1.200.000;12;01/2026\n');
  assert.equal(filas[0].compania, "Ceiba");
  assert.equal(filas[0].descripcion, "Póliza INS; vehículos", "el separador dentro de comillas no parte la celda");
  assert.equal(filas[0].cuenta_activo, "1.01.005.001");
});

test("Importar: valida compañía y cuentas en el plan de cada una; con probar no guarda", async () => {
  const datos = instancia(), db = new BaseDeDatos(":memory:");
  const csv = [
    "compania,descripcion,cuenta_activo,cuenta_gasto,monto,meses,inicio,referencia",
    "Ceiba,Póliza INS vehículos,1.01.5.1,5.04.20.1,1200000,12,2026-01,FE-0001",
    "Lirio,Alquiler bodega adelantado,1.01.005.001,5.04.015.001,600000,6,2025-12,",
    "Lirio,Licencia que no existe aquí,1.01.005.001,5.04.021.001,100000,12,2026-01,",
    "Nadie,X,1,2,10,1,2026-01,"
  ].join("\n");
  const prueba = await srv.importar({ corridas: armar(datos), db, texto: csv, quien: "victor", probar: true });
  assert.deepEqual([prueba.filas, prueba.validos, prueba.creados, prueba.errores.length], [4, 2, 0, 2]);
  assert.match(prueba.errores.find(e => e.fila === 4).errores.join(), /5.04.021.001 no existe .* Lirio/);
  assert.match(prueba.errores.find(e => e.fila === 5).errores.join(), /Compañía «Nadie»/);
  assert.equal(db.diferidos().length, 0);
  const real = await srv.importar({ corridas: armar(datos), db, texto: csv, quien: "victor" });
  assert.equal(real.creados, 2);
  assert.equal(db.diferidos().find(d => d.compania === "Ceiba").cuenta_activo, "1.01.005.001 Seguros pagados por adelantado", "el código canónico encuentra 1.01.5.1");
});

test("Agente: asiento del mes por compañía con cuotas atrasadas; lo registrado en Odoo no se repite", async () => {
  const datos = instancia(), db = new BaseDeDatos(":memory:");
  await srv.registrar({ corridas: armar(datos), db, quien: "victor", d: { compania: 1, descripcion: "Póliza INS", cuentaActivo: "1.01.005.001", cuentaGasto: "5.04.020.001", monto: 1200000, meses: 12, inicio: "2026-01" } });
  await srv.registrar({ corridas: armar(datos), db, quien: "victor", d: { compania: "Lirio", descripcion: "Alquiler bodega", cuentaActivo: "1.01.005.001", cuentaGasto: "5.04.015.001", monto: 600000, meses: 6, inicio: "2026-02" } });
  assert.match((await srv.registrar({ corridas: armar(datos), db, quien: "v", d: { compania: 1, descripcion: "x", cuentaActivo: "1.01.005.001", cuentaGasto: "9.9", monto: 1, meses: 1, inicio: "2026-01" } })).error, /9.9 no existe/);

  const correr = mes => agente.ejecutar({ odoo: new OdooSimulado(datos), cfg: { DIFERIDOS_MES: mes }, log: silencio, db });
  let r = await correr("2026-02");
  const ceiba = r.asientosSugeridos.find(a => a.companiaId === 1);
  assert.deepEqual(ceiba.lineas.map(l => [l.cuentaId, l.debito, l.credito, l.meses.join()]), [[12, 200000, 0, "2026-01,2026-02"], [11, 0, 200000, "2026-01,2026-02"]], "enero atrasado + febrero");
  assert.match(ceiba.lineas[0].descripcion, /cuotas 1–2\/12/);
  assert.equal(ceiba.diarioId, 5);
  assert.equal(r.diferidos.find(d => d.companiaId === 1).estado, "atrasado");
  assert.equal(r.diferidos.find(d => d.companiaId === 2).estado, "cuota-del-mes");

  // se aprueba y se crea el de Ceiba; marzo ya no repite enero ni febrero
  db.sincronizarAsientos(1, r.asientosSugeridos, { origen: "diferidos", reemplazarAnteriores: true });
  const a = db.asientos().find(x => x.clave === "diferidos|1|2026-02");
  db.decidirAsiento(a.id, "aprobada", "victor");
  const x = await asientos.aplicar({ corridas: armar(datos, { PERMITIR_ESCRITURA_ASIENTOS: "si", ASIENTOS_PUBLICAR: "si" }), db, id: a.id, quien: "victor" });
  assert.equal(x.ok, true, JSON.stringify(x));
  r = await correr("2026-03");
  db.sincronizarAsientos(2, r.asientosSugeridos, { origen: "diferidos", reemplazarAnteriores: true });
  const marzo = r.asientosSugeridos.find(a => a.companiaId === 1);
  assert.deepEqual(marzo.lineas[0].meses, ["2026-03"]);
  assert.equal(marzo.lineas[0].debito, 100000);
  const lirio = r.asientosSugeridos.find(a => a.companiaId === 2);
  assert.deepEqual(lirio.lineas[0].meses, ["2026-02", "2026-03"], "Lirio no se aplicó: marzo incluye febrero");
  assert.equal(db.asientos({ estado: "obsoleta" }).find(o => o.clave === "diferidos|2|2026-02") != null, true, "el de febrero de Lirio queda reemplazado");
  assert.equal(r.diferidos.find(d => d.companiaId === 1).registradas, 2);
  assert.equal(r.diferidos.find(d => d.companiaId === 1).saldo, 1000000);
});
