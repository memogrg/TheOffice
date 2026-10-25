// CLASIFICADOR de cuentas de gasto: la guía de Victor (docs/guia-clasificacion-cuentas.md) en código.
//
//   Paso 0  regla propia del cliente (data/reglas.json: por artículo o por proveedor) → se aplica.
//   Paso 1  naturaleza del gasto: palabras de la línea (naturaleza-del-gasto.json) + tipo de proveedor
//           (su actividad económica, actividad-proveedor.json). Gasto que parece personal → consulta.
//   Paso 2  historial: el del propio cliente (catálogo) y el consenso entre clientes
//           (consenso-articulos.json). Comparado por cuenta LÓGICA (canon del código).
//   Paso 3  consulta al contador: historial dividido, historial que choca con la naturaleza,
//           gasto personal, naturaleza ambigua o confianza baja.
//   Paso 4  lo no identificado se reporta. Nunca se propone un comodín (7.01.01, 5.04.99, 5.04.999).
//
// Puro: no lee Odoo ni escribe archivos. Devuelve una decisión con su motivo y los pasos que la
// sostienen, para que la persona que aprueba vea por qué.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canon, norm } from "./catalogo.js";

const REFERENCIA = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "referencia");
const leer = (dir, f, siNo) => { const r = join(dir, f); return existsSync(r) ? JSON.parse(readFileSync(r, "utf8")) : siNo; };

// Umbral para proponer sin consulta (el mismo que ya usaba Cuentas).
export const UMBRAL = 0.9;

export class Clasificador {
  constructor({ catalogo, dirReferencia = REFERENCIA } = {}) {
    this.cat = catalogo;
    const nat = leer(dirReferencia, "naturaleza-del-gasto.json", { categorias: [], senales_gasto_personal: { palabras: [] } });
    const act = leer(dirReferencia, "actividad-proveedor.json", { tipos: [] });
    const cons = leer(dirReferencia, "consenso-articulos.json", { filas: [] });
    const log = leer(dirReferencia, "cuentas-logicas.json", { comodines: { codigos: [] }, cuentas: [] });
    this.categorias = nat.categorias.map(c => ({ ...c, frases: (c.palabras || []).map(norm).filter(Boolean), fuertes: (c.senal_fuerte || []).map(norm).filter(Boolean) }));
    this.porCategoria = new Map(this.categorias.map(c => [c.id, c]));
    this.personal = (nat.senales_gasto_personal?.palabras || []).map(norm).filter(Boolean);
    this.tipos = act.tipos.map(t => ({ ...t, frases: t.patrones.map(norm) }));
    this.consenso = new Map(cons.filas.map(f => [f.articulo, f]));
    this.comodines = new Set([...(log.comodines?.codigos || []), "5.04.999", "5.04.99", "7.01.01", "7.01.001", "7.01"].map(canon));
    this.logicas = new Map(log.cuentas.map(c => [canon(c.codigo), c]));
    this.referenciaEstado = nat.estado || null;
  }

  esComodin(codigo) { return Boolean(codigo) && this.comodines.has(canon(codigo)); }
  misma(a, b) { return Boolean(a && b) && canon(a) === canon(b); }
  logica(codigo) { return this.logicas.get(canon(codigo)) || null; }
  nombreLogico(codigo) { return this.logica(codigo)?.nombre || null; }

  // --- Paso 1: naturaleza --------------------------------------------------------------
  categoriasDeArticulo(texto) {
    const t = ` ${norm(texto)} `;
    // palabra completa, aceptando el plural (TORNILLO → TORNILLOS, LIMON → LIMONES)
    const esta = f => t.includes(` ${f} `) || t.includes(` ${f}S `) || t.includes(` ${f}ES `);
    const hits = [];
    for (const c of this.categorias) {
      const palabras = c.frases.filter(esta);
      const fuertes = c.fuertes.filter(esta);
      if (palabras.length || fuertes.length) hits.push({ id: c.id, cuenta: c.cuenta || null, accion: c.accion || null, palabras: [...fuertes, ...palabras], fuerte: fuertes.length > 0 });
    }
    return hits;
  }
  tipoDeProveedor(actividad) {
    if (!actividad) return null;
    const t = ` ${norm(actividad)} `;
    for (const tp of this.tipos) {
      const f = tp.frases.find(x => t.includes(` ${x} `));
      if (f) return { id: tp.id, categoria: tp.categoria || null, compatibles: tp.compatibles || null, personal: Boolean(tp.personal), por: f };
    }
    return null;
  }
  senalesPersonales(texto) { const t = ` ${norm(texto)} `; return this.personal.filter(f => t.includes(` ${f} `)); }

  // La naturaleza que se puede afirmar con la línea y el proveedor, o por qué no.
  naturaleza(articulo, actividad) {
    const art = this.categoriasDeArticulo(articulo);
    const prov = this.tipoDeProveedor(actividad);
    const conCuenta = art.filter(c => c.cuenta);
    const provCat = prov?.categoria ? this.porCategoria.get(prov.categoria) : null;
    const describir = (c, por) => ({ id: c.id, cuenta: c.cuenta || null, accion: c.accion || null, nombre: c.naturaleza, por });

    // proveedor y artículo dicen lo mismo
    if (provCat && art.some(c => c.id === provCat.id)) return { ...describir(provCat, "artículo y proveedor"), base: 0.95, art, prov };
    // proveedor «compatible» (telecomunicaciones): decide el artículo dentro de lo compatible
    if (prov?.compatibles) {
      const dentro = conCuenta.filter(c => prov.compatibles.includes(c.id));
      if (dentro.length === 1) return { ...describir(this.porCategoria.get(dentro[0].id), "artículo y proveedor"), base: 0.95, art, prov };
    }
    const cuentasDistintas = [...new Set(conCuenta.map(c => canon(c.cuenta)))];
    // el artículo apunta a una sola cuenta
    if (cuentasDistintas.length === 1) {
      const c = this.porCategoria.get(conCuenta[0].id);
      // el proveedor dice otra naturaleza con cuenta: no coinciden
      if (provCat?.cuenta && !this.misma(provCat.cuenta, c.cuenta)) return { ambigua: `la línea parece «${c.naturaleza}» pero el proveedor es de «${provCat.naturaleza}»`, art, prov };
      // proveedor de abarrotes/supermercado (sin cuenta) frente a una línea con cuenta: consulta
      if (provCat && !provCat.cuenta) return { ...describir(provCat, "proveedor"), conflictoCon: c, art, prov };
      return { ...describir(c, "artículo"), base: art.find(x => x.id === c.id)?.fuerte ? 0.95 : 0.9, art, prov };
    }
    // el artículo apunta a varias cuentas
    if (cuentasDistintas.length > 1) {
      return { ambigua: `la línea tiene señales de varias naturalezas (${conCuenta.map(c => c.id).join(", ")})`, art, prov };
    }
    // el artículo no tiene señales con cuenta: decide el proveedor (si tiene categoría)
    if (provCat) return { ...describir(provCat, "proveedor"), base: provCat.cuenta ? 0.85 : null, art, prov };
    // solo señales sin cuenta (abarrotes): consulta
    if (art.length) { const c = this.porCategoria.get(art[0].id); return { ...describir(c, "artículo"), base: null, art, prov }; }
    return { art, prov };
  }

  // --- Paso 2: historial ----------------------------------------------------------------
  historial(compania, articulo) {
    const propio = this.cat?.propio(compania, articulo) || null;
    const fila = this.consenso.get(norm(articulo)) || null;
    const consenso = fila ? { estado: fila.estado, clientes: fila.clientes, cuentas: fila.cuentas, top: fila.cuentas[0] } : null;
    const global = this.cat?.globalExacto(articulo) || null;
    const aproximado = this.cat?.aproximadoPropio(compania, articulo) || null;
    return { propio, consenso, global, aproximado };
  }

  // --- La decisión ---------------------------------------------------------------------
  // entrada: { compania, articulo, proveedor: {id, nombre}, actividad: "nombre de la actividad del emisor" }
  // salida: { decision: "proponer" | "consulta" | "no-identificado", codigo, cuenta, fuente, confianza, motivo, pasos, naturaleza }
  clasificar({ compania, articulo, proveedor = {}, actividad = null }) {
    const pasos = [];
    const salida = (decision, extra) => ({ decision, pasos, ...extra });
    const proponer = (codigo, cuenta, fuente, confianza, motivo, naturaleza = null) => {
      if (this.esComodin(codigo)) return salida("no-identificado", { motivo: `la única referencia es un comodín (${codigo}); no se usa como destino`, naturaleza });
      if (confianza < UMBRAL) return salida("consulta", { codigo, cuenta, fuente, confianza, motivo: motivo || `confianza baja (${confianza})`, naturaleza });
      return salida("proponer", { codigo, cuenta, fuente, confianza, motivo, naturaleza });
    };

    // Paso 0 — regla propia
    const regla = this.cat?.regla(compania, articulo, { proveedorId: proveedor.id, proveedor: proveedor.nombre });
    if (regla) {
      pasos.push(`0 · regla de ${regla.decidio || "una persona"}${regla.porProveedor ? " por proveedor" : " por artículo"}: ${regla.codigo} ${regla.cuenta}`);
      return salida("proponer", { codigo: regla.codigo, cuenta: regla.cuenta, fuente: "regla-humana", confianza: 1, motivo: regla.motivo || "regla humana", decidio: regla.decidio });
    }

    // Paso 1 — naturaleza (y gasto personal)
    const nat = this.naturaleza(articulo, actividad);
    const personales = this.senalesPersonales(articulo);
    const natInfo = nat.id ? { id: nat.id, nombre: nat.nombre, por: nat.por } : null;
    if (nat.prov) pasos.push(`1 · proveedor: ${nat.prov.id}${nat.prov.por ? ` («${nat.prov.por}» en su actividad)` : ""}`);
    if (nat.art?.length) pasos.push(`1 · la línea dice: ${nat.art.map(a => `${a.id} (${a.palabras.slice(0, 3).join(", ")})`).join("; ")}`);
    if (personales.length || nat.prov?.personal) {
      const por = personales.length ? `la línea dice ${personales.slice(0, 3).join(", ")}` : `el proveedor es de ${nat.prov.por.toLowerCase()}`;
      return salida("consulta", { motivo: `parece gasto personal (${por}): no se reclasifica a una cuenta deducible sin el contador`, naturaleza: natInfo, tipo: "personal" });
    }

    // Paso 2 — historial
    const h = this.historial(compania, articulo);
    if (h.propio) pasos.push(`2 · historial de esta compañía: ${h.propio.codigo} ${h.propio.cuenta} (${h.propio.veces} veces)`);
    if (h.consenso) pasos.push(`2 · otros clientes: ${h.consenso.estado}, ${h.consenso.clientes} clientes; mayoría en ${h.consenso.top[0]} (${h.consenso.top[1]})`);
    const propioValido = h.propio && !this.esComodin(h.propio.codigo) ? h.propio : null;
    const consensoTop = h.consenso?.estado === "consenso" && !this.esComodin(h.consenso.top[0]) ? h.consenso.top : null;

    // Con naturaleza que apunta a una cuenta
    if (nat.id && nat.cuenta && nat.base) {
      const N = nat.cuenta, nombreN = this.nombreLogico(N) || nat.nombre;
      const choques = [];
      if (propioValido && !this.misma(propioValido.codigo, N)) choques.push(`esta compañía la registra en ${propioValido.codigo} ${propioValido.cuenta} (${propioValido.veces} veces)`);
      if (consensoTop && !this.misma(consensoTop[0], N)) choques.push(`${consensoTop[1]} clientes la registran en ${consensoTop[0]} ${this.nombreLogico(consensoTop[0]) || ""}`.trim());
      if (choques.length) return salida("consulta", { codigo: N, cuenta: nombreN, fuente: "naturaleza", confianza: nat.base, motivo: `el historial choca con la naturaleza («${nat.nombre}»): ${choques.join("; ")}`, naturaleza: natInfo, tipo: "choque" });
      const apoya = (propioValido && this.misma(propioValido.codigo, N)) || (consensoTop && this.misma(consensoTop[0], N));
      const conf = apoya ? 1 : nat.base;
      return proponer(N, nombreN, apoya ? "naturaleza+historial" : "naturaleza", conf,
        apoya ? null : `solo la naturaleza («${nat.nombre}», por ${nat.por}); sin historial que lo confirme`, natInfo);
    }
    // Naturaleza que exige consulta (abarrotes) o ambigua
    if (nat.conflictoCon) return salida("consulta", { codigo: nat.conflictoCon.cuenta, cuenta: this.nombreLogico(nat.conflictoCon.cuenta) || nat.conflictoCon.naturaleza, fuente: "naturaleza", confianza: 0.8, motivo: `la línea parece «${nat.conflictoCon.naturaleza}» pero el proveedor es de «${nat.nombre}»`, naturaleza: natInfo, tipo: "naturaleza" });
    if (nat.id && nat.accion === "consulta") {
      const sug = propioValido || (consensoTop ? { codigo: consensoTop[0], cuenta: this.nombreLogico(consensoTop[0]) } : null);
      return salida("consulta", { codigo: sug?.codigo || null, cuenta: sug?.cuenta || null, fuente: sug ? "historial" : null, confianza: 0.8, motivo: `«${nat.nombre}»: el criterio depende de la compañía (atención a clientes, personal o costo de ventas)`, naturaleza: natInfo, tipo: "naturaleza" });
    }
    if (nat.ambigua) {
      const sug = propioValido || (consensoTop ? { codigo: consensoTop[0], cuenta: this.nombreLogico(consensoTop[0]) } : null);
      return salida("consulta", { codigo: sug?.codigo || null, cuenta: sug?.cuenta || null, fuente: sug ? "historial" : null, confianza: 0.8, motivo: nat.ambigua, naturaleza: null, tipo: "naturaleza" });
    }

    // Sin naturaleza: decide el historial
    if (h.consenso?.estado === "dividido") {
      const reparto = h.consenso.cuentas.slice(0, 3).map(c => `${c[0]} (${c[1]})`).join(", ");
      return salida("consulta", { codigo: propioValido?.codigo || null, cuenta: propioValido?.cuenta || null, fuente: propioValido ? "historial-propio" : null, confianza: 0.8, motivo: `historial dividido entre clientes: ${reparto}`, tipo: "dividido" });
    }
    if (consensoTop) {
      if (propioValido && !this.misma(propioValido.codigo, consensoTop[0]))
        return salida("consulta", { codigo: consensoTop[0], cuenta: this.nombreLogico(consensoTop[0]), fuente: "consenso", confianza: 0.8, motivo: `esta compañía la registra en ${propioValido.codigo} ${propioValido.cuenta} y ${consensoTop[1]} clientes en ${consensoTop[0]}`, tipo: "choque" });
      return proponer(consensoTop[0], this.nombreLogico(consensoTop[0]) || h.global?.cuenta || consensoTop[0], propioValido ? "consenso+historial" : "consenso", propioValido ? 1 : 0.9);
    }
    if (propioValido) return proponer(propioValido.codigo, propioValido.cuenta, "historial-propio", 0.9);
    if (h.global && !this.esComodin(h.global.codigo))
      return salida("consulta", { codigo: h.global.codigo, cuenta: h.global.cuenta, fuente: "historial-otro-cliente", confianza: 0.8, motivo: "solo otro cliente lo registró así; no alcanza para decidir", tipo: "poco-historial" });
    if (h.aproximado && !this.esComodin(h.aproximado.codigo))
      return salida("consulta", { codigo: h.aproximado.codigo, cuenta: h.aproximado.cuenta, fuente: "parecido", confianza: h.aproximado.confianza, motivo: `parecido (${h.aproximado.confianza}) a «${h.aproximado.parecidoA}» de esta compañía`, tipo: "parecido" });

    // Paso 4
    const porque = h.consenso?.estado === "comodin-mayoritario" ? "los demás clientes lo mandan a un comodín" : "sin regla, sin naturaleza reconocible y sin historial";
    return salida("no-identificado", { motivo: porque });
  }
}

// En el plan de la compañía: la cuenta del destino. Si la referencia vino de OTRO cliente y esa
// cuenta cambia de significado entre clientes («consistente: false»), el código no basta: se busca
// por nombre lógico, y si no aparece una sola, no se resuelve (va a consulta).
export function resolverEnPlan(clasificador, d, plan) {
  if (!d?.codigo && !d?.cuenta) return { cuenta: null };
  const vivas = plan.filter(c => !c.deprecated);
  const porCodigo = vivas.find(c => canon(c.code) === canon(d.codigo));
  const propia = ["regla-humana", "historial-propio", "consenso+historial", "naturaleza+historial"].includes(d.fuente);
  const logica = clasificador.logica(d.codigo);
  if (porCodigo && (propia || !logica || logica.consistente !== false)) return { cuenta: porCodigo };
  const nombre = norm(d.cuenta || logica?.nombre || "");
  const porNombre = nombre ? vivas.filter(c => norm(c.name) === nombre) : [];
  if (porNombre.length === 1) return { cuenta: porNombre[0], porNombre: true };
  if (logica?.consistente === false) return { cuenta: null, motivo: `la cuenta ${d.codigo} cambia de significado entre clientes y en este plan no hay una sola «${logica.nombre}»` };
  return { cuenta: null, motivo: `la cuenta ${d.codigo} ${d.cuenta || ""} no existe en el plan de esta compañía`.trim() };
}
