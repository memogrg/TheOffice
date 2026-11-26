// Controles de cierre de la firma (B3): candados, arrastre retroactivo, salarios en cero, cobros sin
// contacto, variación ±15 %; y el candado en la validación de asientos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OdooSimulado } from "../src/odoo-simulado.js";
import { BaseDeDatos } from "../src/servicio/db.js";
import * as controles from "../src/agents/controles.js";
import { validar } from "../src/servicio/asientos.js";

const C1 = [1, "Ceiba"], C2 = [2, "Lirio"];
const silencio = () => {};

function instancia() {
  let id = 0;
  const mv = (cia, name, date, create, write, extra = {}) => ({ id: ++id, company_id: cia, name, date, create_date: create, write_date: write, state: "posted", amount_total: 100000, move_type: "entry", journal_id: [7, "Diario"], write_uid: [2, "Admin"], ...extra });
  const ln = (cia, cuenta, nombre, date, balance, extra = {}) => ({ id: 1000 + (++id), company_id: cia, account_id: [cuenta, nombre], date, parent_state: "posted", balance, partner_id: [9, "Tercero"], ...extra });
  const lineas = [];
  // Electricidad de Ceiba: 100 000 cada mes desde septiembre 2024 (incluye diciembres), febrero 2026 = 220 000
  for (let i = 18; i >= 1; i--) { const d = new Date(Date.UTC(2026, 1 - i, 15)); lineas.push(ln(C1, 50, "Electricidad", d.toISOString().slice(0, 10), i === 6 ? 300000 : 100000)); }   // un mes raro en el historial (nov 2025 no es diciembre)
  lineas.push(ln(C1, 50, "Electricidad", "2026-02-10", 220000));
  // Teléfono de Ceiba: estable (no sale)
  for (let i = 18; i >= 0; i--) { const d = new Date(Date.UTC(2026, 1 - i, 10)); lineas.push(ln(C1, 51, "Teléfono", d.toISOString().slice(0, 10), 20000)); }
  // Salarios por pagar: Ceiba con saldo, Lirio en cero
  lineas.push(ln(C1, 60, "Salarios por pagar", "2026-02-28", -450000), ln(C2, 60, "Salarios por pagar", "2026-02-15", -300000), ln(C2, 60, "Salarios por pagar", "2026-02-28", 300000));
  // Cobros sin contacto en febrero (Ceiba)
  lineas.push(ln(C1, 20, "Clientes", "2026-02-12", -50000, { partner_id: false }), ln(C1, 20, "Clientes", "2026-02-13", -1000, { partner_id: false }));
  return {
    "res.company": [{ id: 1, name: "Ceiba", fiscalyear_lock_date: false, hard_lock_date: false, tax_lock_date: false }, { id: 2, name: "Lirio", fiscalyear_lock_date: false, hard_lock_date: "2026-01-31", tax_lock_date: false }],
    "account.account": [{ id: 20, name: "Clientes", account_type: "asset_receivable" }, { id: 50, name: "Electricidad", account_type: "expense" }, { id: 51, name: "Teléfono", account_type: "expense" }, { id: 60, name: "Salarios por pagar", account_type: "liability_current" }],
    "account.journal": [{ id: 7, name: "Diario", type: "general", company_id: C1 }, { id: 8, name: "Diario Lirio", type: "general", company_id: C2 }],
    "account.move": [
      mv(C1, "ENE/1", "2026-01-10", "2026-01-12 10:00:00", "2026-01-12 10:00:00"),        // a tiempo
      mv(C1, "ENE/2", "2026-01-20", "2026-02-25 09:00:00", "2026-02-25 09:00:00"),        // creado después del 20 de febrero: tardío
      mv(C1, "ENE/3", "2026-01-25", "2026-02-02 09:00:00", "2026-03-01 15:30:00"),        // modificado después: tardío
      mv(C1, "DIC/1", "2025-12-05", "2025-12-06 09:00:00", "2026-01-25 09:00:00"),        // diciembre tocado el 25 de enero: tardío
      mv(C2, "ENE/9", "2026-01-15", "2026-02-27 09:00:00", "2026-02-27 09:00:00"),        // Lirio: tardío también (el candado se puso después)
      mv(C1, "FEB/1", "2026-02-10", "2026-03-10 09:00:00", "2026-03-10 09:00:00")         // el mes evaluado no se revisa
    ],
    "account.move.line": lineas
  };
}

test("Controles: candados, asientos tardíos por mes, salarios con saldo, cobros sin contacto y variación de ±15 %", async () => {
  const odoo = new OdooSimulado(instancia());
  const r = await controles.ejecutar({ odoo, cfg: { CONTROLES_MES: "2026-02" }, log: silencio });
  assert.equal(odoo.escrituras, 0);
  // candados: Ceiba sin ninguno; Lirio con el duro al 31 de enero (al día para entregar enero; al cerrar febrero tendrá que moverlo)
  const cand = Object.fromEntries(r.candados.map(c => [c.compania, c]));
  assert.equal(cand.Ceiba.estado, "sin-candado"); assert.equal(cand.Lirio.estado, "al-dia"); assert.equal(cand.Lirio.candado, "2026-01-31"); assert.equal(cand.Lirio.alCerrar, "2026-02-28");
  // arrastre retroactivo: enero de Ceiba 2 (uno creado tarde, uno modificado), diciembre de Ceiba 1, enero de Lirio 1; febrero no cuenta
  const retro = Object.fromEntries(r.retroactivos.map(g => [`${g.compania}|${g.mes}`, g]));
  assert.equal(retro["Ceiba|2026-01"].asientos, 2); assert.equal(retro["Ceiba|2026-01"].creadosTarde, 1); assert.equal(retro["Ceiba|2026-01"].modificadosTarde, 1);
  assert.equal(retro["Ceiba|2026-01"].ultimaModificacion, "2026-03-01 15:30"); assert.equal(retro["Ceiba|2026-01"].corteReal, false);
  assert.equal(retro["Ceiba|2025-12"].asientos, 1); assert.equal(retro["Lirio|2026-01"].asientos, 1);
  assert.equal(r.totales.retroactivos, 4); assert.ok(!r.retroactivos.some(g => g.mes === "2026-02"));
  // salarios: solo Ceiba
  assert.deepEqual(r.salarios.map(s => [s.compania, s.saldo]), [["Ceiba", 450000]]);
  // cobros sin contacto
  assert.deepEqual(r.sinContacto.map(x => [x.compania, x.lineas]), [["Ceiba", 2]]);
  // variación: Electricidad +120 % contra ~111 000 de promedio (el mes raro sube el promedio); Teléfono no
  assert.equal(r.variaciones.length, 1);
  const v = r.variaciones[0]; assert.equal(v.cuenta, "Electricidad"); assert.equal(v.actual, 220000); assert.ok(v.variacionPct > 90 && v.variacionPct < 110, String(v.variacionPct)); assert.ok(v.mesesConDato >= 15);
  assert.ok(r.alertas.some(a => /asientos de meses ya entregados/.test(a.texto)));
  assert.ok(r.alertas.some(a => /sin fecha de bloqueo/.test(a.texto)));
});

test("Controles: con la fecha real del cierre en la Oficina, el corte es esa fecha y no el día 20", async () => {
  const db = new BaseDeDatos(":memory:");
  db.cerrarMes(1, "Ceiba", "2026-01", "victor", null, {});       // Ceiba entregó enero… hoy (después de todos los asientos del simulado)
  const r = await controles.ejecutar({ odoo: new OdooSimulado(instancia()), cfg: { CONTROLES_MES: "2026-02" }, log: silencio, db });
  assert.ok(!r.retroactivos.some(g => g.compania === "Ceiba" && g.mes === "2026-01"), "nada de enero de Ceiba fue tocado después del cierre real");
  assert.ok(r.retroactivos.some(g => g.compania === "Lirio" && g.mes === "2026-01"), "Lirio sigue con el corte del día 20");
});

test("Validar un asiento: ni en un mes bloqueado en Odoo ni en un mes cerrado en la Oficina", async () => {
  const odoo = new OdooSimulado(instancia());
  const db = new BaseDeDatos(":memory:");
  const asiento = (cia, fecha) => ({ compania_id: cia, diario_id: cia === 2 ? 8 : 7, fecha, lineas: [{ cuentaId: 50, debito: 1000, credito: 0 }, { cuentaId: 60, debito: 0, credito: 1000 }] });
  const enLirioEnero = await validar(odoo, asiento(2, "2026-01-31"), { db });
  assert.equal(enLirioEnero.ok, false); assert.match(enLirioEnero.errores.join(" "), /periodo bloqueado en Odoo \(candado al 2026-01-31\)/);
  assert.equal((await validar(odoo, asiento(2, "2026-02-01"), { db })).ok, true, "el día siguiente al candado sí");
  db.cerrarMes(1, "Ceiba", "2026-02", "victor", null, {});
  const enCeibaFeb = await validar(odoo, asiento(1, "2026-02-15"), { db });
  assert.equal(enCeibaFeb.ok, false); assert.match(enCeibaFeb.errores.join(" "), /2026-02 ya está cerrado en la Oficina/);
  assert.equal((await validar(odoo, asiento(1, "2026-03-01"), { db })).ok, true);
});
