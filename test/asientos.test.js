// Fase 3B: asientos propuestos. Cierre los sugiere con la contrapartida que la cuenta usó antes;
// la cola los guarda sin duplicar; un contable aprueba; solo con PERMITIR_ESCRITURA_ASIENTOS=si se
// crean en Odoo (en borrador, salvo ASIENTOS_PUBLICAR=si) y se verifican al releer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OdooSimulado } from "../src/odoo-simulado.js";
import * as cierre from "../src/agents/cierre.js";
import { BaseDeDatos } from "../src/servicio/db.js";
import * as asientos from "../src/servicio/asientos.js";
import { instancia } from "./simulado/asientos.js";

const silencio = () => {};

const correrCierre = async datos => cierre.ejecutar({ odoo: new OdooSimulado(datos), cfg: { CIERRE_MES: "2026-02", CIERRE_VENTANA: 2 }, log: silencio });

test("Cierre sugiere el asiento que liquida lo que arrastra, con la contrapartida que la cuenta usó antes", async () => {
  const r = await correrCierre(instancia());
  assert.equal(r.errorAsientos, null);
  const sal = r.asientosSugeridos.find(a => a.clave === "cierre|1|101");
  assert.ok(sal, "salarios de la compañía uno");
  assert.equal(sal.fecha, "2026-02-28");
  assert.deepEqual(sal.lineas.map(l => [l.cuentaId, l.debito, l.credito]), [[101, 1000000, 0], [109, 0, 1000000]]);
  assert.equal(sal.diarioId, 10, "el diario de los pagos anteriores");
  assert.match(sal.lineas[1].fuente, /2 pagos anteriores/);
  assert.equal(sal.porDefinir, false);

  const iva = r.asientosSugeridos.find(a => a.clave === "cierre|1|iva");
  assert.deepEqual(iva.lineas.map(l => [l.cuentaId, l.debito, l.credito, l.rol]),
    [[103, 100000, 0, "puente"], [104, 0, 40000, "compensacion"], [null, 0, 60000, "contrapartida"]], "compensa el crédito y el resto se paga; dos bancos sin historial → por definir");
  assert.equal(iva.porDefinir, true);

  const ccss = r.asientosSugeridos.find(a => a.clave === "cierre|2|102");
  assert.equal(ccss.porDefinir, true, "dos bancos y ningún pago anterior: lo elige una persona");
  assert.equal(r.totales.asientosSugeridos, 3);
  assert.ok(r.alertas.some(a => /asientos de liquidación propuestos/.test(a.texto)));
});

test("La cola no duplica: actualiza el propuesto, respeta el banco elegido, no repite lo rechazado y marca obsoleto lo que ya no sale", async () => {
  const db = new BaseDeDatos(":memory:");
  const r = await correrCierre(instancia());
  assert.deepEqual(db.sincronizarAsientos(1, r.asientosSugeridos), { nuevos: 3, actualizados: 0, obsoletos: 0 });
  const ccss = db.asientos().find(a => a.clave === "cierre|2|102");
  // una persona elige el banco de la contrapartida
  db.editarAsiento(ccss.id, { diarioId: 21, diario: "BAC", lineas: ccss.lineas.map(l => l.rol === "contrapartida" ? { ...l, cuentaId: 111, cuenta: "BAC", editada: true } : l) }, "victor");
  const sal = db.asientos().find(a => a.clave === "cierre|1|101");
  db.decidirAsiento(sal.id, "rechazada", "victor", "se pagó por planilla electrónica: corregir el otro asiento");
  // segunda corrida del mismo mes: CCSS conserva el banco elegido; salarios rechazado no vuelve
  assert.deepEqual(db.sincronizarAsientos(2, r.asientosSugeridos), { nuevos: 0, actualizados: 2, obsoletos: 0 });
  const ccss2 = db.asiento(ccss.id);
  assert.equal(ccss2.diario_id, 21);
  assert.equal(ccss2.lineas[1].cuentaId, 111);
  assert.equal(ccss2.porDefinir, false);
  // tercera: el IVA ya se liquidó (no sale) → obsoleto
  assert.deepEqual(db.sincronizarAsientos(3, r.asientosSugeridos.filter(a => a.clave !== "cierre|1|iva")), { nuevos: 0, actualizados: 1, obsoletos: 1 });
  assert.equal(db.asientos({ estado: "obsoleta" })[0].clave, "cierre|1|iva");
});

test("Forma y validación: cuadre, cuentas, diario y periodo fiscal", async () => {
  assert.match(asientos.revisarForma({ fecha: "2026-02-28", diarioId: 10, lineas: [{ cuentaId: 1, debito: 10 }, { cuentaId: 2, credito: 9 }] }).errores.join(), /No cuadra/);
  assert.match(asientos.revisarForma({ fecha: "2026-02-28", diarioId: 10, lineas: [{ cuentaId: 1, debito: 10 }, { cuentaId: null, credito: 10, rol: "contrapartida" }] }).errores.join(), /elija el banco/);
  const odoo = new OdooSimulado(instancia());
  const ok = await asientos.validar(odoo, { compania_id: 1, diario_id: 10, fecha: "2026-02-28", lineas: [{ cuentaId: 101, debito: 5 }, { cuentaId: 109, credito: 5 }] });
  assert.equal(ok.ok, true, ok.errores.join());
  const mal = await asientos.validar(odoo, { compania_id: 2, diario_id: 10, fecha: "2026-02-28", lineas: [{ cuentaId: 102, debito: 5 }, { cuentaId: 109, credito: 5 }] });
  assert.match(mal.errores.join(" | "), /no es de esta compañía/);
  assert.match(mal.errores.join(" | "), /es de otra compañía/);
  assert.match(mal.errores.join(" | "), /periodo fiscal .* está cerrado/);
});

test("Aplicar: bloqueado sin permiso; con permiso crea el asiento en borrador y lo verifica; publica solo con ASIENTOS_PUBLICAR", async () => {
  const datos = instancia();
  const db = new BaseDeDatos(":memory:");
  const r = await correrCierre(datos);
  db.sincronizarAsientos(1, r.asientosSugeridos);
  const sal = db.asientos().find(a => a.clave === "cierre|1|101");
  const armar = cfg => ({ cfg, crearCliente: ag => new OdooSimulado(datos, { permitirEscritura: ag.meta.escribe === true }) });

  let x = await asientos.aplicar({ corridas: armar({ PERMITIR_ESCRITURA_ASIENTOS: "si" }), db, id: sal.id, quien: "victor" });
  assert.match(x.error, /solo se aplica uno aprobado/);
  db.decidirAsiento(sal.id, "aprobada", "victor");
  x = await asientos.aplicar({ corridas: armar({ PERMITIR_ESCRITURA: "si" }), db, id: sal.id, quien: "victor" });
  assert.match(x.error, /PERMITIR_ESCRITURA_ASIENTOS/, "el permiso de facturas no alcanza para asientos");

  const antes = datos["account.move"].length;
  x = await asientos.aplicar({ corridas: armar({ PERMITIR_ESCRITURA_ASIENTOS: "si" }), db, id: sal.id, quien: "victor" });
  assert.equal(x.ok, true, JSON.stringify(x));
  assert.equal(x.estadoOdoo, "draft");
  assert.equal(datos["account.move"].length, antes + 1);
  const creado = datos["account.move"].at(-1);
  assert.equal(creado.move_type, "entry");
  assert.match(creado.ref, /Oficina #\d+/);
  assert.equal(db.asiento(sal.id).estado, "aplicada");
  assert.equal(db.asiento(sal.id).move_id, creado.id);

  // con ASIENTOS_PUBLICAR=si queda publicado
  const otro = db.proponerAsiento({ origen: "manual", companiaId: 1, compania: "Compañía Uno", fecha: "2026-02-27", diarioId: 10, diario: "Banco Nacional", referencia: "Prueba",
    lineas: [{ cuentaId: 102, cuenta: "A pagar CCSS", debito: 300000, credito: 0 }, { cuentaId: 109, cuenta: "Banco Nacional", debito: 0, credito: 300000 }] }, "victor");
  db.decidirAsiento(otro.id, "aprobada", "victor");
  x = await asientos.aplicar({ corridas: armar({ PERMITIR_ESCRITURA_ASIENTOS: "si", ASIENTOS_PUBLICAR: "si" }), db, id: otro.id, quien: "victor" });
  assert.equal(x.estadoOdoo, "posted");
  assert.equal(db.asiento(otro.id).resultado.ok, true);
});

test("El Director dicta un asiento por códigos de cuenta: queda propuesto, nunca escrito", async () => {
  const datos = instancia();
  const db = new BaseDeDatos(":memory:");
  const corridas = { cfg: {}, crearCliente: () => new OdooSimulado(datos) };
  const r = await asientos.proponer({ corridas, db, compania: 1, fecha: "2026-02-15", referencia: "Pago CCSS enero", motivo: "lo pagó el 15 por el BN",
    lineas: [{ codigo: "2.01.022.001", debito: 300000 }, { codigo: "1.01.001.002", credito: 300000 }], propuso: "director:victor" });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.asiento.diario, "Operaciones varias", "sin diario: el general");
  assert.deepEqual(r.asiento.lineas.map(l => l.cuentaId), [102, 109]);
  assert.equal(db.asientos()[0].origen, "director");
  const malo = await asientos.proponer({ corridas, db, compania: 1, fecha: "2026-02-15", motivo: "x", lineas: [{ codigo: "9.99", debito: 1 }, { codigo: "1.01.001.002", credito: 1 }], propuso: "d" });
  assert.match(malo.error, /no existe/);
  const descuadrado = await asientos.proponer({ corridas, db, compania: 1, fecha: "2026-02-15", motivo: "x", lineas: [{ codigo: "2.01.022.001", debito: 2 }, { codigo: "1.01.001.002", credito: 1 }], propuso: "d" });
  assert.match(descuadrado.error, /No cuadra/);
});
