// La oficina 2D: ui/plantilla.html con las cifras reales, el Director y la marca incrustados.
// La usan run.js (terminal) y el servicio (por inquilino).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const leerJSON = (ruta, siNoExiste) => (existsSync(ruta) ? JSON.parse(readFileSync(ruta, "utf8")) : siNoExiste);

// raizProyecto: donde viven ui/plantilla.html y src/director-core.cjs.
// raiz: donde viven data/ y reportes/ del inquilino (igual a raizProyecto si es único).
export function generarOficina({ raizProyecto, raiz, cfg, estado, marca = null, prefijo = "" }) {
  const datos = { ...estado };
  datos.correo = (cfg.SMTP_HOST && cfg.SMTP_USER) ? cfg.REPORTE_PARA : "";
  datos.roster = leerJSON(join(raiz, "data", "roster.json"), { agentes: [], noConstruidos: [] });
  datos.companias = leerJSON(join(raiz, "data", "companias.json"), []).map(c => ({ id: c.id, name: c.name }));
  datos.marca = marca ? { id: marca.id, nombre: marca.nombre, color: marca.color, logo: marca.logo } : null;
  datos.prefijo = prefijo;
  const nombre = marca?.nombre || "IASIMA";
  const plantilla = readFileSync(join(raizProyecto, "ui", "plantilla.html"), "utf8");
  const director = readFileSync(join(raizProyecto, "src", "director-core.cjs"), "utf8");
  return plantilla
    .replace(/\/\*DATOS\*\/[\s\S]*?\/\*FIN\*\//, () =>
      "/*DATOS*/ " + JSON.stringify(datos)
        // Hay lineas de Odoo con el caracter de reemplazo donde iba una vocal acentuada.
        .replace(/�/g, "\\uFFFD")
        .replace(/<\//g, "<\\/") + " /*FIN*/")
    .replace(/\/\*DIRECTOR\*\/[\s\S]*?\/\*FINDIRECTOR\*\//, () => "/*DIRECTOR*/\n" + director + "\n/*FINDIRECTOR*/")
    .replace("<title>Oficina virtual IASIMA</title>", `<title>Oficina virtual ${esc(nombre)}</title>`)
    .replace('<span class="appname">Oficina IASIMA</span>', `<span class="appname">Oficina ${esc(nombre)}</span>`)
    .replace("<style>", marca?.color ? `<style>:root{--seal:${esc(marca.color)}}\n` : "<style>");
}

export function escribirOficina(opciones) {
  const html = generarOficina(opciones);
  const destino = join(opciones.raiz, "Oficina IASIMA.html");
  writeFileSync(destino, html);
  return destino;
}

const esc = s => String(s ?? "").replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
