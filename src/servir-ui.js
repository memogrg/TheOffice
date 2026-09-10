// Abre la oficina 2D en el navegador, servida desde este proyecto.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUERTO = 4173;
createServer((req, res) => {
  if (req.url.startsWith("/estado.json")) {
    const p = join(RAIZ, "data", "estado.json");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(existsSync(p) ? readFileSync(p) : "{}");
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(readFileSync(join(RAIZ, "ui", "index.html")));
}).listen(PUERTO, () => console.log(`\n  Oficina abierta en http://localhost:${PUERTO}\n  (Ctrl+C para cerrar)\n`));
