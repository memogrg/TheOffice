// Memoria del agente de cuentas: que cuenta corresponde a cada articulo.
// Se construyo del Excel "Articulos por cuenta de gasto" (34.128 lineas historicas).
import { readFileSync, existsSync } from "node:fs";

export function norm(s){
  if (s == null) return "";
  return String(s)
    .replace(/�/g, " ")                      // el caracter roto de la extraccion
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\[[^\]]*\]/g, " ")                  // quita prefijos tipo [PUUK]
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}
// 5.04.02.02 y 5.04.002.002.000.000 -> 5.04.002.002
export function canon(code){
  if (!code) return "";
  const p = String(code).trim().split(".").filter(Boolean);
  while (p.length > 2 && /^0+$/.test(p[p.length - 1])) p.pop();
  return p.map((s, i) => (i < 2 ? s : s.padStart(3, "0"))).join(".");
}

export class Catalogo {
  constructor(ruta, rutaReglas){
    const d = JSON.parse(readFileSync(ruta, "utf8"));
    this.cuentas = d.cuentas || {};
    this.porCliente = d.porCliente || {};
    this.global = d.global || {};
    // indice por primer token, para el emparejamiento aproximado
    this.idx = new Map();
    for (const k of Object.keys(this.global)){
      const t = k.split(" ")[0];
      if (!t) continue;
      if (!this.idx.has(t)) this.idx.set(t, []);
      this.idx.get(t).push(k);
    }
    this.articulosCliente = Object.values(this.porCliente).reduce((s, o) => s + Object.keys(o).length, 0);
    this.articulosGlobal = Object.keys(this.global).length;

    // Reglas humanas: mandan sobre el historico.
    // Dos clases: por artículo (alcance|ARTICULO) y por proveedor (alcance|#id o alcance|@NOMBRE),
    // para «todo lo de Rostipollos va a Relaciones públicas». La de artículo es más específica y gana.
    this.reglas = new Map();
    this.reglasProveedor = new Map();
    if (rutaReglas && existsSync(rutaReglas)){
      const rr = JSON.parse(readFileSync(rutaReglas, "utf8")).reglas || [];
      for (const r of rr){
        const alc = (r.alcance && r.alcance !== "todas") ? norm(r.alcance) : "*";
        const valor = { codigo: canon(r.codigo), cuenta: r.cuenta, decidio: r.decidio, motivo: r.motivo };
        if (r.articulo) this.reglas.set(alc + "|" + norm(r.articulo), valor);
        else if (r.proveedorId) this.reglasProveedor.set(alc + "|#" + Number(r.proveedorId), valor);
        else if (r.proveedor) this.reglasProveedor.set(alc + "|@" + norm(r.proveedor), valor);
      }
    }
    this.nReglas = this.reglas.size + this.reglasProveedor.size;
  }

  #reglaProveedor(c, { proveedorId = null, proveedor = null } = {}){
    const claves = [];
    if (proveedorId) claves.push(c + "|#" + Number(proveedorId), "*|#" + Number(proveedorId));
    if (proveedor) claves.push(c + "|@" + norm(proveedor), "*|@" + norm(proveedor));
    for (const k of claves) if (this.reglasProveedor.has(k)) return this.reglasProveedor.get(k);
    return null;
  }

  #jaccard(a, b){
    const A = new Set(a.split(" ")), B = new Set(b.split(" "));
    let inter = 0; for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter);
  }

  // Devuelve { codigo, cuenta, fuente, confianza } o null
  // proveedor: { proveedorId, proveedor } de la factura, para las reglas por proveedor.
  resolver(cliente, articulo, proveedor = {}){
    const a = norm(articulo);
    if (!a) return null;
    const c = norm(cliente);

    // 0. una decision humana gana siempre: primero por artículo, luego por proveedor
    const regla = this.reglas.get(c + "|" + a) || this.reglas.get("*|" + a);
    if (regla) return { codigo: regla.codigo, cuenta: regla.cuenta, fuente: "regla-humana",
                        confianza: 1, decidio: regla.decidio };
    const rp = this.#reglaProveedor(c, proveedor);
    if (rp) return { codigo: rp.codigo, cuenta: rp.cuenta, fuente: "regla-humana",
                     confianza: 1, decidio: rp.decidio, porProveedor: true };

    const pc = this.porCliente[c];
    if (pc && pc[a]) return { codigo: pc[a][0], cuenta: pc[a][1], fuente: "cliente-exacto", confianza: 1, veces: pc[a][2] };
    if (this.global[a]) return { codigo: this.global[a][0], cuenta: this.global[a][1], fuente: "global-exacto", confianza: .95, veces: this.global[a][2] };

    // aproximado dentro del propio cliente
    if (pc){
      let mejor = null;
      for (const k of Object.keys(pc)){
        const s = this.#jaccard(a, k);
        if (s >= .7 && (!mejor || s > mejor.s)) mejor = { s, k };
      }
      if (mejor) return { codigo: pc[mejor.k][0], cuenta: pc[mejor.k][1], fuente: "cliente-aproximado",
                          confianza: Math.round(mejor.s * 100) / 100, parecidoA: mejor.k };
    }
    // aproximado global, acotado por el primer token
    const cand = this.idx.get(a.split(" ")[0]) || [];
    let mejor = null;
    for (const k of cand){
      const s = this.#jaccard(a, k);
      if (s >= .8 && (!mejor || s > mejor.s)) mejor = { s, k };
    }
    if (mejor) return { codigo: this.global[mejor.k][0], cuenta: this.global[mejor.k][1], fuente: "global-aproximado",
                        confianza: Math.round(mejor.s * 100) / 100, parecidoA: mejor.k };
    return null;
  }
}
