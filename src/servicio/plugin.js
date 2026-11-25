// El plugin «Oficina Hacienda» se descarga desde la propia Oficina (pestaña Hacienda → Descargar plugin):
// se empaqueta al vuelo desde plugin/oficina-hacienda, así siempre es la versión del código desplegado.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { crearZip } from "../lib/zip.js";

export const CARPETA_PLUGIN = "plugin/oficina-hacienda";
export const NOMBRE_ARCHIVO = "oficina-hacienda.plugin";

export function versionPlugin(raizProyecto) {
  try { return JSON.parse(readFileSync(join(raizProyecto, CARPETA_PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version || "?"; } catch { return "?"; }
}

export function empaquetarPlugin(raizProyecto) {
  const base = join(raizProyecto, CARPETA_PLUGIN);
  if (!existsSync(base)) throw new Error("El plugin no está en este despliegue (falta plugin/oficina-hacienda).");
  const archivos = {};
  const recorrer = dir => {
    for (const e of readdirSync(dir).sort()) {
      if (e === ".DS_Store" || e.endsWith(".plugin") || e === "node_modules") continue;
      const ruta = join(dir, e);
      if (statSync(ruta).isDirectory()) recorrer(ruta);
      else archivos[relative(base, ruta).split("\\").join("/")] = readFileSync(ruta);
    }
  };
  recorrer(base);
  return crearZip(archivos);
}
