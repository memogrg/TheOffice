// Los cuatro agentes de punta a punta contra el Odoo simulado (test/simulado/instancia.json).
// Cada test corre en una carpeta temporal propia para no tocar data/ ni reportes/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OdooSimulado } from "../src/odoo-simulado.js";
import * as recepcion from "../src/agents/recepcion.js";
import * as conciliacion from "../src/agents/conciliacion.js";
import * as comunicacion from "../src/agents/comunicacion.js";
import * as cuentas from "../src/agents/cuentas.js";
import { reporteHTML, resumenTexto } from "../src/reporte.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..");
const instancia = () => JSON.parse(readFileSync(join(AQUI, "simulado", "instancia.json"), "utf8"));
const silencio = () => {};

function raizTemporal() {
  const r = mkdtempSync(join(tmpdir(), "oficina-"));
  mkdirSync(join(r, "data"));
  copyFileSync(join(RAIZ, "data", "reglas.json"), join(r, "data", "reglas.json"));
  copyFileSync(join(AQUI, "simulado", "catalogo-cuentas.json"), join(r, "data", "catalogo-cuentas.json"));
  return r;
}

test("Recepción: cuenta estados, verifica tiquetes, consolida por receptor y deja la bandeja", async () => {
  const raiz = raizTemporal();
  const odoo = new OdooSimulado(instancia());
  const r = await recepcion.ejecutar({ odoo, cfg: { ALERTA_REFERENCIA: "ultimo-correo", ALERTA_HORAS_SIN_INGESTA: "48" }, log: silencio, raiz });

  assert.equal(r.totales.total, 19);
  assert.equal(r.totales.registradas, 7);
  assert.equal(r.totales.tiquetes, 4);
  assert.equal(r.totales.sinRegistrar, 8);
  assert.equal(r.totales.companias, 3);
  assert.deepEqual(r.porEstado.map(e => e.estado).sort(), ["done", "duplicate", "error", "isticket", "process", "rejected", "vatiderror"]);

  // control de tiquetes: 4 marcados, uno es tipo 01 (mal marcado) y un 04 quedó como factura
  assert.equal(r.verificacionTiquetes.total, 4);
  assert.equal(r.verificacionTiquetes.confirmadosTipo04, 3);
  assert.equal(r.verificacionTiquetes.inconsistentes.length, 1);
  assert.equal(r.verificacionTiquetes.coladosComoFactura.length, 1);

  // Aurora no recibe desde el 5 de febrero; medido contra el último correo (11 de marzo) está caída
  const caida = r.alertas.find(a => /buzones sin un correo/.test(a.texto));
  assert.ok(caida && /1 de 3/.test(caida.texto), caida?.texto);
  assert.equal(r.companias[0].nombre, "Puuk", "la de peor tasa va primero (4 de 14 registradas)");
  assert.equal(r.companias[0].pctOk, 28.6);

  // el mismo tiquete reenviado se reclama una vez, diciendo que llegó dos veces
  const puuk = r.paraVictor.externo.find(x => x.receptor === "contabilidad@puuk.cr");
  assert.ok(puuk);
  assert.equal(puuk.correosTiquete, 3);
  assert.equal(puuk.tiquetes, 2, "dos tiquetes distintos aunque llegaron tres correos");
  const colina = puuk.establecimientos.find(e => e.establecimiento === "Colina Hermanos S.A.");
  assert.ok(colina, "el establecimiento se identifica por la cédula de la clave");
  assert.ok(colina.documentos.some(d => d.veces === 2));

  // sin clave, el remitente es la pista (y se dice que es pista)
  const interno = r.paraVictor.interno.find(x => x.receptor === "contabilidad@puuk.cr");
  const vat = interno.porEstado.find(e => e.estado === "vatiderror").detalle[0];
  assert.equal(vat.establecimiento, "Distribuidora Vega");
  // Hacienda nunca es el emisor
  const hacienda = r.paraVictor.externo.flatMap(x => x.establecimientos).find(e => /hacienda/i.test(e.establecimiento || ""));
  assert.equal(hacienda, undefined);

  // causas dominantes agrupan los dos periodos fiscales en una
  const causas = interno.causas;
  assert.equal(causas[0].correos, 2);
  assert.match(causas[0].causa, /periodo fiscal «fecha»/);

  // archivos que deja
  assert.ok(existsSync(join(raiz, "data", "bandeja-victor.json")));
  assert.equal(JSON.parse(readFileSync(join(raiz, "data", "companias.json"), "utf8")).length, 3);
  assert.ok(r.alertas.some(a => /sin registrar no traen receptor/.test(a.texto)), "el correo sin to_mail se reporta");

  // el reporte se arma sin reventar
  assert.match(reporteHTML(r), /Buzón de facturas/);
  assert.match(resumenTexto(r), /Correos revisados: 19/);
});

test("Conciliación: encuentra los correos done sin asiento en libros", async () => {
  const odoo = new OdooSimulado(instancia());
  const r = await conciliacion.ejecutar({ odoo, cfg: {}, log: silencio });
  assert.equal(r.totales.correosDone, 7);
  assert.equal(r.totales.clavesUnicas, 7);
  assert.equal(r.totales.conAsiento, 3);
  assert.equal(r.totales.sinAsiento, 4);
  assert.equal(r.companias[0].compania, "Puuk");
  assert.ok(r.porTipoDocumento.some(t => t.tipo === "Tiquete electrónico"), "el 04 colado aparece como tiquete sin asiento");
  assert.equal(odoo.escrituras, 0);
});

test("Comunicación: redacta un correo por receptor y no envía sin --enviar", async () => {
  const raiz = raizTemporal();
  await recepcion.ejecutar({ odoo: new OdooSimulado(instancia()), cfg: {}, log: silencio, raiz });
  const r = await comunicacion.ejecutar({ cfg: {}, log: silencio, raiz, args: [] });
  assert.equal(r.totales.correosAfuera, 4);
  assert.equal(r.totales.correosAdentro, 1);
  assert.equal(r.totales.enviados, 0);
  assert.equal(r.modo, "borrador");
  const carpeta = readdirSync(join(raiz, "reportes")).find(d => d.startsWith("borradores-victor-"));
  const archivos = readdirSync(join(raiz, "reportes", carpeta));
  assert.equal(archivos.length, 5);
  const html = readFileSync(join(raiz, "reportes", carpeta, archivos.find(a => a.includes("afuera-contabilidad_puuk_cr"))), "utf8");
  assert.match(html, /Colina Hermanos S\.A\./);
  assert.match(html, /llegó 2 veces/);

  // con --enviar pero sin SMTP tampoco sale nada
  const r2 = await comunicacion.ejecutar({ cfg: {}, log: silencio, raiz, args: ["--enviar"] });
  assert.equal(r2.totales.enviados, 0);
  assert.ok(r2.alertas.some(a => /NO se enviaron/.test(a.texto)));
});

test("Cuentas: propone sin tocar; aplica solo con --aplicar y PERMITIR_ESCRITURA=si; nunca toca pagadas", async () => {
  // 1. propuesta
  let raiz = raizTemporal();
  let odoo = new OdooSimulado(instancia(), { permitirEscritura: true });
  let r = await cuentas.ejecutar({ odoo, cfg: {}, log: silencio, raiz, args: ["--empresa=Puuk"] });
  assert.equal(r.compania, "Puuk");
  assert.equal(r.modo, "solo lectura (propuesta)");
  assert.equal(odoo.escrituras, 0);
  assert.equal(r.totales.aCorregir, 2);     // bomberos (regla humana), eléctrico en cajón de sastre (publicada)
  assert.equal(r.totales.sinCatalogo, 2);   // tornillos (sin catálogo) y eléctrico de la factura pagada (no se toca)
  assert.ok(r.revisionHumana.some(x => /estado de pago "paid"/.test(x.motivo)));
  assert.equal(r.totales.aplicadas, 0);
  const bomberos = r.propuestas.find(p => /BOMBEROS/.test(p.articulo));
  assert.equal(bomberos.fuente, "regla-humana");
  assert.equal(bomberos.cuentaNueva, "5.04.002.002 Electricidad");

  // 2. --aplicar sin PERMITIR_ESCRITURA: sigue en propuesta
  raiz = raizTemporal();
  odoo = new OdooSimulado(instancia(), { permitirEscritura: true });
  r = await cuentas.ejecutar({ odoo, cfg: {}, log: silencio, raiz, args: ["--empresa=144", "--aplicar"] });
  assert.equal(odoo.escrituras, 0);
  assert.equal(r.totales.aplicadas, 0);

  // 3. --aplicar con permiso
  raiz = raizTemporal();
  odoo = new OdooSimulado(instancia(), { permitirEscritura: true });
  r = await cuentas.ejecutar({ odoo, cfg: { PERMITIR_ESCRITURA: "si" }, log: silencio, raiz, args: ["--empresa=144", "--aplicar"] });
  assert.equal(r.modo, "escritura");
  assert.equal(r.totales.aplicadas, 2, "la borrador y la publicada en cajón de sastre");
  assert.equal(r.fallos.length, 0, "la pagada ni se propone, así que no falla");
  const metodos = odoo.cambios.map(c => c.metodo);
  assert.deepEqual(metodos.filter(m => m === "button_draft").length, 1, "solo la publicada se restablece a borrador");
  assert.deepEqual(metodos.filter(m => m === "action_post").length, 2);
  // verificación post-escritura: las líneas quedaron en Electricidad
  const lineas = await odoo.leer("account.move.line", "search_read", [[["id", "in", [1, 4]]], ["account_id"]]);
  assert.ok(lineas.every(l => l.account_id[0] === 500));
  // memoria: no repite en la siguiente corrida
  const mem = JSON.parse(readFileSync(join(raiz, "data", "revisadas.json"), "utf8"));
  assert.equal(mem["900"].estado, "corregida");
  assert.equal(mem["902"].estado, "con-dudas");
  const r2 = await cuentas.ejecutar({ odoo, cfg: { PERMITIR_ESCRITURA: "si" }, log: silencio, raiz, args: ["--empresa=144", "--aplicar"] });
  assert.equal(r2.totales.aplicadas, 0);
});

test("Cuentas: sin compañía o sin catálogo falla con un mensaje claro", async () => {
  const raiz = raizTemporal();
  const odoo = new OdooSimulado(instancia());
  await assert.rejects(() => cuentas.ejecutar({ odoo, cfg: {}, log: silencio, raiz, args: [] }), /Indique la compania/);
  await assert.rejects(() => cuentas.ejecutar({ odoo, cfg: { CATALOGO_CUENTAS: "no/existe.json" }, log: silencio, raiz, args: ["--empresa=144"] }), /construir-catalogo/);
});
