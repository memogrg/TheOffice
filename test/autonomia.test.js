// Fase 4: de NIVELES a AUTÓNOMO por tipo × compañía, medido con las decisiones de las personas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseDeDatos } from "../src/servicio/db.js";
import { Corridas } from "../src/servicio/corridas.js";
import { OdooSimulado } from "../src/odoo-simulado.js";
import * as autonomia from "../src/servicio/autonomia.js";
import { RUTAS_CON_SESION } from "../src/servicio/seguridad.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const linea = (cuentaId, debito, credito) => ({ cuentaId, cuenta: String(cuentaId), descripcion: "x", debito, credito, rol: cuentaId ? "gasto" : "contrapartida" });
const sugerido = (cia, mes, extra = {}) => ({ clave: `cambiario|${cia}|${mes}`, origen: "cambiario", mes, companiaId: cia, compania: `Cía ${cia}`, fecha: `${mes}-28`,
  diarioId: 70 + cia, diario: "Diferencias", referencia: `Diferencial ${mes}`, motivo: "m", lineas: [linea(600, 100, 0), linea(500, 0, 100)], ...extra });
function proponer(db, s) { db.sincronizarAsientos(null, [s], { origen: s.origen }); return db.asientos({ estado: "propuesta" }).find(a => a.clave === s.clave && a.mes === s.mes); }
function decidir(db, s, como = "aprobada", quien = "victor") { const a = proponer(db, s); db.decidirAsiento(a.id, como, quien); return a; }

function odooSim(extra = {}) {
  return {
    "res.company": [1, 2, 3].map(id => ({ id, name: `Cía ${id}` })),
    "account.account": [{ id: 500, code: "1-01", name: "Banco", company_ids: [1, 2, 3] }, { id: 600, code: "6-01", name: "Pérdida cambiaria", company_ids: [1, 2, 3] }],
    "account.journal": [1, 2, 3].map(c => ({ id: 70 + c, name: "Diferencias", company_id: [c, `Cía ${c}`], type: "general" })),
    "account.move": [], "account.move.line": [], ...extra
  };
}

test("Candidato: dos meses seguidos sin correcciones; corregido, rechazado o meses salteados no", () => {
  const db = new BaseDeDatos(":memory:");
  decidir(db, sugerido(1, "2026-01")); decidir(db, sugerido(1, "2026-02"));
  decidir(db, sugerido(2, "2026-01"));
  const e = proponer(db, sugerido(2, "2026-02"));
  db.editarAsiento(e.id, { fecha: "2026-02-27" }, "victor"); db.decidirAsiento(e.id, "aprobada", "victor");
  decidir(db, sugerido(3, "2026-01")); decidir(db, sugerido(3, "2026-03"));
  decidir(db, sugerido(1, "2026-02", { clave: "cierre|1|ccss", origen: "cierre" }), "rechazada");
  db.correr("INSERT INTO asientos (clave, origen, mes, compania_id, compania, fecha, lineas, propuso, creado_en, estado, decidio) VALUES ('d','director','2026-02',1,'Cía 1','2026-02-01','[]','director','x','aprobada','memo')");

  const h = autonomia.historial(db, {});
  const de = (tipo, cia) => h.find(f => f.tipo === tipo && f.companiaId === cia);
  assert.equal(de("cambiario", 1).nivel, "candidato");
  assert.match(de("cambiario", 1).motivo, /2026-01 y 2026-02 sin correcciones/);
  assert.equal(de("cambiario", 2).nivel, "niveles");
  assert.match(de("cambiario", 2).motivo, /1 corregidas/);
  assert.match(de("cambiario", 3).motivo, /no son seguidos/);
  assert.match(de("cierre", 1).motivo, /solo 2026-02/);
  assert.equal(h.some(f => f.tipo === "director"), false, "lo dictado al Director nunca es autónomo");
  assert.equal(h[0].nivel, "candidato", "los candidatos primero");
  assert.equal(autonomia.historial(db, { AUTONOMIA_MINIMO: "2" }).find(f => f.tipo === "cambiario" && f.companiaId === 1).nivel, "niveles", "con mínimo 2 por mes no alcanza");

  assert.match(autonomia.otorgar({ db, cfg: {}, tipo: "cambiario", companiaId: 2, quien: "memo" }).error, /Todavía no/);
  const ok = autonomia.otorgar({ db, cfg: {}, tipo: "cambiario", companiaId: 1, nota: "dos cierres limpios", quien: "memo" });
  assert.ok(ok.id);
  assert.match(ok.mensaje, /botón/);
  assert.equal(db.autonomias()[0].evidencia.length, 2, "queda la evidencia");
  assert.equal(autonomia.historial(db, {}).find(f => f.tipo === "cambiario" && f.companiaId === 1).nivel, "autonomo");
  assert.match(autonomia.otorgar({ db, cfg: {}, tipo: "cambiario", companiaId: 1, quien: "memo" }).error, /Ya es autónomo/);
  assert.ok(RUTAS_CON_SESION.some(re => re.test("/api/autonomia/otorgar")), "desde afuera, otorgar pide sesión personal");
});

test("Autónomo: lo nuevo se aprueba solo si pasa las validaciones; lo incompleto queda para una persona", async () => {
  const db = new BaseDeDatos(":memory:");
  decidir(db, sugerido(1, "2026-01")); decidir(db, sugerido(1, "2026-02"));
  autonomia.otorgar({ db, cfg: {}, tipo: "cambiario", companiaId: 1, quien: "memo" });
  db.sincronizarAsientos(null, [sugerido(1, "2026-03"), sugerido(1, "2026-03", { clave: "cambiario|1|2026-03|b", lineas: [linea(600, 50, 0), linea(null, 0, 50)] }), sugerido(2, "2026-03")], { origen: "cambiario" });
  const r = await autonomia.aprobarAutonomos({ db, corridas: null, odoo: new OdooSimulado(odooSim()), cfg: {} });
  assert.equal(r.aprobados, 1);
  assert.equal(r.retenidos.length, 1);
  assert.match(r.retenidos[0].motivo, /falta la cuenta/);
  const aprob = db.asientos({ estado: "aprobada" }).filter(a => a.mes === "2026-03");
  assert.equal(aprob.length, 1);
  assert.equal(aprob[0].decidio, autonomia.QUIEN);
  assert.equal(db.asientos({ estado: "propuesta" }).length, 2, "la incompleta y la de otra compañía siguen esperando");
  const h = autonomia.historial(db, {}).find(f => f.tipo === "cambiario" && f.companiaId === 1);
  assert.equal(h.meses["2026-03"].solas, 1, "lo aprobado solo no cuenta como decisión de una persona");
});

test("Con AUTONOMIA_APLICAR=si se crea en Odoo; si falla, ese tipo × compañía pierde la autonomía", async () => {
  const armar = (sim) => {
    const raiz = mkdtempSync(join(tmpdir(), "autonomia-"));
    writeFileSync(join(raiz, "sim.json"), JSON.stringify(sim));
    const db = new BaseDeDatos(":memory:");
    const cfg = { ODOO_SIMULADO: "sim.json", AUTONOMIA_APLICAR: "si", PERMITIR_ESCRITURA_ASIENTOS: "si" };
    const corridas = new Corridas({ db, cfg, raiz, raizProyecto: RAIZ });
    decidir(db, sugerido(1, "2026-01")); decidir(db, sugerido(1, "2026-02"));
    autonomia.otorgar({ db, cfg, tipo: "cambiario", companiaId: 1, quien: "memo" });
    proponer(db, sugerido(1, "2026-03"));
    return { db, cfg, corridas, odoo: new OdooSimulado(sim) };
  };
  const bien = armar(odooSim());
  const r = await autonomia.aprobarAutonomos({ ...bien });
  assert.deepEqual([r.aprobados, r.aplicados, r.revocadas], [1, 1, 0]);
  assert.equal(bien.db.asientos({ estado: "aplicada" }).find(a => a.mes === "2026-03").decidio, autonomia.QUIEN);

  const sinMovimientos = odooSim(); delete sinMovimientos["account.move"];
  const mal = armar(sinMovimientos);
  const r2 = await autonomia.aprobarAutonomos({ ...mal });
  assert.deepEqual([r2.aprobados, r2.aplicados, r2.revocadas], [1, 0, 1]);
  const [rev] = mal.db.autonomias({ estado: "revocada" });
  assert.match(rev.motivo, /Falló al crear el asiento/);
  const h = autonomia.historial(mal.db, {}).find(f => f.tipo === "cambiario" && f.companiaId === 1);
  assert.equal(h.nivel, "niveles");
  assert.match(h.motivo, /Se revocó|fallidas/);
});
