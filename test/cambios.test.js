// Cambios masivos al plan de cuentas (objetivo 5): previsualizar en N compañías, aprobar,
// ejecutar solo lo incluido y verificar al releer. Un mismo código puede ser otra cuenta en otro
// cliente: la previsualización lo deja fuera o lo marca para revisar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OdooSimulado } from "../src/odoo-simulado.js";
import { BaseDeDatos } from "../src/servicio/db.js";
import * as cambios from "../src/servicio/cambios.js";

function instancia() {
  const c = (id, cia, code, name, account_type = "expense") => ({ id, code, name, account_type, deprecated: false, company_ids: [cia] });
  return {
    "res.company": [{ id: 1, name: "Uno" }, { id: 2, name: "Dos" }, { id: 3, name: "Tres" }, { id: 4, name: "Cuatro" }],
    "account.account": [
      c(11, 1, "5.04.017.001.000.000", "Alimentación"), c(12, 1, "5.04.099", "Otros gastos"), c(13, 1, "1.01.012", "Créditos fiscales", "asset_current"),
      c(21, 2, "5.04.17.01", "Alimentación"), c(22, 2, "5.04.17.02", "Viáticos"),
      c(31, 3, "5.04.17.01", "Combustibles"),
      c(41, 4, "5.04.01", "Salarios")
    ],
    "account.move.line": [{ id: 1, account_id: [12, "Otros gastos"], date: new Date().toISOString().slice(0, 10), company_id: [1, "Uno"], parent_state: "posted" }]
  };
}
const armar = (datos, cfg = {}) => ({ cfg, crearCliente: ag => new OdooSimulado(datos, { permitirEscritura: ag.meta.escribe === true }) });

test("Previsualizar: listo, otro significado, no existe, conflicto, rama ausente y cuenta en uso", async () => {
  const datos = instancia(), db = new BaseDeDatos(":memory:");
  const r = await cambios.proponer({ corridas: armar(datos), db, propuso: "victor",
    instruccion: { tipo: "renombrar", codigo: "5.04.17.01", nombreActual: "Alimentación", nuevoNombre: "Alimentación y viáticos", motivo: "unificar nombres" } });
  assert.equal(r.error, undefined, r.error);
  const it = Object.fromEntries(db.cambio(r.cambio.id).items.map(i => [i.compania, i]));
  assert.equal(it.Uno.estado, "listo", "5.04.017.001.000.000 es el mismo código que 5.04.17.01");
  assert.equal(it.Dos.estado, "listo");
  assert.equal(it.Tres.estado, "otro-significado");
  assert.equal(it.Tres.incluido, false);
  assert.equal(it.Cuatro.estado, "no-existe");
  assert.equal(r.cambio.resumen.incluidos, 2);

  // sin nombre esperado, la minoría queda para revisar (incluida, pero marcada)
  const r2 = await cambios.proponer({ corridas: armar(datos), db, propuso: "victor", instruccion: { tipo: "renombrar", codigo: "5.04.17.01", nuevoNombre: "X", motivo: "m" } });
  assert.equal(db.cambio(r2.cambio.id).items.find(i => i.compania === "Tres").estado, "revisar");

  const r3 = await cambios.proponer({ corridas: armar(datos), db, propuso: "victor", instruccion: { tipo: "recodificar", codigo: "5.04.17.01", nuevoCodigo: "5.04.17.02", motivo: "m" } });
  assert.equal(db.cambio(r3.cambio.id).items.find(i => i.compania === "Dos").estado, "conflicto");

  const r4 = await cambios.proponer({ corridas: armar(datos), db, propuso: "victor", instruccion: { tipo: "crear", codigo: "1.01.012.003", nuevoNombre: "Saldo a favor IVA", tipoCuenta: "asset_current", motivo: "m" } });
  const i4 = Object.fromEntries(db.cambio(r4.cambio.id).items.map(i => [i.compania, i.estado]));
  assert.deepEqual(i4, { Uno: "listo", Dos: "revisar", Tres: "revisar", Cuatro: "revisar" }, "solo Uno tiene la cuenta madre 1.01.012");

  const r5 = await cambios.proponer({ corridas: armar(datos), db, propuso: "victor", instruccion: { tipo: "obsoleta", codigo: "5.04.99", companias: [1], motivo: "comodín" } });
  const i5 = db.cambio(r5.cambio.id).items;
  assert.equal(i5.length, 1, "solo las compañías pedidas");
  assert.equal(i5[0].estado, "revisar");
  assert.match(i5[0].motivo, /últimos 90 días/);

  assert.match((await cambios.proponer({ corridas: armar(datos), db, propuso: "v", instruccion: { tipo: "crear", codigo: "1.9", nuevoNombre: "x", motivo: "m" } })).error, /tipo de cuenta/);
});

test("Ejecutar: bloqueado sin permiso; con permiso cambia solo lo incluido, revalida y verifica", async () => {
  const datos = instancia(), db = new BaseDeDatos(":memory:");
  const { cambio } = await cambios.proponer({ corridas: armar(datos), db, propuso: "victor",
    instruccion: { tipo: "renombrar", codigo: "5.04.17.01", nombreActual: "Alimentación", nuevoNombre: "Alimentación y viáticos", motivo: "unificar" } });
  assert.equal(db.incluirEnCambio(cambio.id, 3, true, "victor"), false, "no se puede incluir una compañía donde el código es otra cuenta");
  assert.equal(db.incluirEnCambio(cambio.id, 2, false, "victor"), true);
  let x = await cambios.aplicar({ corridas: armar(datos, { PERMITIR_ESCRITURA_CUENTAS: "si" }), db, id: cambio.id, quien: "victor" });
  assert.match(x.error, /solo se ejecuta uno aprobado/);
  db.decidirCambio(cambio.id, "aprobada", "victor");
  x = await cambios.aplicar({ corridas: armar(datos, { PERMITIR_ESCRITURA: "si", PERMITIR_ESCRITURA_ASIENTOS: "si" }), db, id: cambio.id, quien: "victor" });
  assert.match(x.error, /PERMITIR_ESCRITURA_CUENTAS/);
  x = await cambios.aplicar({ corridas: armar(datos, { PERMITIR_ESCRITURA_CUENTAS: "si" }), db, id: cambio.id, quien: "victor" });
  assert.deepEqual([x.aplicados, x.fallos, x.estado], [1, 0, "aplicada"]);
  const cta = id => datos["account.account"].find(c => c.id === id);
  assert.equal(cta(11).name, "Alimentación y viáticos");
  assert.equal(cta(21).name, "Alimentación", "Dos quedó excluida");
  assert.equal(cta(31).name, "Combustibles", "Tres es otra cuenta");
  const final = db.cambio(cambio.id);
  assert.equal(final.items.find(i => i.compania === "Uno").estado, "aplicado");
  assert.equal(final.items.find(i => i.compania === "Uno").despues.nombre, "Alimentación y viáticos");

  // crear: nace en la compañía, con su código
  const c2 = await cambios.proponer({ corridas: armar(datos), db, propuso: "victor", instruccion: { tipo: "crear", codigo: "1.01.012.003", nuevoNombre: "Saldo a favor IVA", tipoCuenta: "asset_current", companias: [1], motivo: "m" } });
  db.decidirCambio(c2.cambio.id, "aprobada", "victor");
  x = await cambios.aplicar({ corridas: armar(datos, { PERMITIR_ESCRITURA_CUENTAS: "si" }), db, id: c2.cambio.id, quien: "victor" });
  assert.equal(x.aplicados, 1);
  assert.ok(datos["account.account"].some(c => c.code === "1.01.012.003" && c.name === "Saldo a favor IVA"));
});
