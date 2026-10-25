// El servicio: base de datos + agentes + calendario + API + app web, por inquilino.
//   npm run servicio            → http://localhost:4180
//   PUERTO=8080 npm run servicio
//
// Un inquilino (lo de siempre): variables ODOO_* globales. Varios: INQUILINOS=iasima,sima y
// IASIMA_ODOO_URL=…, SIMA_ODOO_URL=… (ver src/servicio/inquilinos.js). Cada uno tiene su base,
// sus datos, su calendario, su Director y su marca; se entra por /t/<id>/ o por su dominio.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cargarEnv } from "../odoo.js";
import { BaseDeDatos } from "./db.js";
import { Corridas } from "./corridas.js";
import { Programador } from "./programador.js";
import { crearApi } from "./api.js";
import { DirectorLLM } from "./director-llm.js";
import { cargarInquilinos } from "./inquilinos.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rutaEnv = join(RAIZ, ".env");
const cfg = { ...cargarEnv(existsSync(rutaEnv) ? readFileSync(rutaEnv, "utf8") : ""), ...process.env };
const log = m => console.log(`  ${new Date().toLocaleTimeString("es-CR", { hour12: false })}  ${m}`);

const inquilinos = cargarInquilinos(cfg, RAIZ);
const contextos = inquilinos.map(inq => {
  const c = inq.cfg;
  const logI = inquilinos.length > 1 ? (m => log(`[${inq.id}] ${m}`)) : log;
  // resolve y no join: una ruta absoluta en BASE_DE_DATOS se respeta (join la colgaba dentro del repo)
  const db = new BaseDeDatos(resolve(inq.raiz, c.BASE_DE_DATOS || "data/oficina.db"));
  const purgadas = db.purgarConversaciones(Number(c.DIRECTOR_RETENCION_DIAS || 30));
  if (purgadas) logI(`${purgadas} conversaciones del Director con más de ${c.DIRECTOR_RETENCION_DIAS || 30} días borradas`);
  const prefijo = inq.unico || inq.dominio ? "" : `/t/${inq.id}`;
  const corridas = new Corridas({ db, cfg: c, raiz: inq.raiz, raizProyecto: RAIZ, marca: inq, prefijo, log: logI });
  const programador = new Programador({ corridas, db, cfg: c, log: logI });
  const director = new DirectorLLM({ db, corridas, cfg: c, raiz: inq.raiz, log: logI });
  return { inquilino: inq, db, corridas, programador, director, cfg: c, raiz: inq.raiz };
});
const api = crearApi({ contextos, raizProyecto: RAIZ, log });

const puerto = Number(cfg.PUERTO || 4180);
api.listen(puerto, () => {
  console.log(`\n=== Oficina · servicio (${inquilinos.length} inquilino${inquilinos.length === 1 ? "" : "s"}) ===`);
  for (const x of contextos) {
    const c = x.cfg, i = x.inquilino;
    console.log(`  · ${i.nombre} (${i.id})${i.dominio ? " · " + i.dominio : ""}${i.unico ? "" : " · /t/" + i.id}`);
    console.log(`      ${c.ODOO_SIMULADO ? "SIMULADO " + c.ODOO_SIMULADO : (c.ODOO_URL || "(sin ODOO_URL)") + " · base " + (c.ODOO_DB || "?")}`);
    console.log(`      escritura ${String(c.PERMITIR_ESCRITURA || "").toLowerCase() === "si" ? "PERMITIDA" : "bloqueada"} · SMTP ${c.SMTP_HOST ? "listo" : "sin configurar"} · token ${c.SERVICIO_TOKEN ? "sí" : "no"} · calendario: ${x.programador.describir()}`);
    console.log(`      Director: ${x.director.disponible ? "modelo de lenguaje (" + x.director.modelo + ")" : "palabras clave"}`);
  }
  console.log(`    App: http://localhost:${puerto}   API: http://localhost:${puerto}/api/estado\n`);
  for (const x of contextos) x.programador.iniciar();
});

for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { for (const x of contextos) { x.programador.detener(); x.db.cerrar(); } api.close(); process.exit(0); });
