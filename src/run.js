// Punto de entrada.
//   node src/run.js recepcion
//   node src/run.js cuentas --empresa=144 [--aplicar]
//   node src/run.js comunicacion [--enviar] [--a-los-receptores]
//   node src/run.js director "revisá las cuentas de Puuk"
//
// Con ODOO_SIMULADO=<archivo.json> no se toca la red: el cliente responde con los datos
// de ese archivo (ver test/simulado/). Sirve para probar la cadena completa sin credenciales.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Odoo, cargarEnv } from "./odoo.js";
import { OdooSimulado } from "./odoo-simulado.js";
import * as recepcion from "./agents/recepcion.js";
import * as conciliacion from "./agents/conciliacion.js";
import * as cuentas from "./agents/cuentas.js";
import * as comunicacion from "./agents/comunicacion.js";
import * as diagnostico from "./agents/diagnostico.js";
import * as recurrentes from "./agents/recurrentes.js";
import * as bancos from "./agents/bancos.js";
import * as documentos from "./agents/documentos.js";
import * as cierre from "./agents/cierre.js";
import * as estados from "./agents/estados.js";
import { reporteHTML, resumenTexto, ETIQUETA } from "./reporte.js";
import { enviar } from "./mailer.js";
import { Director } from "./director.js";
import { escribirOficina } from "./oficina.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTES = { recepcion, conciliacion, cuentas, comunicacion, diagnostico, recurrentes, bancos, documentos, cierre, estados };

const hhmmss = () => new Date().toLocaleTimeString("es-CR", { hour12: false });
const bitacora = [];
function log(m) { const l = `${hhmmss()}  ${m}`; bitacora.push(l); console.log("  " + l); }

function leerJSON(ruta, siNoExiste) {
  return existsSync(ruta) ? JSON.parse(readFileSync(ruta, "utf8")) : siNoExiste;
}

// Dos corridas a la vez se pisan los archivos de data/. Un candado simple lo evita;
// si quedó de una corrida muerta (más de 2 h), se ignora.
function tomarCandado(quien) {
  const ruta = join(RAIZ, "data", "corriendo.lock");
  mkdirSync(join(RAIZ, "data"), { recursive: true });
  if (existsSync(ruta)) {
    const previo = leerJSON(ruta, {});
    const edad = Date.now() - new Date(previo.desde || 0).getTime();
    if (edad < 2 * 3600e3) {
      throw new Error(`Ya hay una corrida en curso (${previo.agente}, desde ${previo.desde}). Si no es así, borre data/corriendo.lock.`);
    }
  }
  writeFileSync(ruta, JSON.stringify({ agente: quien, desde: new Date().toISOString(), pid: process.pid }));
  return () => { try { unlinkSync(ruta); } catch { /* ya no está */ } };
}

export function crearCliente(cfg, agente) {
  if (cfg.ODOO_SIMULADO) {
    return new OdooSimulado(leerJSON(join(RAIZ, cfg.ODOO_SIMULADO), null), { permitirEscritura: agente.meta.escribe === true });
  }
  for (const k of ["ODOO_URL", "ODOO_DB", "ODOO_USER", "ODOO_PASSWORD"]) {
    if (!cfg[k]) throw new Error(`Falta ${k} en .env (copie .env.example a .env y complételo).`);
  }
  return new Odoo({
    url: cfg.ODOO_URL, db: cfg.ODOO_DB, user: cfg.ODOO_USER, password: cfg.ODOO_PASSWORD,
    permitirEscritura: agente.meta.escribe === true,
    timeoutMs: Number(cfg.ODOO_TIMEOUT_SEGUNDOS || 60) * 1000
  });
}

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
      if (d.marcador?.length) console.log("  marcador: " + d.marcador.map(m => m.nombre + " " + m.puntaje).join(" · ") + "\n");
      process.exit(0);
    }
    console.log(`  → ${d.comando}\n`);
    process.argv = [process.argv[0], process.argv[1], d.agente.id, ...d.args];
    return main();
  }

  const agente = AGENTES[quien];
  if (!agente) { console.error(`No existe el agente "${quien}". Disponibles: ${Object.keys(AGENTES).join(", ")}`); process.exit(1); }

  const rutaEnv = join(RAIZ, ".env");
  const cfg = { ...cargarEnv(existsSync(rutaEnv) ? readFileSync(rutaEnv, "utf8") : ""), ...soloOdooDelEntorno() };
  console.log(`\n=== ${agente.meta.nombre}${agente.meta.rol ? " · " + agente.meta.rol : ""} — ${agente.meta.puesto} ===`);
  console.log(`    ${cfg.ODOO_SIMULADO ? "SIMULADO " + cfg.ODOO_SIMULADO : cfg.ODOO_URL + " · base " + cfg.ODOO_DB} · modo ${agente.meta.escribe ? "ESCRITURA" : "solo lectura"}\n`);

  let soltar = () => {};
  let r;
  try {
    soltar = tomarCandado(quien);
    const odoo = crearCliente(cfg, agente);
    r = await agente.ejecutar({ odoo, cfg, log, raiz: RAIZ, args: process.argv.slice(3) });
  } catch (e) {
    soltar();
    console.error("\n  FALLO: " + e.message + "\n");
    process.exit(1);
  }

  try {
    r.bitacora = bitacora;
    const fecha = new Date().toISOString().slice(0, 10);
    const base = join(RAIZ, "reportes", `${quien}-${fecha}`);
    mkdirSync(join(RAIZ, "reportes"), { recursive: true });
    mkdirSync(join(RAIZ, "data"), { recursive: true });
    const html = reporteHTML(r);
    writeFileSync(base + ".json", JSON.stringify(r, null, 2));
    writeFileSync(base + ".html", html);

    // estado que leera la interfaz de la oficina
    const previo = leerJSON(join(RAIZ, "data", "estado.json"), { agentes: [] });
    const ficha = {
      id: agente.meta.id, nombre: agente.meta.nombre, rol: agente.meta.rol || agente.meta.nombre, puesto: agente.meta.puesto,
      estado: "done",
      resultado: Object.entries(r.totales || {}).slice(0, 6).map(([k, v]) => [ETIQUETA[k] || k, typeof v === "number" ? v.toLocaleString("de-DE") : String(v)]),
      bitacora: bitacora.slice(-6).map(l => [l.slice(0, 5), l.slice(7)]),
      alertas: r.alertas || []
    };
    const agentes = (previo.agentes || []).filter(a => a.id !== ficha.id).concat([ficha]);
    const estado = { actualizado: r.corrida, agentes };
    writeFileSync(join(RAIZ, "data", "estado.json"), JSON.stringify(estado, null, 2));
    escribirOficina({ raizProyecto: RAIZ, raiz: RAIZ, cfg, estado, marca: { nombre: cfg.NOMBRE || "IASIMA", color: cfg.COLOR || null } });
    log("Oficina actualizada: Oficina IASIMA.html");

    const cab = (r.alertas || []).filter(a => a.nivel !== "ok").map(a => a.texto).slice(0, 2).join(" · ");
    const asunto = `IASIMA · ${agente.meta.nombre} — ${cab || "sin novedades"}`;
    await enviar({ cfg, asunto, html, texto: resumenTexto(r), log });

    console.log("\n" + resumenTexto(r) + "\n");
    console.log(`  Reporte: ${base}.html`);
    console.log(`  Datos:   ${base}.json\n`);
  } finally {
    soltar();
  }
}

// Variables ODOO_* / ALERTA_* / SMTP_* / REPORTE_* del entorno pisan al .env, para poder
// correr en CI o en un contenedor sin escribir el archivo.
function soloOdooDelEntorno() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ODOO_|ALERTA_|SMTP_|REPORTE_|PERMITIR_ESCRITURA|COMUNICACION_|CATALOGO_)/.test(k)) out[k] = v;
  }
  return out;
}

main();
