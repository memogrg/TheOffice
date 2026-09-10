// Punto de entrada. Uso:  npm run recepcion
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Odoo, cargarEnv } from "./odoo.js";
import * as recepcion from "./agents/recepcion.js";
import * as conciliacion from "./agents/conciliacion.js";
import * as cuentas from "./agents/cuentas.js";
import * as comunicacion from "./agents/comunicacion.js";
import { reporteHTML, resumenTexto, ETIQUETA } from "./reporte.js";
import { enviar } from "./mailer.js";
import { Director } from "./director.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTES = { recepcion, conciliacion, cuentas, comunicacion };

const hhmmss = () => new Date().toLocaleTimeString("es-CR", { hour12: false });
const bitacora = [];
function log(m) { const l = `${hhmmss()}  ${m}`; bitacora.push(l); console.log("  " + l); }

async function main() {
  const quien = (process.argv[2] || "recepcion").toLowerCase();

  // El Director: recibe la instruccion en palabras y decide quien la ejecuta.
  if (quien === "director") {
    const instruccion = process.argv.slice(3).join(" ");
    if (!instruccion) { console.error('Uso: node src/run.js director "revisá las cuentas de Puuk"'); process.exit(1); }
    const dir = new Director(join(RAIZ, "data", "roster.json"), join(RAIZ, "data", "companias.json"));
    const d = dir.decidir(instruccion);
    console.log(`\n  Usted: ${instruccion}`);
    console.log(`  Director: ${d.mensaje}\n`);
    if (d.accion !== "ejecutar") { 
      console.log("  marcador: " + d.marcador.map(m => m.nombre + " " + m.puntaje).join(" · ") + "\n");
      process.exit(0);
    }
    console.log(`  → ${d.comando}\n`);
    process.argv = [process.argv[0], process.argv[1], d.agente.id, ...d.args];
    return main();
  }

  const agente = AGENTES[quien];
  if (!agente) { console.error(`No existe el agente "${quien}". Disponibles: ${Object.keys(AGENTES).join(", ")}`); process.exit(1); }

  const cfg = cargarEnv(readFileSync(join(RAIZ, ".env"), "utf8"));
  console.log(`\n=== ${agente.meta.nombre}${agente.meta.rol ? " · " + agente.meta.rol : ""} — ${agente.meta.puesto} ===`);
  console.log(`    ${cfg.ODOO_URL} · base ${cfg.ODOO_DB} · modo ${agente.meta.escribe ? "ESCRITURA" : "solo lectura"}\n`);

  const odoo = new Odoo({
    url: cfg.ODOO_URL, db: cfg.ODOO_DB, user: cfg.ODOO_USER, password: cfg.ODOO_PASSWORD,
    permitirEscritura: agente.meta.escribe === true
  });

  let r;
  try { r = await agente.ejecutar({ odoo, cfg, log, raiz: RAIZ, args: process.argv.slice(3) }); }
  catch (e) { console.error("\n  FALLO: " + e.message + "\n"); process.exit(1); }

  r.bitacora = bitacora;
  const fecha = new Date().toISOString().slice(0, 10);
  const base = join(RAIZ, "reportes", `${quien}-${fecha}`);
  mkdirSync(join(RAIZ, "reportes"), { recursive: true });
  mkdirSync(join(RAIZ, "data"), { recursive: true });
  const html = reporteHTML(r);
  writeFileSync(base + ".json", JSON.stringify(r, null, 2));
  writeFileSync(base + ".html", html);
  // estado que leera la interfaz de la oficina
  const previo = existsSync(join(RAIZ, "data", "estado.json"))
    ? JSON.parse(readFileSync(join(RAIZ, "data", "estado.json"), "utf8")) : { agentes: [] };
  const ficha = {
    id: agente.meta.id, nombre: agente.meta.nombre, rol: agente.meta.rol || agente.meta.nombre, puesto: agente.meta.puesto,
    estado: "done",
    resultado: Object.entries(r.totales || {}).slice(0, 6).map(([k, v]) => [ETIQUETA[k] || k, typeof v === "number" ? v.toLocaleString("de-DE") : String(v)]),
    bitacora: bitacora.slice(-6).map(l => [l.slice(0, 5), l.slice(7)]),
    alertas: r.alertas || []
  };
  const agentes = (previo.agentes || []).filter(a => a.id !== ficha.id).concat([ficha]);
  writeFileSync(join(RAIZ, "data", "estado.json"), JSON.stringify({ actualizado: r.corrida, agentes }, null, 2));

  // La oficina 2D: se reescribe con las cifras reales incrustadas, para que se
  // abra con doble clic sin necesitar servidor ni node.
  const datos = JSON.parse(readFileSync(join(RAIZ, "data", "estado.json"), "utf8"));
  datos.correo = (cfg.SMTP_HOST && cfg.SMTP_USER) ? cfg.REPORTE_PARA : "";
  // El Director de la oficina lee el mismo contrato que el de la terminal.
  datos.roster = JSON.parse(readFileSync(join(RAIZ, "data", "roster.json"), "utf8"));
  datos.companias = JSON.parse(readFileSync(join(RAIZ, "data", "companias.json"), "utf8"))
    .map(c => ({ id: c.id, name: c.name }));
  const plantilla = readFileSync(join(RAIZ, "ui", "plantilla.html"), "utf8");
  const oficina = plantilla.replace(
    /\/\*DATOS\*\/[\s\S]*?\/\*FIN\*\//,
    "/*DATOS*/ " + JSON.stringify(datos)
      // 1.129 lineas de Odoo traen el caracter de reemplazo donde iba una vocal acentuada.
      // Se escapa para no dejarlo literal en el archivo; el dato se conserva tal cual.
      .replace(/\uFFFD/g, "\\uFFFD") + " /*FIN*/");
  writeFileSync(join(RAIZ, "Oficina IASIMA.html"), oficina);
  log("Oficina actualizada: Oficina IASIMA.html");

  const cab = (r.alertas || []).filter(a => a.nivel !== "ok").map(a => a.texto).slice(0, 2).join(" · ");
  const asunto = `IASIMA · ${agente.meta.nombre} — ${cab || "sin novedades"}`;
  await enviar({ cfg, asunto, html, texto: resumenTexto(r), log });

  console.log("\n" + resumenTexto(r) + "\n");
  console.log(`  Reporte: ${base}.html`);
  console.log(`  Datos:   ${base}.json\n`);
}
main();
