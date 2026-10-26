// La guía de clasificación de Victor (docs/guia-clasificacion-cuentas.md), caso por caso, con los
// archivos reales de data/referencia/ y un catálogo pequeño en memoria.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalogo } from "../src/catalogo.js";
import { Clasificador, resolverEnPlan } from "../src/clasificador.js";

function catalogo({ porCliente = {}, global = {}, reglas = [] } = {}) {
  const d = mkdtempSync(join(tmpdir(), "clas-"));
  writeFileSync(join(d, "cat.json"), JSON.stringify({ cuentas: {}, porCliente, global }));
  writeFileSync(join(d, "reglas.json"), JSON.stringify({ reglas }));
  return new Catalogo(join(d, "cat.json"), join(d, "reglas.json"));
}
const ALFONSO = "ALFONSO LLORCA CASTRO";
const cafeteria = "5610.0 CAFETERIAS";

test("ejemplo resuelto de la guía: Rostipollos → Relaciones públicas (naturaleza + historial)", () => {
  const cl = new Clasificador({ catalogo: catalogo({ porCliente: { [ALFONSO]: {
    "MEDIO POLLO 2 ACOMP": ["5.04.17.01", "Relaciones publicas", 3], "ROSTER MILANESA CRU": ["5.04.17.01", "Relaciones publicas", 4] } } }) });
  for (const art of ["Ensalada Pollo, Agu", "Medio Pollo+2 acomp", "Roster Milanesa Cru"]) {
    const r = cl.clasificar({ compania: "Alfonso Llorca Castro", articulo: art, actividad: cafeteria });
    assert.equal(r.decision, "proponer", art);
    assert.equal(r.codigo, "5.04.17.01", art);
    assert.equal(r.naturaleza.id, "alimentacion-restaurante", art);
  }
  // sin historial, solo el proveedor dice «restaurante»: consulta (no basta)
  const solo = new Clasificador({ catalogo: catalogo() }).clasificar({ compania: "X", articulo: "Roster Milanesa Cru", actividad: cafeteria });
  assert.equal(solo.decision, "consulta");
  assert.equal(solo.codigo, "5.04.17.01", "pero deja la sugerencia");
});

test("paso 0: la regla propia del cliente gana sobre naturaleza e historial", () => {
  const cl = new Clasificador({ catalogo: catalogo({
    porCliente: { [ALFONSO]: { "ENSALADA POLLO AGU": ["7.01.01", "Gastos no justificados", 9] } },
    reglas: [{ proveedorId: 77, proveedor: "Rostipollos Escazu", codigo: "5.04.17.01", cuenta: "Relaciones publicas", alcance: "Alfonso Llorca Castro", decidio: "Victor" }] }) });
  const r = cl.clasificar({ compania: "Alfonso Llorca Castro", articulo: "Ensalada Pollo, Agu", proveedor: { id: 77, nombre: "Rostipollos Escazu" }, actividad: cafeteria });
  assert.equal(r.decision, "proponer");
  assert.equal(r.fuente, "regla-humana");
  assert.equal(r.decidio, "Victor");
  // otra compañía: la regla no aplica
  const otra = cl.clasificar({ compania: "Puuk", articulo: "Ensalada Pollo, Agu", proveedor: { id: 77 }, actividad: cafeteria });
  assert.notEqual(otra.fuente, "regla-humana");
});

test("paso 3: el historial que choca con la naturaleza va a consulta (el caso IAR: comida en Útiles)", () => {
  const cl = new Clasificador({ catalogo: catalogo({ porCliente: { "INTERNATIONAL ANIMAL RESCUE": { "CASADO CON POLLO": ["5.04.08.01", "Utiles para oficina", 12] } } }) });
  const r = cl.clasificar({ compania: "International Animal Rescue", articulo: "CASADO CON POLLO", actividad: "552004 SERVICIO DE RESTAURANTE, CAFETERIAS, SODAS" });
  assert.equal(r.decision, "consulta");
  assert.equal(r.tipo, "choque");
  assert.equal(r.codigo, "5.04.17.01");
  assert.match(r.motivo, /Utiles para oficina/);
});

test("paso 3: gasto que parece personal va a consulta aunque el historial diga otra cosa", () => {
  const cl = new Clasificador({ catalogo: catalogo({ porCliente: { PUUK: { "ACETAMINOFEN 500MG": ["5.04.08.01", "Utiles para oficina", 3] } } }) });
  const porLinea = cl.clasificar({ compania: "Puuk", articulo: "ACETAMINOFEN 500MG", actividad: "4711.1 SUPERMERCADOS" });
  assert.equal(porLinea.decision, "consulta");
  assert.equal(porLinea.tipo, "personal");
  const porProveedor = cl.clasificar({ compania: "Puuk", articulo: "PRODUCTO VARIOS", actividad: "523101 FARMACIAS" });
  assert.equal(porProveedor.tipo, "personal");
});

test("paso 3: abarrotes de supermercado (naturaleza sin cuenta) y naturalezas cruzadas van a consulta", () => {
  const cl = new Clasificador({ catalogo: catalogo() });
  assert.equal(cl.clasificar({ compania: "X", articulo: "ARROZ 1KG", actividad: "4711.1 SUPERMERCADOS Y ALMACENES DE ABARROTES" }).decision, "consulta");
  const cloro = cl.clasificar({ compania: "X", articulo: "CLORO 1L", actividad: "4711.1 SUPERMERCADOS Y ALMACENES DE ABARROTES" });
  assert.equal(cloro.decision, "consulta");
  assert.equal(cloro.codigo, "5.04.08.02", "sugiere Útiles de limpieza");
});

test("paso 2 sin naturaleza: consenso entre clientes propone; dividido consulta", () => {
  const cl = new Clasificador({ catalogo: catalogo() });
  // «IMPUESTO DE SERVICIO»: 29 de 31 clientes en Relaciones públicas (consenso-articulos.json)
  const servicio = cl.clasificar({ compania: "X", articulo: "IMPUESTO DE SERVICIO" });
  assert.equal(servicio.decision, "proponer");
  assert.equal(servicio.codigo, "5.04.17.01");
  const dividido = [...cl.consenso.values()].find(f => f.estado === "dividido" && !cl.categoriasDeArticulo(f.articulo).length && !cl.senalesPersonales(f.articulo).length);
  const r = cl.clasificar({ compania: "X", articulo: dividido.articulo });
  assert.equal(r.decision, "consulta");
  assert.equal(r.tipo, "dividido");
});

test("paso 4: nunca un comodín como destino; lo no identificado se reporta", () => {
  const cl = new Clasificador({ catalogo: catalogo({ porCliente: { PUUK: { "COSA RARA": ["5.04.999", "Gastos generales", 20] } }, global: { "OTRA COSA": ["7.01.01", "Gastos no justificados", 50] } }) });
  assert.equal(cl.clasificar({ compania: "Puuk", articulo: "COSA RARA" }).decision, "no-identificado");
  assert.equal(cl.clasificar({ compania: "Puuk", articulo: "OTRA COSA" }).decision, "no-identificado");
  // «13 COMPRAS»: la mayoría de clientes lo manda a un comodín
  const r = cl.clasificar({ compania: "Puuk", articulo: "13 COMPRAS" });
  assert.equal(r.decision, "no-identificado");
  assert.match(r.motivo, /comodín/);
  assert.ok(cl.esComodin("5.04.999") && cl.esComodin("5.04.099") && cl.esComodin("7.01.001") && !cl.esComodin("5.04.17.01"));
});

test("cuenta lógica: códigos cortos y largos son la misma; las cuentas que cambian de significado se resuelven por nombre", () => {
  const cl = new Clasificador({ catalogo: catalogo() });
  assert.ok(cl.misma("5.04.17.01", "5.04.017.001"));
  const plan = [
    { id: 1, code: "5.04.017.001", name: "Relaciones publicas" },
    { id: 2, code: "5.04.014.001", name: "Hospedaje de correo" },
    { id: 3, code: "5.04.014.002", name: "Suscripciones" },
    { id: 4, code: "5.04.999", name: "Gastos generales" }];
  assert.equal(resolverEnPlan(cl, { codigo: "5.04.17.01", cuenta: "Relaciones públicas", fuente: "naturaleza" }, plan).cuenta.id, 1);
  // 5.04.14.01 «Suscripciones» es inconsistente entre clientes: aquí ese código es otra cosa → por nombre
  const s = resolverEnPlan(cl, { codigo: "5.04.14.01", cuenta: "Suscripciones", fuente: "naturaleza" }, plan);
  assert.equal(s.cuenta.id, 3);
  assert.equal(s.porNombre, true);
  // con historial propio el código del propio cliente vale
  assert.equal(resolverEnPlan(cl, { codigo: "5.04.14.01", cuenta: "Hospedaje de correo", fuente: "historial-propio" }, plan).cuenta.id, 2);
  assert.match(resolverEnPlan(cl, { codigo: "5.04.06", cuenta: "Combustible", fuente: "naturaleza" }, plan).motivo, /no existe/);
});

test("palabras completas con plural, sin falsos positivos por pedazos de palabra", () => {
  const cl = new Clasificador({ catalogo: catalogo() });
  assert.equal(cl.categoriasDeArticulo("TORNILLOS GALVANIZADOS")[0].id, "mantenimiento-local");
  assert.ok(!cl.categoriasDeArticulo("SALSA INGLESA").some(c => c.id === "alimentacion-supermercado" && c.palabras.includes("SAL")), "SAL no casa con SALSA");
  assert.equal(cl.tipoDeProveedor("SERVICIOS TELEFONICOS, TELEGRAFICOS Y POR TELEX").id, "telecomunicaciones");
  assert.equal(cl.tipoDeProveedor("BARBERIA Y ESTETICA").personal, true);
  assert.equal(cl.tipoDeProveedor("BARRAS DE ACERO"), null, "BAR no casa con BARRAS");
});

test("regla por tipo de gasto (corrección 9 del log): toda comida de restaurante de una compañía, de cualquier proveedor", () => {
  const cl = new Clasificador({ catalogo: catalogo({
    porCliente: { [ALFONSO]: { "CASADO": ["7.01.01", "Gastos no justificados", 5] } },
    reglas: [{ naturaleza: "alimentacion-restaurante", codigo: "5.04.17.01", cuenta: "Relaciones publicas", alcance: "Alfonso Llorca Castro", decidio: "Victor" },
             { naturaleza: "alimentacion-supermercado", codigo: "5.01.01", cuenta: "Costo de ventas", alcance: "Alfonso Llorca Castro", decidio: "Victor" }] }) });
  const r = cl.clasificar({ compania: "Alfonso Llorca Castro", articulo: "CASADO", actividad: "SODA" });
  assert.equal(r.fuente, "regla-humana");
  assert.ok(cl.misma(r.codigo, "5.04.17.01"));
  assert.ok(r.pasos.some(p => /tipo de gasto/.test(p)));
  // la consulta de supermercado se resuelve con su propia regla…
  assert.ok(cl.misma(cl.clasificar({ compania: "Alfonso Llorca Castro", articulo: "ARROZ 1KG", actividad: "SUPERMERCADOS" }).codigo, "5.01.01"));
  // …pero no arrastra lo que la línea dice que es otra cosa (cloro en el súper), ni lo personal
  assert.equal(cl.clasificar({ compania: "Alfonso Llorca Castro", articulo: "CLORO 1L", actividad: "SUPERMERCADOS" }).decision, "consulta");
  assert.equal(cl.clasificar({ compania: "Alfonso Llorca Castro", articulo: "SHAMPOO", actividad: "SUPERMERCADOS" }).tipo, "personal");
  // otra compañía: no aplica
  assert.notEqual(cl.clasificar({ compania: "Puuk", articulo: "CASADO", actividad: "SODA" }).fuente, "regla-humana");
});
