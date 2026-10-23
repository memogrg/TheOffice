// Construye data/catalogo-cuentas.json directamente de Odoo, sin Excel.
//
//   node scripts/construir-catalogo.js                 # lee .env, escribe data/catalogo-cuentas.json
//   node scripts/construir-catalogo.js --salida=x.json
//   ODOO_SIMULADO=test/simulado/instancia.json node scripts/construir-catalogo.js --salida=/tmp/c.json
//
// Qué hace: toma todas las líneas de facturas de proveedor PUBLICADAS (in_invoice e
// in_refund, display_type product/other), y para cada artículo (el texto de la línea,
// normalizado) cuenta en qué cuenta contable se registró. La cuenta más usada gana.
// Se arma por compañía (porCliente) y en total (global). Es el histórico: registra lo
// que se hizo, no lo que es correcto; las decisiones humanas van en data/reglas.json.
//
// Formato de salida (el que espera src/catalogo.js):
//   { cuentas: { "5.04.002.002": "Electricidad" },
//     porCliente: { "PUUK": { "SERVICIO ELECTRICO": ["5.04.002.002", "Electricidad", 40] } },
//     global:     { "SERVICIO ELECTRICO": ["5.04.002.002", "Electricidad", 218] } }
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Odoo, cargarEnv } from "../src/odoo.js";
import { OdooSimulado } from "../src/odoo-simulado.js";
import { norm, canon } from "../src/catalogo.js";
import { cargarInquilinos } from "../src/servicio/inquilinos.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const salidaArg = (args.find(a => a.startsWith("--salida=")) || "").split("=")[1];
const minimoVeces = Number((args.find(a => a.startsWith("--minimo=")) || "").split("=")[1] || 1);

const rutaEnv = join(RAIZ, ".env");
const cfgGlobal = { ...cargarEnv(existsSync(rutaEnv) ? readFileSync(rutaEnv, "utf8") : ""), ...process.env };
// --inquilino=sima: usa la conexión de ese inquilino y escribe en inquilinos/sima/data/
const idInquilino = (args.find(a => a.startsWith("--inquilino=")) || "").split("=")[1];
const inquilinos = cargarInquilinos(cfgGlobal, RAIZ);
const inquilino = idInquilino ? inquilinos.find(i => i.id === idInquilino.toLowerCase()) : inquilinos[0];
if (!inquilino) { console.error(`  No existe el inquilino "${idInquilino}". Hay: ${inquilinos.map(i => i.id).join(", ")}`); process.exit(1); }
const cfg = inquilino.cfg;
const salida = salidaArg || join(inquilino.raiz, "data", "catalogo-cuentas.json");
if (inquilinos.length > 1) console.log(`  Inquilino: ${inquilino.nombre} (${inquilino.id})`);
const log = m => console.log("  " + m);

function cliente() {
  if (cfg.ODOO_SIMULADO) return new OdooSimulado(JSON.parse(readFileSync(join(RAIZ, cfg.ODOO_SIMULADO), "utf8")));
  for (const k of ["ODOO_URL", "ODOO_DB", "ODOO_USER", "ODOO_PASSWORD"]) if (!cfg[k]) throw new Error(`Falta ${k} en .env`);
  return new Odoo({ url: cfg.ODOO_URL, db: cfg.ODOO_DB, user: cfg.ODOO_USER, password: cfg.ODOO_PASSWORD });
}

// Devuelve, por artículo, la cuenta más usada: { ARTICULO: [codigo, cuenta, veces] }
function consolidar(conteos) {
  const out = {};
  for (const [articulo, porCuenta] of Object.entries(conteos)) {
    const [mejor, veces] = Object.entries(porCuenta).sort((a, b) => b[1] - a[1])[0];
    if (veces < minimoVeces) continue;
    const [codigo, cuenta] = mejor.split("|");
    out[articulo] = [codigo, cuenta, veces];
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const odoo = cliente();
  await odoo.conectar();

  const companias = await odoo.leer("res.company", "search_read", [[], ["name"]]);
  const nombreCia = Object.fromEntries(companias.map(c => [c.id, c.name]));
  const ctx = { allowed_company_ids: companias.map(c => c.id) };
  log(`${companias.length} compañías`);

  // En Odoo 18 el código de cuenta depende de la compañía activa (code_mapping): leído con
  // 79 compañías a la vez, solo las de la primera traen código. Se lee el plan de cada una
  // por separado, igual que hace el agente Cuentas, y se indexa por (compañía, cuenta).
  const codigoDe = new Map();   // "cia|cuentaId" -> { codigo, nombre }
  let nCuentas = 0;
  for (const c of companias) {
    const plan = await odoo.leerTodo("account.account", [["company_ids", "in", [c.id]]], ["code", "name"],
      { context: { allowed_company_ids: [c.id] } });
    for (const a of plan) codigoDe.set(`${c.id}|${a.id}`, { codigo: canon(a.code), nombre: a.name });
    nCuentas += plan.length;
  }
  log(`${nCuentas} cuentas en los planes de ${companias.length} compañías`);

  // account.move.line trae company_id y parent_state propios; move_type no es almacenado,
  // así que el tipo se filtra por el asiento padre con un dominio relacionado.
  const lineas = await odoo.leerTodo("account.move.line",
    [["move_id.move_type", "in", ["in_invoice", "in_refund"]], ["parent_state", "=", "posted"],
     ["display_type", "in", ["product", "other"]]],
    ["name", "product_id", "account_id", "company_id"],
    { context: ctx, alAvanzar: n => n % 10000 === 0 && log(`líneas: ${n}...`) });
  log(`${lineas.length} líneas de facturas de proveedor publicadas`);

  const porCliente = {}, global = {}, cuentas = {};
  let sinCuenta = 0, sinTexto = 0;
  for (const l of lineas) {
    const texto = l.name || (l.product_id ? l.product_id[1] : "");
    const articulo = norm(texto);
    if (!articulo) { sinTexto++; continue; }
    const ciaId = l.company_id ? l.company_id[0] : null;
    const cta = l.account_id ? codigoDe.get(`${ciaId}|${l.account_id[0]}`) : null;
    if (!cta || !cta.codigo) { sinCuenta++; continue; }
    cuentas[cta.codigo] = cta.nombre;
    const llave = `${cta.codigo}|${cta.nombre}`;
    const cia = norm(nombreCia[ciaId] || "");
    if (cia) {
      const pc = porCliente[cia] || (porCliente[cia] = {});
      const pa = pc[articulo] || (pc[articulo] = {});
      pa[llave] = (pa[llave] || 0) + 1;
    }
    const ga = global[articulo] || (global[articulo] = {});
    ga[llave] = (ga[llave] || 0) + 1;
  }

  const catalogo = {
    _comentario: `Histórico construido de Odoo el ${new Date().toISOString().slice(0, 10)}: ${lineas.length} líneas de facturas de proveedor publicadas. Registra lo que se hizo, no lo que es correcto; las decisiones humanas van en reglas.json.`,
    construido: new Date().toISOString(),
    lineas: lineas.length,
    cuentas,
    porCliente: Object.fromEntries(Object.entries(porCliente).map(([c, v]) => [c, consolidar(v)])),
    global: consolidar(global)
  };
  mkdirSync(dirname(salida), { recursive: true });
  writeFileSync(salida, JSON.stringify(catalogo, null, 1));
  const nCliente = Object.values(catalogo.porCliente).reduce((s, o) => s + Object.keys(o).length, 0);
  log(`Catálogo: ${nCliente} artículos por cliente en ${Object.keys(catalogo.porCliente).length} compañías, ${Object.keys(catalogo.global).length} globales, ${Object.keys(cuentas).length} cuentas. ` +
      `${sinTexto} líneas sin texto y ${sinCuenta} sin cuenta se ignoraron.`);
  log(`Escrito en ${salida} (${Math.round((Date.now() - t0) / 100) / 10} s, ${odoo.llamadas} consultas)`);
}

main().catch(e => { console.error("\n  FALLO: " + e.message + "\n"); process.exit(1); });
