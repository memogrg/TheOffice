// Activos fijos y depreciación (fase 3B, ítem 16): registro con lo ya depreciado a mano, asiento
// del mes con atrasados, no duplicar la depreciación hecha a mano, baja, y no repetir lo aplicado.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OdooSimulado } from "../src/odoo-simulado.js";
import { BaseDeDatos } from "../src/servicio/db.js";
import * as agente from "../src/agents/depreciacion.js";
import * as srv from "../src/servicio/activos.js";
import * as asientos from "../src/servicio/asientos.js";

const silencio = () => {};
const C1 = [1, "Puuk"], C2 = [2, "Aurora"];
function instancia() {
  const c = (id, cia, code, name, t) => ({ id, code, name, account_type: t, deprecated: false, company_ids: [cia] });
  return {
    "res.company": [{ id: 1, name: "Puuk" }, { id: 2, name: "Aurora" }],
    "account.account": [c(11, 1, "1.02.003", "Vehículos", "asset_fixed"), c(12, 1, "1.02.090.003", "Depreciación acumulada vehículos", "asset_fixed"), c(13, 1, "5.04.030", "Gasto por depreciación", "expense_depreciation"),
      c(21, 2, "1.02.004", "Equipo de cómputo", "asset_fixed"), c(22, 2, "1.02.090.004", "Depreciación acumulada cómputo", "asset_fixed"), c(23, 2, "5.04.030", "Gasto por depreciación", "expense_depreciation")],
    "account.journal": [{ id: 5, name: "Operaciones varias", type: "general", company_id: C1 }, { id: 6, name: "Varios", type: "general", company_id: C2 }],
    "account.move": [{ id: 800, name: "MISC/800", ref: "", state: "posted" }, { id: 900, name: "MISC/900", ref: "Depreciación febrero", state: "posted" }],
    "account.move.line": [
      { id: 1, company_id: C1, account_id: [13, "Gasto por depreciación"], date: "2026-01-31", parent_state: "posted", balance: 0, move_id: [800, "x"] },
      // Aurora ya depreció febrero a mano
      { id: 2, company_id: C2, account_id: [23, "Gasto por depreciación"], date: "2026-02-28", parent_state: "posted", balance: 50000, move_id: [900, "MISC/900"] }
    ],
    "taerp.fiscal.period": [{ id: 1, company_id: C1, name: "2026", date_from: "2026-01-01", date_to: "2026-12-31", state: "open" }]
  };
}
const armar = (datos, cfg = {}) => ({ cfg, crearCliente: ag => new OdooSimulado(datos, { permitirEscritura: ag.meta.escribe === true }) });

test("Registro e importación: vida en años, residual, lo ya depreciado afuera y cuentas por código", async () => {
  const datos = instancia(), db = new BaseDeDatos(":memory:");
  const r = await srv.registrar({ corridas: armar(datos), db, quien: "victor", d: { compania: "Puuk", descripcion: "Pickup Toyota", cuentaActivo: "1.02.003", cuentaAcumulada: "1.02.090.003",
    cuentaGasto: "5.04.030", costo: "18.000.000", residual: "6.000.000", vidaAnios: 10, inicio: "2025-07", hechoHasta: "2025-12" } });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.activo.vida_meses, 120);
  assert.equal(r.cuota, 100000, "(18 M − 6 M) / 120");
  assert.match((await srv.registrar({ corridas: armar(datos), db, quien: "v", d: { compania: 1, descripcion: "x", cuentaAcumulada: "1.02.090.003", cuentaGasto: "5.04.030", costo: 10, residual: 10, vidaMeses: 12, inicio: "2026-01" } })).error, /residual/);
  const csv = "Compañía;Activo;Categoría;Cuenta depreciación acumulada;Cuenta gasto depreciación;Costo;Valor residual;Vida útil años;Fecha adquisición;Depreciado hasta\n" +
    "Aurora;Laptops contabilidad;Cómputo;1.02.090.004;5.04.030;2.400.000;0;5;15/01/2026;\nAurora;Servidor;Cómputo;1.02.090.009;5.04.030;3.000.000;0;5;2026-01;\n";
  const imp = await srv.importar({ corridas: armar(datos), db, texto: csv, quien: "victor" });
  assert.deepEqual([imp.filas, imp.creados, imp.errores.length], [2, 1, 1]);
  assert.match(imp.errores[0].errores.join(), /1.02.090.009 no existe/);
  assert.equal(db.activos().find(a => a.compania === "Aurora").vida_meses, 60);
});

test("Agente: asiento con meses atrasados, no duplica lo depreciado a mano, baja y lo aplicado no se repite", async () => {
  const datos = instancia(), db = new BaseDeDatos(":memory:");
  const reg = d => srv.registrar({ corridas: armar(datos), db, quien: "victor", d });
  const pickup = (await reg({ compania: 1, descripcion: "Pickup", cuentaAcumulada: "1.02.090.003", cuentaGasto: "5.04.030", costo: 18000000, residual: 6000000, vidaMeses: 120, inicio: "2025-07", hechoHasta: "2025-12" })).activo;
  const moto = (await reg({ compania: 1, descripcion: "Moto", cuentaAcumulada: "1.02.090.003", cuentaGasto: "5.04.030", costo: 1200000, vidaMeses: 24, inicio: "2026-02" })).activo;
  await reg({ compania: 2, descripcion: "Laptops", cuentaAcumulada: "1.02.090.004", cuentaGasto: "5.04.030", costo: 2400000, vidaMeses: 48, inicio: "2026-01" });

  const correr = mes => agente.ejecutar({ odoo: new OdooSimulado(datos), cfg: { DEPRECIACION_MES: mes }, log: silencio, db });
  let r = await correr("2026-02");
  const puuk = r.asientosSugeridos.find(a => a.companiaId === 1);
  assert.deepEqual(puuk.lineas.map(l => [l.activoId, l.cuentaId, l.debito, l.credito, l.meses.join()]),
    [[pickup.id, 13, 200000, 0, "2026-01,2026-02"], [pickup.id, 12, 0, 200000, "2026-01,2026-02"], [moto.id, 13, 50000, 0, "2026-02"], [moto.id, 12, 0, 50000, "2026-02"]],
    "el pickup ya estaba depreciado a mano hasta diciembre: enero y febrero");
  assert.equal(r.asientosSugeridos.some(a => a.companiaId === 2), false, "Aurora ya depreció febrero a mano");
  assert.equal(r.duplicados[0].compania, "Aurora");
  const p = r.activos.find(a => a.id === pickup.id);
  assert.deepEqual([p.registradas, p.depreciado, p.valorEnLibros], [6, 600000, 17400000], "julio–diciembre hechos a mano");

  db.sincronizarAsientos(1, r.asientosSugeridos, { origen: "depreciacion", reemplazarAnteriores: true });
  const a = db.asientos().find(x => x.clave === "depreciacion|1|2026-02");
  db.decidirAsiento(a.id, "aprobada", "victor");
  const x = await asientos.aplicar({ corridas: armar(datos, { PERMITIR_ESCRITURA_ASIENTOS: "si", ASIENTOS_PUBLICAR: "si" }), db, id: a.id, quien: "victor" });
  assert.equal(x.ok, true, JSON.stringify(x));

  // la moto se vende en marzo: se deprecia marzo y después no
  db.darDeBajaActivo(moto.id, "2026-03", "victor", "vendida");
  r = await correr("2026-04");
  const abril = r.asientosSugeridos.find(a => a.companiaId === 1);
  assert.deepEqual(abril.lineas.filter(l => l.rol === "gasto").map(l => [l.activoId, l.meses.join()]), [[pickup.id, "2026-03,2026-04"], [moto.id, "2026-03"]],
    "no repite enero ni febrero; la moto solo hasta la baja; lo creado por la app no cuenta como depreciación a mano");
});
