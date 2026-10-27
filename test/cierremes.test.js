// Cierre de mes por cliente: junta las últimas corridas y la cola; pendientes, dar por bueno,
// cerrar solo sin pendientes, reabrir con motivo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BaseDeDatos } from "../src/servicio/db.js";
import { lista, ITEMS } from "../src/servicio/cierreMes.js";

const MES = "2026-02";
const CIAS = [{ id: 1, name: "Puuk" }, { id: 2, name: "Aurora" }];
const corrida = (db, agente, resultado) => { const id = db.abrirCorrida(agente); db.cerrarCorrida(id, resultado); };

function base() {
  const db = new BaseDeDatos(":memory:");
  corrida(db, "recepcion", { totales: {} });
  corrida(db, "diagnostico", { causas: [{ id: "periodo-fiscal", pendientes: [{ compania: "Puuk", detalle: "mes 2026-01", correos: 4 }], companias: [] }] });
  corrida(db, "recurrentes", { mes: MES, faltantes: [{ companiaId: 1, proveedor: "CNFL" }] });
  corrida(db, "documentos", { notas: [] });
  corrida(db, "bancos", { cuentas: [{ companiaId: 1, diario: "BNCR", estado: "atrasada", ultimaConciliada: "2025-12" }, { companiaId: 2, diario: "BAC", estado: "al-dia" }] });
  corrida(db, "cierre", { mes: MES, cuentas: [{ companiaId: 1, cuenta: "A pagar CCSS", estado: "arrastra", arrastre: 300000 }, { companiaId: 2, cuenta: "Créditos IVA", estado: "arrastra", arrastre: 5000, saldoAFavor: true }],
    iva: [{ companiaId: 2, malUbicado: 0, neto: 93000, resultado: "a pagar" }] });
  corrida(db, "estados", { mes: MES, companias: [{ companiaId: 1, borradores: 2, balance: { diferencia: 0 }, resultadosAnio: { utilidad: 10 } }, { companiaId: 2, borradores: 0, balance: { diferencia: 0 }, resultadosAnio: { utilidad: 5 } }],
    cajasNegativas: [], ladoContrario: [] });
  corrida(db, "cambiario", { mes: MES, companias: [{ companiaId: 2, ajustes: 1, neto: 65000 }] });
  return db;
}

test("Cierre de mes: qué falta por compañía, con lo que dicen los agentes y la cola", () => {
  const db = base();
  // Aurora: el asiento de diferencial está creado en Odoo
  const a = db.proponerAsiento({ clave: `cambiario|2|${MES}`, origen: "cambiario", companiaId: 2, compania: "Aurora", fecha: "2026-02-28", diarioId: 7, mes: MES,
    lineas: [{ cuentaId: 1, debito: 65000, credito: 0 }, { cuentaId: 2, debito: 0, credito: 65000 }] }, "agente:cambiario");
  db.decidirAsiento(a.id, "aprobada", "victor"); db.marcarAsiento(a.id, "aplicada", { moveId: 55, moveName: "MISC/55" });

  const l = lista(db, { mes: MES, companias: CIAS });
  const puuk = l.companias.find(c => c.compania === "Puuk"), aurora = l.companias.find(c => c.compania === "Aurora");
  const it = (f, id) => f.items.find(i => i.id === id);
  assert.equal(puuk.items.length, ITEMS.length);
  assert.equal(it(puuk, "periodos").estado, "pendiente");
  assert.match(it(puuk, "periodos").detalle, /mes 2026-01/);
  assert.equal(it(puuk, "recurrentes").estado, "pendiente");
  assert.equal(it(puuk, "bancos").estado, "pendiente");
  assert.match(it(puuk, "puente").detalle, /A pagar CCSS: ₡300/);
  assert.equal(it(puuk, "borradores").estado, "pendiente");
  assert.equal(it(puuk, "cambiario").estado, "na");
  assert.equal(it(puuk, "diferidos").estado, "na", "sin diferidos registrados");
  assert.equal(puuk.estado, "abierto");

  assert.equal(it(aurora, "puente").estado, "ok", "el crédito fiscal a favor no frena el cierre");
  assert.equal(it(aurora, "cambiario").estado, "ok");
  assert.match(it(aurora, "cambiario").detalle, /MISC\/55/);
  assert.equal(it(aurora, "iva").estado, "ok");
  assert.equal(aurora.pendientes, 0);
  assert.equal(aurora.estado, "listo");
  assert.equal(l.companias[0].compania, "Puuk", "las abiertas primero");

  // sin corrida del mes: «sin datos» (cuenta como pendiente)
  const marzo = lista(db, { mes: "2026-03", companias: CIAS }).companias.find(c => c.compania === "Aurora");
  assert.equal(marzo.items.find(i => i.id === "puente").estado, "sin-datos");
});

test("Dar por bueno, cerrar solo sin pendientes, la foto queda y reabrir pide motivo", () => {
  const db = base();
  const pendientes = () => lista(db, { mes: MES, companias: CIAS, companiaId: 1 }).companias[0];
  let p = pendientes();
  for (const i of p.items.filter(i => i.estado === "pendiente")) db.revisarItemCierre(1, "Puuk", MES, i.id, "victor", `visto: ${i.id}`);
  p = pendientes();
  assert.equal(p.pendientes, 0);
  assert.equal(p.items.find(i => i.id === "bancos").estado, "revisado");
  assert.equal(p.items.find(i => i.id === "bancos").revisado.nota, "visto: bancos");
  assert.equal(db.cerrarMes(1, "Puuk", MES, "victor", "ok", p.items), true);
  assert.equal(lista(db, { mes: MES, companias: CIAS, companiaId: 1 }).companias[0].estado, "cerrado");
  assert.equal(db.cierreMes(1, MES).foto.length, ITEMS.length);
  assert.equal(db.revisarItemCierre(1, "Puuk", MES, "iva", "victor", "x"), false, "cerrado no se toca");
  assert.equal(db.reabrirMes(1, MES, "victor", "llegó la factura de la CNFL"), true);
  assert.equal(lista(db, { mes: MES, companias: CIAS, companiaId: 1 }).companias[0].estado, "listo");
});
