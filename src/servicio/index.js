// El servicio: base de datos + agentes + calendario + API + app web.
//   npm run servicio            → http://localhost:4180
//   PUERTO=8080 npm run servicio
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cargarEnv } from "../odoo.js";
import { BaseDeDatos } from "./db.js";
import { Corridas } from "./corridas.js";
import { Programador } from "./programador.js";
import { crearApi } from "./api.js";
import { DirectorLLM } from "./director-llm.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rutaEnv = join(RAIZ, ".env");
const cfg = { ...cargarEnv(existsSync(rutaEnv) ? readFileSync(rutaEnv, "utf8") : ""), ...delEntorno() };
const log = m => console.log(`  ${new Date().toLocaleTimeString("es-CR", { hour12: false })}  ${m}`);

const db = new BaseDeDatos(join(RAIZ, cfg.BASE_DE_DATOS || "data/oficina.db"));
const corridas = new Corridas({ db, cfg, raiz: RAIZ, log });
const programador = new Programador({ corridas, db, cfg, log });
const director = new DirectorLLM({ db, corridas, cfg, raiz: RAIZ, log });
const api = crearApi({ db, corridas, programador, director, cfg, raiz: RAIZ, log });

const puerto = Number(cfg.PUERTO || 4180);
api.listen(puerto, () => {
  console.log(`\n=== Oficina IASIMA · servicio ===`);
  console.log(`    ${cfg.ODOO_SIMULADO ? "SIMULADO " + cfg.ODOO_SIMULADO : cfg.ODOO_URL + " · base " + cfg.ODOO_DB}`);
  console.log(`    escritura ${String(cfg.PERMITIR_ESCRITURA || "").toLowerCase() === "si" ? "PERMITIDA" : "bloqueada"} · SMTP ${cfg.SMTP_HOST ? "listo" : "sin configurar"} · token ${cfg.SERVICIO_TOKEN ? "sí" : "no"}`);
  console.log(`    Director: ${director.disponible ? "modelo de lenguaje (" + director.modelo + ")" : "palabras clave (configure CLAUDE_API_KEY para el modelo)"}`);
  console.log(`    App: http://localhost:${puerto}   API: http://localhost:${puerto}/api/estado\n`);
  programador.iniciar();
});

for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { programador.detener(); api.close(); db.cerrar(); process.exit(0); });

function delEntorno() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (/^(ODOO_|ALERTA_|SMTP_|REPORTE_|PERMITIR_ESCRITURA|COMUNICACION_|CATALOGO_|SERVICIO_|CORRIDA_|CONCILIACION_|BASE_DE_DATOS|PUERTO|CLAUDE_API_KEY|DIRECTOR_)/.test(k)) out[k] = v;
  return out;
}
