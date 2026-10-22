// EL DIRECTOR — núcleo puro. Decide qué agente ejecuta cada instrucción.
//
// Este archivo es la ÚNICA implementación. Node lo importa (src/director.js) y run.js
// lo incrusta textualmente en la oficina (ui/plantilla.html), de modo que la terminal
// y el navegador deciden exactamente igual. Por eso está escrito sin import/export y
// sin sintaxis que un navegador viejo no entienda.
//
// No adivina: lee el roster (data/roster.json), que es el contrato de cada agente.
//   1. Puntúa a TODOS los agentes y compara.
//   2. Si el segundo lugar queda cerca, PREGUNTA en vez de elegir.
//   3. Si al agente le falta un dato obligatorio (la compañía), lo PIDE.
//
// Cuando el Director pase a ser un modelo de lenguaje con herramientas, este archivo
// es el que se reemplaza; la firma decidir(instruccion, roster, companias) se conserva.

(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) module.exports = fabrica();
  else raiz.DirectorCore = fabrica();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var MIN_PUNTAJE = 3;   // por debajo de esto no entiende la instrucción
  var MARGEN = 1.5;      // el ganador debe sacarle esto al segundo

  function norm(s) {
    if (s == null) return "";
    return String(s)
      .replace(/\uFFFD/g, " ")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();
  }

  // "Marta (recepción)" se lee mejor que "RECEPCIÓN" a secas.
  function quien(a) {
    return (a.rol && a.rol !== a.nombre) ? a.nombre + " (" + a.rol.toLowerCase() + ")" : a.nombre;
  }

  function puntuar(texto, palabras) {
    var t = norm(texto), p = 0, pegaron = [];
    for (var clave in (palabras || {})) {
      if (t.indexOf(norm(clave)) >= 0) { p += palabras[clave]; pegaron.push(clave); }
    }
    return { p: p, pegaron: pegaron };
  }

  // Busca el nombre de una compañía dentro de la instrucción (el más largo que calce).
  function hallarCompania(texto, companias) {
    var t = norm(texto), mejor = null;
    (companias || []).forEach(function (c) {
      var n = norm(c.name);
      if (n.length < 4) return;
      if (t.indexOf(n) >= 0 && (!mejor || n.length > norm(mejor.name).length)) mejor = c;
    });
    return mejor;
  }

  function marcadorDe(lista) {
    return lista.map(function (m) { return { nombre: quien(m.agente), puntaje: m.p }; });
  }

  function decidir(instruccion, roster, companias) {
    if (!roster || !roster.agentes) {
      return { accion: "sin-roster", mensaje: "Todavía no tengo el contrato de los agentes. Corra un agente para generarlo.", marcador: [] };
    }
    var marcador = roster.agentes
      .map(function (a) { var q = puntuar(instruccion, a.palabras); return { agente: a, p: q.p, pegaron: q.pegaron }; })
      .sort(function (x, y) { return y.p - x.p; });
    var pendientes = (roster.noConstruidos || [])
      .map(function (a) { var q = puntuar(instruccion, a.palabras); return { agente: a, p: q.p, pegaron: q.pegaron }; })
      .sort(function (x, y) { return y.p - x.p; });

    var g = marcador[0], s = marcador[1];

    // ¿La instrucción apunta a un puesto que todavía no existe?
    if (pendientes[0] && pendientes[0].p >= MIN_PUNTAJE && (!g || pendientes[0].p > g.p)) {
      return { accion: "no-construido", agente: pendientes[0].agente,
        mensaje: "Eso sería trabajo de " + quien(pendientes[0].agente) + ", que todavía no está construido. " + pendientes[0].agente.hace,
        marcador: marcadorDe(marcador) };
    }

    if (!g || g.p < MIN_PUNTAJE) {
      return { accion: "no-entiendo",
        mensaje: "No sé a quién pasarle eso. Puedo pedirle a:\n" +
          roster.agentes.map(function (a) { return "  · " + quien(a) + " — " + a.hace; }).join("\n"),
        marcador: marcadorDe(marcador) };
    }

    if (s && s.p > 0 && g.p < s.p * MARGEN) {
      return { accion: "ambiguo",
        mensaje: "Puede ser para " + quien(g.agente) + " (" + g.agente.hace.slice(0, 60) + "…) o para " + quien(s.agente) + " (" + s.agente.hace.slice(0, 60) + "…). ¿Cuál?",
        candidatos: [quien(g.agente), quien(s.agente)],
        marcador: marcadorDe(marcador) };
    }

    // Parámetros obligatorios
    var args = [], compania = null;
    var pars = g.agente.parametros || [];
    for (var i = 0; i < pars.length; i++) {
      var par = pars[i];
      if (par.nombre === "empresa") {
        var c = hallarCompania(instruccion, companias);
        if (!c) return { accion: "falta-dato", agente: g.agente, parametro: par.nombre,
          mensaje: quien(g.agente) + " puede hacerlo, pero " + par.pregunta,
          marcador: marcadorDe(marcador) };
        args.push("--empresa=" + c.id);
        compania = c.name;
      }
    }

    return {
      accion: "ejecutar", agente: g.agente, args: args, compania: compania,
      comando: "node src/run.js " + g.agente.id + (args.length ? " " + args.join(" ") : ""),
      mensaje: "Se lo paso a " + quien(g.agente) + (compania ? " para " + compania : "") + "." +
        (g.agente.escribe ? " Recuerde: escribe en Odoo, así que primero propone." : ""),
      porQue: g.pegaron,
      marcador: marcadorDe(marcador)
    };
  }

  return { decidir: decidir, norm: norm, puntuar: puntuar, hallarCompania: hallarCompania, quien: quien,
           MIN_PUNTAJE: MIN_PUNTAJE, MARGEN: MARGEN };
});
