// EL DIRECTOR — decide qué agente ejecuta cada instrucción.
//
// No adivina: lee data/roster.json, que es el contrato de cada agente.
// Tres reglas que lo separan de la version anterior:
//   1. Puntúa a TODOS los agentes y compara. Antes tomaba el primer regex que pegara.
//   2. Si el segundo lugar queda cerca, PREGUNTA en vez de elegir.
//   3. Si al agente le falta un dato obligatorio (la compañía), lo PIDE.

import { readFileSync, existsSync } from "node:fs";
import { norm } from "./catalogo.js";

const MIN_PUNTAJE = 3;      // por debajo de esto no entiende la instruccion
const MARGEN = 1.5;         // el ganador debe sacarle esto al segundo

// "Marta (recepción)" se lee mejor que "RECEPCIÓN" a secas.
const quien = a => (a.rol && a.rol !== a.nombre) ? `${a.nombre} (${a.rol.toLowerCase()})` : a.nombre;

export class Director {
  constructor(rutaRoster, rutaCompanias){
    const r = JSON.parse(readFileSync(rutaRoster, "utf8"));
    this.agentes = r.agentes || [];
    this.noConstruidos = r.noConstruidos || [];
    this.companias = (rutaCompanias && existsSync(rutaCompanias))
      ? JSON.parse(readFileSync(rutaCompanias, "utf8")) : [];
  }

  #puntuar(texto, palabras){
    const t = norm(texto);
    let p = 0; const pegaron = [];
    for (const [clave, peso] of Object.entries(palabras || {})){
      if (t.includes(norm(clave))){ p += peso; pegaron.push(clave); }
    }
    return { p, pegaron };
  }

  // Busca el nombre de una compañía dentro de la instruccion
  #compania(texto){
    const t = norm(texto);
    let mejor = null;
    for (const c of this.companias){
      const n = norm(c.name);
      if (n.length < 4) continue;
      if (t.includes(n) && (!mejor || n.length > norm(mejor.name).length)) mejor = c;
    }
    return mejor;
  }

  decidir(instruccion){
    const marcador = this.agentes
      .map(a => ({ agente: a, ...this.#puntuar(instruccion, a.palabras) }))
      .sort((x, y) => y.p - x.p);
    const pendientes = this.noConstruidos
      .map(a => ({ agente: a, ...this.#puntuar(instruccion, a.palabras) }))
      .sort((x, y) => y.p - x.p);

    const g = marcador[0], s = marcador[1];

    // ¿La instruccion apunta a un puesto que todavia no existe?
    if (pendientes[0] && pendientes[0].p >= MIN_PUNTAJE && (!g || pendientes[0].p > g.p)){
      return { accion: "no-construido", agente: pendientes[0].agente,
        mensaje: `Eso sería trabajo de ${quien(pendientes[0].agente)}, que todavía no está construido. ${pendientes[0].agente.hace}`,
        marcador: marcador.map(m => ({ nombre: quien(m.agente), puntaje: m.p })) };
    }

    if (!g || g.p < MIN_PUNTAJE){
      return { accion: "no-entiendo",
        mensaje: "No sé a quién pasarle eso. Puedo pedirle a:\n" +
          this.agentes.map(a => `  · ${quien(a)} — ${a.hace}`).join("\n"),
        marcador: marcador.map(m => ({ nombre: quien(m.agente), puntaje: m.p })) };
    }

    if (s && s.p > 0 && g.p < s.p * MARGEN){
      return { accion: "ambiguo",
        mensaje: `Puede ser para ${quien(g.agente)} (${g.agente.hace.slice(0, 60)}…) o para ${quien(s.agente)} (${s.agente.hace.slice(0, 60)}…). ¿Cuál?`,
        candidatos: [quien(g.agente), quien(s.agente)],
        marcador: marcador.map(m => ({ nombre: quien(m.agente), puntaje: m.p })) };
    }

    // Parametros obligatorios
    const args = [];
    for (const par of g.agente.parametros || []){
      if (par.nombre === "empresa"){
        const c = this.#compania(instruccion);
        if (!c) return { accion: "falta-dato", agente: g.agente, parametro: par.nombre,
          mensaje: `${quien(g.agente)} puede hacerlo, pero ${par.pregunta}`,
          marcador: marcador.map(m => ({ nombre: quien(m.agente), puntaje: m.p })) };
        args.push(`--empresa=${c.id}`);
        g.compania = c.name;
      }
    }

    return {
      accion: "ejecutar", agente: g.agente, args, compania: g.compania || null,
      comando: `node src/run.js ${g.agente.id}${args.length ? " " + args.join(" ") : ""}`,
      mensaje: `Se lo paso a ${quien(g.agente)}${g.compania ? " para " + g.compania : ""}.` +
               (g.agente.escribe ? " Recuerde: escribe en Odoo, así que primero propone." : ""),
      porQue: g.pegaron,
      marcador: marcador.map(m => ({ nombre: quien(m.agente), puntaje: m.p }))
    };
  }
}
